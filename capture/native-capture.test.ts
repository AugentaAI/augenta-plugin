import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture } from "./capture";
import { CaptureState } from "./capture-cursor";
import { Outbox, isCaptureEvent } from "./outbox";

test("native turn and sequence survive an empty PreCompact, rewrite and incremental continuation", () => {
  const p = mkdtempSync(join(tmpdir(), "aug-native-compact-"));
  try {
    mkdirSync(join(p, ".codex"));
    const path = join(p, ".codex/rollout.jsonl");
    const row = (type: string, payload: object) => JSON.stringify({ type, timestamp: "2026-09-11T18:00:00Z", payload }) + "\n";
    const msg = (text: string) => row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
    writeFileSync(path, row("event_msg", { type: "task_started", turn_id: "a" }) + msg("before"));
    const capture = (event: string) => runCapture({ cwd: p, session_id: "s", transcript_path: path, hook_event_name: event }, { projectRoot: p, spawnShipper: false });
    capture("PostToolUse");
    const before = new CaptureState(p).get(path);
    capture("PreCompact"); // nothing left to read, but the next rewrite still needs a baseline
    expect(new CaptureState(p).get(path).rebaseline).toBe(true);
    writeFileSync(path, row("compacted", {}));
    capture("PostCompact");
    appendFileSync(path, msg("after"));
    capture("PostToolUse");
    const records = new Outbox(p).readPending().records.filter(isCaptureEvent);
    expect(records.map(e => [e.text, e.turn, e.seq])).toEqual([["before", 1, 0], ["after", 1, 1]]);
    expect(new CaptureState(p).get(path).seq).toBe(before.seq + 1);
    capture("PostToolUse");
    expect(new Outbox(p).readPending().records.filter(isCaptureEvent)).toHaveLength(2);
  } finally { rmSync(p, { recursive: true, force: true }); }
});
