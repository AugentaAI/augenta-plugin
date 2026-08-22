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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync, chmodSync } from "node:fs";
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

  test("creates the dir 0700", () => {
    ensureAugentaDir(project);
    expect(statSync(join(project, ".augenta")).mode & 0o777).toBe(0o700);
  });

  /* The case the autonomous path makes ordinary. `mkdirSync`'s `mode` applies at
     creation, so a directory the user made keeps their umask — 0755 by default —
     and every local user can then traverse it to read config.json and the raw
     trajectory buffers. Since writing that config by hand is now the DOCUMENTED
     way to configure a service, the plugin is usually not the creator. */
  test("narrows a pre-existing world-readable dir to 0700", () => {
    const dir = join(project, ".augenta");
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755); // defeat the creating umask, so the premise is real
    expect(statSync(dir).mode & 0o777).toBe(0o755);

    ensureAugentaDir(project);

    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("a key already sitting in a loose dir is protected by the same call", () => {
    const dir = join(project, ".augenta");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, "config.json"), '{"authMode":"api-key","apiKey":"sk-aug-x.y"}');

    ensureAugentaDir(project);

    // 0700 on the DIRECTORY is the load-bearing protection: reading the config
    // needs search permission on the directory, so this closes the hole whatever
    // mode the hand-written file itself has.
    expect(statSync(dir).mode & 0o777).toBe(0o700);
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
