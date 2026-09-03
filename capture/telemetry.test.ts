import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lowCardinalityMetricAttributes, safePluginAttributes } from "./telemetry";

describe("detached shipper telemetry privacy", () => {
  test("retains only allowlisted operational fields", () => {
    expect(safePluginAttributes({
      "operation.name": "experiences.upload",
      "augenta.count": 2,
      "augenta.bytes": 128,
      "augenta.connector.id": "opaque-connector",
      prompt: "secret prompt",
      payload: "captured transcript",
      "url.full": "https://example.test/path?query=secret",
      "exception.message": "secret failure text",
      path: "/Users/private/project",
    })).toEqual({
      "operation.name": "experiences.upload",
      "augenta.count": 2,
      "augenta.bytes": 128,
      "augenta.connector.id": "opaque-connector",
    });
  });

  test("metric labels exclude opaque ids and measured values", () => {
    expect(lowCardinalityMetricAttributes({
      "augenta.connector.id": "connector-many",
      "augenta.workspace.id": "workspace-many",
      "augenta.count": 4,
      "augenta.bytes": 2048,
      "augenta.reason": "success",
      "augenta.stage": "upload",
    })).toEqual({ "augenta.reason": "success", "augenta.stage": "upload" });
  });

  test("the capture entrypoint remains free of telemetry and network work", () => {
    const source = readFileSync(join(import.meta.dir, "capture.ts"), "utf8");
    const bundle = readFileSync(join(import.meta.dir, "../dist/capture/capture.mjs"), "utf8");
    for (const text of [source, bundle]) {
      expect(text).not.toContain("/v1/telemetry");
      expect(text).not.toContain("OTLPTraceExporter");
    }
  });
});
