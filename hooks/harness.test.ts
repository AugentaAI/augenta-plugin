/**
 * Tests for harness.ts — detecting the Codex vs Claude Code harness from the
 * hook payload's transcript path. Drives the #182 fix (suppress internal-only
 * injections on Codex, where additionalContext is user-visible).
 *
 * Run: bun test plugin/hooks/harness.test.ts
 */
import { test, expect, describe } from "bun:test";
import { isCodexHarness, sniffHarness } from "./harness";

describe("isCodexHarness", () => {
  test("true for Codex rollout paths (either separator)", () => {
    expect(isCodexHarness("C:/Users/x/.codex/sessions/2026/06/24/rollout-2026-06-24T00-00-00-abc.jsonl")).toBe(true);
    expect(isCodexHarness("C:\\Users\\x\\.codex\\sessions\\2026\\06\\24\\rollout-abc.jsonl")).toBe(true);
    expect(isCodexHarness("/home/u/.codex/sessions/x/rollout-y.jsonl")).toBe(true);
  });

  test("false for Claude Code transcripts and junk", () => {
    expect(isCodexHarness("C:/Users/x/.claude/projects/enc/sess-1.jsonl")).toBe(false);
    expect(isCodexHarness("/home/u/.claude/projects/p/abc.jsonl")).toBe(false);
    expect(isCodexHarness(undefined)).toBe(false);
    expect(isCodexHarness(null)).toBe(false);
    expect(isCodexHarness("")).toBe(false);
  });

  test("broad-by-design: rollout filename alone classifies as Codex even without a .codex parent dir", () => {
    expect(isCodexHarness("/tmp/rollout-2026.jsonl")).toBe(true);
  });

  test("a transcript under a custom CODEX_HOME classifies as Codex even with a neutral filename", () => {
    const previous = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = "/tmp/custom-codex";
      expect(isCodexHarness("/tmp/custom-codex/sessions/session.jsonl")).toBe(true);
      expect(isCodexHarness("/tmp/custom-codex-other/sessions/session.jsonl")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});

describe("sniffHarness (G9) — content fallback when the path matches neither pattern", () => {
  test("a real Codex response_item line sniffs as codex", () => {
    const line = JSON.stringify({ timestamp: "2026-06-28T17:15:11.000Z", type: "response_item", payload: { type: "message", role: "user", content: [] } });
    expect(sniffHarness(line)).toBe("codex");
  });

  test("a real Codex event_msg line (no message field) also sniffs as codex", () => {
    const line = JSON.stringify({ timestamp: "2026-06-28T17:15:11.000Z", type: "event_msg", payload: { type: "agent_message", message: "ok" } });
    expect(sniffHarness(line)).toBe("codex");
  });

  test("a real Claude Code assistant line (message field) sniffs as claude-code", () => {
    const line = JSON.stringify({ type: "assistant", sessionId: "s1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
    expect(sniffHarness(line)).toBe("claude-code");
  });

  test("a Claude Code summary/system line (no message field, but a recognized type) sniffs as claude-code", () => {
    expect(sniffHarness(JSON.stringify({ type: "summary" }))).toBe("claude-code");
    expect(sniffHarness(JSON.stringify({ type: "system" }))).toBe("claude-code");
  });

  test("neither shape (unrecognized type, no message, no payload) is undefined", () => {
    expect(sniffHarness(JSON.stringify({ type: "something-else" }))).toBeUndefined();
    expect(sniffHarness(JSON.stringify({ foo: "bar" }))).toBeUndefined();
  });

  test("corrupt JSON, a non-object, or an empty line is undefined — never throws", () => {
    expect(sniffHarness("{ not json")).toBeUndefined();
    expect(sniffHarness(JSON.stringify("just a string"))).toBeUndefined();
    expect(sniffHarness(JSON.stringify(null))).toBeUndefined();
    expect(sniffHarness("")).toBeUndefined();
  });
});
