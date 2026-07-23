/**
 * Tests for ship.ts — the detached outbox→backend shipper.
 *
 * Drain is exercised against a REAL loopback HTTP server (Bun.serve) — not a
 * mock of our code; a genuine endpoint standing in for the `/v1/experiences`
 * receiver. Asserts: records arrive turn-grouped as `{ experiences: [...] }`
 * with CaptureEvents in `events` and raw transcript lines in `data`, groups
 * with zero events are dropped, oversize experiences are bounded by the
 * ladder (drop `data` → split by disjoint seq ranges → truncate a giant step
 * with the loud marker), POST bodies are packed under MAX_BODY_BYTES, the
 * cursor advances only after every body of a slice 2xxes and the spool
 * compacts, and on a network error or non-2xx the whole slice is kept for
 * retry. Also covers the pure grouper/bounder/packer and the single-flight
 * lock.
 *
 * Run: bun test capture/ship.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drain,
  acquireLock,
  releaseLock,
  groupIntoExperiences,
  boundExperienceSize,
  boundRawData,
  packBodies,
  MAX_EXPERIENCE_BYTES,
  MAX_BODY_BYTES,
  DOCUMENT_TRUNCATION_MARKER,
  TRUNCATION_MARKER,
} from "./ship";
import { Outbox } from "./outbox";
import type { CaptureEvent, DocumentRecord, TrajectoryExperience, RawRecord } from "./event";

function ev(seq: number, opts: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    src: "claude-code",
    sid: "s1",
    proj: "/work/app",
    ts: "2026-06-15T00:00:00.000Z",
    seq,
    kind: "msg",
    role: "user",
    text: `event ${seq}`,
    ...opts,
  };
}

function raw(line: string, opts: Partial<RawRecord> = {}): RawRecord {
  return {
    raw: JSON.stringify({ type: "test_raw", text: line }),
    src: "claude-code",
    sid: "s1",
    proj: "/work/app",
    ...opts,
  };
}

function rawJson(line: string, opts: Partial<RawRecord> = {}): RawRecord {
  return { ...raw("", opts), raw: line };
}

function doc(id = "doc-1", text = "scrubbed memory"): DocumentRecord {
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
      text,
      sourceUpdatedAt: "2026-06-15T00:00:00.000Z",
      capturedAt: "2026-06-15T00:01:00.000Z",
      revision: "r1",
      deleted: false,
      chunkIndex: 0,
      chunkCount: 1,
    },
  };
}

function trajectories(records: Parameters<typeof groupIntoExperiences>[0]): TrajectoryExperience[] {
  return groupIntoExperiences(records).filter((experience): experience is TrajectoryExperience => experience.type === "trajectory");
}

describe("groupIntoExperiences", () => {
  test("sanitizes legacy queued raw JSON before egress", () => {
    const g = trajectories([
      ev(0),
      rawJson('{"payload":{"signature":"opaque","encrypted_content":"opaque","thinking":"keep"}}'),
    ])[0]!;
    expect(g.data).toEqual(['{"payload":{"thinking":"keep"}}']);
  });

  test("drops malformed legacy raw records rather than bypassing sanitation", () => {
    const g = trajectories([ev(0), rawJson("{ not json")])[0]!;
    expect("data" in g).toBe(false);
  });

  test("groups by turn, preserving first-seen order and intra-group step order", () => {
    const groups = trajectories([
      ev(0, { turn: 1 }),
      ev(1, { turn: 1 }),
      ev(2, { turn: 2 }),
      ev(3, { turn: 2 }),
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0]!.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(groups[1]!.events.map((e) => e.seq)).toEqual([2, 3]);
    // turn is the grouping key but rides on the STEPS, never the envelope
    expect(groups[0]!.events.every((e) => e.turn === 1)).toBe(true);
    expect(groups[1]!.events.every((e) => e.turn === 2)).toBe(true);
    expect("turn" in groups[0]!).toBe(false);
  });

  test("CaptureEvents fill `events`, RawRecords' strings fill `data`, per turn", () => {
    const groups = trajectories([
      ev(0, { turn: 1 }),
      raw("line-a", { turn: 1 }),
      ev(1, { turn: 1 }),
      raw("line-b", { turn: 2 }),
      ev(2, { turn: 2 }),
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0]!.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(groups[0]!.data).toEqual([raw("line-a").raw]);
    expect(groups[1]!.events.map((e) => e.seq)).toEqual([2]);
    expect(groups[1]!.data).toEqual([raw("line-b").raw]);
  });

  test("`data` is omitted (not empty) when a group has no raws", () => {
    const g = trajectories([ev(0, { turn: 1 })])[0]!;
    expect("data" in g).toBe(false);
  });

  test("a group with zero events is DROPPED — a trajectory without steps is unshippable", () => {
    const groups = trajectories([
      raw("orphan raw", { turn: 1 }), // whole turn produced no events
      ev(0, { turn: 2 }),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0]!.events.map((e) => e.seq)).toEqual([0]);
  });

  test("splits by session as well as turn", () => {
    const groups = trajectories([
      ev(0, { turn: 1, sid: "a" }),
      ev(0, { turn: 1, sid: "b" }),
    ]);
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.sid)).toEqual(["a", "b"]);
  });

  test("records without a turn stamp bucket as turn 0 (their own envelope)", () => {
    const groups = trajectories([ev(0), raw("preamble"), ev(1, { turn: 1 })]);
    expect(groups.length).toBe(2);
    expect(groups[0]!.events.map((e) => e.seq)).toEqual([0]);
    expect(groups[0]!.data).toEqual([raw("preamble").raw]);
    expect(groups[1]!.events.map((e) => e.seq)).toEqual([1]);
  });

  test("envelope carries the identity triple and the trajectory type", () => {
    const g = trajectories([ev(0, { turn: 3 })])[0]!;
    expect(g).toMatchObject({ src: "claude-code", sid: "s1", proj: "/work/app", type: "trajectory" });
  });

  test("keeps document records as standalone doc experiences beside trajectories", () => {
    const experiences = groupIntoExperiences([ev(0, { turn: 1 }), doc(), raw("raw", { turn: 1 })]);
    expect(experiences).toHaveLength(2);
    expect(experiences[0]).toMatchObject({ type: "trajectory", events: [expect.objectContaining({ seq: 0 })], data: [raw("raw").raw] });
    expect(experiences[1]).toMatchObject({ type: "doc", sid: "memory-doc-1", data: expect.objectContaining({ documentId: "doc-1" }) });
    expect("events" in experiences[1]!).toBe(false);
  });
});

describe("boundExperienceSize", () => {
  const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x), "utf8");

  test("an experience under the cap passes through untouched (same reference)", () => {
    const exp: TrajectoryExperience = {
      src: "claude-code",
      sid: "s1",
      proj: "/p",
      type: "trajectory",
      events: [ev(0)],
      data: ["small"],
    };
    const out = boundExperienceSize(exp);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(exp);
  });

  test("a bounded document remains a standalone doc envelope with no events", () => {
    const exp = doc();
    const out = boundExperienceSize(exp);
    expect(out).toEqual([exp]);
    expect("events" in out[0]!).toBe(false);
  });

  test("an unexpected oversized document is bounded loudly without splitting a Unicode scalar", () => {
    const exp = doc("oversized", "😊".repeat(MAX_EXPERIENCE_BYTES));
    const out = boundExperienceSize(exp);
    expect(out).toHaveLength(1);
    expect(out[0]!.data.text.endsWith(DOCUMENT_TRUNCATION_MARKER)).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out[0]!.data.text)).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(out[0]), "utf8")).toBeLessThanOrEqual(MAX_EXPERIENCE_BYTES);
  });

  test("rung 1.5: an oversize experience keeps events; raw data becomes a loud [marker]-only array when NOTHING fits (G8)", () => {
    const huge = "x".repeat(MAX_EXPERIENCE_BYTES); // this one raw line alone busts the cap
    const exp: TrajectoryExperience = {
      src: "claude-code",
      sid: "s1",
      proj: "/p",
      type: "trajectory",
      events: [ev(0)],
      data: [huge],
    };
    const out = boundExperienceSize(exp);
    expect(out.length).toBe(1);
    expect(out[0]!.data?.length).toBe(1); // NOT omitted — the wire contract forbids an empty array too
    expect(out[0]!.data![0]).toContain("1 of 1 raw line(s) dropped");
    expect(out[0]!.events.map((e) => e.seq)).toEqual([0]);
    expect(bytes(out[0])).toBeLessThanOrEqual(MAX_EXPERIENCE_BYTES);
  });

  test("the cap measures UTF-8 BYTES, not UTF-16 units — multi-byte data still gets the drop treatment", () => {
    // 300K CJK chars ≈ 300K UTF-16 units (fits the cap as .length) but ~900KB
    // UTF-8 on the wire (over it). A .length check would fail open here and
    // let the envelope wedge the outbox against the backend byte limit.
    const cjk = "語".repeat(300_000);
    const exp: TrajectoryExperience = {
      src: "claude-code",
      sid: "s1",
      proj: "/p",
      type: "trajectory",
      events: [ev(0)],
      data: [cjk],
    };
    expect(JSON.stringify(exp).length).toBeLessThanOrEqual(MAX_EXPERIENCE_BYTES); // the trap: units fit…
    const out = boundExperienceSize(exp);
    expect(out.length).toBe(1);
    expect(out[0]!.data).toEqual([expect.stringContaining("1 of 1 raw line(s) dropped")]); // …but bytes don't
    expect(bytes(out[0])).toBeLessThanOrEqual(MAX_EXPERIENCE_BYTES);
  });

  describe("rung 1.5 (G8): keep the raw lines that fit, mark the rest — never a silent full drop", () => {
    test("a fitting PREFIX of data is kept verbatim, with a trailing marker for what didn't fit", () => {
      // Small events; three raw lines where the first two together comfortably
      // fit the remaining budget but the third alone busts the cap.
      const small = "keep-me";
      const huge = "x".repeat(MAX_EXPERIENCE_BYTES);
      const exp: TrajectoryExperience = {
        src: "claude-code",
        sid: "s1",
        proj: "/p",
        type: "trajectory",
        events: [ev(0)],
        data: [small, small, huge],
      };
      const out = boundExperienceSize(exp);
      expect(out.length).toBe(1);
      expect(out[0]!.data).toEqual([small, small, expect.stringContaining("1 of 3 raw line(s) dropped")]);
      expect(bytes(out[0])).toBeLessThanOrEqual(MAX_EXPERIENCE_BYTES);
    });

    test("when literally nothing fits, data becomes [marker] only — never an empty array", () => {
      const hugeA = "a".repeat(MAX_EXPERIENCE_BYTES);
      const hugeB = "b".repeat(MAX_EXPERIENCE_BYTES);
      const exp: TrajectoryExperience = {
        src: "claude-code",
        sid: "s1",
        proj: "/p",
        type: "trajectory",
        events: [ev(0)],
        data: [hugeA, hugeB],
      };
      const out = boundExperienceSize(exp);
      expect(out[0]!.data!.length).toBe(1);
      expect(out[0]!.data![0]).toContain("2 of 2 raw line(s) dropped");
      expect(bytes(out[0])).toBeLessThanOrEqual(MAX_EXPERIENCE_BYTES);
    });

    test("many small raw lines that saturate the budget to the last byte still yield an envelope ≤ the cap (no structural overshoot)", () => {
      // Regression: the budget must reserve the `,"data":[]` framing, or a
      // marker-terminated kept prefix packed to the boundary serializes to
      // MAX + ~9 bytes. Thousands of tiny lines force the tight-packing path.
      const data: string[] = [];
      for (let i = 0; i < 60_000; i++) data.push("x".repeat(8));
      const exp: TrajectoryExperience = {
        src: "claude-code",
        sid: "s1",
        proj: "/p",
        type: "trajectory",
        events: [ev(0, { text: "hi" })],
        data,
      };
      expect(bytes(exp)).toBeGreaterThan(MAX_EXPERIENCE_BYTES); // input really is over the cap
      const out = boundExperienceSize(exp);
      expect(out.length).toBe(1);
      expect(bytes(out[0])).toBeLessThanOrEqual(MAX_EXPERIENCE_BYTES); // provably under, not MAX+9
      // a prefix was kept and a marker appended (packing didn't just drop everything)
      expect(out[0]!.data!.length).toBeGreaterThan(1);
      expect(out[0]!.data![out[0]!.data!.length - 1]).toContain("raw line(s) dropped");
    });
  });

  describe("boundRawData (G8) — the rung 1.5 helper in isolation", () => {
    test("when the walk keeps every line, no marker is appended", () => {
      const eventsOnly: Omit<TrajectoryExperience, "data"> = { src: "claude-code", sid: "s1", proj: "/p", type: "trajectory", events: [ev(0)] };
      const out = boundRawData(eventsOnly, ["a", "b", "c"]);
      expect(out.data).toEqual(["a", "b", "c"]); // every line kept — nothing was dropped, so no marker
    });

    test("undefined/empty data is passed through unchanged", () => {
      const eventsOnly = { src: "claude-code" as const, sid: "s1", proj: "/p", type: "trajectory" as const, events: [ev(0)] };
      expect(boundRawData(eventsOnly, undefined)).toEqual(eventsOnly);
      expect(boundRawData(eventsOnly, [])).toEqual(eventsOnly);
    });

    test("when even the marker itself wouldn't fit, data is omitted entirely rather than busting the cap", () => {
      // Fill the envelope to ~10 bytes under the cap so there's no room for even
      // the (reserved ~90-byte) marker → boundRawData omits data, and the
      // returned events-only envelope is itself still under the cap.
      const meta = { src: "claude-code" as const, sid: "s1", proj: "/p", type: "trajectory" as const };
      const overhead = bytes({ ...meta, events: [ev(0, { text: "" })], data: [] });
      const eventsOnly: Omit<TrajectoryExperience, "data"> = { ...meta, events: [ev(0, { text: "e".repeat(MAX_EXPERIENCE_BYTES - overhead - 10) })] };
      expect(bytes(eventsOnly)).toBeLessThanOrEqual(MAX_EXPERIENCE_BYTES); // precondition: events-only still fits
      const out = boundRawData(eventsOnly, ["some raw line"]);
      expect("data" in out).toBe(false);
      expect(bytes(out)).toBeLessThanOrEqual(MAX_EXPERIENCE_BYTES);
    });
  });

  test("rung 2: an events-ONLY oversize splits into envelopes with disjoint contiguous seq ranges", () => {
    // 5 steps × ~200KB text ≈ 1MB events alone — must split, not wedge.
    const big = "x".repeat(200 * 1024);
    const exp: TrajectoryExperience = {
      src: "claude-code",
      sid: "s1",
      proj: "/p",
      type: "trajectory",
      events: [0, 1, 2, 3, 4].map((i) => ev(i, { text: big })),
      data: ["shed me first"],
    };
    const parts = boundExperienceSize(exp);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(bytes(p)).toBeLessThanOrEqual(MAX_EXPERIENCE_BYTES);
      expect("data" in p).toBe(false); // the raw channel was shed before splitting
      expect(p).toMatchObject({ src: "claude-code", sid: "s1", proj: "/p", type: "trajectory" });
    }
    // Union preserves every step, in order; ranges are disjoint and ascending
    // (same sid + disjoint seq ranges = separate records, merged on read).
    expect(parts.flatMap((p) => p.events.map((e) => e.seq))).toEqual([0, 1, 2, 3, 4]);
    for (let i = 1; i < parts.length; i++) {
      expect(Math.min(...parts[i]!.events.map((e) => e.seq))).toBeGreaterThan(
        Math.max(...parts[i - 1]!.events.map((e) => e.seq)),
      );
    }
    // Steps that fit are carried VERBATIM (no truncation on the split path).
    expect(parts[0]!.events[0]!.text).toBe(big);
  });

  test("rung 3: a single step over the cap is truncated with the loud marker — seq and identity survive", () => {
    const giant = ev(7, { text: "y".repeat(MAX_EXPERIENCE_BYTES * 2) });
    const exp: TrajectoryExperience = { src: "claude-code", sid: "s1", proj: "/p", type: "trajectory", events: [ev(6), giant] };
    const parts = boundExperienceSize(exp);
    const all = parts.flatMap((p) => p.events);
    expect(all.map((e) => e.seq)).toEqual([6, 7]); // nothing dropped, order kept
    const truncated = all.find((e) => e.seq === 7)!;
    expect(truncated.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(truncated.text.length).toBeLessThan(giant.text.length);
    expect(all.find((e) => e.seq === 6)!.text).toBe(ev(6).text); // neighbors untouched
    for (const p of parts) expect(bytes(p)).toBeLessThanOrEqual(MAX_EXPERIENCE_BYTES);
  });
});

describe("packBodies", () => {
  const mk = (seq: number, kb: number): TrajectoryExperience => ({
    src: "claude-code",
    sid: "s1",
    proj: "/p",
    type: "trajectory",
    events: [ev(seq, { text: "z".repeat(kb * 1024) })],
  });

  test("small experiences ride one body", () => {
    const a = mk(0, 1);
    const b = mk(1, 1);
    expect(packBodies([a, b])).toEqual([[a, b]]);
  });

  test("packing splits at MAX_BODY_BYTES, order-preserving, every body under budget", () => {
    // Three ~400KB experiences ≈ 1.2MB total → 2 bodies ([a,b], [c]).
    const a = mk(0, 400);
    const b = mk(1, 400);
    const c = mk(2, 400);
    const bodies = packBodies([a, b, c]);
    expect(bodies.length).toBe(2);
    expect(bodies.flat()).toEqual([a, b, c]);
    for (const body of bodies) {
      expect(Buffer.byteLength(JSON.stringify({ experiences: body }), "utf8")).toBeLessThanOrEqual(MAX_BODY_BYTES);
    }
  });
});

describe("single-flight lock", () => {
  let project: string;
  beforeEach(() => (project = mkdtempSync(join(tmpdir(), "aug-lock-"))));
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  test("second acquire fails while held; releases for reacquire", () => {
    expect(acquireLock(project)).toBe(true);
    expect(acquireLock(project)).toBe(false);
    releaseLock(project);
    expect(acquireLock(project)).toBe(true);
    releaseLock(project);
  });
});

describe("drain against a real loopback endpoint", () => {
  let project: string;
  let box: Outbox;
  let received: { count: number; bodies: Array<{ experiences: TrajectoryExperience[] }> };
  let server: ReturnType<typeof Bun.serve>;

  function startServer(status = 202) {
    received = { count: 0, bodies: [] };
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { experiences: Array<{ type?: unknown; events?: unknown; data?: unknown }> };
        received.bodies.push(body as unknown as { experiences: TrajectoryExperience[] });
        received.count +=
          body.experiences?.reduce((n, x) => {
            if (x.type === "doc") return n + 1;
            const events = Array.isArray(x.events) ? x.events.length : 0;
            const data = Array.isArray(x.data) ? x.data.length : 0;
            return n + events + data;
          }, 0) ?? 0;
        return new Response("", { status });
      },
    });
  }
  const url = () => `http://127.0.0.1:${server.port}/v1/experiences`;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "aug-ship-"));
    box = new Outbox(project);
  });
  afterEach(() => {
    server?.stop(true);
    rmSync(project, { recursive: true, force: true });
  });

  test("ships pending records turn-grouped as { experiences: [{…, events, data}] }, advances the cursor, compacts on 2xx", async () => {
    startServer(202);
    box.append([
      ev(0, { turn: 1 }),
      ev(1, { turn: 1 }),
      raw("raw-turn-1", { turn: 1 }),
      ev(2, { turn: 2 }),
      raw("raw-turn-2", { turn: 2 }),
    ]);

    const res = await drain({ url: url(), projectRoot: project });
    expect(res.shipped).toBe(5);
    expect(res.lastStatus).toBe(202);
    expect(received.count).toBe(5);
    // body must be the turn-grouped envelope shape — not a flat record list
    const body = received.bodies[0]!;
    expect(body.experiences).toBeDefined();
    expect(body.experiences.length).toBe(2);
    expect(body.experiences[0]!).toMatchObject({ sid: "s1", type: "trajectory" }); // the envelope names the kind
    expect("turn" in body.experiences[0]!).toBe(false); // turn rides on the steps, not the envelope
    expect(body.experiences[0]!.events.length).toBe(2);
    expect(body.experiences[0]!.events.map((e) => e.turn)).toEqual([1, 1]);
    expect(body.experiences[0]!.data).toEqual([raw("raw-turn-1").raw]); // the raw channel, sanitized JSON strings
    expect(body.experiences[1]!.events.map((e) => e.turn)).toEqual([2]);
    expect(body.experiences[1]!.data).toEqual([raw("raw-turn-2").raw]);
    // cursor advanced → nothing left pending
    expect(box.readPending().records).toEqual([]);
  });

  test("ships a document as its own type: doc experience without an events field", async () => {
    startServer(202);
    box.append([doc("memory-1")]);

    const result = await drain({ url: url(), projectRoot: project });
    expect(result).toMatchObject({ shipped: 1, lastStatus: 202 });
    const wire = received.bodies[0]!.experiences[0]! as unknown as DocumentRecord;
    expect(wire).toMatchObject({ type: "doc", sid: "memory-memory-1", data: { documentId: "memory-1" } });
    expect("events" in wire).toBe(false);
    expect(box.readPending().records).toEqual([]);
  });

  test("batches large spools; maxBatch bounds combined spool records per slice", async () => {
    startServer(202);
    // 3 events + 3 raws, all one turn → 6 records → 3 POSTs at maxBatch 2.
    box.append([
      ev(0, { turn: 1 }),
      ev(1, { turn: 1 }),
      ev(2, { turn: 1 }),
      raw("r0", { turn: 1 }),
      raw("r1", { turn: 1 }),
      raw("r2", { turn: 1 }),
    ]);

    const res = await drain({ url: url(), projectRoot: project, maxBatch: 2 });
    expect(res.shipped).toBe(6); // every record consumed
    // Slices: [ev0,ev1] POSTed, [ev2,r0] POSTed, [r1,r2] is a zero-event group —
    // consumed WITHOUT a POST (dropped by design; a raw-only slice is unshippable).
    expect(res.batches).toBe(2);
    expect(received.bodies.length).toBe(2);
    expect(received.bodies[0]!.experiences[0]!.events.map((e) => e.seq)).toEqual([0, 1]);
    expect("data" in received.bodies[0]!.experiences[0]!).toBe(false);
    // A turn split across batches repeats its envelope.
    expect(received.bodies[1]!.experiences[0]!.events.map((e) => e.seq)).toEqual([2]);
    expect(received.bodies[1]!.experiences[0]!.data).toEqual([raw("r0").raw]);
    expect(box.readPending().records).toEqual([]); // fully drained
  });

  test("an oversize experience ships events + a loud raw-drop marker (G8) — never wedging the outbox", async () => {
    startServer(202);
    const huge = "x".repeat(MAX_EXPERIENCE_BYTES); // this raw alone busts the cap
    box.append([ev(0, { turn: 1 }), raw(huge, { turn: 1 })]);

    const res = await drain({ url: url(), projectRoot: project });
    expect(res.shipped).toBe(2);
    expect(res.lastStatus).toBe(202);
    const exp = received.bodies[0]!.experiences[0]!;
    expect(exp.events.map((e) => e.seq)).toEqual([0]);
    expect(exp.data).toEqual([expect.stringContaining("1 of 1 raw line(s) dropped")]); // marker, not a silent drop
    // drained clean — no permanent retry loop
    expect(box.readPending().records).toEqual([]);
  });

  test("a giant events-ONLY turn ships split across bounded envelopes and bodies — never wedges", async () => {
    startServer(202);
    // 5 steps × ~200KB text: over the per-envelope cap with no raw channel to
    // shed — the pre-guard code shipped this as one >1MB envelope and wedged.
    const big = "x".repeat(200 * 1024);
    box.append([0, 1, 2, 3, 4].map((i) => ev(i, { turn: 1, text: big })));

    const res = await drain({ url: url(), projectRoot: project });
    expect(res.shipped).toBe(5);
    expect(res.lastStatus).toBe(202);
    const exps = received.bodies.flatMap((b) => b.experiences);
    expect(exps.length).toBeGreaterThan(1); // split into disjoint-seq envelopes
    expect(exps.flatMap((x) => x.events.map((e) => e.seq))).toEqual([0, 1, 2, 3, 4]);
    for (const b of received.bodies) {
      expect(Buffer.byteLength(JSON.stringify(b), "utf8")).toBeLessThanOrEqual(MAX_BODY_BYTES);
    }
    expect(box.readPending().records).toEqual([]); // drained clean — no retry loop
  });

  test("a mid-slice body failure keeps the WHOLE slice pending (redelivery is idempotent server-side)", async () => {
    // First POST 202s, everything after 500s — the slice needs ≥2 bodies.
    let calls = 0;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        await req.text(); // drain the upload — responding early can reset the client mid-body
        calls += 1;
        return new Response("", { status: calls === 1 ? 202 : 500 });
      },
    });
    // 6 steps → three ~410KB envelopes ≈ 1.23MB total → guaranteed ≥2 bodies.
    const big = "x".repeat(200 * 1024);
    box.append([0, 1, 2, 3, 4, 5].map((i) => ev(i, { turn: 1, text: big })));

    const res = await drain({ url: url(), projectRoot: project });
    expect(calls).toBeGreaterThan(1); // the packing really produced multiple bodies
    expect(res.lastStatus).toBe(500);
    expect(res.shipped).toBe(0); // cursor NOT advanced past the partially-shipped slice
    expect(new Outbox(project).readPending().records.length).toBe(6); // all 6 retry next drain
  });

  describe("spool-cap overflow episode (G3) — drain() clears it once the spool is genuinely empty", () => {
    test("a fully-draining drain clears an active drop episode", async () => {
      startServer(202);
      box.markDropped(); // simulate an overflow episode capture.ts flagged earlier
      box.append([ev(0)]);

      const res = await drain({ url: url(), projectRoot: project });
      expect(res.shipped).toBe(1);
      expect(box.markDropped()).toBe(true); // episode was cleared — this counts as a NEW one
    });

    test("a drain that leaves the slice pending (transient failure) does NOT clear the episode", async () => {
      startServer(500);
      box.markDropped();
      box.append([ev(0)]);

      const res = await drain({ url: url(), projectRoot: project });
      expect(res.shipped).toBe(0); // nothing drained — spool still has pending bytes
      expect(box.markDropped()).toBe(false); // episode still active — not falsely cleared
    });
  });

  describe("permanent-rejection quarantine (G4) — a 400/413/422 never wedges the outbox", () => {
    const rejectedPath = () => join(project, ".augenta", "outbox", "rejected.jsonl");
    const readRejected = (): Array<{ ts: string; status: number; error?: string; experiences: TrajectoryExperience[] }> =>
      readFileSync(rejectedPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));

    test("an all-400 drain still advances the cursor — the rejected body is quarantined, not retried forever", async () => {
      startServer(400);
      box.append([ev(0, { turn: 1 }), ev(1, { turn: 1 })]);

      const res = await drain({ url: url(), projectRoot: project });
      expect(res.shipped).toBe(2); // consumed — either shipped or quarantined, never left to wedge
      expect(res.lastStatus).toBe(400);
      expect(box.readPending().records).toEqual([]); // cursor advanced past the rejected body

      const rejected = readRejected();
      expect(rejected.length).toBe(1);
      expect(rejected[0]!.status).toBe(400);
      expect(rejected[0]!.experiences[0]!.events.map((e) => e.seq)).toEqual([0, 1]);
    });

    test("413 is quarantined exactly like 400 (both are permanent, deterministic rejections)", async () => {
      startServer(413);
      box.append([ev(0, { turn: 1 })]);

      const res = await drain({ url: url(), projectRoot: project });
      expect(res.shipped).toBe(1);
      expect(box.readPending().records).toEqual([]);
      expect(readRejected()[0]!.status).toBe(413);
    });

    test("mixed 202/400/202 across a drain: only the rejected body is quarantined, the accepted ones ship normally", async () => {
      let call = 0;
      server = Bun.serve({
        port: 0,
        async fetch(req) {
          const body = (await req.json()) as { experiences: TrajectoryExperience[] };
          received.bodies.push(body);
          call += 1;
          return new Response(call === 2 ? "door: bad sid" : "", { status: call === 2 ? 400 : 202 });
        },
      });
      // One record per turn + maxBatch:1 forces one body per slice, so the
      // 2nd drain-loop iteration is exactly the 2nd POST.
      box.append([ev(0, { turn: 1 }), ev(1, { turn: 2 }), ev(2, { turn: 3 })]);

      const res = await drain({ url: url(), projectRoot: project, maxBatch: 1 });
      expect(res.shipped).toBe(3); // all three consumed
      expect(box.readPending().records).toEqual([]);

      const rejected = readRejected();
      expect(rejected.length).toBe(1); // only the middle (400) body quarantined
      expect(rejected[0]!.status).toBe(400);
      expect(rejected[0]!.error).toBe("door: bad sid");
      expect(rejected[0]!.experiences[0]!.events.map((e) => e.seq)).toEqual([1]); // the turn-2 event
    });

    test("400-then-500 in the SAME slice keeps the whole slice pending — no quarantine (mixed transient+permanent never partially commits)", async () => {
      let call = 0;
      server = Bun.serve({
        port: 0,
        async fetch(req) {
          await req.text();
          call += 1;
          return new Response("", { status: call === 1 ? 400 : 500 });
        },
      });
      // Three ~400KB single-event turns: under the boundExperienceSize cap
      // individually (no truncation), but packBodies packs them [turn1+turn2]
      // then [turn3] — two bodies in ONE slice, matching the packBodies unit
      // test's own packing math for this size.
      const big = "x".repeat(400 * 1024);
      box.append([1, 2, 3].map((t) => ev(t - 1, { turn: t, text: big })));

      const res = await drain({ url: url(), projectRoot: project });
      expect(call).toBeGreaterThan(1); // really did produce ≥2 bodies in one slice
      expect(res.lastStatus).toBe(500);
      expect(res.shipped).toBe(0); // whole slice kept pending — nothing committed
      expect(box.readPending().records.length).toBe(3);
      expect(existsSync(rejectedPath())).toBe(false); // the 400 seen before the 500 was NEVER persisted
    });
  });

  test("a batch of only zero-event groups is consumed without a POST (orphan raws never wedge the spool)", async () => {
    startServer(202);
    box.append([raw("orphan-1", { turn: 1 }), raw("orphan-2", { turn: 1 })]);

    const res = await drain({ url: url(), projectRoot: project });
    expect(received.bodies.length).toBe(0); // nothing shippable → no POST
    expect(res.shipped).toBe(2); // but the records are consumed
    expect(box.readPending().records).toEqual([]);
  });

  test("non-2xx keeps the batch for retry (cursor not advanced)", async () => {
    startServer(500);
    box.append([ev(0), raw("keep-me")]);

    const res = await drain({ url: url(), projectRoot: project });
    expect(res.shipped).toBe(0);
    expect(res.lastStatus).toBe(500);
    expect(box.readPending().records.length).toBe(2); // still pending — event and raw
  });

  test("network error keeps the batch for retry", async () => {
    // No server on this port → fetch rejects.
    box.append([ev(0)]);
    const res = await drain({ url: "http://127.0.0.1:1/v1/experiences", projectRoot: project });
    expect(res.shipped).toBe(0);
    expect(box.readPending().records.length).toBe(1);
  });
});
