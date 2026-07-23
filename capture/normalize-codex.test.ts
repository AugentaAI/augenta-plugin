/**
 * SCOPE: developer verification of normalize-codex.ts — Codex (OpenAI Codex CLI)
 * rollout JSONL → neutral CaptureEvents.
 *
 * Contract under test: only `response_item` lines map (session_meta / event_msg /
 * turn_context are skipped, so UI-stream duplicates don't double-count); correct
 * kind/role per payload type; tool name + serialized args on function_call; the
 * conversation id recovered from the rollout PATH (the canonical UUID) ahead of
 * the hook fallback; monotonic seq + exact byte offsets; injectable scrubber;
 * resilience to corrupt lines.
 *
 * Run: bun test plugin/ingest/normalize-codex.test.ts
 */
import { test, expect, describe } from "bun:test";
import { normalizeCodexRollout } from "./normalize-codex";
import { type NormalizeCtx } from "./normalize-core";

// A realistic rollout path so the canonical session UUID is recovered from it.
const codexCtx: NormalizeCtx = {
  sessionId: "unknown", // capture's fallback when the hook omits session_id
  project: "/work/app",
  transcriptPath: "/u/.codex/sessions/2026/06/28/rollout-2026-06-28T17-15-11-019f1016-1871-7170-b219-c79eb84757a5.jsonl",
  harness: "codex",
};
const SID = "019f1016-1871-7170-b219-c79eb84757a5";

/** A Codex rollout envelope: { timestamp, type, payload }. */
function item(payload: unknown, type = "response_item"): string {
  return JSON.stringify({ timestamp: "2026-06-28T17:15:11.000Z", type, payload });
}

