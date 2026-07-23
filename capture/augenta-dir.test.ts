/**
 * Tests for augenta-dir.ts — the `.augenta/` self-gitignore invariant.
 *
 * Contract under test: the directory can never exist without a `.gitignore`
 * containing `*` inside it, no matter which writer creates it first — and a
 * user-authored `.gitignore` is never overwritten.
 *
 * Run: bun test capture/augenta-dir.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAugentaDir } from "./augenta-dir";
import { Outbox } from "./outbox";
import { CaptureState } from "./capture-cursor";
import { TurnState } from "./turn-cursor";

let project: string;
beforeEach(() => (project = mkdtempSync(join(tmpdir(), "aug-dir-"))));
afterEach(() => rmSync(project, { recursive: true, force: true }));

const gitignore = () => join(project, ".augenta", ".gitignore");

describe("ensureAugentaDir", () => {
  test("creates the dir with a self-ignoring .gitignore", () => {
    const dir = ensureAugentaDir(project);
    expect(dir).toBe(join(project, ".augenta"));
    expect(readFileSync(gitignore(), "utf8")).toBe("*\n");
  });

  test("is idempotent and never overwrites a user-authored .gitignore", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(gitignore(), "# mine\nconfig.json\n");
    ensureAugentaDir(project);
    expect(readFileSync(gitignore(), "utf8")).toBe("# mine\nconfig.json\n");
  });
});

describe("every .augenta writer leaves the self-gitignore", () => {
  test("Outbox.append", () => {
    new Outbox(project).append([
      { src: "claude-code", sid: "s", proj: "/p", ts: "t", seq: 0, kind: "msg", role: "user", text: "x" },
    ]);
    expect(existsSync(gitignore())).toBe(true);
  });

  test("CaptureState.set", () => {
    new CaptureState(project).set("/t.jsonl", { offset: 1, seq: 1 });
    expect(existsSync(gitignore())).toBe(true);
  });

  test("TurnState.bump", () => {
    new TurnState(project).bump("/t.jsonl");
    expect(existsSync(gitignore())).toBe(true);
  });
});
