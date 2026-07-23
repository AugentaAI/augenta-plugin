/**
 * SCOPE: developer verification of the TypeScript modules in this change — these
 * tests confirm the scripts behave as intended (event shape, idempotency, the real
 * local ship/land path). Not a product/acceptance suite.
 *
 * Tests for outbox.ts — the durable local spool.
 *
 * Contract under test: append→readPending round-trips scrubbed CaptureEvents,
 * already-sanitized RawRecords, and standalone memory documents in spool
 * order; the cursor only exposes unshipped records; batching reports
 * `endOffset`/`hasMore` correctly and `maxBatch` counts every recognized
 * record; advancing to a returned `endOffset` then re-reading yields the next
 * batch (idempotent resume); corrupt lines are skipped without wedging;
 * compaction reclaims only a fully-drained spool.
 *
 * Run: bun test capture/outbox.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox, isDocumentRecord, isRawRecord, isCaptureEvent, type SpoolRecord } from "./outbox";
import type { CaptureEvent, DocumentRecord, RawRecord } from "./event";

function ev(seq: number, text = `event ${seq}`): CaptureEvent {
  return {
    src: "claude-code",
    sid: "s1",
    proj: "/work/app",
    ts: "2026-06-15T00:00:00.000Z",
    seq,
    kind: "msg",
    role: "user",
    text,
  };
}

function raw(line: string, turn?: number): RawRecord {
  return {
    raw: line,
    src: "claude-code",
    sid: "s1",
    proj: "/work/app",
    ...(turn !== undefined ? { turn } : {}),
  };
}

function doc(id = "doc-1"): DocumentRecord {
  return {
    src: "claude-code",
    sid: `memory-${id}`,
    proj: "/work/app",
    type: "doc",
    data: {
      kind: "agent-memory",
      documentId: id,
      sourcePath: "notes.md",
      title: "Notes",
      format: "text/markdown",
      text: "scrubbed memory",
      sourceUpdatedAt: "2026-06-15T00:00:00.000Z",
      capturedAt: "2026-06-15T00:01:00.000Z",
      revision: "r1",
      deleted: false,
      chunkIndex: 0,
      chunkCount: 1,
    },
  };
}

/** seq for events, raw string for raws — a compact order fingerprint. */
function tag(r: SpoolRecord): number | string {
  if (isDocumentRecord(r)) return r.data.documentId;
  return isRawRecord(r) ? r.raw : r.seq;
}

