/**
 * Tests for user-prompt.ts — the UserPromptSubmit hook, run as the harness runs
 * it: a subprocess fed a JSON payload on stdin.
 *
 * Contract under test: an opted-in project's turn ordinal advances on every
 * fire; the ONLY thing the hook ever writes is an automatic-recall block, as
 * exactly `hookSpecificOutput.{hookEventName, additionalContext}` (Codex rejects
 * any other key); anything short of an answer — no prompt, nothing remembered,
 * an unreachable gateway — is silence with exit 0 inside the budget; and it is
 * a silent no-op for projects without `.augenta/config.json`. The recall rules
 * themselves are covered in auto-recall.test.ts.
 *
 * Run: bun test hooks/user-prompt.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnState } from "../capture/turn-cursor";
import { AUTO_RECALL_SENTINEL } from "../capture/auto-recall-marker";

const HOOK = join(import.meta.dir, "user-prompt.ts");
const TP = "/tmp/transcripts/sess-1.jsonl";
const CODEX_TP = "/u/.codex/sessions/2026/09/23/rollout-2026-09-23T00-00-00-abc.jsonl";
/** A closed port: nothing in this file may reach a real gateway. */
const NOWHERE = "http://127.0.0.1:9";

let project: string;
beforeEach(() => (project = realpathSync(mkdtempSync(join(tmpdir(), "aug-up-")))));
afterEach(() => rmSync(project, { recursive: true, force: true }));

function hookEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), AUGENTA_API_URL: NOWHERE, ...extra };
  delete env.AUGENTA_CAPTURE_ENABLED;
  delete env.AUGENTA_AUTO_RECALL;
  return env;
}

function fire(payload: object, env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(["bun", "run", HOOK], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env: hookEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode };
}

/** Async, because a gateway served from THIS process cannot answer while a
 *  synchronous spawn blocks its event loop. */
async function fireAsync(payload: object, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env: hookEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function optIn(): void {
  mkdirSync(join(project, ".augenta"), { recursive: true });
  writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
}

describe("user-prompt turn bump", () => {
  test("bumps the per-transcript turn ordinal for an opted-in project, emitting nothing without a prompt", () => {
    optIn();
    const r1 = fire({ transcript_path: TP, cwd: project });
    expect(r1.stdout).toBe("");
    expect(r1.exitCode).toBe(0);
    expect(new TurnState(project).get(TP)).toBe(1);

    fire({ transcript_path: TP, cwd: project });
    expect(new TurnState(project).get(TP)).toBe(2);
  });

  test("no project config → silent no-op (no .augenta dir created)", () => {
    const r = fire({ transcript_path: TP, cwd: project, prompt: "what did we decide about sign-in" });
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(project, ".augenta"))).toBe(false);
  });

  test("missing transcript path → silent no-op", () => {
    optIn();
    const r = fire({ cwd: project });
    expect(r.stdout).toBe("");
    expect(new TurnState(project).get(TP)).toBe(0);
  });
});

describe("user-prompt automatic recall", () => {
  let server: ReturnType<typeof Bun.serve>;
  let seen: Array<{ path: string; mode: string | null; body: unknown }>;
  let respond: () => Response;

  beforeEach(() => {
    seen = [];
    respond = () => Response.json({ mode: "context", content: [{ type: "engram", text: "we chose device sign-in" }] });
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, mode: url.searchParams.get("mode"), body: await req.json().catch(() => undefined) });
        return url.pathname === "/v1/recall" ? respond() : new Response("unexpected", { status: 500 });
      },
    });
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({
      authMode: "api-key", apiKey: "platform-test-key", endpoint: `http://127.0.0.1:${server.port}`,
    }));
  });
  afterEach(() => server.stop(true));

  // The project's own endpoint must win, so AUGENTA_API_URL is cleared for these.
  const env = () => ({ AUGENTA_API_URL: "" });

  for (const [harness, transcript] of [["Claude Code", TP], ["Codex", CODEX_TP]] as const) {
    test(`${harness}: an answer is emitted as exactly the two keys both harnesses accept`, async () => {
      const r = await fireAsync({ transcript_path: transcript, cwd: project, prompt: "what did we decide about sign-in" }, env());
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
      const out = JSON.parse(r.stdout);
      expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
      expect(Object.keys(out.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
      expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
      expect(out.hookSpecificOutput.additionalContext).toStartWith(AUTO_RECALL_SENTINEL);
      expect(out.hookSpecificOutput.additionalContext).toContain("we chose device sign-in");
      expect(r.stdout).not.toContain("platform-test-key");
      expect(seen).toEqual([{ path: "/v1/recall", mode: "context", body: { query: "what did we decide about sign-in" } }]);
      expect(new TurnState(project).get(transcript)).toBe(1);
    });
  }

  test("nothing remembered is silence", async () => {
    respond = () => Response.json({ error: { code: "empty_scope", message: "young", retryable: false } }, { status: 404 });
    const r = await fireAsync({ transcript_path: TP, cwd: project, prompt: "what did we decide about sign-in" }, env());
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
  });

  test("a trivial reply is not asked about", async () => {
    const r = await fireAsync({ transcript_path: TP, cwd: project, prompt: "yes" }, env());
    expect(r.stdout).toBe("");
    expect(seen).toEqual([]);
  });
});

test("an unreachable gateway is silent, exits 0, and stays inside the budget", () => {
  mkdirSync(join(project, ".augenta"), { recursive: true });
  writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
  const startedAt = Date.now();
  const r = fire({ transcript_path: TP, cwd: project, prompt: "what did we decide about sign-in" });
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("");
  expect(r.exitCode).toBe(0);
  expect(Date.now() - startedAt).toBeLessThan(7_000);
  expect(new TurnState(project).get(TP)).toBe(1);
});
