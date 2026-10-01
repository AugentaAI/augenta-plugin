import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCapture } from "./capture";
import { CaptureState } from "./capture-cursor";
import { captureGate, loadProjectConfig } from "./config";
import { captureHealth, recordHealth } from "./health";
import { isDocumentRecord, Outbox } from "./outbox";
import { boundExperienceSize, drain, MAX_PENDING_SLICE_BYTES } from "./ship";
import { prepareAttachments } from "./attachments";
import { jsonBytes } from "./documents";
import { joinCheckout, writeSharedConfig, TEST_USER_ID } from "../__tests__/fixtures";
import { readLinks, writeLinks } from "./links";

const t = (n: number) => new Date(Date.UTC(2026, 8, 30, 10, 0, n)).toISOString();
let project: string;
let oldEnv: Record<string, string | undefined>;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "augenta-attachment-integration-")); mkdirSync(join(project, ".augenta"));
  oldEnv = Object.fromEntries(["AUGENTA_CAPTURE_ENABLED", "AUGENTA_CAPTURE_ATTACHMENTS", "AUGENTA_AUTH_HOME", "AUGENTA_API_URL", "AUGENTA_INGEST_URL"].map(k => [k, process.env[k]]));
  for (const k of Object.keys(oldEnv)) delete process.env[k];
});
afterEach(() => { for (const [k, v] of Object.entries(oldEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } rmSync(project, { recursive: true, force: true }); });
function config(attachmentsConsentedAt?: string) { writeFileSync(join(project, ".augenta/config.json"), JSON.stringify({ authMode: "api-key", apiKey: "fixture-only", attachmentsConsentedAt })); }
function mention(n = 2, content = "# Notes\nFirst claim.") { return [
  { type: "user", uuid: `u-${n}`, timestamp: t(n), message: { role: "user", content: "Inspect @notes.md" } },
  { type: "attachment", uuid: `a-${n}`, parentUuid: `u-${n}`, timestamp: t(n), attachment: { type: "file", content: { type: "text", file: { filePath: join(project, "notes.md"), content } } } },
].map(x => JSON.stringify(x)).join("\n") + "\n"; }
function capture(lines: string, name = "session.jsonl", maxSpoolBytes?: number) {
  const path = join(project, name); writeFileSync(path, lines);
  runCapture({ cwd: project, transcript_path: path, session_id: "fixture", hook_event_name: "PostToolUse" }, { projectRoot: project, spawnShipper: false, maxSpoolBytes });
  return path;
}
const docs = () => new Outbox(project).readPending().records.filter(isDocumentRecord);

test("old connections retain trajectory capture with documents disabled; only future supplies qualify", () => {
  config(); capture(mention()); expect(docs()).toHaveLength(0);
  expect(new Outbox(project).readPending().records.length).toBeGreaterThan(0);
  config(t(3)); capture(mention(2) + mention(3), "after-consent.jsonl");
  expect(docs()).toHaveLength(1); expect(docs()[0]!.data.capturedAt).toBe(t(3));
  const cursor = new CaptureState(project).get(join(project, "after-consent.jsonl"));
  expect(cursor.offset).toBe(Buffer.byteLength(mention(2) + mention(3)));
});

test("capture persists mention context between fires", () => {
  config(t(1)); const lines = mention().trim().split("\n");
  const path = capture(lines[0]! + "\n"); expect(docs()).toHaveLength(0);
  writeFileSync(path, lines.join("\n") + "\n");
  runCapture({ cwd: project, transcript_path: path, hook_event_name: "PostToolUse" }, { projectRoot: project, spawnShipper: false });
  expect(docs()).toHaveLength(1);
});

test("a rejected append never advances the attachment index; a later independent observation retries", () => {
  config(t(1));
  new Outbox(project).append([{ src: "claude-code", sid: "seed", proj: project, raw: "seed" }]);
  capture(mention(), "full.jsonl", 1);
  expect(existsSync(join(project, ".augenta/state/attachments.json"))).toBe(false);
  expect(docs()).toHaveLength(0);
  expect(captureHealth(project).attachments?.outcome).toBe("spool_full");
  capture(mention(3), "retry.jsonl"); expect(docs()).toHaveLength(1);
  expect(existsSync(join(project, ".augenta/state/attachments.json"))).toBe(true);
});

test("a rejected unchanged-document append after renewed consent leaves the previous observation intact", () => {
  config(t(1)); capture(mention(2), "original.jsonl");
  const indexPath = join(project, ".augenta/state/attachments.json");
  const previous = readFileSync(indexPath, "utf8");
  config(t(3)); capture(mention(4), "full-after-renewal.jsonl", 1);
  expect(readFileSync(indexPath, "utf8")).toBe(previous);
  expect(docs()).toHaveLength(1);
  capture(mention(5), "retry-after-renewal.jsonl");
  expect(docs()).toHaveLength(2);
  expect(docs()[1]!.data.capturedAt).toBe(t(5));
});

test("a newly selected OAuth Workspace gets a fresh unchanged document, while historical supplies stay excluded", () => {
  const auth = join(project, "auth"); mkdirSync(auth); process.env.AUGENTA_AUTH_HOME = auth;
  writeFileSync(join(auth, "auth.json"), JSON.stringify({ version: 1, profiles: { "fixture-profile": { gateway: "https://gw.example.com", userId: TEST_USER_ID, orgId: "fixture-org", accessToken: "fixture-only", refreshToken: "fixture-only", expiresAt: Date.now() + 3600000, updatedAt: t(1) } } }));
  const a = { workspaceId: "workspace-a", connectorId: "link-a" }, b = { workspaceId: "workspace-b", connectorId: "link-b" };
  const box = new Outbox(project);
  const connect = (n: number, destinations: typeof a[]) => {
    const fixture = { profileId: "fixture-profile", joinedAt: t(n), destinations, extra: { endpoint: "https://gw.example.com" } };
    writeSharedConfig(project, fixture); joinCheckout(project, fixture);
    writeLinks(project, { ...readLinks(project)!, attachmentsConsentedAt: t(n) });
    box.registerDestinations(destinations.map(d => d.connectorId), { freshKeys: destinations.filter(d => d.connectorId === b.connectorId).map(d => d.connectorId) });
  };
  connect(1, [a]); capture(mention(2), "original-workspace.jsonl");
  const original = box.readPending(Infinity, a.connectorId).records.filter(isDocumentRecord)[0]!;
  box.advance(box.readPending(Infinity, a.connectorId).endOffset, a.connectorId); box.compact();
  connect(3, [a, b]); capture(mention(2), "historical-after-connect.jsonl");
  expect(box.readPending(Infinity, b.connectorId).records.filter(isDocumentRecord)).toEqual([]);
  capture(mention(4), "fresh-after-connect.jsonl");
  for (const destination of [a, b]) {
    const documents = box.readPending(Infinity, destination.connectorId).records.filter(isDocumentRecord);
    expect(documents).toHaveLength(1);
    expect(documents[0]!.sid).toBe(original.sid);
    expect(documents[0]!.data.revision).toBe(original.data.revision);
    expect(documents[0]!.data.capturedAt).toBe(t(4));
  }
  capture(mention(5), "duplicate-after-connect.jsonl");
  expect(box.readPending(Infinity, b.connectorId).records.filter(isDocumentRecord)).toHaveLength(1);
});

test("kill switch, attachment switch and tracked keys never enable document capture", () => {
  config(t(1)); process.env.AUGENTA_CAPTURE_ATTACHMENTS = "off"; capture(mention(), "disabled.jsonl"); expect(docs()).toHaveLength(0);
  delete process.env.AUGENTA_CAPTURE_ATTACHMENTS; process.env.AUGENTA_CAPTURE_ENABLED = "0";
  capture(mention(), "killed.jsonl"); expect(docs()).toHaveLength(0);
  delete process.env.AUGENTA_CAPTURE_ENABLED;
  execFileSync("git", ["init", "-q"], { cwd: project }); execFileSync("git", ["add", "-f", ".augenta/config.json"], { cwd: project });
  expect(captureGate(loadProjectConfig(project)!)).toBe("key_tracked");
  capture(mention(), "tracked.jsonl"); expect(docs()).toHaveLength(0);
});

test("a shared browser config cannot grant consent; consent is exposed only through a valid local join", () => {
  const fixture = { profileId: "fixture-profile", destinations: [{ workspaceId: "fixture-ws", connectorId: "fixture-link" }], extra: { attachmentsConsentedAt: t(1), endpoint: "https://gw.example.com" } };
  writeSharedConfig(project, fixture);
  expect(loadProjectConfig(project)?.attachmentsConsentedAt).toBeUndefined();
  expect(captureGate(loadProjectConfig(project)!)).toBe("signed_out");
  capture(mention(), "shared.jsonl"); expect(docs()).toHaveLength(0);
  const auth = join(project, "auth"); mkdirSync(auth); process.env.AUGENTA_AUTH_HOME = auth;
  writeFileSync(join(auth, "auth.json"), JSON.stringify({ version: 1, profiles: { "fixture-profile": { gateway: "https://gw.example.com", userId: TEST_USER_ID, orgId: "fixture-org", accessToken: "fixture-only", refreshToken: "fixture-only", expiresAt: Date.now() + 3600000, updatedAt: t(1) } } }));
  expect(captureGate(loadProjectConfig(project)!)).toBe("not_adopted");
  joinCheckout(project, fixture);
  expect(captureGate(loadProjectConfig(project)!)).toBe("live");
  expect(loadProjectConfig(project)?.attachmentsConsentedAt).toBeUndefined();
  capture(mention(), "old-join.jsonl"); expect(docs()).toHaveLength(0);
  writeLinks(project, { ...readLinks(project)!, attachmentsConsentedAt: t(1) });
  expect(loadProjectConfig(project)?.attachmentsConsentedAt).toBe(t(1));
  const shared = JSON.parse(readFileSync(join(project, ".augenta/config.json"), "utf8")); shared.workspaces.push({ workspaceId: "added" }); writeFileSync(join(project, ".augenta/config.json"), JSON.stringify(shared));
  expect(loadProjectConfig(project)?.attachmentsConsentedAt).toBeUndefined();
});

test("attachment outcomes survive a subsequent capture health update without disclosing content", () => {
  recordHealth(project, "attachments", "too_large", 1); recordHealth(project, "capture", "captured", 2);
  expect(captureHealth(project)).toMatchObject({ attachments: { outcome: "too_large", count: 1 }, capture: { outcome: "captured", count: 2 } });
});

function preparedDoc() { return prepareAttachments(project, "claude-code", [{ origin: "prompt", format: "text/plain", text: "Document text", capturedAt: t(2) }], { consentedAt: t(1), enabled: true, scrub: s => s }).records[0]!; }

test("outbox validation distinguishes kinds and rejects ambiguous or mismatched payloads", () => {
  const doc = preparedDoc(); expect(isDocumentRecord(doc)).toBe(true);
  for (const data of [{ ...doc.data, content: "JVBERi0=" }, { ...doc.data, origin: "unknown" }, { ...doc.data, deleted: true }, { ...doc.data, capturedAt: "now" }]) expect(isDocumentRecord({ ...doc, data })).toBe(false);
  expect(isDocumentRecord({ ...doc, sid: `memory-${doc.data.documentId}` })).toBe(false);
  const pdf = readFileSync(join(import.meta.dir, "__fixtures__/mention-pdf.jsonl"), "utf8").trim().split("\n")[1]!;
  const content = JSON.parse(pdf).attachment.content.file.base64;
  const data = { ...doc.data, text: undefined, format: "application/pdf", encoding: "base64", content, mediaType: "application/pdf" };
  expect(isDocumentRecord({ ...doc, data })).toBe(true);
  expect(isDocumentRecord({ ...doc, data: { ...data, mediaType: "image/png" } })).toBe(false);
  expect(isDocumentRecord({ ...doc, data: { ...data, chunkCount: 2 } })).toBe(false);
});

test("pending slices bound bytes, preserve the cursor, and admit one larger legacy record alone", () => {
  const box = new Outbox(project); const doc = preparedDoc();
  const large = { ...doc, data: { ...doc.data, text: "x".repeat(MAX_PENDING_SLICE_BYTES + 500) } } as typeof doc;
  box.append([large, doc, doc]);
  const first = box.readPending(200, undefined, MAX_PENDING_SLICE_BYTES);
  expect(first.records).toHaveLength(1); expect(first.hasMore).toBe(true);
  expect(first.endOffset).toBe(Buffer.byteLength(JSON.stringify(large)) + 1);
  box.advance(first.endOffset);
  const next = box.readPending(200, undefined, jsonBytes(doc) + 1);
  expect(next.records).toHaveLength(1); expect(next.hasMore).toBe(true);
  box.advance(next.endOffset); expect(box.readPending().records).toHaveLength(1);
});

test("an oversized queued PDF is discarded whole without stalling following documents", async () => {
  const base = preparedDoc();
  const pdfData = { ...base.data, text: undefined, format: "application/pdf" as const, encoding: "base64" as const, content: Buffer.from("%PDF-1.4\n" + "x".repeat(400 * 1024) + "\n%%EOF").toString("base64"), mediaType: "application/pdf" as const };
  const tooLarge = { ...base, data: pdfData } as typeof base;
  expect(isDocumentRecord(tooLarge)).toBe(true); expect(boundExperienceSize(tooLarge)).toEqual([]);
  const box = new Outbox(project); box.append([tooLarge, base]);
  const received: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { received.push(await req.json()); return new Response(null, { status: 202 }); } });
  try {
    expect((await drain({ projectRoot: project, url: `${server.url.origin}/v1/experiences` })).shipped).toBe(2);
    expect(box.hasPendingBytes()).toBe(false);
    expect(received.flatMap(x => x.experiences)).toEqual([base]);
    expect(captureHealth(project).attachments?.outcome).toBe("too_large");
  } finally { server.stop(true); }
});

test("slice preparation failures are contained and leave delivery pending for retry", async () => {
  const box = new Outbox(project); box.append([preparedDoc()]);
  const original = Outbox.prototype.readPending;
  Outbox.prototype.readPending = () => { throw new Error("fixture preparation failure"); };
  try {
    expect(await drain({ projectRoot: project, url: "http://127.0.0.1:1/unused" })).toMatchObject({ shipped: 0, lastStatus: 0 });
    expect(box.hasPendingBytes()).toBe(true);
    expect(captureHealth(project).delivery?.outcome).toBe("retry");
  } finally { Outbox.prototype.readPending = original; }
});
