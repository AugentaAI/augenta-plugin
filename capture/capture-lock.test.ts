import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox, isCaptureEvent } from "./outbox";

test("concurrent installed capture processes preserve per-transcript seq and the shared cursor map", async () => {
  const p = mkdtempSync(join(tmpdir(), "aug-capture-concurrent-"));
  try {
    mkdirSync(join(p, ".augenta")); mkdirSync(join(p, ".codex"));
    writeFileSync(join(p, ".augenta/config.json"), JSON.stringify({ authMode: "api-key", apiKey: "fixture" }));
    const paths = [join(p, ".codex/a.jsonl"), join(p, ".codex/b.jsonl")];
    for (const [i, path] of paths.entries()) writeFileSync(path, [
      { type: "event_msg", payload: { type: "task_started", turn_id: `turn-${i}` } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `final-${i}` }] } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const child = Bun.spawn(["node", join(import.meta.dir, "../dist/capture/capture.mjs")], {
        env: { PATH: process.env.PATH, HOME: p }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      child.stdin.write(JSON.stringify({ cwd: p, session_id: `s-${i % 2}`, transcript_path: paths[i % 2], hook_event_name: "PostToolUse" }));
      child.stdin.end();
      expect(await child.exited).toBe(0);
    }));
    const events = new Outbox(p).readPending().records.filter(isCaptureEvent);
    expect(events.map(e => e.text).sort()).toEqual(["final-0", "final-1"]);
    const cursors = JSON.parse(readFileSync(join(p, ".augenta/state/capture.json"), "utf8"));
    expect(Object.keys(cursors).sort()).toEqual(paths.sort());
    expect(Object.values(cursors).map((c: any) => c.seq)).toEqual([1, 1]);
  } finally { rmSync(p, { recursive: true, force: true }); }
});
