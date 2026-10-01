import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveDeviceProfile } from "./auth";
import { writeOAuthProject } from "../__tests__/fixtures";
import { bindCoworkTask, coworkBindingsPath, nativeCoworkAllowed } from "./cowork-task";
import { ingestCoworkOtlp } from "./cowork-otlp";
import { runCapture } from "./capture";
import { TurnState } from "./turn-cursor";
import { groupIntoExperiences, drainAll } from "./ship";
import { startCoworkReceiver } from "./cowork-command";
import { parseArgs, resolveProject, runJsonVerb } from "../scripts/connect";
import { AUTO_RECALL_SENTINEL } from "./auto-recall-marker";

const GATEWAY = "https://cowork-gateway.example.com";
const realFetch = globalThis.fetch;
const sandbox = ["AUGENTA_AUTH_HOME", "AUGENTA_API_URL", "AUGENTA_INGEST_URL", "AUGENTA_CAPTURE_ENABLED", "AUGENTA_EPHEMERAL", "AUGENTA_COWORK_NATIVE", "CLAUDE_CODE_REMOTE"];
let env: Record<string, string | undefined>;
let project: string;
let authHome: string;
let profileId: string;
let start: number;
let requests: { url: string; connector: string | null; body?: any }[];
let deny: boolean;
let failingDestination: string | undefined;
let connectorPatch: Record<string, unknown>;
const destinations = [
  { connectorId: "connector_a", workspaceId: "workspace_a", workspaceName: "A" },
  { connectorId: "connector_b", workspaceId: "workspace_b", workspaceName: "B" },
];

function configure(root = project, joined = true) {
  if (!joined) rmSync(join(root, ".augenta/state/links.json"), { force: true });
  writeOAuthProject(root, { profileId, destinations, joined, joinedAt: new Date(start - 1000).toISOString(), extra: { endpoint: GATEWAY } });
}
beforeEach(async () => {
  env = Object.fromEntries(sandbox.map(key => [key, process.env[key]]));
  for (const key of sandbox) delete process.env[key];
  authHome = realpathSync(mkdtempSync(join(tmpdir(), "aug-cowork-auth-")));
  project = realpathSync(mkdtempSync(join(tmpdir(), "aug-cowork-project-")));
  process.env.AUGENTA_AUTH_HOME = authHome;
  start = Date.now(); requests = []; deny = false; failingDestination = undefined; connectorPatch = {};
  ({ profileId } = await saveDeviceProfile({ issuer: "https://issuer.example.com", clientId: "client_public", gateway: GATEWAY },
    { accessToken: "access-test", refreshToken: "refresh-test", expiresAt: start + 3600_000 }, { userId: "user_1", orgId: "org_1" }));
  configure();
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const connector = new Headers(init.headers).get("x-augenta-connector-id");
    requests.push({ url: String(url), connector, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/v1/connectors/")) {
      if (deny) return new Response("not available", { status: 403 });
      const id = path.slice("/v1/connectors/".length);
      const destination = destinations.find(d => d.connectorId === id)!;
      return Response.json({ connector: { id, ownerUserId: "user_1", workspaceId: destination.workspaceId, direction: "inbound", status: "active", ...connectorPatch } });
    }
    if (path === "/v1/experiences") return new Response("", { status: connector === failingDestination ? 503 : 202 });
    throw new Error("unexpected route");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of sandbox) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  rmSync(project, { recursive: true, force: true }); rmSync(authHome, { recursive: true, force: true });
});

