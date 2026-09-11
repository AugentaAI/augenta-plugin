import { expect, test } from "bun:test";
import { detectedHarness } from "./harness";

test("Codex identity survives missing sandbox/home variables", () => {
  for (const env of [{ CODEX_THREAD_ID: "task" }, { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, { CODEX_SANDBOX: "seatbelt" }]) {
    expect(detectedHarness(undefined, env)).toBe("codex");
  }
});
test("unknown or conflicting environment does not invent a harness", () => {
  for (const env of [{}, { CODEX_HOME: "/configured/on/machine" }, { CLAUDE_PLUGIN_ROOT: "/shared/plugin" }, { CLAUDECODE: "1", CODEX_THREAD_ID: "outer-task" }]) {
    expect(detectedHarness(undefined, env)).toBeUndefined();
  }
  expect(detectedHarness(undefined, { CLAUDECODE: "1" })).toBe("claude-code");
});
test("explicit identity wins even with inherited or absent environment", () => {
  expect(detectedHarness("codex", {})).toBe("codex");
  expect(detectedHarness("codex", { CLAUDECODE: "1" })).toBe("codex");
  expect(detectedHarness("claude-code", { CODEX_THREAD_ID: "outer-task" })).toBe("claude-code");
});
