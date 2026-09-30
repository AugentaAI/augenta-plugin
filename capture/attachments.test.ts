import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeClaudeTranscript } from "./normalize-claude";
import { commitAttachments, MAX_ATTACHMENT_INDEX_BYTES, prepareAttachments, readPdfSnapshot, validAttachmentContext, type AttachmentCandidate } from "./attachments";
import { jsonBytes, MAX_DOCUMENT_EXPERIENCE_BYTES, sha256 } from "./documents";
import { normalizeNativeTurns } from "./native-turns";
import { normalizeCodexRollout } from "./normalize-codex";
import { attachmentCaptureMode } from "./config";
import { scrub } from "./scrub";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "__fixtures__", `${name}.jsonl`), "utf8").trim().split("\n");
const pdf = Buffer.from(JSON.parse(fixture("mention-pdf")[1]!).attachment.content.file.base64, "base64");
const t = (n: number) => new Date(Date.UTC(2026, 8, 30, 10, 0, n)).toISOString();
const normalize = (lines: string[], attachmentContext?: any) => normalizeClaudeTranscript({ lines, attachmentContext, startSeq: 0, startOffset: 0,
  ctx: { project: "/project", transcriptPath: "/session.jsonl", sessionId: "fixture-session" } });
const text = (path: string, content = "First paragraph.", n = 1): AttachmentCandidate => ({ origin: "mention", format: "text/markdown", filePath: path, text: content, capturedAt: t(n), suppliedAt: t(n) });
let project: string;
beforeEach(() => { project = mkdtempSync(join(tmpdir(), "augenta-attachments-")); });
afterEach(() => { rmSync(project, { recursive: true, force: true }); });
const prepare = (c: AttachmentCandidate[], extra: object = {}) => prepareAttachments(project, "claude-code", c, { consentedAt: t(0), enabled: true, scrub, ...extra });

describe("native transcript attachment fixtures", () => {
  test("genuine text/PDF mentions ignore displayPath and retain the originating time", () => {
    expect(normalize(fixture("mention-text")).documents).toEqual([expect.objectContaining({ origin: "mention", filePath: "/project/notes.md", format: "text/markdown", capturedAt: t(2), suppliedAt: t(1) })]);
    const result = normalize(fixture("mention-pdf"));
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.payload?.content).toBe(pdf.toString("base64"));
    expect(JSON.stringify(result.events)).not.toContain(pdf.toString("base64"));
    expect(JSON.stringify(result.raws)).not.toContain(pdf.toString("base64"));
  });
  test("SDK prompt, full PDF Read and page-range Read; duplicate tool blocks stay one candidate", () => {
    const result = normalize(fixture("sdk-read-resume"));
    expect(result.documents.map(x => x.origin)).toEqual(["prompt", "read", "read"]);
    expect(result.documents[0]!.text).toBe("SDK supplied fixture paragraph.");
    expect(result.documents[1]!.payload?.content).toBe(pdf.toString("base64"));
    expect(result.documents[2]!.payload).toBeUndefined();
    expect(result.documents[2]!.filePath).toBe("/project/fixture.pdf");
  });
  test("mentions survive tail boundaries; unrelated parents cannot reattach", () => {
    const lines = fixture("mention-text");
    const first = normalize(lines.slice(0, 1));
    expect(validAttachmentContext(first.attachmentContext)).toBe(true);
    expect(normalize(lines.slice(1), first.attachmentContext).documents).toHaveLength(1);
    const wrong = JSON.parse(lines[1]!); wrong.parentUuid = "unrelated";
    expect(normalize([JSON.stringify(wrong)], first.attachmentContext).documents).toEqual([]);
    expect(normalize(lines.slice(1)).documents).toEqual([]);
  });
  test("compaction restoration stays excluded across fires until a fresh harness prompt", () => {
    const lines = fixture("compaction");
    const first = normalize(lines.slice(0, 5));
    const restored = normalize(lines.slice(5), first.attachmentContext);
    expect(restored.documents).toEqual([]);
    const fresh = fixture("mention-text").map(s => JSON.parse(s)); fresh[0].promptSource = "cli";
    expect(normalize(fresh.map(x => JSON.stringify(x)), restored.attachmentContext).documents).toHaveLength(1);
  });
  test("agent-read text, images and undocumented Codex input_file shapes stay excluded", () => {
    const x = JSON.parse(fixture("sdk-read-resume")[2]!);
    x.toolUseResult = { type: "text", file: { filePath: "/project/source.ts", content: "code" } };
    expect(normalize([JSON.stringify(x)]).documents).toEqual([]);
    const img = JSON.parse(fixture("sdk-read-resume")[0]!); img.message.content[0].type = "image";
    expect(normalize([JSON.stringify(img)]).documents).toEqual([]);
    expect(normalizeCodexRollout({ lines: [JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_file", file_data: `data:application/pdf;base64,${pdf.toString("base64")}` }] } })], startOffset: 0, startSeq: 0,
      ctx: { project, transcriptPath: "/rollout.jsonl", sessionId: "s" } }).documents).toEqual([]);
  });
});

