/** Real Codex host dispatch against an installed plugin, using only local fixtures.
 * Run: bun scripts/codex-lifecycle-e2e.ts /absolute/path/to/codex
 * This is NOT desktop approval/activation or hosted-ingestion acceptance.
 * The invocation-only trust flag applies only to the repository's vetted hooks
 * in a disposable home; no user's trust records or installed cache are changed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import type { Experience } from "../capture/event";
import { execFileSync } from "node:child_process";

const cli = process.argv[2];
if (!cli) throw new Error("Usage: bun scripts/codex-lifecycle-e2e.ts /absolute/path/to/codex [--worktree]");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "augenta-host-lifecycle-")));
const home = join(root, "home");
const main = join(root, "main");
const worktreeMode = process.argv.includes("--worktree");
const project = join(root, "project");
mkdirSync(home); mkdirSync(main);
if (worktreeMode) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  git("worktree", "add", "--detach", project);
  // Main's consent must not cause an unconnected external worktree to capture.
  mkdirSync(join(main, ".augenta"));
  writeFileSync(join(main, ".augenta/config.json"), JSON.stringify({ authMode: "api-key", apiKey: "main-fixture" }));
} else mkdirSync(project);
const received: Experience[] = [];
let modelCalls = 0;
let offline = false;
let toolNext = false;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/v1/connectors") return Response.json({ connectors: [{ id: "fixture-connector", orgId: "fixture-org",
    workspaceId: "fixture-workspace", kind: "agent", status: "active", direction: "inbound" }] });
  if (path === "/v1/experiences") {
    if (offline) return new Response("retry", { status: 503 });
    received.push(...(await req.json() as { experiences: Experience[] }).experiences);
    return Response.json({ accepted: true });
  }
  if (!path.endsWith("/responses")) return Response.json({}); // local OTel sink
  modelCalls++;
  const message = { id: `msg_${modelCalls}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: `lifecycle final ${modelCalls}`, annotations: [] }] };
  const item = toolNext ? { id: `fc_${modelCalls}`, type: "function_call", name: "exec_command",
    call_id: `call_${modelCalls}`, arguments: JSON.stringify({ cmd: "printf lifecycle-tool" }) } : message;
  toolNext = false;
  const response = { id: `resp_${modelCalls}`, object: "response", status: "completed", output: [item],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } });
} });
const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home,
  AUGENTA_HOME: join(home, ".augenta"), AUGENTA_API_URL: server.url.origin };
const flags = ["-c", 'model_provider="fixture"', "-c", 'model="fixture-model"', "-c",
  `model_providers.fixture={name="Fixture",base_url="${server.url.origin}/v1",wire_api="responses",requires_openai_auth=false}`];
async function run(args: string[], binary = cli!) {
  const child = Bun.spawn([binary, ...args], { env, cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(status, 0, `${args[0]} failed: ${err.slice(-1500)}`);
    return out;
  } finally { clearTimeout(timer); }
}
async function turn(thread?: string, trust = true) {
  const out = await run(["exec", ...(thread ? ["resume"] : []),
    ...(trust ? ["--dangerously-bypass-hook-trust"] : []), "--skip-git-repo-check", "--json", ...flags,
    ...(thread ? [thread] : []), "Complete this fixture turn."]);
  const events = out.split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert(events.some(e => e.type === "turn.completed"), "host did not complete the turn");
  return events.find(e => e.type === "thread.started").thread_id as string;
}
const allSteps = () => received.flatMap(e => e.type === "trajectory" ? e.events : []);
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(50);
  assert(predicate(), "automatic hook/shipper activity timed out");
}
try {
  const version = (await run(["--version"])).trim();
  await run(["plugin", "marketplace", "add", repo]);
  const installed = JSON.parse(await run(["plugin", "add", "augenta@augenta", "--json"]));
  const connectBundle = join(installed.installedPath, "dist/scripts/connect.mjs");
  // Connecting during an existing task must exclude its unconsented history.
  const historical = await turn();
  const historicalFinal = `lifecycle final ${modelCalls}`;
  assert(!existsSync(join(project, ".augenta/state/capture.json")));
  // Run the installed connection entrypoint from the actual cwd, with no
  // --project override to hide a worktree-resolution regression. The key is a
  // disposable synthetic fixture; no real credential is involved.
  await run([connectBundle, "--api-key", "fixture-only", "--endpoint", server.url.origin], "node");
  assert(existsSync(join(project, ".augenta/config.json")));
  if (worktreeMode) assert(!existsSync(join(main, ".augenta/state/capture.json")));
  toolNext = true;
  await turn(historical);
  const first = `lifecycle final ${modelCalls}`;
  await until(() => allSteps().some(e => e.text === first));
  await turn(historical);
  const second = `lifecycle final ${modelCalls}`;
  await until(() => allSteps().some(e => e.text === second));
  const finals = [first, second].map(text => allSteps().find(e => e.text === text)!);
  assert.notEqual(finals[0]!.turn, finals[1]!.turn);
  assert(finals.every(e => e.turn_source === "native"));
  assert(allSteps().some(e => e.kind === "tool"));
  assert(!JSON.stringify(received).includes(historicalFinal));
  // Fresh task, already connected. No prompt-to-capture manual calls anywhere.
  await turn();
  const fresh = `lifecycle final ${modelCalls}`;
  await until(() => allSteps().some(e => e.text === fresh));
  // Offline record stays durable and is retried by the next real lifecycle.
  offline = true;
  await turn(historical);
  const queued = `lifecycle final ${modelCalls}`;
  await until(() => existsSync(join(project, ".augenta/state/health-delivery.json")) &&
    JSON.parse(readFileSync(join(project, ".augenta/state/health-delivery.json"), "utf8")).outcome === "retry");
  assert(!allSteps().some(e => e.text === queued));
  offline = false;
  await turn(historical);
  const last = `lifecycle final ${modelCalls}`;
  await until(() => allSteps().some(e => e.text === queued) && allSteps().some(e => e.text === last));
  // A fresh disabled task cannot advance capture or ship its content.
  env.AUGENTA_CAPTURE_ENABLED = "0";
  const cursor = readFileSync(join(project, ".augenta/state/capture.json"), "utf8");
  await turn();
  assert.equal(readFileSync(join(project, ".augenta/state/capture.json"), "utf8"), cursor);
  assert(!allSteps().some(e => e.text === `lifecycle final ${modelCalls}`));
  // Retry does not duplicate accepted step identities in the fixture receiver.
  const identities = allSteps().map(e => `${e.sid}:${e.seq}`);
  assert.equal(new Set(identities).size, identities.length);
  const health = JSON.parse(await run([connectBundle, "--json", "--health"], "node"));
  assert.equal(health.projectRoot, project);
  assert.equal(health.enabled, false);
  assert(health.delivery.successes > 0);
  console.log(JSON.stringify({ version, marketplaceInstalled: true, realHostDispatch: true, worktree: worktreeMode,
    freshTask: "pass", midTaskConnection: "pass", twoTurnsWithFinals: "pass", offlineRetry: "pass",
    disabled: "pass", duplicateSteps: 0, desktopApproval: "not tested", hostedIngestion: "not tested" }, null, 2));
} finally {
  // Let already-detached shippers finish against the local sink before removing fixtures.
  await Bun.sleep(1200);
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
