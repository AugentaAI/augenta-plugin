/**
 * Tests for user-prompt.ts — the UserPromptSubmit turn bump.
 *
 * Contract under test: an opted-in project's turn ordinal advances on every
 * fire; the hook NEVER emits anything (no additionalContext channel left); and
 * it is a silent no-op for projects without `.augenta/config.json`.
 *
 * Run: bun test hooks/user-prompt.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnState } from "../capture/turn-cursor";

const HOOK = join(import.meta.dir, "user-prompt.ts");
const TP = "/tmp/transcripts/sess-1.jsonl";

let project: string;
beforeEach(() => (project = mkdtempSync(join(tmpdir(), "aug-up-"))));
afterEach(() => rmSync(project, { recursive: true, force: true }));

function fire(payload: object): { stdout: string; exitCode: number | null } {
  const proc = Bun.spawnSync(["bun", "run", HOOK], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env: process.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { stdout: proc.stdout.toString(), exitCode: proc.exitCode };
}

function optIn(): void {
  mkdirSync(join(project, ".augenta"), { recursive: true });
  writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ apiKey: "k" }));
}

describe("user-prompt turn bump", () => {
  test("bumps the per-transcript turn ordinal for an opted-in project, emitting nothing", () => {
    optIn();
    const r1 = fire({ transcript_path: TP, cwd: project });
    expect(r1.stdout).toBe("");
    expect(r1.exitCode).toBe(0);
    expect(new TurnState(project).get(TP)).toBe(1);

    fire({ transcript_path: TP, cwd: project });
    expect(new TurnState(project).get(TP)).toBe(2);
  });

  test("no project config → silent no-op (no .augenta dir created)", () => {
    const r = fire({ transcript_path: TP, cwd: project });
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
