import { describe, expect, test } from "bun:test";
import { normalizeNativeTurns } from "./native-turns";
import { groupIntoExperiences } from "./ship";

const ts = "2026-09-11T18:00:00.000Z";
const row = (type: string, payload: object, timestamp = ts) => JSON.stringify({ type, timestamp, payload });
const start = (id: string, timestamp = ts) => row("event_msg", { type: "task_started", turn_id: id, started_at: Math.floor(Date.parse(timestamp) / 1000) }, timestamp);
const context = (id: string) => row("turn_context", { turn_id: id, model: "test-model" });
const message = (text: string) => row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const end = (id: string) => row("event_msg", { type: "task_complete", turn_id: id });
const opts = (lines: string[], seq = 0, off = 0) => ({ lines, startSeq: seq, startOffset: off,
  ctx: { sessionId: "test", project: "/test", transcriptPath: "/test/rollout.jsonl" } });

describe("Codex native turns (sanitized desktop schema)", () => {
  test("delayed read keeps two completed turns separate, without prompt state", () => {
    const r = normalizeNativeTurns(opts([start("a"), context("a"), message("first final"), end("a"), start("b"), context("b"), message("second final"), end("b")]));
    const groups = groupIntoExperiences(r.records);
    expect(groups).toHaveLength(2);
    expect(r.events.map(e => [e.text, e.turn, e.turn_source])).toEqual([["first final", 1, "native"], ["second final", 2, "native"]]);
    expect(new Set(r.events.map(e => e.seq)).size).toBe(r.events.length);
  });
  test("incremental restart retains identity and repeated context does not bump it", () => {
    const a = normalizeNativeTurns(opts([start("a"), context("a"), message("tool response")]));
    const b = normalizeNativeTurns(opts([context("a"), message("final"), end("a")], a.nextSeq, a.nextOffset), JSON.parse(JSON.stringify(a.turns)));
    expect(b.events[0]?.turn).toBe(1);
    expect(b.events[0]?.seq).toBe(a.nextSeq);
    expect(b.events[0]?.model).toBe("test-model");
    expect(b.turns.active).toBeUndefined();
  });
  test("ambiguous messages are unknown, never inferred as separate turns", () => {
    const r = normalizeNativeTurns(opts([message("one"), message("two"), start("known"), message("three")]));
    expect(r.events.map(e => [e.turn, e.turn_source])).toEqual([[0, "unknown"], [0, "unknown"], [1, "native"]]);
  });
  test("first context can recover a known boundary when task_started is absent", () => {
    const r = normalizeNativeTurns(opts([context("a"), message("a"), context("b"), message("b")]));
    expect(r.events.map(e => e.turn)).toEqual([1, 2]);
  });
  test("consent excludes ambiguous history and entire pre-connection turn on both channels", () => {
    const since = "2026-09-11T18:00:01.000Z";
    const a = normalizeNativeTurns(opts([message("unknown private history"), start("old"), message("old")]), undefined, since);
    const b = normalizeNativeTurns(opts([context("old"), message("still old"), end("old"), start("new", "2026-09-11T18:00:02Z"), message("eligible"), end("new")], a.nextSeq, a.nextOffset), a.turns, since);
    expect(a.records).toEqual([]);
    expect(b.events.map(e => e.text)).toEqual(["eligible"]);
    expect(JSON.stringify(b.records)).not.toContain('"old"');
  });
  test("prototype-looking native IDs are data", () => {
    const r = normalizeNativeTurns(opts([start("__proto__"), message("a"), end("__proto__"), start("constructor"), message("b")]));
    expect(r.events.map(e => e.turn)).toEqual([1, 2]);
    expect(JSON.parse(JSON.stringify(r.turns)).ids.__proto__).toBe(1);
  });
});

test("reconnection invalidates an in-flight turn's previous consent", () => {
  const a = normalizeNativeTurns(opts([start("active"), message("before reconnect")]));
  const b = normalizeNativeTurns(opts([context("active"), message("after reconnect"), end("active"),
    start("new", "2026-09-11T18:00:03Z"), message("new consent")], a.nextSeq, a.nextOffset), a.turns, "2026-09-11T18:00:02Z");
  expect(b.events.map(e => e.text)).toEqual(["new consent"]);
});
