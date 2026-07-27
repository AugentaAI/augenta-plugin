/**
 * Tests for session-start.ts — the SessionStart connect prompt, memory scan, and
 * stranded-outbox drain.
 *
 * Contract under test: an unconnected project fires the connect prompt exactly
 * once per project (`initialUserMessage` = /augenta:connect on Claude Code, a
 * natural-language ask on Codex — which shows additionalContext to the user,
 * so it must carry no agent-only scaffolding there); a connected project is
 * silent; a previously-prompted project is silent — including one prompted
 * under the pre-0.3.0 `init-prompted.json` map. A config file the current
 * parser REJECTS counts as unconnected and gets its own one-shot reconnect
 * prompt; it must never be silently treated as connected.
 *
 * Run as a subprocess with an isolated AUGENTA_HOME (the prompted-marker map)
 * and a temp project as cwd.
 *
 * Run: bun test hooks/session-start.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** Seed a prompted-marker map in the isolated AUGENTA_HOME. */
function writeMarkers(file: string, markers: Record<string, string>): void {
  const stateDir = join(home, ".augenta", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, file), JSON.stringify(markers));
}

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

describe("unconnected project — the connect prompt, harness-aware", () => {
  test("Claude Code: fires /augenta:connect with agent-directed context", () => {
    const out = fire({ transcript_path: CLAUDE_TP, cwd: project });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput?.initialUserMessage).toBe("/augenta:connect");
    expect(out).toContain("never be pasted");
  });

  test("Codex: natural-language ask, no slash command, no agent-only scaffolding", () => {
    const out = fire({ transcript_path: CODEX_TP, cwd: project });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput?.initialUserMessage).toBe("Connect Augenta");
    expect(out).not.toContain("/augenta:connect");
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

  test("a project already prompted under the pre-0.3.0 marker is not re-prompted", () => {
    // Renaming the skill renamed the marker map. Reading only the new name would
    // re-fire the "one automatic prompt it will ever get" at every project every
    // user had already dismissed.
    writeMarkers("init-prompted.json", { [project]: "2026-01-01T00:00:00.000Z" });
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });
});

describe("the kill switch means silence, notices included", () => {
  test("a pending auth notice is neither shown nor consumed while capture is off", () => {
    // hooks.json promises AUGENTA_CAPTURE_ENABLED=0 disables the hook. Nagging
    // about a connection the user deliberately switched off breaks that — and
    // leaving the marker unread means it still surfaces once capture is back,
    // which is the moment it becomes actionable.
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(
      join(project, ".augenta", "config.json"),
      JSON.stringify({ authMode: "api-key", apiKey: "k" }),
    );
    const notice = join(project, ".augenta", "relogin-required");
    writeFileSync(notice, "relogin\n");

    expect(fire({ transcript_path: CLAUDE_TP, cwd: project }, { AUGENTA_CAPTURE_ENABLED: "0" })).toBe("");
    expect(existsSync(notice)).toBe(true);

    // Re-enabled: the same pending notice now surfaces, exactly once.
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toContain("queued capture");
    expect(existsSync(notice)).toBe(false);
  });
});

describe("a config file the parser rejects is UNCONNECTED, not connected", () => {
  // The failure this covers: resolveProjectRoot finds a config by existence, so
  // an unreadable one took the connected branch — capture off (it does not load)
  // AND unpromptable (the prompt is gated on the file's ABSENCE). Silent, and
  // permanent. Every pre-0.3.0 `{apiKey}` config from the removed setup.ts is
  // exactly this shape.
  const LEGACY = JSON.stringify({ apiKey: "k-from-setup-ts" });

  function writeConfig(body: string): void {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), body);
  }

  test("a legacy setup.ts config prompts to reconnect instead of going silent", () => {
    writeConfig(LEGACY);
    const parsed = JSON.parse(fire({ transcript_path: CLAUDE_TP, cwd: project }));
    expect(parsed.hookSpecificOutput?.initialUserMessage).toBe("/augenta:connect");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("cannot read");
  });

  test("truncated JSON prompts the same way", () => {
    writeConfig('{"authMode":"workos","profileId":');
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).not.toBe("");
  });

  test("the reconnect prompt also fires exactly once", () => {
    writeConfig(LEGACY);
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).not.toBe("");
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("the pre-0.3.0 marker does NOT suppress it", () => {
    // Every project holding a legacy config was prompted under the old flow, so
    // honoring that marker here would re-silence exactly the users who need this.
    writeConfig(LEGACY);
    writeMarkers("init-prompted.json", { [project]: "2026-01-01T00:00:00.000Z" });
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).not.toBe("");
  });

  test("Codex gets user-facing wording with no agent scaffolding", () => {
    writeConfig(LEGACY);
    const out = fire({ transcript_path: CODEX_TP, cwd: project });
    expect(JSON.parse(out).hookSpecificOutput?.initialUserMessage).toBe("Connect Augenta");
    expect(out).not.toContain("[Augenta]");
    expect(out).not.toContain("/augenta:connect");
  });
});

describe("connected / silent paths", () => {
  test("a project with .augenta/config.json is silent", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("a config in an ancestor also counts as connected", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
    const sub = join(project, "src");
    mkdirSync(sub);
    expect(fire({ transcript_path: CLAUDE_TP, cwd: sub })).toBe("");
  });

  test("a connected Codex SessionStart captures matching global-memory Task Groups before its detached drain", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "aug-ss-codex-home-"));
    try {
      mkdirSync(join(project, ".augenta"), { recursive: true });
      writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
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

  test("a connected project with a pending spool still exits silently — the drain is detached, output is unaffected", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
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

  test("a connected project with NOTHING pending is still silent (no spurious spawn)", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });
});