describe("materialization, ordering and local state", () => {
  test("consent is required before file I/O; no current-time fallback; exact boundary admitted", () => {
    const candidate: AttachmentCandidate = { origin: "read", format: "application/pdf", filePath: "/missing.pdf", capturedAt: t(1) };
    let calls = 0;
    expect(prepare([candidate], { consentedAt: undefined, afterRead: () => calls++ }).records).toEqual([]);
    expect(prepare([candidate], { enabled: false, afterRead: () => calls++ }).records).toEqual([]);
    expect(calls).toBe(0);
    expect(prepare([text(join(project, "a.md"), "A", 1)], { consentedAt: t(2) }).records).toEqual([]);
    expect(prepare([{ ...text(join(project, "a.md")), suppliedAt: t(0) }], { consentedAt: t(1) }).records).toEqual([]);
    expect(prepare([{ ...text(join(project, "a.md")), capturedAt: undefined }]).records).toEqual([]);
    expect(prepare([text(join(project, "a.md"))], { consentedAt: t(1) }).records[0]!.data.capturedAt).toBe(t(1));
    for (const value of ["0", "off", "false", " OFF "]) expect(attachmentCaptureMode({ AUGENTA_CAPTURE_ATTACHMENTS: value })).toBe("off");
    expect(attachmentCaptureMode({ AUGENTA_CAPTURE_ATTACHMENTS: "all" })).toBe("documents");
  });
  test("project identity is a physical relative path; outside/pasted identity is content", () => {
    const first = prepare([text(join(project, "a.md"))]).records[0]!;
    const edited = prepare([text(join(project, "a.md"), "Changed", 2)]).records[0]!;
    expect(first.sid).toBe(edited.sid);
    expect(first.data.sourcePath).toBe("a.md");
    expect(first.data.documentId).toBe(sha256(`attachment\0claude-code\0${resolve(project)}\0a.md`));
    const outside = prepare([text("/outside/a.md"), text("/elsewhere/b.md")]);
    expect(outside.records).toHaveLength(1);
    expect(outside.records[0]!.data.sourcePath).toBe("a.md");
    const pasted = prepare([{ origin: "prompt", format: "text/plain", text: "First paragraph.", capturedAt: t(1) }]);
    expect(pasted.records[0]!.sid).toBe(outside.records[0]!.sid);
    symlinkSync("/outside", join(project, "escape"));
    expect(prepare([text(join(project, "escape/a.md"))]).records[0]!.sid).toBe(outside.records[0]!.sid);
  });
  test("duplicate copies, revisions, equal-time conflict and unchanged observation watermark", () => {
    const path = join(project, "notes.md");
    const first = prepare([text(path), text(path), text(path, "First paragraph.", 2)]);
    expect(first.records).toHaveLength(1); expect(first.captured).toBe(1);
    expect(Object.values(first.observations)[0]!.capturedAt).toBe(t(2));
    expect(commitAttachments(project, first)).toBe(true);
    const next = prepare([text(path, "Edited paragraph.", 3)]); expect(next.records).toHaveLength(1); commitAttachments(project, next);
    expect(prepare([text(path, "Old", 2), text(path, "Conflicting", 3)]).records).toEqual([]);
    const unchanged = prepare([text(path, "Edited paragraph.", 5)]); expect(unchanged.records).toEqual([]); commitAttachments(project, unchanged);
    expect(prepare([text(path, "Late conflicting replay", 4)]).records).toEqual([]);
    expect(prepare([text(path, "New", 6)]).records).toHaveLength(1);
  });
  test("scrubbed text chunks preserve Unicode and each envelope stays below 512 KiB", () => {
    const result = prepare([text(join(project, "large.md"), "😊".repeat(300_000))]);
    expect(result.records.length).toBeGreaterThan(1);
    expect(result.records.every(d => jsonBytes(d) < MAX_DOCUMENT_EXPERIENCE_BYTES)).toBe(true);
    expect(result.records.map(d => d.data.text).join("")).toBe("😊".repeat(300_000));
    expect(result.records.map(d => d.data.chunkIndex)).toEqual(result.records.map((_, i) => i));
    expect(new Set(result.records.map(d => d.data.chunkCount)).size).toBe(1);
    const secret = prepare([text(join(project, "secret.md"), "token: sk-proj-" + "a".repeat(60))]);
    expect(secret.records[0]!.data.text).not.toContain("a".repeat(60));
  });
  test("validated atomic index is bounded and evicts oldest observations", () => {
    const entries = prepare(Array.from({ length: 8 }, (_, i) => text(join(project, `${i}.md`), `${i}`, i + 1)), { maxIndexBytes: 950 });
    expect(entries.records).toHaveLength(8);
    expect(jsonBytes({ version: 1, documents: entries.observations })).toBeLessThanOrEqual(950);
    expect(Object.values(entries.observations).some(x => x.capturedAt === t(8))).toBe(true);
    expect(Object.values(entries.observations).some(x => x.capturedAt === t(1))).toBe(false);
    expect(commitAttachments(project, entries, 950)).toBe(true);
    expect(prepare([text(join(project, "7.md"), "7", 8)], { maxIndexBytes: 950 }).records).toEqual([]);
    writeFileSync(join(project, ".augenta/state/attachments.json"), " ".repeat(MAX_ATTACHMENT_INDEX_BYTES + 1));
    expect(prepare([text(join(project, "7.md"), "7", 8)]).records).toHaveLength(1);
    writeFileSync(join(project, ".augenta/state/attachments.json"), JSON.stringify({ version: 1, documents: { bogus: { documentId: "bogus" } } }));
    expect(prepare([text(join(project, "7.md"), "7", 8)]).records).toHaveLength(1);
  });
});

