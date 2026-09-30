import { describe, expect, test } from "bun:test";
import { attachmentHash, sanitizeTelemetryJsonl, sanitizeTelemetryRecord, sanitizeTelemetryValue } from "./sanitize";

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

describe("embedded attachment sanitation", () => {
  const content = Buffer.from("%PDF-1.4\nfixture document\n").toString("base64");
  test("strips every PDF copy and returns one decoded-content identity", () => {
    const record = sanitizeTelemetryRecord(JSON.stringify({
      toolUseResult: { type: "pdf", file: { filePath: "/project/report.pdf", base64: content } },
      message: { content: [{ type: "tool_result", content: [{ type: "document", source: {
        type: "base64", media_type: "application/pdf", data: content,
      } }] }] },
    }))!;
    const value = record.value as any;
    const ref = value.toolUseResult.file.base64;
    expect(value.message.content[0].content[0].source.data).toBe(ref);
    expect(record.json).not.toContain(content);
    expect(record.payloads.size).toBe(1);
    expect(record.payloads.get(attachmentHash(ref)!)).toMatchObject({
      content, mediaType: "application/pdf", bytes: Buffer.from(content, "base64").length, valid: true,
    });
    expect(sanitizeTelemetryRecord(record.json)!.json).toBe(record.json);
    expect(sanitizeTelemetryRecord(record.json)!.payloads.size).toBe(0);
  });
  test("strips Claude images and both Codex image URL shapes", () => {
    const source = { type: "base64", media_type: "image/png", data: content };
    const record = sanitizeTelemetryRecord(JSON.stringify({ content: [
      { type: "image", source },
      { type: "input_image", image_url: `data:image/png;base64,${content}` },
      { type: "image_url", image_url: { url: `data:image/png;base64,${content}` } },
    ] }))!;
    expect(record.json).not.toContain(content);
    expect(record.payloads.size).toBe(1);
    const values = (record.value as any).content;
    expect(values[0].source.data).toBe(values[1].image_url);
    expect(values[1].image_url).toBe(values[2].image_url.url);
  });
  test("preserves text sources, ordinary data and remote URLs", () => {
    const value = { source: { type: "text", data: "complete document" }, data: content,
      image_url: "https://example.invalid/photo.png" };
    expect(sanitizeTelemetryValue(value)).toEqual(value);
  });
  test("invalid declared base64 is still removed, but cannot become a document", () => {
    const record = sanitizeTelemetryRecord(JSON.stringify({ source: { type: "base64", data: "invalid!" } }))!;
    expect(record.json).not.toContain("invalid!");
    expect([...record.payloads.values()][0]!.valid).toBe(false);
  });
  test("a payload larger than a trajectory envelope can be stripped without dropping the line", () => {
    const large = Buffer.alloc(600_000, 65).toString("base64");
    const record = sanitizeTelemetryRecord(JSON.stringify({ type: "pdf", file: { base64: large } }))!;
    expect(record.json.length).toBeLessThan(256);
    expect([...record.payloads.values()][0]!.bytes).toBe(600_000);
  });
});