describe("normalizeCodexRollout", () => {
  test("user message → msg(user); conversation id from the rollout path", () => {
    const lines = [item({ type: "message", role: "user", content: [{ type: "input_text", text: "say hi" }] })];
    const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.kind).toBe("msg");
    expect(e.role).toBe("user");
    expect(e.text).toBe("say hi");
    // Path-derived UUID beats the "unknown" hook fallback.
    expect(e.sid).toBe(SID);
    expect(e.src).toBe("codex");
  });

  test("assistant message → msg(assistant)", () => {
    const lines = [item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] })];
    const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
    expect(events[0]!.role).toBe("assistant");
    expect(events[0]!.text).toBe("ok");
  });

  test("developer/system message → session(system)", () => {
    const lines = [item({ type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions>" }] })];
    const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
    expect(events[0]!.kind).toBe("session");
    expect(events[0]!.role).toBe("system");
  });

  test("function_call → tool(assistant) with tool_name + serialized args", () => {
    const lines = [item({ type: "function_call", name: "shell", arguments: '{"cmd":"ls"}', call_id: "c1" })];
    const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
    const e = events[0]!;
    expect(e.kind).toBe("tool");
    expect(e.role).toBe("assistant");
    expect(e.tool_name).toBe("shell");
    expect(e.text).toContain('[tool_use:shell] {"cmd":"ls"}');
  });

  test("function_call_output → tool(tool)", () => {
    const lines = [item({ type: "function_call_output", call_id: "c1", output: "file.txt" })];
    const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
    const e = events[0]!;
    expect(e.kind).toBe("tool");
    expect(e.role).toBe("tool");
    expect(e.text).toContain("[tool_result] file.txt");
  });

  test("reasoning → msg(assistant) tagged [thinking]", () => {
    const lines = [item({ type: "reasoning", summary: [{ type: "summary_text", text: "planning" }] })];
    const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
    expect(events[0]!.role).toBe("assistant");
    expect(events[0]!.text).toBe("[thinking] planning");
  });

  test("reasoning keeps its summary but removes encrypted content from the raw line", () => {
    const lines = [item({ type: "reasoning", summary: [{ type: "summary_text", text: "planning" }], encrypted_content: "opaque" })];
    const { events, raws } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
    expect(events[0]!.text).toBe("[thinking] planning");
    expect(raws[0]!.raw).not.toContain("encrypted_content");
    expect(raws[0]!.raw).toContain("planning");
  });

  test("empty reasoning produces no placeholder-only event", () => {
    const { events } = normalizeCodexRollout({
      lines: [item({ type: "reasoning", summary: [] })],
      ctx: codexCtx,
      startSeq: 0,
      startOffset: 0,
    });
    expect(events).toEqual([]);
  });

  test("valid non-object JSON is retained as raw telemetry without crashing normalization", () => {
    const { events, raws } = normalizeCodexRollout({
      lines: ["null", "42", "[]"],
      ctx: codexCtx,
      startSeq: 0,
      startOffset: 0,
    });
    expect(events).toEqual([]);
    expect(raws.map((raw) => raw.raw)).toEqual(["null", "42", "[]"]);
    expect(raws.every((raw) => raw.sid === SID)).toBe(true);
  });

  test("skips session_meta / event_msg / turn_context (no double-counting)", () => {
    const lines = [
      item({ id: SID, cwd: "/work/app" }, "session_meta"),
      item({ type: "task_started" }, "event_msg"),
      item({ type: "message", role: "user", content: [{ type: "input_text", text: "say hi" }] }),
      item({ type: "user_message", message: "say hi" }, "event_msg"), // UI duplicate of the line above
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }),
      item({ type: "agent_message", message: "ok" }, "event_msg"), // UI duplicate
      item({ type: "token_count", info: {} }, "event_msg"),
    ];
    const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
    // Exactly the two response_item messages — the event_msg duplicates are dropped.
    expect(events.map((e) => e.text)).toEqual(["say hi", "ok"]);
  });

  test("monotonic seq only for emitted events; ref offsets track byte starts", () => {
    const skipped = item({ type: "task_started" }, "event_msg");
    const l1 = item({ type: "message", role: "user", content: [{ type: "input_text", text: "one" }] });
    const l2 = item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "two" }] });
    const { events, nextSeq, nextOffset } = normalizeCodexRollout({ lines: [skipped, l1, l2], ctx: codexCtx, startSeq: 0, startOffset: 0 });
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(nextSeq).toBe(2);
    // First emitted event sits AFTER the skipped line's bytes.
    expect(events[0]!.ref?.off).toBe(Buffer.byteLength(skipped, "utf8") + 1);
    expect(nextOffset).toBe([skipped, l1, l2].reduce((acc, l) => acc + Buffer.byteLength(l, "utf8") + 1, 0));
  });

  test("applies the injected scrubber before cap", () => {
    const scrub = (t: string) => t.replace(/SECRET/g, "[redacted]");
    const lines = [item({ type: "message", role: "user", content: [{ type: "input_text", text: "key SECRET" }] })];
    const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0, scrub });
    expect(events[0]!.text).toBe("key [redacted]");
  });

  test("skips corrupt JSON lines but keeps tailing", () => {
    const good = item({ type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] });
    const { events } = normalizeCodexRollout({ lines: ["{ not json", good], ctx: codexCtx, startSeq: 0, startOffset: 0 });
    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe("ok");
  });

  // Payload shapes below are grounded in real local Codex rollouts (not
  // synthesized guesses) unless noted otherwise.
  describe("Codex payload coverage (G6) — real rollouts contain these, previously all dropped", () => {
    test("custom_tool_call → tool(assistant) with tool_name + the raw (non-JSON) input", () => {
      const lines = [
        item({
          type: "custom_tool_call",
          status: "completed",
          call_id: "call_78bKD243ysto75qIupOUx0CE",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Add File: backend/README.md\n+# Notes\n*** End Patch",
        }),
      ];
      const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      const e = events[0]!;
      expect(e.kind).toBe("tool");
      expect(e.role).toBe("assistant");
      expect(e.tool_name).toBe("apply_patch");
      expect(e.text).toContain("[tool_use:apply_patch] *** Begin Patch");
    });

    test("custom_tool_call_output → tool(tool), ok status, when exit_code is 0", () => {
      const lines = [
        item({
          type: "custom_tool_call_output",
          call_id: "call_78bKD243ysto75qIupOUx0CE",
          output: JSON.stringify({ output: "Success. Updated backend/README.md\n", metadata: { exit_code: 0, duration_seconds: 0.0 } }),
        }),
      ];
      const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      const e = events[0]!;
      expect(e.kind).toBe("tool");
      expect(e.role).toBe("tool");
      expect(e.tool_status).toBe("ok");
      expect(e.text).toContain("[tool_result]");
      expect(e.text).toContain("Success. Updated backend/README.md");
    });

    test("custom_tool_call_output → tool_status error when metadata.exit_code is non-zero", () => {
      const lines = [
        item({
          type: "custom_tool_call_output",
          call_id: "c1",
          output: JSON.stringify({ output: "boom", metadata: { exit_code: 1, duration_seconds: 0.1 } }),
        }),
      ];
      const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      expect(events[0]!.tool_status).toBe("error");
    });

    test("custom_tool_call_output with a plain (non-JSON) output string defaults to ok", () => {
      const lines = [item({ type: "custom_tool_call_output", call_id: "c1", output: "Plan updated" })];
      const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      expect(events[0]!.tool_status).toBe("ok");
      expect(events[0]!.text).toBe("[tool_result] Plan updated");
    });

    test("web_search_call → tool(assistant), tool_name web_search, action serialized (carries the query)", () => {
      const lines = [
        item({
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "site:weather.gov NYC forecast", queries: ["site:weather.gov NYC forecast"] },
        }),
      ];
      const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      const e = events[0]!;
      expect(e.kind).toBe("tool");
      expect(e.tool_name).toBe("web_search");
      expect(e.text).toBe('[tool_use:web_search] {"type":"search","query":"site:weather.gov NYC forecast","queries":["site:weather.gov NYC forecast"]}');
    });

    test("web_search_call with an open_page action (no query) still carries its url", () => {
      const lines = [item({ type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://example.com" } })];
      const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      expect(events[0]!.text).toBe('[tool_use:web_search] {"type":"open_page","url":"https://example.com"}');
    });

    test("agent_message (Codex's sub-agent channel) → msg(assistant) with author→recipient, content flattened", () => {
      const lines = [
        item({
          type: "agent_message",
          id: "amsg_1",
          author: "/root",
          recipient: "/root/design_monumental",
          content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/design_monumental\nSender: /root\nPayload:\n" },
            { type: "encrypted_content", encrypted_content: "gAAAAA..." },
          ],
        }),
      ];
      const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      const e = events[0]!;
      expect(e.kind).toBe("msg");
      expect(e.role).toBe("assistant");
      expect(e.text).toContain("[agent_message /root→/root/design_monumental]");
      expect(e.text).toContain("Message Type: NEW_TASK");
      // The encrypted block isn't decodable client-side — it becomes a
      // placeholder rather than being silently dropped (see extractCodexText).
      expect(e.text).toContain("[encrypted_content]");
    });

    test("local_shell_call(+_output) — defensive coverage, not observed locally — mirrors function_call's shape", () => {
      const callLines = [item({ type: "local_shell_call", name: "shell", arguments: '{"cmd":"ls"}', call_id: "c1" })];
      const { events: callEvents } = normalizeCodexRollout({ lines: callLines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      expect(callEvents[0]!.kind).toBe("tool");
      expect(callEvents[0]!.tool_name).toBe("shell");
      expect(callEvents[0]!.text).toContain('[tool_use:shell] {"cmd":"ls"}');

      const outputLines = [item({ type: "local_shell_call_output", call_id: "c1", output: "file.txt" })];
      const { events: outputEvents } = normalizeCodexRollout({ lines: outputLines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      expect(outputEvents[0]!.kind).toBe("tool");
      expect(outputEvents[0]!.text).toBe("[tool_result] file.txt");
    });

    test("an unrecognized response_item type falls back to a keep-signal session/system event, never silently zero", () => {
      const lines = [item({ type: "zzz_future_type", content: [{ type: "input_text", text: "hello from the future" }] })];
      const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      expect(events.length).toBe(1);
      const e = events[0]!;
      expect(e.kind).toBe("session");
      expect(e.role).toBe("system");
      expect(e.text).toBe("[codex:zzz_future_type] hello from the future");
    });

    test("an unrecognized type with no content/output at all still gets a non-empty fallback (the raw payload)", () => {
      const lines = [item({ type: "zzz_bare_type", weird_field: 42 })];
      const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      expect(events.length).toBe(1);
      expect(events[0]!.text).toContain("[codex:zzz_bare_type]");
      expect(events[0]!.text).toContain("weird_field");
    });

    test("extractCodexText placeholder: a content block with no .text but a string .type never flattens to nothing", () => {
      const lines = [item({ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://x" }] })];
      const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      expect(events[0]!.text).toBe("[input_image]");
    });

    test("extractCodexText placeholder: refusal block", () => {
      const lines = [item({ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "can't help with that" }] })];
      const { events } = normalizeCodexRollout({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
      expect(events[0]!.text).toBe("[refusal]");
    });
  });
});
