/** Shipped Node connect → native hooks → both selected destinations → recall.
 * All credentials/content are synthetic and every request stays on loopback. */
import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveDeviceProfile } from "../capture/auth";

test("cloud bundles connect a non-Git project, route hooks by task binding and recall every selected Workspace", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "aug-cloud-node-")));
  const home = join(scratch, "home"), cwd = join(scratch, "runtime"), project = join(scratch, "selected-project");
  for (const dir of [home, cwd, project]) mkdirSync(dir);
  const sessionId = "b89fcfdc-dfc7-5eb5-99f3-f9da2d6ebbc2";
  const configDir = join(home, ".claude");
  const transcriptDir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
  const line = (role: string, content: string) => JSON.stringify({ type: role, sessionId,
    timestamp: new Date().toISOString(), message: { role, content } }) + "\n";
  writeFileSync(transcriptPath, line("user", "history before consent"));
  const links = new Map<string, Record<string, unknown>>();
  const uploads: { connector: string | null; body: any }[] = [];
  const recalls: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path === "/.well-known/augenta.json") return Response.json({ issuer: url.origin, clientId: "client_public", gateway: url.origin });
    if (request.headers.get("authorization") !== "Bearer synthetic-access") return new Response("unauthorized", { status: 401 });
    if (path === "/v1/me") return Response.json({ user: { id: "user_1", name: "Test", email: "test@example.com" }, org: { id: "org_1", name: "Test Org" } });
    if (path === "/v1/workspaces") return Response.json({ workspaces: [{ id: "workspace_a", name: "A" }, { id: "workspace_b", name: "B" }] });
    if (path === "/v1/connectors" && request.method === "GET") return Response.json({ connectors: [...links.values()] });
    if (path === "/v1/connectors" && request.method === "POST") {
      const body = await request.json() as any;
      const connector = { ...body, id: `connector_${body.workspaceId}`, ownerUserId: "user_1", status: "active", direction: "inbound", _etag: "revision-1" };
      links.set(connector.id, connector); return Response.json({ connector });
    }
    if (path.startsWith("/v1/connectors/")) {
      const connector = links.get(decodeURIComponent(path.slice("/v1/connectors/".length)));
      return connector ? Response.json({ connector }) : new Response("not found", { status: 404 });
    }
    if (path === "/v1/experiences") {
      uploads.push({ connector: request.headers.get("x-augenta-connector-id"), body: await request.json() });
      return new Response(null, { status: 202 });
    }
    if (path === "/v1/recall") {
      const body = await request.json() as any; recalls.push(body);
      return Response.json({ mode: "context", scope: `org_1:${body.workspace}`, note_count: 0, notes_truncated: false,
        content: [{ type: "engram", text: "remembered cloud decision", engram_id: "synthetic", memory_class: "procedural", born_t: new Date().toISOString(), contradiction: false, quality_verdict: "good" }] });
    }
    return new Response(`unexpected route ${path}`, { status: 500 });
  } });
  const gateway = `http://127.0.0.1:${server.port}`;
  const authHome = join(home, "auth");
  const oldAuth = process.env.AUGENTA_AUTH_HOME;
  try {
    process.env.AUGENTA_AUTH_HOME = authHome;
    await saveDeviceProfile({ issuer: gateway, clientId: "client_public", gateway },
      { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3_600_000 }, { userId: "user_1", orgId: "org_1" });
  } finally { if (oldAuth === undefined) delete process.env.AUGENTA_AUTH_HOME; else process.env.AUGENTA_AUTH_HOME = oldAuth; }
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) if (/^(AUGENTA_|HTTPS?_PROXY$|https?_proxy$|ALL_PROXY$|all_proxy$|NO_PROXY$|no_proxy$|NODE_EXTRA_CA_CERTS$|NODE_USE_ENV_PROXY$|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CODEX_HOME$)/.test(key)) delete env[key];
  Object.assign(env, { HOME: home, AUGENTA_HOME: home, AUGENTA_AUTH_HOME: authHome, CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_SESSION_ID: sessionId });
  const root = resolve(import.meta.dir, "..");
  async function run(bundle: string, args: string[] = [], payload?: object) {
    const proc = Bun.spawn(["node", join(root, "dist", bundle), ...args], { cwd, env, stdout: "pipe", stderr: "pipe",
      stdin: payload ? Buffer.from(JSON.stringify(payload)) : "ignore" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(stderr).toBe(""); expect(code).toBe(0);
      expect(stdout).not.toMatch(/synthetic-access|synthetic-refresh|accessToken|refreshToken/);
      return stdout ? JSON.parse(stdout) : undefined;
    } finally { clearTimeout(timer); }
  }
  try {
    const prefix = ["--json", "--harness", "claude-code", "--project", project, "--control-url", gateway];
    const probe = await run("scripts/connect.mjs", [...prefix, "--probe"]);
    expect(probe).toMatchObject({ status: "need_workspace", session: { ephemeral: true, temporaryProject: true } });
    expect(existsSync(join(project, ".augenta"))).toBe(false);
    const connected = await run("scripts/connect.mjs", [...prefix, "--workspace", "workspace_a", "--workspace", "workspace_b", "--auto-recall", "on"]);
    expect(connected).toMatchObject({ status: "connected", nativeCapture: { status: "bound", sessionId }, captureHealth: { enabled: true } });
    expect(connected.destinations.map((x: any) => x.workspaceId)).toEqual(["workspace_a", "workspace_b"]);
    const payload = { cwd, session_id: sessionId, transcript_path: transcriptPath };
    await run("hooks/user-prompt.mjs", [], { ...payload, session_id: "another-task", prompt: "unbound cloud prompt" });
    expect(recalls).toHaveLength(0);
    await run("hooks/user-prompt.mjs", [], { ...payload, prompt: "synthetic cloud prompt" });
    expect(recalls.map(x => [x.workspace, x.origin]).sort()).toEqual([["workspace_a", "auto"], ["workspace_b", "auto"]]);
    expect(recalls.every(x => Object.keys(x).sort().join() === "budget_tokens,origin,query,workspace")).toBe(true);
    appendFileSync(transcriptPath, line("user", "synthetic cloud prompt") + line("assistant", "synthetic cloud answer"));
    await run("capture/capture.mjs", [], { ...payload, hook_event_name: "Stop" });
    const deadline = Date.now() + 5000;
    while (uploads.length < 2 && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
    expect(uploads.map(x => x.connector).sort()).toEqual(["connector_workspace_a", "connector_workspace_b"]);
    expect(uploads[0]!.body).toEqual(uploads[1]!.body);
    expect(JSON.stringify(uploads)).not.toContain("history before consent");
    expect(uploads[0]!.body.experiences).toMatchObject([{ type: "trajectory", sid: sessionId, events: [{ text: "synthetic cloud prompt", turn: 1 }, { text: "synthetic cloud answer", turn: 1 }] }]);
    const remembered = await run("scripts/recall.mjs", ["--json", "--context", "--query", "what did the cloud task decide"]);
    expect(remembered.status).toBe("answered"); expect(remembered.answers).toHaveLength(2);
    expect(recalls.filter(x => x.origin === "manual").map(x => x.workspace).sort()).toEqual(["workspace_a", "workspace_b"]);
    env.AUGENTA_CAPTURE_ENABLED = "0";
    const disabledRecall = await run("scripts/recall.mjs", ["--json", "--context", "--query", "what did the cloud task decide"]);
    expect(disabledRecall.status).toBe("answered"); expect(disabledRecall.answers).toHaveLength(2);
    delete env.AUGENTA_CAPTURE_ENABLED;
    const spool = join(project, ".augenta", "outbox", "spool.jsonl");
    const before = existsSync(spool) ? readFileSync(spool, "utf8") : "";
    appendFileSync(transcriptPath, line("user", "must remain unbound"));
    await run("capture/capture.mjs", [], { ...payload, session_id: "another-task", hook_event_name: "Stop" });
    expect(existsSync(spool) ? readFileSync(spool, "utf8") : "").toBe(before);
  } finally { server.stop(true); rmSync(scratch, { recursive: true, force: true }); }
}, 20_000);