function log(name: string, sequence: number, promptId = "prompt-1", extra: Record<string, unknown> = {}, sessionId = "session-1") {
  const fields = { "session.id": sessionId, "prompt.id": promptId, "event.sequence": sequence,
    "event.timestamp": new Date(start + 1000 + sequence).toISOString(), ...extra };
  return { body: { stringValue: `claude_code.${name}` }, attributes: Object.entries(fields).map(([key, value]) => ({ key,
    value: typeof value === "number" ? { intValue: String(value) } : { stringValue: String(value) } })) };
}
function batch(...records: any[]) {
  return { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "cowork" } }] }, scopeLogs: [{ logRecords: records }] }] };
}
async function bind(transport: "otlp" | "native" = "otlp", session = "session-1", transcriptPath?: string) {
  return bindCoworkTask(project, session, transport, { now: new Date(start).toISOString(), transcriptPath });
}
function records(): any[] {
  const file = join(project, ".augenta/outbox/spool.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x)) : [];
}

describe("explicit Cowork task binding", () => {
  test("binding output is safe and the project must be explicit", async () => {
    const resolved = resolveProject({ project }, project);
    expect(await runJsonVerb(resolved, parseArgs(["--json", "--cowork-task", "session-1", "--cowork-transport", "otlp"])))
      .toMatchObject({ code: "project_required" });
    const args = ["--json", "--project", project, "--cowork-task", "session-1", "--cowork-transport", "otlp"];
    expect(await runJsonVerb(resolved, parseArgs([...args, "--login"]))).toMatchObject({ code: "conflicting_verbs" });
    const output = await runJsonVerb(resolved, parseArgs(args));
    expect(output).toMatchObject({ status: "bound", sessionId: "session-1", transport: "otlp" });
    expect(JSON.stringify(output)).not.toMatch(/access-test|refresh-test|accessToken|refreshToken|apiKey|connection/);
  });
  test("requires this checkout's join and rejects inaccessible Connectors", async () => {
    configure(project, false);
    await expect(bind()).rejects.toMatchObject({ code: "not_joined" });
    expect(requests).toEqual([]);
    configure(); deny = true;
    await expect(bind()).rejects.toMatchObject({ code: "connector_unavailable" });
    expect(existsSync(coworkBindingsPath(project))).toBe(false);
  });
  test("a task cannot switch transports or bind a second project", async () => {
    await bind();
    const transcript = join(project, "native.jsonl"); writeFileSync(transcript, "");
    await expect(bind("native", "session-1", transcript)).rejects.toMatchObject({ code: "task_already_bound" });
    const other = realpathSync(mkdtempSync(join(tmpdir(), "aug-cowork-other-")));
    try {
      configure(other);
      await expect(bindCoworkTask(other, "session-1", "otlp")).rejects.toMatchObject({ code: "task_already_bound" });
      expect(nativeCoworkAllowed(other, "session-1", transcript)).toBe(false);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
  test("native capture starts at binding and reuses normalizer, turns and outbox", async () => {
    const transcript = join(project, "native.jsonl");
    const line = (type: string, content: string) => JSON.stringify({ type, sessionId: "session-1", timestamp: new Date(start + 1000).toISOString(), message: { role: type, content } }) + "\n";
    writeFileSync(transcript, line("user", "before binding"));
    await bind("native", "session-1", transcript);
    new TurnState(project).bump(transcript);
    appendFileSync(transcript, line("user", "native prompt") + line("assistant", "native response"));
    const payload = { cwd: project, session_id: "session-1", transcript_path: transcript, hook_event_name: "Stop" };
    expect(runCapture(payload, { spawnShipper: false }).appended).toBe(2);
    expect(runCapture(payload, { spawnShipper: false }).appended).toBe(0);
    const experiences = groupIntoExperiences(records());
    expect(experiences).toMatchObject([{ type: "trajectory", events: [{ turn: 1, text: "native prompt" }, { turn: 1, text: "native response" }] }]);
    expect(JSON.stringify(experiences)).not.toContain("before binding");
    expect(nativeCoworkAllowed(project, "session-1", join(project, "wrong.jsonl"), true)).toBe(false);
  });
  test("an OTLP binding suppresses the native capture hook for the same task", async () => {
    await bind();
    const transcript = join(project, "native.jsonl"); writeFileSync(transcript, "{}\n");
    expect(runCapture({ cwd: project, session_id: "session-1", transcript_path: transcript, hook_event_name: "Stop" }, { spawnShipper: false }))
      .toEqual({ appended: 0, flushed: false });
    expect(records()).toEqual([]);
  });
  test("the explicit native runtime requires binding while ordinary local sessions retain their gate", () => {
    expect(nativeCoworkAllowed(project, "ordinary-session", "/unused")).toBe(true);
    process.env.AUGENTA_COWORK_NATIVE = "1";
    expect(nativeCoworkAllowed(project, "unbound-task", "/unused")).toBe(false);
    expect(nativeCoworkAllowed(project)).toBe(false);
  });
});

describe("Cowork OTLP agent turns", () => {
  test.each([{ ownerUserId: "someone_else" }, { workspaceId: "another_workspace" }, { status: "disabled" }])("rejects an invalid live Connector: %j", async patch => {
    await bind(); connectorPatch = patch;
    await expect(ingestCoworkOtlp([project], batch(log("user_prompt", 1, "prompt-1", { prompt: "private" }))))
      .rejects.toMatchObject({ code: "connector_unavailable" });
    expect(records()).toEqual([]);
  });
  test("automatic recall context is not echoed into any Workspace", async () => {
    await bind();
    const result = await ingestCoworkOtlp([project], batch(
      log("user_prompt", 1, "prompt-1", { prompt: `what is ${AUTO_RECALL_SENTINEL}` }),
      log("assistant_response", 2, "prompt-1", { response: `${AUTO_RECALL_SENTINEL} stored context` })));
    expect(result).toMatchObject({ queued: 1, ignored: 1 });
    expect(JSON.stringify(records())).not.toContain("stored context");
  });
  test("orders, correlates prompts, responses, tools and usage in the existing envelope", async () => {
    await bind();
    const result = await ingestCoworkOtlp([project], batch(
      log("assistant_response", 14, "prompt-1", { response: "done", model: "test-model" }),
      log("user_prompt", 11, "prompt-1", { prompt: "first turn", "workspace.host_paths": "/unrelated/path", "organization.id": "untrusted-org" }),
      log("tool_result", 12, "prompt-1", { tool_name: "Bash", success: "true", tool_input: "echo ok" }),
      log("api_request", 13, "prompt-1", { input_tokens: 10, output_tokens: 20 }),
      log("user_prompt", 21, "prompt-2", { prompt: "second turn" }),
      log("assistant_response", 22, "prompt-2", { response: "second response" })));
    expect(result.queued).toBe(6);
    const experiences = groupIntoExperiences(records());
    expect(experiences.length).toBe(2);
    expect((experiences[0] as any).events.map((x: any) => [x.seq, x.turn])).toEqual([[11, 12], [12, 12], [13, 12], [14, 12]]);
    expect((experiences[1] as any).events.map((x: any) => x.turn)).toEqual([22, 22]);
    expect(experiences[0]).toMatchObject({ src: "claude-code", sid: "session-1", proj: project, type: "trajectory", data: expect.any(Array) });
    expect((experiences[0] as any).events[1].text).toContain("complete tool-result content is not present");
  });
  test("duplicates are ignored; late events wait durably for their prompt", async () => {
    await bind();
    const response = batch(log("assistant_response", 3, "prompt-1", { response: "late delivery" }));
    expect((await ingestCoworkOtlp([project], response)).queued).toBe(0);
    expect((await ingestCoworkOtlp([project], response)).duplicates).toBe(1);
    const prompt = batch(log("user_prompt", 1, "prompt-1", { prompt: "question" }));
    expect((await ingestCoworkOtlp([project], prompt)).queued).toBe(2);
    expect((await ingestCoworkOtlp([project], prompt)).duplicates).toBe(1);
    expect(groupIntoExperiences(records())).toMatchObject([{ events: [{ seq: 1 }, { seq: 3 }] }]);
    await expect(ingestCoworkOtlp([project], batch(log("assistant_response", 3, "prompt-1", { response: "changed" })))).rejects.toMatchObject({ code: "sequence_conflict" });
    expect(records().length).toBe(4);
  });
  test("unbound, disabled, unjoined and changed connections forward no content", async () => {
    const payload = batch(log("user_prompt", 1, "prompt-1", { prompt: "private" }));
    expect((await ingestCoworkOtlp([project], payload)).ignored).toBe(1);
    expect(requests).toEqual([]);
    await bind(); requests = [];
    process.env.AUGENTA_CAPTURE_ENABLED = "0";
    expect((await ingestCoworkOtlp([project], payload)).queued).toBe(0);
    delete process.env.AUGENTA_CAPTURE_ENABLED;
    configure(project, false);
    expect((await ingestCoworkOtlp([project], payload)).queued).toBe(0);
    configure();
    writeOAuthProject(project, { profileId, destinations: [destinations[0]!], extra: { endpoint: GATEWAY } });
    expect((await ingestCoworkOtlp([project], payload)).queued).toBe(0);
    expect(requests).toEqual([]); expect(records()).toEqual([]);
  });
  test("metadata-only and pre-binding turns are not captured", async () => {
    await bind();
    await ingestCoworkOtlp([project], batch(log("user_prompt", 1), log("assistant_response", 2, "prompt-1", { response: "<REDACTED>" })));
    const old = log("user_prompt", 3, "prompt-old", { prompt: "old turn", "event.timestamp": new Date(start - 1).toISOString() });
    await ingestCoworkOtlp([project], batch(old, log("assistant_response", 4, "prompt-old", { response: "old" })));
    expect(records()).toEqual([]);
  });
  test("an inaccessible Connector prevents queueing, and retries preserve fan-out", async () => {
    await bind(); deny = true;
    const payload = batch(log("user_prompt", 1, "prompt-1", { prompt: "fan out" }), log("assistant_response", 2, "prompt-1", { response: "complete" }));
    await expect(ingestCoworkOtlp([project], payload)).rejects.toMatchObject({ code: "connector_unavailable" });
    expect(records()).toEqual([]);
    deny = false; await ingestCoworkOtlp([project], payload);
    requests = []; failingDestination = "connector_b";
    const options = { projectRoot: project, url: `${GATEWAY}/v1/experiences`, authMode: "oauth" as const, connectorIds: destinations.map(x => x.connectorId), token: async () => "access-test" };
    await drainAll(options);
    failingDestination = undefined;
    await drainAll(options);
    const uploads = requests.filter(x => x.body);
    expect(uploads.map(x => x.connector)).toEqual(["connector_a", "connector_b", "connector_b"]);
    expect(uploads[0]!.body).toEqual(uploads[1]!.body);
    expect(uploads[1]!.body).toEqual(uploads[2]!.body);
    expect(uploads[0]!.body.experiences).toMatchObject([{ type: "trajectory", events: [{ turn: 2 }, { turn: 2 }] }]);
  });
  test("the localhost receiver authenticates before reading source content", async () => {
    const secret = "fixture-collector-secret-at-least-32-characters";
    const receiver = await startCoworkReceiver([project], 0, secret);
    const url = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/v1/logs`;
    try {
      const denied = await realFetch(url, { method: "POST", body: "private invalid content" });
      expect(denied.status).toBe(401);
      const accepted = await realFetch(url, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(batch(log("user_prompt", 1, "prompt-1", { prompt: "unbound private content" }))) });
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).not.toContain("unbound private content");
      expect(requests).toEqual([]); expect(records()).toEqual([]);
    } finally { receiver.closeAllConnections(); receiver.close(); }
  });
});
