/**
 * Tests for environment.ts: telling a throwaway session from a lasting one, and
 * a project folder a connection could outlast the session in.
 *
 * Run: bun test capture/environment.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ephemeralProject, insideGitCheckout, sessionEnvironment } from "./environment";

describe("sessionEnvironment", () => {
  test("a local session carries none of the signals", () => {
    expect(sessionEnvironment({})).toEqual({ ephemeral: false, signals: [] });
    // Documented as never true locally; anything else is not the signal.
    expect(sessionEnvironment({ CLAUDE_CODE_REMOTE: "false" }).ephemeral).toBe(false);
    expect(sessionEnvironment({ CODEX_HOME: "/Users/x/.codex" }).ephemeral).toBe(false);
  });

  test("Claude Code cloud sessions, by the documented variable only", () => {
    expect(sessionEnvironment({ CLAUDE_CODE_REMOTE: "true" }))
      .toEqual({ ephemeral: true, kind: "claude-cloud", signals: ["CLAUDE_CODE_REMOTE"] });
    // Not documented as cloud-only, so it must never refuse a local session.
    expect(sessionEnvironment({ CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01JvAst" }).ephemeral).toBe(false);
  });

  test("Codex cloud by its home, labelled a heuristic", () => {
    expect(sessionEnvironment({ CODEX_HOME: "/opt/codex/" }))
      .toEqual({ ephemeral: true, kind: "codex-cloud", signals: ["CODEX_HOME=/opt/codex (heuristic)"] });
  });

  test("AUGENTA_EPHEMERAL declares it either way and wins", () => {
    expect(sessionEnvironment({ AUGENTA_EPHEMERAL: "1" })).toMatchObject({ ephemeral: true, kind: "declared" });
    // A persistent self-hosted runner can say it keeps its disk.
    expect(sessionEnvironment({ AUGENTA_EPHEMERAL: "0", CLAUDE_CODE_REMOTE: "true" }).ephemeral).toBe(false);
    // Declared plus a real signal names the real kind.
    expect(sessionEnvironment({ AUGENTA_EPHEMERAL: "1", CLAUDE_CODE_REMOTE: "true" }).kind).toBe("claude-cloud");
  });
});

describe("a folder a connection could outlast the session in", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "aug-env-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("inside a checkout: a .git directory, or a worktree's .git file, in it or above it", () => {
    expect(insideGitCheckout(dir)).toBe(false);
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    mkdirSync(join(dir, "repo", "src"), { recursive: true });
    expect(insideGitCheckout(join(dir, "repo", "src"))).toBe(true);
    mkdirSync(join(dir, "worktree"));
    writeFileSync(join(dir, "worktree", ".git"), "gitdir: /elsewhere\n");
    expect(insideGitCheckout(join(dir, "worktree"))).toBe(true);
  });

  test("only a throwaway session outside a checkout has a temporary project", () => {
    const cloud = { CLAUDE_CODE_REMOTE: "true" };
    expect(ephemeralProject(dir, cloud)).toBe(true);
    expect(ephemeralProject(dir, {})).toBe(false);
    mkdirSync(join(dir, ".git"));
    // A cloud clone of a repository keeps its committed config: allowed.
    expect(ephemeralProject(dir, cloud)).toBe(false);
  });
});