describe("PDF snapshots", () => {
  const candidate = (path: string): AttachmentCandidate => ({ origin: "read", format: "application/pdf", filePath: path, capturedAt: t(1) });
  test("generated temporary PDFs and page-range references produce whole PDF bytes", () => {
    const path = join(project, "temporary.pdf"); writeFileSync(path, pdf);
    const result = prepare([candidate(path), candidate(path)]);
    expect(result.records).toHaveLength(1);
    const data = result.records[0]!.data;
    expect(data.kind === "agent-attachment" && data.encoding === "base64" && Buffer.from(data.content, "base64").equals(pdf)).toBe(true);
    expect(readPdfSnapshot(path).equals(pdf)).toBe(true);
  });
  test("embedded bytes take priority over a missing or changed path", () => {
    const supplied = normalize(fixture("mention-pdf")).documents[0]!;
    expect(prepare([supplied]).records).toHaveLength(1);
    supplied.payload!.valid = false;
    expect(prepare([supplied]).skipped).toBe(1);
  });
  test("missing, non-regular, unreadable/invalid and changing snapshots are skipped", () => {
    const path = join(project, "bad.pdf"); writeFileSync(path, "not a PDF");
    expect(prepare([candidate(path)]).skipped).toBe(1);
    expect(prepare([candidate(join(project, "absent.pdf"))]).skipped).toBe(1);
    mkdirSync(join(project, "dir.pdf")); expect(prepare([candidate(join(project, "dir.pdf"))]).skipped).toBe(1);
    writeFileSync(path, pdf);
    expect(prepare([candidate(path)], { afterRead: () => writeFileSync(path, "changed") }).skipped).toBe(1);
    writeFileSync(path, pdf); const replacement = join(project, "replacement.pdf"); writeFileSync(replacement, pdf);
    expect(prepare([candidate(path)], { afterRead: () => renameSync(replacement, path) }).skipped).toBe(1);
  });
  test("oversized PDFs are skipped whole; a following small document still captures", () => {
    const path = join(project, "large.pdf"); writeFileSync(path, Buffer.concat([pdf, Buffer.alloc(400 * 1024)]));
    const result = prepare([candidate(path), text(join(project, "ok.md"))]);
    expect(result.tooLarge).toBe(1); expect(result.records).toHaveLength(1);
    expect(result.records[0]!.data.format).toBe("text/markdown");
  });
});

test("native-turn batches return documents only after the effective checkout capture instant", () => {
  const lines = [0, 2].flatMap(n => [JSON.stringify({ type: "event_msg", timestamp: t(n), payload: { type: "task_started", turn_id: `turn-${n}` } }), JSON.stringify({ type: "event_msg", timestamp: t(n), payload: { type: "task_complete", turn_id: `turn-${n}` } })]);
  const result = normalizeNativeTurns({ lines, startSeq: 0, startOffset: 0, ctx: { project, sessionId: "s", transcriptPath: "/rollout.jsonl" } }, undefined, t(1), opts => ({ events: [], raws: [], nextSeq: opts.startSeq, nextOffset: opts.startOffset + opts.lines.join("\n").length + 1, documents: [text(join(project, "notes.md"), opts.lines[0]!, 2)] }));
  expect(result.documents).toHaveLength(1);
  expect(result.documents[0]!.text).toContain("turn-2");
});
