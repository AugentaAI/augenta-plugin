/**
 * Tests for session-start.ts — the SessionStart init prompt, memory scan, and
 * stranded-outbox drain.
 *
 * Contract under test: an uninitialized project fires the init prompt exactly
 * once per project (`initialUserMessage` = /augenta:init on Claude Code, a
 * natural-language ask on Codex — which shows additionalContext to the user,
 * so it must carry no agent-only scaffolding there); an initialized project is
 * silent; a previously-prompted project is silent.
 *
 * Run as a subprocess with an isolated AUGENTA_HOME (the prompted-marker map)
 * and a temp project as cwd.
 *
 * Run: bun test hooks/session-start.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDocumentRecord, Outbox } from "../capture/outbox";
import type { CaptureEvent } from "../capture/event";

const HOOK = join(import.meta.dir, "session-start.ts");
const CODEX_TP = "C:/Users/x/.codex/sessions/2026/06/24/rollout-2026-06-24T00-00-00-abc.jsonl";
const CLAUDE_TP = "C:/Users/x/.claude/projects/enc/sess-1.jsonl";

let home: string;
let project: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aug-ss-home-"));
  project = mkdtempSync(join(tmpdir(), "aug-ss-proj-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function fire(payload: object, overrides: Record<string, string> = {}): string {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), AUGENTA_HOME: home, ...overrides };
  const proc = Bun.spawnSync(["bun", "run", HOOK], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.stdout.toString();
}

describe("uninitialized project — the init prompt, harness-aware", () => {
  test("Claude Code: fires /augenta:init with agent-directed context", () => {
    const out = fire({ transcript_path: CLAUDE_TP, cwd: project });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput?.initialUserMessage).toBe("/augenta:init");
    expect(out).toContain("never be pasted");
  });

  test("Codex: natural-language ask, no slash command, no agent-only scaffolding", () => {
    const out = fire({ transcript_path: CODEX_TP, cwd: project });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput?.initialUserMessage).toBe("Initialize Augenta");
    expect(out).not.toContain("/augenta:init");
    expect(out).not.toContain("[Augenta]");
  });

  test("fires exactly once per project (second session is silent)", () => {
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).not.toBe("");
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("distinct projects each get their one prompt", () => {
    const other = mkdtempSync(join(tmpdir(), "aug-ss-proj2-"));
    try {
      expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).not.toBe("");
      expect(fire({ transcript_path: CLAUDE_TP, cwd: other })).not.toBe("");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("initialized / silent paths", () => {
  test("a project with .augenta/config.json is silent", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ apiKey: "k" }));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("a config in an ancestor also counts as initialized", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ apiKey: "k" }));
    const sub = join(project, "src");
    mkdirSync(sub);
    expect(fire({ transcript_path: CLAUDE_TP, cwd: sub })).toBe("");
  });

  test("an initialized Codex SessionStart captures matching global-memory Task Groups before its detached drain", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "aug-ss-codex-home-"));
    try {
      mkdirSync(join(project, ".augenta"), { recursive: true });
      writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ apiKey: "k" }));
      mkdirSync(join(codexHome, "memories"), { recursive: true });
      writeFileSync(
        join(codexHome, "memories", "MEMORY.md"),
        `# Task Group: Current\napplies_to: cwd=${project}\nBackground memory.`,
      );

      expect(
        fire(
          { transcript_path: CODEX_TP, cwd: project },
          { CODEX_HOME: codexHome, AUGENTA_INGEST_URL: "http://127.0.0.1:1/v1/experiences" },
        ),
      ).toBe("");
      const captured = new Outbox(project).readPending().records.filter(isDocumentRecord);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.data.text).toContain("Background memory.");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe("SessionStart drains a stranded outbox (G2)", () => {
  function stubEvent(seq: number): CaptureEvent {
    return { src: "claude-code", sid: "s1", proj: project, ts: "2026-06-15T00:00:00.000Z", seq, kind: "msg", role: "user", text: `stranded ${seq}` };
  }

  test("an initialized project with a pending spool still exits silently — the drain is detached, output is unaffected", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ apiKey: "k" }));
    // Seed a spool as if a prior session's final Stop never drained it.
    new Outbox(project).append([stubEvent(0)]);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      AUGENTA_HOME: home,
      // Unreachable on purpose — the spawned shipper's POST must fail fast and
      // harmlessly rather than ever reaching the real prod gateway.
      AUGENTA_INGEST_URL: "http://127.0.0.1:1/v1/experiences",
    };
    const proc = Bun.spawnSync(["bun", "run", HOOK], {
      stdin: Buffer.from(JSON.stringify({ transcript_path: CLAUDE_TP, cwd: project })),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe("");
  });

  test("an initialized project with NOTHING pending is still silent (no spurious spawn)", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ apiKey: "k" }));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });
});
