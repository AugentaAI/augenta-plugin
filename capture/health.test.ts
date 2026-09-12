import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureHealth, recordHealth } from "./health";
import { drain } from "./ship";
import { Outbox } from "./outbox";
const dirs: string[] = [];
const project = () => { const p = mkdtempSync(join(tmpdir(), "aug-health-")); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
test("unconfigured read is local, honest and creates no state", () => {
  const p = project();
  expect(captureHealth(p)).toMatchObject({ configured: false, enabled: false, dispatch: null, ingestion: "unverified" });
  expect(captureHealth(p)).toMatchObject({ configuration: "missing", activityScope: "project", hostDispatch: "unverified" });
  expect(existsSync(join(p, ".augenta"))).toBe(false);
});
test("configuration is not proof of dispatch; health excludes secrets and identifiers", () => {
  const p = project(); mkdirSync(join(p, ".augenta"));
  writeFileSync(join(p, ".augenta/config.json"), JSON.stringify({ authMode: "api-key", apiKey: "secret-canary" }));
  expect(captureHealth(p)).toMatchObject({ configured: true, dispatch: null, nextStep: "check_host_hook_approval_and_activation" });
  recordHealth(p, "dispatch", "started"); recordHealth(p, "capture", "missing_transcript");
  const value = captureHealth(p);
  expect(value).toMatchObject({ configuration: "valid", capture: { outcome: "missing_transcript" }, nextStep: "check_host_transcript_payload", hostDispatch: "unverified" });
  expect(JSON.stringify(value)).not.toContain("secret-canary");
  expect(JSON.stringify(value)).not.toContain(p);
});

test("invalid configuration does not masquerade as an unconnected or enabled project", () => {
  const p = project(); mkdirSync(join(p, ".augenta"));
  writeFileSync(join(p, ".augenta/config.json"), "invalid");
  expect(captureHealth(p)).toMatchObject({ configuration: "invalid", configured: false, enabled: false });
});
test("acceptance counters survive compaction and later transport failure", async () => {
  const p = project(); const box = new Outbox(p);
  const row = { src: "codex" as const, sid: "test", proj: p, seq: 0, ts: new Date().toISOString(), text: "test", kind: "msg" as const, role: "assistant" as const };
  box.append([row]);
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("", { status: 202 })) as unknown as typeof fetch;
    await drain({ projectRoot: p, url: "http://localhost/v1/experiences", token: "test", authMode: "api-key" });
    const success = captureHealth(p).delivery!;
    expect(success.successes).toBe(1);
    expect(success.lastSuccessAt).toBeString();
    box.append([{ ...row, seq: 1 }]);
    globalThis.fetch = (async () => { throw Error("secret transport details"); }) as unknown as typeof fetch;
    await drain({ projectRoot: p, url: "http://localhost/v1/experiences", token: "test", authMode: "api-key" });
    const health = captureHealth(p).delivery!;
    expect(health).toMatchObject({ successes: 1, lastSuccessAt: success.lastSuccessAt, outcome: "retry" });
    expect(readFileSync(join(p, ".augenta/state/health-delivery.json"), "utf8")).not.toContain("secret");
  } finally { globalThis.fetch = realFetch; }
});

test("health JSON cannot echo arbitrary fields from tampered local state", () => {
  const p = project(); recordHealth(p, "dispatch", "started");
  const path = join(p, ".augenta/state/health-dispatch.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...state, token: "secret-canary", at: "/private/transcript" }));
  expect(captureHealth(p).dispatch).toBeNull();
});