describe("Outbox", () => {
  let home: string;
  let box: Outbox;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aug-outbox-"));
    box = new Outbox(home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("append then readPending returns the events in order", () => {
    box.append([ev(0), ev(1), ev(2)]);
    const { records, hasMore } = box.readPending();
    expect(records.map(tag)).toEqual([0, 1, 2]);
    expect(hasMore).toBe(false);
  });

  test("the outbox round-trips a supplied raw record without applying another transform", () => {
    const line = '{"type":"user","message":{"content":"token ghp_0123456789abcdefghijklmnopqrstuvwx"}}';
    box.append([raw(line, 3)]);
    const { records } = box.readPending();
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(isRawRecord(r)).toBe(true);
    expect(isCaptureEvent(r)).toBe(false);
    // Structural sanitation happens before the outbox; secret scrubbing does not.
    expect((r as RawRecord).raw).toBe(line);
    expect((r as RawRecord).turn).toBe(3);
  });

  test("mixed events and raws come back in spool order", () => {
    box.append([ev(0), raw("line-a"), ev(1), raw("line-b")]);
    const { records } = box.readPending();
    expect(records.map(tag)).toEqual([0, "line-a", 1, "line-b"]);
  });

  test("standalone document records round-trip alongside trajectory records without acquiring events", () => {
    box.append([ev(0), doc(), raw("line-a")]);
    const records = box.readPending().records;
    expect(records.map(tag)).toEqual([0, "doc-1", "line-a"]);
    const memory = records[1]!;
    expect(isDocumentRecord(memory)).toBe(true);
    expect(memory).toMatchObject({ type: "doc", sid: "memory-doc-1" });
    expect("events" in memory).toBe(false);
  });

  test("rejects document records with inconsistent identity or chunk bounds", () => {
    box.append([ev(0)]);
    appendFileSync(box.spoolPath, JSON.stringify({ ...doc("wrong-sid"), sid: "memory-someone-else" }) + "\n");
    appendFileSync(box.spoolPath, JSON.stringify({ ...doc("bad-chunk"), data: { ...doc("bad-chunk").data, chunkIndex: 1, chunkCount: 1 } }) + "\n");
    box.append([ev(1)]);
    expect(box.readPending().records.map(tag)).toEqual([0, 1]);
  });

  test("maxBatch counts every recognized event and raw record", () => {
    box.append([ev(0), raw("line-a"), ev(1), raw("line-b")]);
    const b1 = box.readPending(3);
    expect(b1.records.map(tag)).toEqual([0, "line-a", 1]);
    expect(b1.hasMore).toBe(true);

    box.advance(b1.endOffset);
    const b2 = box.readPending(3);
    expect(b2.records.map(tag)).toEqual(["line-b"]);
    expect(b2.hasMore).toBe(false);
  });

  test("extra fields on a step survive the spool round-trip (the spool never reshapes)", () => {
    box.append([{ ...ev(0), custom_field: "kept" } as unknown as CaptureEvent]);
    expect((box.readPending().records[0] as unknown as Record<string, unknown>).custom_field).toBe("kept");
  });

  test("append of an empty batch is a no-op", () => {
    box.append([]);
    expect(box.pendingCount()).toBe(0);
  });

  test("advance to endOffset hides shipped records", () => {
    box.append([ev(0), ev(1)]);
    const first = box.readPending();
    box.advance(first.endOffset);
    expect(box.readPending().records).toEqual([]);

    // New appends after shipping are still picked up.
    box.append([ev(2)]);
    expect(box.readPending().records.map(tag)).toEqual([2]);
  });

  test("batching: maxBatch limits the batch and flags hasMore; resume gets the rest", () => {
    box.append([ev(0), ev(1), ev(2), ev(3)]);
    const b1 = box.readPending(2);
    expect(b1.records.map(tag)).toEqual([0, 1]);
    expect(b1.hasMore).toBe(true);

    box.advance(b1.endOffset);
    const b2 = box.readPending(2);
    expect(b2.records.map(tag)).toEqual([2, 3]);
    expect(b2.hasMore).toBe(false);
  });

  test("skips a corrupt line without wedging the spool", () => {
    box.append([ev(0)]);
    appendFileSync(box.spoolPath, "{ not valid json\n");
    box.append([raw("line-a")]);
    const { records } = box.readPending();
    expect(records.map(tag)).toEqual([0, "line-a"]);
  });

  test("a spool record with a NON-INTEGER seq is unrecognized — never shipped into a guaranteed door 400", () => {
    box.append([ev(0)]);
    appendFileSync(box.spoolPath, JSON.stringify({ ...ev(1), seq: 1.5 }) + "\n");
    box.append([ev(2)]);
    const { records } = box.readPending();
    expect(records.map(tag)).toEqual([0, 2]); // the float-seq record is skipped as corrupt
  });

  test("compact reclaims a fully-drained spool and resets the cursor", () => {
    box.append([ev(0), raw("line-a")]);
    box.advance(box.readPending().endOffset);
    box.compact();
    expect(box.pendingCount()).toBe(0); // spool fully reclaimed (file removed or empty)
    // After reset, a fresh append is readable from offset 0.
    box.append([ev(2)]);
    expect(box.readPending().records.map(tag)).toEqual([2]);
  });

  test("compact is a no-op when the spool is only partially drained", () => {
    box.append([ev(0), ev(1)]);
    const b = box.readPending(1); // ship only the first
    box.advance(b.endOffset);
    box.compact(); // not fully drained → must NOT truncate
    expect(box.readPending().records.map(tag)).toEqual([1]);
  });

  test("a missing/corrupt cursor reads from the start (fail-safe)", () => {
    box.append([ev(0)]);
    appendFileSync(box.cursorPath, "garbage"); // cursor exists but unparseable
    expect(box.readPending().records.map(tag)).toEqual([0]);
  });

  describe("hasPendingBytes (G2) — the cheap size check SessionStart uses", () => {
    test("false with no spool yet", () => {
      expect(box.hasPendingBytes()).toBe(false);
    });

    test("true once records are appended, false again once fully shipped and compacted", () => {
      expect(box.hasPendingBytes()).toBe(false);
      box.append([ev(0), ev(1)]);
      expect(box.hasPendingBytes()).toBe(true);

      box.advance(box.readPending().endOffset);
      expect(box.hasPendingBytes()).toBe(false); // shipped, though not yet compacted

      box.compact();
      expect(box.hasPendingBytes()).toBe(false); // still false post-compact

      box.append([ev(2)]);
      expect(box.hasPendingBytes()).toBe(true); // a fresh append is pending again
    });

    test("true when only PART of the spool has shipped", () => {
      box.append([ev(0), ev(1)]);
      const first = box.readPending(1);
      box.advance(first.endOffset);
      expect(box.hasPendingBytes()).toBe(true); // ev(1) still unshipped
    });
  });

  describe("spool-cap overflow (G3) — append() signals the drop instead of vanishing silently", () => {
    test("append returns false and writes nothing once the (injected, tiny) cap is reached", () => {
      const tiny = new Outbox(home, { maxSpoolBytes: 10 }); // a couple bytes — any record trips it
      expect(tiny.append([ev(0)])).toBe(true); // first write always lands regardless of size
      expect(statSync(tiny.spoolPath).size).toBeGreaterThanOrEqual(10); // already at/over the tiny cap
      expect(tiny.append([ev(1)])).toBe(false); // dropped — cap already reached
      expect(tiny.readPending().records.map(tag)).toEqual([0]); // ev(1) never made it in
    });

    test("forceAppend bypasses the cap entirely", () => {
      const tiny = new Outbox(home, { maxSpoolBytes: 10 });
      tiny.append([ev(0)]); // trips the cap
      expect(tiny.append([ev(1)])).toBe(false);
      tiny.forceAppend([ev(99)]); // bypasses the cap regardless
      expect(tiny.readPending().records.map(tag)).toEqual([0, 99]);
    });

    test("markDropped is true once per episode, false on repeats, true again after clearDropEpisode", () => {
      expect(box.markDropped()).toBe(true); // first drop of a new episode
      expect(box.markDropped()).toBe(false); // same episode — no repeat marker
      expect(box.markDropped()).toBe(false);
      box.clearDropEpisode();
      expect(box.markDropped()).toBe(true); // a fresh episode after the drain cleared it
    });

    test("clearDropEpisode is a harmless no-op when no episode is active", () => {
      expect(() => box.clearDropEpisode()).not.toThrow();
    });
  });
});
