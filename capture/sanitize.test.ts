import { describe, expect, test } from "bun:test";
import { sanitizeTelemetryJsonl, sanitizeTelemetryValue } from "./sanitize";

describe("sanitizeTelemetryValue", () => {
  test("removes opaque reasoning artifacts at every nesting level and preserves useful text", () => {
    expect(
      sanitizeTelemetryValue({
        signature: "top-level-opaque",
        payload: {
          encryptedContent: "opaque",
          thinking: "keep this thought",
          tool: { signature: "opaque", input: "keep this" },
        },
        list: [{ encrypted_content: "opaque", reasoning: "keep this summary" }],
      }),
    ).toEqual({
      payload: { thinking: "keep this thought", tool: { input: "keep this" } },
      list: [{ reasoning: "keep this summary" }],
    });
  });

  test("removes only empty thinking/reasoning fields", () => {
    expect(
      sanitizeTelemetryValue({
        thinking: " ",
        reasoning: { signature: "opaque" },
        nested: { thinking: [], reasoning: {} },
        note: "kept",
      }),
    ).toEqual({ nested: {}, note: "kept" });
    expect(sanitizeTelemetryValue({ thinking: "actual thought", reasoning: "actual summary" })).toEqual({
      thinking: "actual thought",
      reasoning: "actual summary",
    });
  });

  test("preserves __proto__ as transcript data without allowing prototype mutation", () => {
    const sanitized = sanitizeTelemetryJsonl(
      '{"__proto__":{"signature":"opaque","value":"kept"},"constructor":"also-kept"}',
    );
    expect(sanitized).toBe('{"__proto__":{"value":"kept"},"constructor":"also-kept"}');
    expect(Object.getPrototypeOf(JSON.parse(sanitized!))).toBe(Object.prototype);
  });

  test("serializes sanitized JSONL and rejects malformed lines", () => {
    expect(sanitizeTelemetryJsonl('{"thinking":"","signature":"opaque","ok":true}')).toBe('{"ok":true}');
    expect(sanitizeTelemetryJsonl("{ not json")).toBeUndefined();
  });
});
