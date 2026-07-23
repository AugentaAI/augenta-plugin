/**
 * SCOPE: developer verification of the TypeScript modules in this change — these
 * tests confirm the scripts behave as intended (deterministic ids, event shape,
 * idempotency, the real local ship/land path). Not a product/acceptance suite.
 *
 * Tests for normalize-claude.ts — Claude Code transcript → neutral CaptureEvents.
 *
 * Contract under test: faithful 1:1 mapping with correct kind/role/tool
 * fields, token counts from assistant `usage`, exact per-line byte offsets
 * in `ref.off` and a correct `nextOffset`/`nextSeq`, an injectable scrubber
 * applied before the cap, and resilience to empty/corrupt lines (skip, never throw).
 *
 * Run: bun test plugin/ingest/normalize-claude.test.ts
 */
import { test, expect, describe } from "bun:test";
import { normalizeClaudeTranscript, extractText } from "./normalize-claude";
import { type NormalizeCtx } from "./normalize-core";

const ctx: NormalizeCtx = {
  sessionId: "fallback-sess",
  project: "/work/app",
  transcriptPath: "/t/transcript.jsonl",
};

function lineFor(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("extractText", () => {
  test("returns plain strings unchanged", () => {
    expect(extractText("hello")).toBe("hello");
  });
  test("flattens text/thinking/tool_use/tool_result blocks", () => {
    const content = [
      { type: "text", text: "doing it" },
      { type: "thinking", thinking: "hmm" },
      { type: "tool_use", name: "Edit", input: { path: "a.ts" } },
      { type: "tool_result", content: "ok" },
    ];
    expect(extractText(content)).toBe(
      'doing it\n[thinking] hmm\n[tool_use:Edit] {"path":"a.ts"}\n[tool_result] ok',
    );
  });
  test("omits empty thinking blocks instead of emitting a bare marker", () => {
    expect(extractText([{ type: "thinking", thinking: "" }, { type: "text", text: "keep" }])).toBe("keep");
  });
  test("returns empty string for null/undefined content", () => {
    expect(extractText(undefined)).toBe("");
    expect(extractText(null)).toBe("");
  });
  test("JSON-stringifies a non-string, non-array content value", () => {
    expect(extractText({ a: 1 })).toBe('{"a":1}');
  });
  test("null entries are skipped, but a typed block (e.g. image) is kept as a placeholder — not dropped (G5)", () => {
    const content = [null, { type: "image", source: "x" }, { type: "text", text: "keep" }];
    expect(extractText(content)).toBe("[image]\nkeep");
  });
  test("stringifies non-string tool_result content", () => {
    expect(extractText([{ type: "tool_result", content: { ok: true } }])).toBe('[tool_result] {"ok":true}');
  });

  describe("default placeholder for unmapped block shapes (G5)", () => {
    test("an image-only content array does not flatten to empty — it's a real turn, not nothing", () => {
      expect(extractText([{ type: "image", source: "x" }])).toBe("[image]");
    });
    test("mixed text + image keeps both, in order", () => {
      const content = [{ type: "text", text: "here's a screenshot" }, { type: "image", source: "x" }];
      expect(extractText(content)).toBe("here's a screenshot\n[image]");
    });
    test("an unrecognized future block type still gets a placeholder", () => {
      expect(extractText([{ type: "future_block", weird: true } as never])).toBe("[future_block]");
    });
    test("redacted_thinking / document / server_tool_use — other real Anthropic block shapes — all get placeholders", () => {
      expect(extractText([{ type: "redacted_thinking" } as never])).toBe("[redacted_thinking]");
      expect(extractText([{ type: "document" } as never])).toBe("[document]");
      expect(extractText([{ type: "server_tool_use" } as never])).toBe("[server_tool_use]");
    });
    test("a block with no type at all still contributes nothing (no signal to placeholder)", () => {
      expect(extractText([{ foo: "bar" } as never, { type: "text", text: "keep" }])).toBe("keep");
    });
  });
});

describe("normalizeClaudeTranscript", () => {
  test("assistant text → msg(assistant) event with token counts", () => {
    const lines = [
      lineFor({
        type: "assistant",
        sessionId: "s1",
        timestamp: "2026-06-15T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    ];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.kind).toBe("msg");
    expect(e.role).toBe("assistant");
    expect(e.in_tok).toBe(10);
    expect(e.out_tok).toBe(5);
    expect(e.sid).toBe("s1");
    expect(e.text).toBe("done");
  });

  test("assistant tool_use → tool event with tool_name", () => {
    const lines = [
      lineFor({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { cmd: "ls" } }] },
      }),
    ];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    const e = events[0]!;
    expect(e.kind).toBe("tool");
    expect(e.role).toBe("assistant");
    expect(e.tool_name).toBe("Bash");
  });

  test("user tool_result error → tool event with tool_status error", () => {
    const lines = [
      lineFor({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "boom", is_error: true }] },
      }),
    ];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    const e = events[0]!;
    expect(e.kind).toBe("tool");
    expect(e.role).toBe("tool");
    expect(e.tool_status).toBe("error");
  });

  test("plain user message → msg(user); session id falls back to ctx", () => {
    const lines = [lineFor({ type: "user", message: { role: "user", content: "fix the bug" } })];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    const e = events[0]!;
    expect(e.kind).toBe("msg");
    expect(e.role).toBe("user");
    expect(e.sid).toBe("fallback-sess");
  });

  test("system line → session kind", () => {
    const lines = [lineFor({ type: "system", message: { role: "system", content: "context compacted" } })];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    const e = events[0]!;
    expect(e.kind).toBe("session");
    expect(e.role).toBe("system");
  });

  test("skips empty-content and unknown lines without throwing", () => {
    const lines = [
      lineFor({ type: "summary" }), // no content → skipped
      lineFor({ type: "weird-type" }), // unclassifiable → skipped
      lineFor({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "real" }] } }),
    ];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe("real");
  });

  test("skips corrupt JSON lines but keeps tailing", () => {
    const good = lineFor({ type: "user", message: { role: "user", content: "ok" } });
    const lines = ["{ not json", good];
    const { events, raws } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe("ok");
    expect(raws).toEqual([{ raw: good, sid: "fallback-sess" }]);
  });

  test("valid non-object JSON is retained as raw telemetry without crashing normalization", () => {
    const { events, raws } = normalizeClaudeTranscript({
      lines: ["null", "42", "[]"],
      ctx,
      startSeq: 0,
      startOffset: 0,
    });
    expect(events).toEqual([]);
    expect(raws).toEqual([
      { raw: "null", sid: "fallback-sess" },
      { raw: "42", sid: "fallback-sess" },
      { raw: "[]", sid: "fallback-sess" },
    ]);
  });

  test("removes signatures from raw telemetry while preserving readable thinking", () => {
    const lines = [
      lineFor({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "opaque-signature" }] },
      }),
    ];
    const { events, raws } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    expect(events[0]!.text).toBe("[thinking] plan");
    expect(raws).toEqual([
      {
        sid: "fallback-sess",
        raw: JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "thinking", thinking: "plan" }] },
        }),
      },
    ]);
  });

  test("an empty signed thinking block is raw-sanitized and produces no event", () => {
    const lines = [
      lineFor({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "", signature: "opaque" }],
        },
      }),
    ];
    const { events, raws } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    expect(events).toEqual([]);
    expect(raws[0]!.raw).toBe(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking" }] } }));
  });

  test("assigns monotonic seq only to emitted events", () => {
    const lines = [
      lineFor({ type: "user", message: { role: "user", content: "one" } }),
      lineFor({ type: "summary" }), // skipped — must NOT consume a seq
      lineFor({ type: "user", message: { role: "user", content: "two" } }),
    ];
    const { events, nextSeq } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(nextSeq).toBe(2);
  });

  test("ref.off points at each line's byte start; nextOffset spans all lines", () => {
    const l0 = lineFor({ type: "user", message: { role: "user", content: "one" } });
    const l1 = lineFor({ type: "user", message: { role: "user", content: "two" } });
    const { events, nextOffset } = normalizeClaudeTranscript({
      lines: [l0, l1],
      ctx,
      startSeq: 0,
      startOffset: 100, // simulate tailing from a non-zero cursor
    });
    expect(events[0]!.ref?.off).toBe(100);
    expect(events[1]!.ref?.off).toBe(100 + Buffer.byteLength(l0, "utf8") + 1);
    expect(nextOffset).toBe(100 + Buffer.byteLength(l0, "utf8") + 1 + Buffer.byteLength(l1, "utf8") + 1);
  });

  test("applies the injected scrubber before cap", () => {
    const scrub = (t: string) => t.replace(/SECRET/g, "[redacted]");
    const lines = [lineFor({ type: "user", message: { role: "user", content: "token is SECRET" } })];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0, scrub });
    expect(events[0]!.text).toBe("token is [redacted]");
  });

  test("captures message.model on assistant events", () => {
    const lines = [
      lineFor({
        type: "assistant",
        message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "done" }] },
      }),
    ];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    const e = events[0]!;
    expect(e.model).toBe("claude-opus-4-8");
    expect(e.src).toBe("claude-code"); // default when ctx omits harness
  });

  test("omits model on turns that don't report one (e.g. a user turn)", () => {
    const lines = [lineFor({ type: "user", message: { role: "user", content: "fix it" } })];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    expect(events[0]!.model).toBeUndefined();
  });

  test("stamps src from ctx harness (codex)", () => {
    const codexCtx: NormalizeCtx = { ...ctx, harness: "codex" };
    const lines = [lineFor({ type: "user", message: { role: "user", content: "hi" } })];
    const { events } = normalizeClaudeTranscript({ lines, ctx: codexCtx, startSeq: 0, startOffset: 0 });
    expect(events[0]!.src).toBe("codex");
  });

  test("defensive: top-level tool_use line → tool(assistant) event with tool_name", () => {
    const lines = [
      lineFor({ type: "tool_use", message: { content: [{ type: "tool_use", name: "Grep", input: { q: "x" } }] } }),
    ];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.kind).toBe("tool");
    expect(e.role).toBe("assistant");
    expect(e.tool_name).toBe("Grep");
  });

  test("defensive: top-level tool_result error line → tool(tool) event with tool_status error", () => {
    const lines = [
      lineFor({ type: "tool_result", message: { content: [{ type: "tool_result", content: "boom", is_error: true }] } }),
    ];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.kind).toBe("tool");
    expect(e.role).toBe("tool");
    expect(e.tool_status).toBe("error");
  });

  test("unknown top-level type but reconcilable message.role → msg event", () => {
    const lines = [lineFor({ type: "x-odd", message: { role: "assistant", content: "still text" } })];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.kind).toBe("msg");
    expect(e.role).toBe("assistant");
  });

  test("unknown type with an unrecognized role is skipped (no event)", () => {
    const lines = [lineFor({ type: "x-odd", message: { role: "banana", content: "noise" } })];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    expect(events.length).toBe(0);
  });

  test("assistant carrying BOTH text and tool_use classifies as a tool event", () => {
    const lines = [
      lineFor({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "let me run it" }, { type: "tool_use", name: "Bash", input: {} }] },
      }),
    ];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    const e = events[0]!;
    expect(e.kind).toBe("tool");
    expect(e.tool_name).toBe("Bash");
  });

  test("an image-only user turn (G5) produces a [image] event instead of being dropped as empty", () => {
    const lines = [
      lineFor({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "..." } }] } }),
    ];
    const { events } = normalizeClaudeTranscript({ lines, ctx, startSeq: 0, startOffset: 0 });
    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe("[image]");
    expect(events[0]!.kind).toBe("msg");
    expect(events[0]!.role).toBe("user");
  });
});
