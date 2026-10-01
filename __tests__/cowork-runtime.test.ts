import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

test("shipped Node Cowork commands bind, deliver a turn once, and refuse native duplication", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "aug-cowork-node-")));
  const project = join(home, "project"); mkdirSync(join(project, ".augenta"), { recursive: true });
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (/^(AUGENTA_|HTTPS?_PROXY$|https?_proxy$|NO_PROXY$|no_proxy$|NODE_USE_ENV_PROXY$|CLAUDE_CODE_REMOTE|CODEX_HOME)/.test(key)) delete env[key];
  }
  Object.assign(env, { HOME: home, AUGENTA_AUTH_HOME: join(home, "auth"), NODE_NO_WARNINGS: "1" });
  const uploads: any[] = [];
  let accepted!: () => void;
  const delivered = new Promise<void>(done => { accepted = done; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url === "/v1/connectors") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ connectors: [{ id: "connector_test", orgId: "org_test", workspaceId: "workspace_test", status: "active", direction: "inbound" }] }));
    } else if (request.url === "/v1/experiences") {
      expect(request.headers.authorization).toBe("AugentaKey fixture-cowork-secret");
      expect(request.headers["x-augenta-connector-id"]).toBeUndefined();
      uploads.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(202); response.end("{}"); accepted();
    } else { response.writeHead(202); response.end("{}"); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const gateway = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(join(project, ".augenta/config.json"), JSON.stringify({ authMode: "api-key", apiKey: "fixture-cowork-secret", endpoint: gateway,
    destinations: [{ connectorId: "connector_test", workspaceId: "workspace_test" }] }));
  async function run(bundle: string, args: string[], input?: unknown) {
    const proc = Bun.spawn(["node", join(root, "dist", bundle), ...args], { env, stdout: "pipe", stderr: "pipe", stdin: input ? Buffer.from(JSON.stringify(input)) : "ignore" });
    const timeout = setTimeout(() => proc.kill(), 10_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(stderr).toBe(""); expect(stdout).not.toContain("fixture-cowork-secret");
      return { stdout, exitCode };
    } finally { clearTimeout(timeout); }
  }
  try {
    const binding = await run("scripts/connect.mjs", ["--json", "--harness", "codex", "--project", project, "--cowork-task", "node-session", "--cowork-transport", "otlp"]);
    expect(binding.exitCode).toBe(0); expect(JSON.parse(binding.stdout)).toMatchObject({ status: "bound", transport: "otlp" });
    const timestamp = new Date(Date.now() + 1000).toISOString();
    const log = (name: string, sequence: number, content: Record<string, string>) => ({ body: { stringValue: `claude_code.${name}` },
      attributes: Object.entries({ "session.id": "node-session", "prompt.id": "node-prompt", "event.timestamp": timestamp, "event.sequence": sequence, ...content })
        .map(([key, value]) => ({ key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } })) });
    const payload = { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "cowork" } }] }, scopeLogs: [{ logRecords: [
      log("assistant_response", 2, { response: "synthetic response" }), log("user_prompt", 1, { prompt: "synthetic prompt" }),
    ] }] }] };
    const first = await run("capture/capture.mjs", ["--cowork-otlp", "--project", project], payload);
    expect(first.exitCode).toBe(0); expect(JSON.parse(first.stdout)).toMatchObject({ status: "queued", queued: 2 });
    await delivered;
    expect(uploads).toMatchObject([{ experiences: [{ src: "claude-code", sid: "node-session", proj: project, type: "trajectory", events: [
      { seq: 1, turn: 2, text: "synthetic prompt" }, { seq: 2, turn: 2, text: "synthetic response" },
    ], data: expect.any(Array) }] }]);
    const retry = await run("capture/capture.mjs", ["--cowork-otlp", "--project", project], payload);
    expect(JSON.parse(retry.stdout)).toMatchObject({ queued: 0, duplicates: 2 });
    const native = await run("capture/capture.mjs", ["--cowork-native", "--project", project], { session_id: "node-session", transcript_path: "/unused", hook_event_name: "Stop" });
    expect(native.exitCode).toBe(1); expect(JSON.parse(native.stdout)).toMatchObject({ code: "task_not_bound" });
    expect(uploads.length).toBe(1);
  } finally { server.closeAllConnections(); server.close(); rmSync(home, { recursive: true, force: true }); }
}, 20_000);

test("the built receiver refuses a missing private collector credential safely", () => {
  const home = mkdtempSync(join(tmpdir(), "aug-cowork-listener-"));
  try {
    const proc = Bun.spawnSync(["node", join(root, "dist/capture/capture.mjs"), "--cowork-listen", "0", "--project", home], {
      env: { ...process.env, AUGENTA_COWORK_COLLECTOR_TOKEN: "", AUGENTA_AUTH_HOME: join(home, "auth") }, stdout: "pipe", stderr: "pipe",
    });
    expect(proc.exitCode).toBe(1); expect(proc.stderr.toString()).toBe("");
    expect(JSON.parse(proc.stdout.toString())).toMatchObject({ code: "collector_auth_required" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
