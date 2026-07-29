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
import { mkdtempSync, rmSync, appendFileSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Outbox,
  isDocumentRecord,
  isRawRecord,
  isCaptureEvent,
  LAG_STRIKES,
  type SpoolRecord,
} from "./outbox";
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

  /**
   * One spool, N cursors. Every test above this block passes a `destKey` of
   * undefined and is left untouched on purpose — that IS the compatibility
   * proof for the single-destination (platform key) form.
   */
  describe("per-destination cursors — one spool feeding several Neurospaces", () => {
    /** The cursor exactly as stored, so the on-disk contract can be asserted. */
    function stored(o: Outbox): { shipped?: number; links?: Record<string, number> } {
      return JSON.parse(readFileSync(o.cursorPath, "utf8"));
    }

    test("advancing one destination leaves the other's records pending", () => {
      box.append([ev(0), ev(1)]);
      box.registerDestinations(["nl_a", "nl_b"]);
      box.advance(box.readPending(Infinity, "nl_a").endOffset, "nl_a");

      expect(box.readPending(Infinity, "nl_a").records).toEqual([]);
      expect(box.readPending(Infinity, "nl_b").records.map(tag)).toEqual([0, 1]);
      expect(box.pendingCount("nl_b")).toBe(2);
    });

    test("the stored `shipped` scalar is the MIN across destinations", () => {
      // An older build understands only `shipped`. The min makes it RE-SHIP what
      // some destinations already took (idempotent); a max would make it SKIP
      // what the laggard never saw.
      box.append([ev(0), ev(1)]);
      box.registerDestinations(["nl_a", "nl_b"]);
      const end = box.readPending(Infinity, "nl_a").endOffset;
      box.advance(end, "nl_a");

      const cursor = stored(box);
      expect(cursor.links).toEqual({ nl_a: end, nl_b: 0 });
      expect(cursor.shipped).toBe(0);
      expect(box.hasPendingBytes()).toBe(true); // min-gated, so still pending
    });

    test("compaction waits for the SLOWEST destination, then reclaims", () => {
      box.append([ev(0), ev(1)]);
      box.registerDestinations(["nl_a", "nl_b"]);

      box.advance(box.readPending(Infinity, "nl_a").endOffset, "nl_a");
      box.compact();
      expect(box.hasPendingBytes()).toBe(true); // nl_b has not had these bytes
      expect(box.readPending(Infinity, "nl_b").records.map(tag)).toEqual([0, 1]);

      box.advance(box.readPending(Infinity, "nl_b").endOffset, "nl_b");
      box.compact();
      expect(box.hasPendingBytes()).toBe(false);
    });

    test("compaction zeroes EVERY destination, so a peer cannot skip the next append", () => {
      // The trap: compact() renames the spool so offsets restart at 0. A key left
      // at a nonzero offset would silently skip the next N bytes appended.
      box.append([ev(0), ev(1)]);
      box.registerDestinations(["nl_a", "nl_b"]);
      for (const key of ["nl_a", "nl_b"]) {
        box.advance(box.readPending(Infinity, key).endOffset, key);
      }
      box.compact();

      expect(stored(box).links).toEqual({ nl_a: 0, nl_b: 0 });
      box.append([ev(2)]);
      expect(box.readPending(Infinity, "nl_a").records.map(tag)).toEqual([2]);
      expect(box.readPending(Infinity, "nl_b").records.map(tag)).toEqual([2]);
    });

    test("a legacy scalar cursor is inherited by the single destination that earned it", () => {
      box.append([ev(0), ev(1), ev(2)]);
      const first = box.readPending(1);
      box.advance(first.endOffset); // legacy single-cursor advance
      box.registerDestinations(["nl_a"]);

      // Everything below the scalar was already reclaimable, so inheriting it is
      // bounded to the pending tail.
      expect(stored(box).links).toEqual({ nl_a: first.endOffset });
      expect(box.readPending(Infinity, "nl_a").records.map(tag)).toEqual([1, 2]);
    });

    test("migrating off the legacy scalar does NOT hand its pending tail to a new destination", () => {
      // A 0.5.x project with an undrained spool, reconnected with a second
      // Neurospace added. The tail was captured when only nl_a was a destination,
      // so only nl_a may have it — `freshKeys` is how connect.ts says which is new.
      box.append([ev(0), ev(1), ev(2)]);
      const first = box.readPending(1);
      box.advance(first.endOffset); // legacy scalar, mid-spool
      const end = statSync(box.spoolPath).size;

      box.registerDestinations(["nl_a", "nl_b"], { freshKeys: ["nl_b"] });

      expect(stored(box).links).toEqual({ nl_a: first.endOffset, nl_b: end });
      expect(box.readPending(Infinity, "nl_a").records.map(tag)).toEqual([1, 2]);
      expect(box.readPending(Infinity, "nl_b").records).toEqual([]); // no back-fill
    });

    test("without a fresh-key hint, a multi-key legacy migration shares nothing", () => {
      // The conservative reading when the caller cannot say which key is new: the
      // tail is withheld rather than over-shared. connect.ts always passes the hint.
      box.append([ev(0), ev(1)]);
      box.advance(box.readPending(1).endOffset);
      const end = statSync(box.spoolPath).size;

      box.registerDestinations(["nl_a", "nl_b"]);
      expect(stored(box).links).toEqual({ nl_a: end, nl_b: end });
    });

    test("a FIRST-TIME connection hands its whole spool to every destination", () => {
      // There is no watermark to divide, so the conservative rule above must not
      // fire — otherwise a brand-new project ships nothing on its first drain.
      box.append([ev(0), ev(1)]);
      box.registerDestinations(["nl_a", "nl_b"], { freshKeys: ["nl_a", "nl_b"] });

      expect(stored(box).links).toEqual({ nl_a: 0, nl_b: 0 });
      expect(box.readPending(Infinity, "nl_a").records.map(tag)).toEqual([0, 1]);
      expect(box.readPending(Infinity, "nl_b").records.map(tag)).toEqual([0, 1]);
    });

    test("a NEWLY added destination seeds at the spool end — it never inherits a backlog", () => {
      box.append([ev(0), ev(1)]);
      box.registerDestinations(["nl_a"]);
      const end = statSync(box.spoolPath).size;

      box.registerDestinations(["nl_a", "nl_b"]);
      // A Neurospace the user just added must not receive activity from before
      // they consented to it.
      expect(box.readPending(Infinity, "nl_b").records).toEqual([]);
      expect(stored(box).links).toEqual({ nl_a: 0, nl_b: end });

      box.append([ev(2)]);
      expect(box.readPending(Infinity, "nl_b").records.map(tag)).toEqual([2]);
      expect(box.readPending(Infinity, "nl_a").records.map(tag)).toEqual([0, 1, 2]);
    });

    test("a DESELECTED destination is dropped, which unpins compaction", () => {
      box.append([ev(0)]);
      box.registerDestinations(["nl_a", "nl_b"]);
      box.advance(box.readPending(Infinity, "nl_a").endOffset, "nl_a");
      box.compact();
      expect(box.hasPendingBytes()).toBe(true); // nl_b still pins the spool

      box.registerDestinations(["nl_a"]); // user removed nl_b
      expect(stored(box).links).toEqual({ nl_a: statSync(box.spoolPath).size });
      box.compact();
      expect(box.hasPendingBytes()).toBe(false); // no longer wedged forever
    });

    test("registerDestinations is idempotent — no write when the set is unchanged", () => {
      box.append([ev(0)]);
      box.registerDestinations(["nl_a", "nl_b"]);
      box.advance(box.readPending(Infinity, "nl_a").endOffset, "nl_a");
      const before = stored(box);
      box.registerDestinations(["nl_b", "nl_a"]); // same set, different order
      expect(stored(box)).toEqual(before);
    });

    test("registerDestinations with an empty set leaves the cursor alone", () => {
      box.append([ev(0)]);
      box.advance(box.readPending().endOffset);
      const before = stored(box);
      box.registerDestinations([]);
      expect(stored(box)).toEqual(before);
    });

    test("a corrupt links map falls back to the scalar rather than throwing", () => {
      // Falling back to a MIN can only re-ship; defaulting a bad key could skip.
      box.append([ev(0), ev(1)]);
      const end = box.readPending(1).endOffset;
      for (const links of [
        { nl_a: -1 },
        { nl_a: 1.5 },
        { nl_a: "10" },
        { nl_a: null },
        { "": 0 },
        [],
        "nope",
      ]) {
        writeFileSync(box.cursorPath, JSON.stringify({ shipped: end, links }));
        expect(() => box.readPending(Infinity, "nl_a")).not.toThrow();
        expect(box.readPending(Infinity, "nl_a").records.map(tag)).toEqual([1]);
      }
    });

    test("an UNSEEDED destKey reads 0 — it must never inherit a peer's position", () => {
      // registerDestinations is what seeds keys, so this is a caller bug. Falling
      // back to the min looks safe but is not: once every peer is caught up the min
      // IS their position, which would hide from an unseeded destination every
      // record it never received.
      box.append([ev(0), ev(1)]);
      box.registerDestinations(["nl_a", "nl_b"]);
      for (const key of ["nl_a", "nl_b"]) {
        box.advance(box.readPending(Infinity, key).endOffset, key);
      }
      expect(box.readPending(Infinity, "nl_unknown").records.map(tag)).toEqual([0, 1]);
    });

    test("a stored offset past the spool end RESETS, so nothing is skipped", () => {
      // A crash or a reclaimed stale lock can interleave with compact(), leaving an
      // offset beyond a spool that restarted at 0. Re-shipping is idempotent;
      // trusting the stale offset (or clamping it to the END) would keep skipping,
      // and nothing would flag it because it looks AHEAD of its peers, not behind.
      box.append([ev(0)]);
      writeFileSync(box.cursorPath, JSON.stringify({ shipped: 0, links: { nl_a: 999_999 } }));
      expect(box.readPending(Infinity, "nl_a").records.map(tag)).toEqual([0]);
    });

    describe("enforceLag — bounding the wedged destination that would fill the spool", () => {
      /** Drive `count` consecutive no-progress drains for `laggard`. */
      const strike = (o: Outbox, laggard: string, healthy: string, count: number) => {
        let swept: ReturnType<Outbox["enforceLag"]> = [];
        for (let i = 0; i < count; i++) swept = o.enforceLag([healthy]);
        return swept;
      };

      test("discards nothing until the laggard has failed LAG_STRIKES times", () => {
        // The hysteresis IS the safety margin: one timed-out POST on the first
        // drain after a week offline looks exactly like a dead Neurolink, and
        // deleting a week of records on that evidence is the bug this prevents.
        const tiny = new Outbox(home, { maxDestLagBytes: 10 });
        tiny.append([ev(0), ev(1), ev(2)]);
        tiny.registerDestinations(["nl_a", "nl_b"]);
        tiny.advance(tiny.readPending(Infinity, "nl_a").endOffset, "nl_a");

        for (let i = 1; i < LAG_STRIKES; i++) {
          expect(tiny.enforceLag(["nl_a"])).toEqual([]); // still on probation
          expect(tiny.pendingCount("nl_b")).toBe(3); // backlog intact
        }
        const swept = tiny.enforceLag(["nl_a"]);
        expect(swept.length).toBe(1);
        expect(swept[0]!.destKey).toBe("nl_b");
        expect(tiny.pendingCount("nl_b")).toBe(0);
      });

      test("any successful ship RESETS the strike count", () => {
        // A destination that is merely slow, failing intermittently, must never
        // accumulate its way to a discard.
        const tiny = new Outbox(home, { maxDestLagBytes: 10 });
        tiny.append([ev(0), ev(1), ev(2)]);
        tiny.registerDestinations(["nl_a", "nl_b"]);
        tiny.advance(tiny.readPending(Infinity, "nl_a").endOffset, "nl_a");

        for (let round = 0; round < 4; round++) {
          strike(tiny, "nl_b", "nl_a", LAG_STRIKES - 1); // just short of the sweep
          expect(tiny.enforceLag(["nl_a", "nl_b"])).toEqual([]); // nl_b shipped → reset
        }
        expect(tiny.pendingCount("nl_b")).toBe(3); // never discarded
      });

      test("two simultaneously-wedged destinations do not shield each other", () => {
        // Measuring lag against the NEAREST peer let both sit behind together
        // while the spool filled to MAX_SPOOL_BYTES and append began dropping
        // records for everyone — the exact outcome this cap exists to prevent.
        const tiny = new Outbox(home, { maxDestLagBytes: 10 });
        tiny.append([ev(0), ev(1), ev(2)]);
        tiny.registerDestinations(["nl_a", "nl_b", "nl_c"]);
        tiny.advance(tiny.readPending(Infinity, "nl_a").endOffset, "nl_a");

        const swept = strike(tiny, "", "nl_a", LAG_STRIKES);
        expect(swept.map((s) => s.destKey).sort()).toEqual(["nl_b", "nl_c"]);
        // Both were swept, so the spool is BOUNDED at roughly the cap instead of
        // growing to MAX_SPOOL_BYTES. It is not emptied — the sweep deliberately
        // keeps each laggard within the cap rather than at the leader.
        const size = statSync(tiny.spoolPath).size;
        const min = JSON.parse(readFileSync(tiny.cursorPath, "utf8")).shipped as number;
        expect(size - min).toBeLessThanOrEqual(10);
      });

      test("the sweep keeps the laggard within the cap rather than at the leader", () => {
        // Discard as little as possible: everything older than the cap goes, the
        // rest is still deliverable, and the spool stays bounded at ~the cap.
        const tiny = new Outbox(home, { maxDestLagBytes: 40 });
        tiny.append([ev(0), ev(1), ev(2), ev(3)]);
        const leader = tiny.readPending(Infinity, "nl_a").endOffset;
        tiny.registerDestinations(["nl_a", "nl_b"]);
        tiny.advance(leader, "nl_a");

        const swept = strike(tiny, "nl_b", "nl_a", LAG_STRIKES);
        expect(swept[0]!.to).toBe(leader - 40);
        expect(swept[0]!.to).toBeLessThan(leader); // not fast-forwarded all the way
      });

      test("declares NOTHING derelict when no peer made progress", () => {
        // A week offline must not discard the backlog — that is the case the
        // spool exists to survive. No number of repeats changes that.
        const tiny = new Outbox(home, { maxDestLagBytes: 10 });
        tiny.append([ev(0), ev(1), ev(2)]);
        tiny.registerDestinations(["nl_a", "nl_b"]);
        for (let i = 0; i < LAG_STRIKES + 2; i++) expect(tiny.enforceLag([])).toEqual([]);
        expect(tiny.readPending(Infinity, "nl_a").records.map(tag)).toEqual([0, 1, 2]);
        expect(tiny.readPending(Infinity, "nl_b").records.map(tag)).toEqual([0, 1, 2]);
      });

      test("never fires for a single destination, however far behind", () => {
        const tiny = new Outbox(home, { maxDestLagBytes: 0 });
        tiny.append([ev(0), ev(1)]);
        tiny.registerDestinations(["nl_a"]);
        expect(tiny.enforceLag(["nl_a"])).toEqual([]);
        expect(tiny.readPending(Infinity, "nl_a").records.map(tag)).toEqual([0, 1]);
      });

      test("leaves a laggard that is still WITHIN the cap alone", () => {
        box.append([ev(0), ev(1)]); // well under the 16MB default
        box.registerDestinations(["nl_a", "nl_b"]);
        box.advance(box.readPending(Infinity, "nl_a").endOffset, "nl_a");
        expect(box.enforceLag(["nl_a"])).toEqual([]);
        expect(box.readPending(Infinity, "nl_b").records.map(tag)).toEqual([0, 1]);
      });
    });
  });
});
