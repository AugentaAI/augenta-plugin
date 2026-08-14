/**
 * Executes the SHIPPED artifact: the bundles in dist/, under real `node`.
 *
 * Every other subprocess test in this repo spawns `bun run <source>.ts`, which
 * after the Node port shares zero bytes with what a user actually runs. The
 * contract test's existsSync over hook-command paths proves the bundles are
 * PRESENT; nothing else proved they RUN. That gap shipped a real defect once: a
 * prototype's session-start bundle inlined capture.ts's entrypoint block, ate
 * stdin, and exited 0 without ever emitting the connect prompt — a dead
 * onboarding path with a fully green build.
 *
 * These are packaging assertions, deliberately thin on logic — the behavior
 * itself is covered against the sources in hooks/*.test.ts and capture/*.test.ts.
 * What this file catches is bundling damage: an entrypoint hijack, a Bun global
 * surviving into a Node bundle, an ESM/CJS misparse, a bad shebang, a missing
 * output.
 *
 * Requires a current dist/ — run `bun run build` first. CI builds before testing.
 *
 * Run: bun run build && bun test __tests__/dist-smoke.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "dist");
const CLAUDE_TP = "C:/Users/x/.claude/projects/enc/sess-1.jsonl";
const CODEX_TP = "C:/Users/x/.codex/sessions/2026/06/24/rollout-2026-06-24T00-00-00-abc.jsonl";

let home: string;
let project: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aug-dist-home-"));
  project = mkdtempSync(join(tmpdir(), "aug-dist-proj-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/**
 * Spawn a bundle with the literal string "node" — NOT process.execPath, which
 * under `bun test` is the bun binary and would defeat the entire point of this
 * file.
 */
function run(
  bundle: string,
  args: string[],
  opts: { stdin?: string; env?: Record<string, string>; cwd?: string } = {},
) {
  const proc = Bun.spawnSync(["node", join(DIST, bundle), ...args], {
    stdin: opts.stdin === undefined ? undefined : Buffer.from(opts.stdin),
    env: { ...(process.env as Record<string, string>), AUGENTA_HOME: home, ...(opts.env ?? {}) },
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

const BUNDLES = [
  "hooks/session-start.mjs",
  "hooks/user-prompt.mjs",
  "capture/capture.mjs",
  "capture/ship.mjs",
  "scripts/connect.mjs",
];

describe("the built bundles exist and are what hooks.json points at", () => {
  for (const bundle of BUNDLES) {
    test(`${bundle} is present and declares node`, async () => {
      const path = join(DIST, bundle);
      expect(existsSync(path), `missing bundle — run 'bun run build': ${path}`).toBe(true);
      const first = (await Bun.file(path).text()).split("\n")[0];
      // A bun shebang here would mean the build's rewrite regressed and we are
      // shipping an executable that asks for a runtime the user does not have.
      expect(first).toBe("#!/usr/bin/env node");
    });
  }
});

describe("session-start, run as the user's harness runs it", () => {
  test("Claude Code: emits the connect prompt for an unconnected project", () => {
    const r = run("hooks/session-start.mjs", [], {
      stdin: JSON.stringify({ transcript_path: CLAUDE_TP, cwd: project }),
    });
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    // The regression guard. Before capture.ts's entrypoint was extracted into
    // capture/shipper.ts, bundling inlined its `isMain` block ahead of this
    // hook's own code: the capture body consumed stdin and exited 0, so stdout
    // was EMPTY and the plugin's entire onboarding path was silently dead.
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hookSpecificOutput?.initialUserMessage).toBe("/augenta:connect");
  });

  test("Codex: the same bundle takes the natural-language branch", () => {
    const r = run("hooks/session-start.mjs", [], {
      stdin: JSON.stringify({ transcript_path: CODEX_TP, cwd: project }),
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput?.initialUserMessage).toBe("Connect Augenta");
  });
});

describe("capture, and the consent gate on the real artifact", () => {
  test("no project config → silent no-op, nothing written to disk", () => {
    const transcript = join(project, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
    const r = run("capture/capture.mjs", [], {
      stdin: JSON.stringify({
        session_id: "s",
        transcript_path: transcript,
        cwd: project,
        hook_event_name: "Stop",
      }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    // The privacy invariant, verified against the bytes that ship: capture must
    // not create any project state for a project that never opted in.
    expect(existsSync(join(project, ".augenta"))).toBe(false);
  });

  test("malformed payload still exits 0 and stays silent", () => {
    const r = run("capture/capture.mjs", [], { stdin: "not json" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("user-prompt", () => {
  test("unconnected project: silent, exit 0, no state written", () => {
    const r = run("hooks/user-prompt.mjs", [], {
      stdin: JSON.stringify({ transcript_path: CLAUDE_TP, cwd: project }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(join(project, ".augenta"))).toBe(false);
  });
});

describe("ship", () => {
  test("no argv and no config: exits 0 without shipping anything", () => {
    const r = run("capture/ship.mjs", []);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a project with no config: still a no-op", () => {
    const r = run("capture/ship.mjs", [project]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(project, ".augenta"))).toBe(false);
  });
});

describe("connect", () => {
  // --probe fetches login discovery, so it cannot be exercised offline for a
  // "connected: false" verdict. What IS testable without a network — and what
  // actually breaks when a bundle is malformed — is that the packaged CLI still
  // answers in its own JSON contract instead of dying with a module-load error.
  test("a --json verb answers in JSON, not a stack trace, when the host is unreachable", () => {
    const r = run("scripts/connect.mjs", ["--json", "--probe"], {
      cwd: project,
      env: { AUGENTA_AUTH_HOME: home, AUGENTA_CONTROL_URL: "http://127.0.0.1:9" },
    });
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("error");
    expect(parsed.code).toBe("failed");
    // Node reports every connection failure as the bare string "fetch failed";
    // describeError unwraps error.cause so the shipped runtime says something a
    // user can act on. A bundle that skipped that would fail here.
    expect(parsed.message).toContain("cannot reach Augenta");
    expect(parsed.message).not.toBe("fetch failed");
    // A malformed bundle fails at load, before any of our error handling — the
    // symptom is a non-empty stderr and unparseable stdout.
    expect(r.stderr).toBe("");
    // No credential may ever appear in a --json payload (AGENTS.md).
    expect(r.stdout).not.toMatch(/accessToken|refreshToken|userCode|deviceCode/i);
  });

  test("a bad flag still returns JSON to a --json caller", () => {
    const r = run("scripts/connect.mjs", ["--json", "--nonsense-flag"], { cwd: project });
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("error");
    expect(r.stderr).toBe("");
  });
});
