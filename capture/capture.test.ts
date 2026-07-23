/**
 * Tests for capture.ts + capture-cursor.ts — the hook-level OBSERVE step.
 *
 * Contract under test: tailing is incremental (only new bytes per fire), a
 * partial final line is held until terminated, the capture cursor advances
 * past consumed bytes (incl. lines that emit no event), scrub is applied TO
 * EVENT TEXT ONLY while every valid JSON line is ALSO buffered as a
 * structurally sanitized RawRecord (the raw-telemetry channel), the current
 * turn ordinal is stamped on both channels, captured records land in the
 * project outbox, and ONLY a genuine Stop fire is a flush. Exercised by calling runCapture directly
 * (spawnShipper: false) against a temp project + temp transcript — no
 * subprocess, no network.
 *
 * Run: bun test capture/capture.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture, shouldFlush, SPOOL_FULL_MARKER } from "./capture";
import { CaptureState } from "./capture-cursor";
import { TurnState } from "./turn-cursor";
import { Outbox, isCaptureEvent, isDocumentRecord, isRawRecord } from "./outbox";
import type { CaptureEvent, RawRecord } from "./event";

function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

describe("CaptureState", () => {
  let project: string;
  beforeEach(() => (project = mkdtempSync(join(tmpdir(), "aug-cur-"))));
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  test("returns zero cursor for an unseen transcript", () => {
    expect(new CaptureState(project).get("/x/t.jsonl")).toEqual({ offset: 0, seq: 0 });
  });

  test("round-trips a cursor and keeps multiple transcripts independent", () => {
    const s = new CaptureState(project);
    s.set("/a.jsonl", { offset: 10, seq: 2 });
    s.set("/b.jsonl", { offset: 99, seq: 7 });
    expect(s.get("/a.jsonl")).toEqual({ offset: 10, seq: 2 });
    expect(s.get("/b.jsonl")).toEqual({ offset: 99, seq: 7 });
  });

  test("a corrupted NON-INTEGER cursor falls back to zero — float seqs would 400 at the door and wedge the outbox", () => {
    const s = new CaptureState(project);
    s.set("/a.jsonl", { offset: 10.5, seq: 2 });
    s.set("/b.jsonl", { offset: 10, seq: 2.5 });
    expect(s.get("/a.jsonl")).toEqual({ offset: 0, seq: 0 });
    expect(s.get("/b.jsonl")).toEqual({ offset: 0, seq: 0 });
  });
});

describe("shouldFlush", () => {
  test("PostToolUse never flushes", () => {
    expect(shouldFlush({ hook_event_name: "PostToolUse" })).toBe(false);
  });
  test("Stop flushes", () => {
    expect(shouldFlush({ hook_event_name: "Stop" })).toBe(true);
  });
  test("a Stop re-fired by a Stop hook's own output never cascades", () => {
    expect(shouldFlush({ hook_event_name: "Stop", stop_hook_active: true })).toBe(false);
  });
  test("no event name never flushes", () => {
    expect(shouldFlush({})).toBe(false);
  });
});

describe("runCapture", () => {
  let project: string;
  let work: string;
  let transcript: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "aug-cap-"));
    work = mkdtempSync(join(tmpdir(), "aug-cap-work-"));
    transcript = join(work, "transcript.jsonl");
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  function fire(event: "PostToolUse" | "Stop" = "PostToolUse") {
    return runCapture(
      { session_id: "s1", transcript_path: transcript, cwd: "/proj", hook_event_name: event },
      { projectRoot: project, spawnShipper: false },
    );
  }

  const pendingEvents = (): CaptureEvent[] =>
    new Outbox(project).readPending().records.filter(isCaptureEvent);
  const pendingRaws = (): RawRecord[] =>
    new Outbox(project).readPending().records.filter(isRawRecord);

  test("captures new lines into the outbox and advances the cursor", () => {
    writeFileSync(transcript, userLine("first task") + userLine("second task"));
    const r = fire();
    expect(r.appended).toBe(2);

    const pending = pendingEvents();
    expect(pending.map((e) => e.text)).toEqual(["first task", "second task"]);
    // seq continues across the session
    expect(pending.map((e) => e.seq)).toEqual([0, 1]);
  });

  test("buffers every consumed JSON line as a sanitized RawRecord alongside the events", () => {
    writeFileSync(transcript, userLine("first task") + userLine("second task"));
    fire();
    const raws = pendingRaws();
    expect(raws.map((r) => r.raw)).toEqual([
      userLine("first task").trimEnd(),
      userLine("second task").trimEnd(),
    ]);
    // Same src/sid/proj context as the events.
    expect(raws.every((r) => r.src === "claude-code" && r.sid === "s1" && r.proj === "/proj")).toBe(true);
  });

  test("Claude path: a line-level sessionId override keeps event and raw sids ALIGNED, line by line", () => {
    // A resumed session replays history lines that keep their ORIGINAL
    // sessionId; events follow the line (`line.sessionId || payload sid`). The
    // raws MUST share that per-line derivation — a divergent raw sid orphans
    // into a zero-event group that ship silently drops, killing the raw
    // channel for exactly those lines.
    const replayed =
      JSON.stringify({ type: "user", sessionId: "old-session", message: { role: "user", content: "replayed history" } }) + "\n";
    // A no-event line (no content → skipped by the normalizer) that still
    // carries the old sessionId — its raw must follow the line too.
    const marker = JSON.stringify({ type: "summary", sessionId: "old-session" }) + "\n";
    writeFileSync(transcript, replayed + marker + userLine("fresh line"));
    fire();

    expect(pendingEvents().map((e) => e.sid)).toEqual(["old-session", "s1"]); // marker produced no event
    expect(pendingRaws().map((r) => r.sid)).toEqual(["old-session", "old-session", "s1"]);
  });

  test("is incremental — a second fire only captures newly-appended lines", () => {
    writeFileSync(transcript, userLine("one"));
    expect(fire().appended).toBe(1);

    appendFileSync(transcript, userLine("two"));
    expect(fire().appended).toBe(1); // only the new line

    const events = pendingEvents();
    expect(events.map((e) => e.text)).toEqual(["one", "two"]);
    expect(events.map((e) => e.seq)).toEqual([0, 1]); // monotonic across fires
    expect(pendingRaws().length).toBe(2); // one raw per consumed line, no rescans
  });

  test("holds a partial final line until it is newline-terminated", () => {
    // No trailing newline → the line is mid-write and must not be consumed.
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "partial" } }));
    expect(fire().appended).toBe(0);
    expect(pendingRaws().length).toBe(0); // not even as a raw — the line is incomplete

    appendFileSync(transcript, "\n"); // now complete
    expect(fire().appended).toBe(1);
    expect(pendingEvents()[0]!.text).toBe("partial");
    expect(pendingRaws().length).toBe(1);
  });

  test("nothing new → no-op", () => {
    writeFileSync(transcript, userLine("done"));
    fire();
    expect(fire().appended).toBe(0);
  });

  test("missing transcript → no-op", () => {
    expect(
      runCapture({ transcript_path: "/nope.jsonl" }, { projectRoot: project, spawnShipper: false }).appended,
    ).toBe(0);
  });

  test("no opted-in project resolvable from cwd → no-op", () => {
    writeFileSync(transcript, userLine("work"));
    const r = runCapture(
      // `work` has no .augenta/config.json anywhere up its (temp) ancestry.
      { session_id: "s1", transcript_path: transcript, cwd: work, hook_event_name: "PostToolUse" },
      { spawnShipper: false },
    );
    expect(r).toEqual({ appended: 0, flushed: false });
  });

  test("applies the secret scrub before events reach the outbox", () => {
    writeFileSync(transcript, userLine("token ghp_0123456789abcdefghijklmnopqrstuvwx done"));
    fire();
    const text = pendingEvents()[0]!.text;
    expect(text).toContain("[redacted:github-token]");
    expect(text).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwx");
  });

  test("SCRUB ASYMMETRY (by design): event text is scrubbed, the raw record retains the secret verbatim", () => {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    writeFileSync(transcript, userLine(`token ${secret} done`));
    fire();

    // The scrubbed channel.
    expect(pendingEvents()[0]!.text).not.toContain(secret);
    // The raw-telemetry channel — structurally sanitized but not secret-scrubbed,
    // covered by the project opt-in.
    const raw = pendingRaws()[0]!;
    expect(raw.raw).toContain(secret);
    expect(raw.raw).toBe(userLine(`token ${secret} done`).trimEnd());
  });

  test("raw records remove opaque reasoning fields before they enter the outbox", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "opaque" }] },
    }) + "\n";
    writeFileSync(transcript, line);
    fire();
    const raw = pendingRaws()[0]!.raw;
    expect(raw).not.toContain("signature");
    expect(raw).toContain("plan");
  });

  test("stamps the current turn ordinal onto every captured event", () => {
    new TurnState(project).bump(transcript); // UserPromptSubmit → turn 1
    writeFileSync(transcript, userLine("turn one work"));
    fire();

    new TurnState(project).bump(transcript); // next turn
    appendFileSync(transcript, userLine("turn two work"));
    fire();

    const events = pendingEvents();
    expect(events.map((e) => e.turn)).toEqual([1, 2]);
  });

  test("raw records carry the same turn stamp as their sibling events", () => {
    new TurnState(project).bump(transcript); // UserPromptSubmit → turn 1
    writeFileSync(transcript, userLine("turn one work"));
    fire();

    new TurnState(project).bump(transcript); // next turn
    appendFileSync(transcript, userLine("turn two work"));
    fire();

    expect(pendingRaws().map((r) => r.turn)).toEqual([1, 2]);
  });

  test("events before the first UserPromptSubmit carry turn 0", () => {
    writeFileSync(transcript, userLine("session preamble"));
    fire();
    expect(pendingEvents()[0]!.turn).toBe(0);
  });

  test("PostToolUse is buffer-only; a genuine Stop is the flush", () => {
    writeFileSync(transcript, userLine("work"));
    expect(fire("PostToolUse").flushed).toBe(false);
    appendFileSync(transcript, userLine("more"));
    expect(fire("Stop").flushed).toBe(true);
  });

  test("a Stop with nothing new still reports the flush (drains earlier buffers)", () => {
    writeFileSync(transcript, userLine("work"));
    fire("PostToolUse"); // consumed everything
    expect(fire("Stop")).toEqual({ appended: 0, flushed: true });
  });

  test("is non-blocking: runCapture is synchronous and never awaits the network", () => {
    writeFileSync(transcript, userLine("work"));
    // The hook's OBSERVE step returns a plain value, not a Promise — there is no
    // awaited network/model call on the critical path; shipping is detached.
    const r = fire();
    expect(r).not.toBeInstanceOf(Promise);
    expect(typeof r.appended).toBe("number");
  });

  test("advances past no-event lines so they aren't re-scanned", () => {
    // A summary line emits no event; a following user line should still capture,
    // and a repeat fire must find nothing new.
    writeFileSync(transcript, JSON.stringify({ type: "summary" }) + "\n" + userLine("real work"));
    expect(fire().appended).toBe(1);
    expect(fire().appended).toBe(0);
  });

  test("a line that produces no event is still captured as a raw (the cursor moves past it)", () => {
    const summary = JSON.stringify({ type: "summary" });
    writeFileSync(transcript, summary + "\n" + userLine("real work"));
    expect(fire().appended).toBe(1); // only the user line became an event

    const raws = pendingRaws();
    expect(raws.map((r) => r.raw)).toEqual([summary, userLine("real work").trimEnd()]);
    expect(fire().appended).toBe(0); // and nothing is re-scanned
    expect(pendingRaws().length).toBe(2);
  });

  describe("positional tail read (G1) — bounded per-fire catch-up", () => {
    test("a budget-capped fire consumes only the complete lines that fit; the next fire resumes, seq stays monotonic", () => {
      const l0 = userLine("one");
      const l1 = userLine("two");
      const l2 = userLine("three");
      writeFileSync(transcript, l0 + l1 + l2);

      // Cap exactly at the byte boundary between line 1 and line 2 — the
      // capped window already contains newlines, so no doubling kicks in and
      // only the first two lines are within budget.
      const capBytes = Buffer.byteLength(l0, "utf8") + Buffer.byteLength(l1, "utf8");
      const r1 = runCapture(
        { session_id: "s1", transcript_path: transcript, cwd: "/proj", hook_event_name: "PostToolUse" },
        { projectRoot: project, spawnShipper: false, maxTailBytes: capBytes },
      );
      expect(r1.appended).toBe(2); // "three" not yet within this fire's budget

      const r2 = fire(); // default (large) budget mops up the rest
      expect(r2.appended).toBe(1);

      const events = pendingEvents();
      expect(events.map((e) => e.text)).toEqual(["one", "two", "three"]);
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2]); // monotonic across the capped boundary
    });

    test("a single line far larger than the per-fire cap is still consumed whole, in one fire (the doubling escape hatch)", () => {
      const giant = userLine("x".repeat(50_000)); // one JSON line, ~50KB, well over a tiny cap
      writeFileSync(transcript, giant);

      const r = runCapture(
        { session_id: "s1", transcript_path: transcript, cwd: "/proj", hook_event_name: "PostToolUse" },
        { projectRoot: project, spawnShipper: false, maxTailBytes: 64 }, // far smaller than the line
      );
      expect(r.appended).toBe(1); // the doubling escape hatch reads all the way to the line's newline
      expect(pendingEvents()[0]!.text).toBe("x".repeat(50_000));
    });

    test("offset >= the current file size is a no-op — never crashes even if the cursor is ahead of the file", () => {
      writeFileSync(transcript, userLine("hello"));
      fire(); // cursor now sits exactly at the file's current size
      // Simulate a cursor stranded ahead of the file (e.g. a shorter transcript
      // swapped in place) — must not throw, must report a clean no-op.
      new CaptureState(project).set(transcript, { offset: 999_999, seq: 5 });
      expect(fire()).toEqual({ appended: 0, flushed: false });
    });

    test("the Stop (flush) fire reads the FULL tail even past maxTailBytes — a turn is never stranded at session end", () => {
      const l0 = userLine("one");
      const l1 = userLine("two");
      const l2 = userLine("three");
      writeFileSync(transcript, l0 + l1 + l2);
      // A cap that only covers the first line — a PostToolUse fire would stop there.
      const tinyCap = Buffer.byteLength(l0, "utf8");

      const r = runCapture(
        { session_id: "s1", transcript_path: transcript, cwd: "/proj", hook_event_name: "Stop" },
        { projectRoot: project, spawnShipper: false, maxTailBytes: tinyCap },
      );
      expect(r.flushed).toBe(true);
      expect(r.appended).toBe(3); // ALL three consumed in the one Stop fire, cap notwithstanding
      expect(pendingEvents().map((e) => e.text)).toEqual(["one", "two", "three"]);
    });

    test("an injected cap of 0 still makes progress instead of spinning (defensive termination)", () => {
      writeFileSync(transcript, userLine("work"));
      const r = runCapture(
        { session_id: "s1", transcript_path: transcript, cwd: "/proj", hook_event_name: "PostToolUse" },
        { projectRoot: project, spawnShipper: false, maxTailBytes: 0 },
      );
      expect(r.appended).toBe(1); // degrades to a 1-byte read that grows — no infinite loop
      expect(pendingEvents()[0]!.text).toBe("work");
    });
  });

  describe("spool-cap overflow (G3) — the drop becomes loud instead of silent", () => {
    function fireCapped(text: string) {
      return runCapture(
        { session_id: "s1", transcript_path: transcript, cwd: "/proj", hook_event_name: "PostToolUse" },
        { projectRoot: project, spawnShipper: false, maxSpoolBytes: 10 }, // tiny — any single fire trips it
      );
    }

    test("the first over-cap fire drops its own batch but emits ONE synthetic marker with a real, non-colliding seq", () => {
      writeFileSync(transcript, userLine("one"));
      fireCapped("one"); // spool doesn't exist yet — this first write always lands, tripping the cap for next time

      appendFileSync(transcript, userLine("two"));
      fireCapped("two"); // now over cap — "two" itself is dropped, but a marker bypasses the cap

      const events = pendingEvents();
      expect(events.map((e) => e.text)).toEqual(["one", SPOOL_FULL_MARKER]);
      expect(events[1]!.kind).toBe("session");
      expect(events[1]!.role).toBe("system");
      expect(Number.isInteger(events[1]!.seq)).toBe(true);
      expect(events[1]!.seq).toBeGreaterThan(events[0]!.seq); // real, monotonic — never collides with a later real event

      // The reserved seq must never be reissued: a subsequent real event
      // (once the spool has room again) gets a seq strictly past the marker's.
      const box = new Outbox(project, { maxSpoolBytes: 10 });
      box.advance(box.readPending().endOffset);
      box.compact();
      box.clearDropEpisode();
      appendFileSync(transcript, userLine("three"));
      fireCapped("three"); // spool freshly empty — this append lands
      const nextReal = pendingEvents().find((e) => e.text === "three");
      expect(nextReal!.seq).toBeGreaterThan(events[1]!.seq);
    });

    test("a second consecutive over-cap fire does NOT emit a second marker (one per episode, not one per fire)", () => {
      writeFileSync(transcript, userLine("one"));
      fireCapped("one");
      appendFileSync(transcript, userLine("two"));
      fireCapped("two"); // first drop — marker emitted
      appendFileSync(transcript, userLine("three"));
      fireCapped("three"); // still over cap — "three" dropped too, but no 2nd marker

      const texts = pendingEvents().map((e) => e.text);
      expect(texts).toEqual(["one", SPOOL_FULL_MARKER]); // "three" never appears; still exactly one marker
    });

    test("the marker carries the same turn stamp as its sibling events", () => {
      new TurnState(project).bump(transcript); // turn 1
      writeFileSync(transcript, userLine("one"));
      fireCapped("one");
      appendFileSync(transcript, userLine("two"));
      fireCapped("two");

      const marker = pendingEvents().find((e) => e.text === SPOOL_FULL_MARKER)!;
      expect(marker.turn).toBe(1);
    });
  });

  describe("harness content-sniff fallback (G9) — a nonstandard path still gets the right normalizer", () => {
    test("a Codex-shaped rollout line at a NEUTRAL path (matches neither .codex/ nor .claude/) still runs the Codex normalizer", () => {
      // `transcript` here lives under a plain temp dir, not ~/.codex/ or
      // ~/.claude/ — exactly the "nonstandard CODEX_HOME" scenario G9 covers.
      const codexLine =
        JSON.stringify({
          timestamp: "2026-06-28T17:15:11.000Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "say hi" }] },
        }) + "\n";
      writeFileSync(transcript, codexLine);
      const r = fire();
      expect(r.appended).toBe(1); // NOT zero — the old path-only logic would have misread this as Claude Code and dropped it

      const e = pendingEvents()[0]!;
      expect(e.src).toBe("codex");
      expect(e.text).toBe("say hi"); // only the Codex normalizer extracts this correctly
    });

    test("a Claude-shaped line at the same neutral path still resolves to claude-code (unaffected by the fallback)", () => {
      writeFileSync(transcript, userLine("plain claude turn"));
      fire();
      const e = pendingEvents()[0]!;
      expect(e.src).toBe("claude-code");
      expect(e.text).toBe("plain claude turn");
    });
  });

  test("memory is skipped on PostToolUse and captured at a genuine Stop before the shipper would run", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "aug-cap-codex-home-"));
    const previous = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = codexHome;
      mkdirSync(join(codexHome, "memories"), { recursive: true });
      writeFileSync(
        join(codexHome, "memories", "MEMORY.md"),
        `# Task Group: Current\napplies_to: cwd=${project}\nRemember this project.`,
      );
      // Neutral path: custom Codex homes are not guaranteed to include
      // `/.codex/`; Stop must retain the content-sniffed harness even after the
      // preceding PostToolUse consumed the entire transcript.
      const rollout = join(work, "neutral-session.jsonl");
      writeFileSync(
        rollout,
        JSON.stringify({ timestamp: "2026-07-20T00:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "work" }] } }) + "\n",
      );

      runCapture(
        { session_id: "codex-s1", transcript_path: rollout, cwd: project, hook_event_name: "PostToolUse" },
        { projectRoot: project, spawnShipper: false },
      );
      expect(new Outbox(project).readPending().records.filter(isDocumentRecord)).toHaveLength(0);

      const stopped = runCapture(
        { session_id: "codex-s1", transcript_path: rollout, cwd: project, hook_event_name: "Stop" },
        { projectRoot: project, spawnShipper: false },
      );
      expect(stopped.flushed).toBe(true);
      const documents = new Outbox(project).readPending().records.filter(isDocumentRecord);
      expect(documents).toHaveLength(1);
      expect(documents[0]!.data.text).toContain("Remember this project.");
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("the hook entrypoint never captures memory without consent or when the global kill switch is set", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "aug-cap-codex-home-"));
    const rollout = join(work, "rollout-consent.jsonl");
    try {
      mkdirSync(join(codexHome, "memories"), { recursive: true });
      writeFileSync(join(codexHome, "memories", "MEMORY.md"), `# Task Group: Current\napplies_to: cwd=${project}\nPrivate memory.`);
      writeFileSync(
        rollout,
        JSON.stringify({ timestamp: "2026-07-20T00:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "work" }] } }) + "\n",
      );
      const payload = JSON.stringify({ session_id: "codex-s1", transcript_path: rollout, cwd: project, hook_event_name: "Stop" });
      const runHook = (extraEnv: Record<string, string> = {}) =>
        Bun.spawnSync(["bun", "run", join(import.meta.dir, "capture.ts")], {
          stdin: Buffer.from(payload),
          env: { ...(process.env as Record<string, string>), CODEX_HOME: codexHome, ...extraEnv },
          stdout: "pipe",
          stderr: "pipe",
        });

      const withoutConsent = runHook();
      expect(withoutConsent.exitCode).toBe(0);
      expect(withoutConsent.stdout.toString()).toBe("");
      expect(existsSync(join(project, ".augenta"))).toBe(false);

      mkdirSync(join(project, ".augenta"), { recursive: true });
      writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ apiKey: "k" }));
      const killed = runHook({ AUGENTA_CAPTURE_ENABLED: "0" });
      expect(killed.exitCode).toBe(0);
      expect(killed.stdout.toString()).toBe("");
      expect(new Outbox(project).readPending().records).toEqual([]);
      expect(existsSync(join(project, ".augenta", "state", "memory.json"))).toBe(false);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  describe("capture-time synthetic event for raws-only fires (G7)", () => {
    test("a bookkeeping-only batch (zero mappable events) gets exactly one synthetic event, plus all its raws, same turn", () => {
      new TurnState(project).bump(transcript); // turn 1
      const line1 = JSON.stringify({ type: "summary" }); // no content → no event
      const line2 = JSON.stringify({ type: "system" }); // likewise — bookkeeping only
      writeFileSync(transcript, line1 + "\n" + line2 + "\n");

      const r = fire();
      expect(r.appended).toBe(1); // the synthetic marker itself

      const events = pendingEvents();
      expect(events.length).toBe(1);
      expect(events[0]!.kind).toBe("session");
      expect(events[0]!.role).toBe("system");
      expect(events[0]!.text).toBe("[augenta: 2 transcript line(s) with no mappable steps — raw channel attached]");
      expect(events[0]!.turn).toBe(1); // grouped with its raws' turn, not orphaned into turn 0

      const raws = pendingRaws();
      expect(raws.map((r) => r.raw)).toEqual([line1, line2]);
      expect(raws.every((r) => r.turn === 1)).toBe(true);
    });

    test("the synthetic's seq is real and monotonic — the next fire's real event gets the following seq", () => {
      writeFileSync(transcript, JSON.stringify({ type: "summary" }) + "\n");
      fire(); // raws-only fire — synthetic consumes seq 0

      appendFileSync(transcript, userLine("real work"));
      fire();

      const events = pendingEvents();
      expect(events.map((e) => e.seq)).toEqual([0, 1]);
      expect(events[1]!.text).toBe("real work");
    });

    test("a batch with at least one real event gets NO synthetic — mixed batches are unaffected", () => {
      writeFileSync(transcript, JSON.stringify({ type: "summary" }) + "\n" + userLine("real work"));
      const r = fire();
      expect(r.appended).toBe(1); // just the real event

      const events = pendingEvents();
      expect(events.length).toBe(1);
      expect(events[0]!.text).toBe("real work");
    });

    test("a multi-sid raws-only fire gets ONE synthetic per distinct sid — no sid's raws are orphaned", () => {
      // A resumed session replays bookkeeping lines carrying their ORIGINAL
      // sessionId; two distinct sids, both producing no events. ship groups by
      // sid, so each sid needs its own synthetic to stay shippable.
      const bkA = JSON.stringify({ type: "summary", sessionId: "sid-A" });
      const bkB = JSON.stringify({ type: "summary", sessionId: "sid-B" });
      writeFileSync(transcript, bkA + "\n" + bkB + "\n");
      const r = fire();
      expect(r.appended).toBe(2); // one synthetic per sid

      const events = pendingEvents();
      expect(events.length).toBe(2);
      expect(events.every((e) => e.kind === "session" && e.role === "system")).toBe(true);
      expect(new Set(events.map((e) => e.sid))).toEqual(new Set(["sid-A", "sid-B"]));
      expect(events.map((e) => e.seq)).toEqual([0, 1]); // distinct, monotonic — no collision
      // Every sid present in the raws now has a matching event, so no zero-event
      // group survives for ship's grouper to drop.
      const rawSids = new Set(pendingRaws().map((r) => r.sid));
      const eventSids = new Set(events.map((e) => e.sid));
      expect(eventSids).toEqual(rawSids);
    });
  });
});
