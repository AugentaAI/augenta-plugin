/** Transcript-supplied documents. Extraction is pure; file snapshots happen only after consent. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
import type { AgentAttachmentDocument, DocumentRecord, EventSource } from "./event";
import { attachmentHash, type RemovedPayload } from "./sanitize";
import { boundedTitle, chunkText, documentTimestamp, isScopedToProject, jsonBytes, MAX_DOCUMENT_EXPERIENCE_BYTES,
  normalizeLogicalPath, physicalPath, readDocumentIndex, sameSnapshot, sha256, writeDocumentIndex } from "./documents";
import type { Scrubber } from "./normalize-core";

export interface AttachmentCandidate {
  origin: "mention" | "prompt" | "read";
  format: "text/plain" | "text/markdown" | "application/pdf";
  capturedAt?: string;
  /** For mentions, the initiating prompt must also follow consent. */
  suppliedAt?: string;
  filePath?: string;
  title?: string;
  text?: string;
  payload?: RemovedPayload;
}
/** Bounded parent-chain context, persisted beside the transcript byte cursor. */
export interface AttachmentContext {
  compact: boolean;
  parent?: string;
  suppliedAt?: string;
  paths: string[];
}
export function validAttachmentContext(value: unknown): value is AttachmentContext {
  const x = value as AttachmentContext | null;
  return !!x && typeof x.compact === "boolean" && Array.isArray(x.paths) && x.paths.length <= 64 &&
    x.paths.every(p => typeof p === "string" && p.length <= 4096) &&
    (x.parent === undefined || (typeof x.parent === "string" && x.parent.length <= 256)) &&
    (x.suppliedAt === undefined || documentTimestamp(x.suppliedAt) !== undefined);
}
const object = (x: any): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
function filePath(value: unknown, project: string): string | undefined {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0") || /^[a-z]+:\/\//i.test(value)) return;
  return resolve(project, value);
}
function mentionPaths(content: unknown, project: string): string[] {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n") : "";
  const paths: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g)) {
    const path = filePath(m[1] ?? m[2] ?? m[3], project);
    if (path && !paths.includes(path)) paths.push(path);
    if (paths.length === 64) break;
  }
  return paths;
}
function removed(value: unknown, payloads: Map<string, RemovedPayload>): RemovedPayload | undefined {
  const hash = attachmentHash(value);
  return hash ? payloads.get(hash) : undefined;
}

/** Only shapes backed by native fixtures. A tool result's duplicate message block is never extracted. */
export function extractClaudeAttachments(
  value: unknown, payloads: Map<string, RemovedPayload>, project: string, prior?: AttachmentContext,
): { documents: AttachmentCandidate[]; context: AttachmentContext } {
  let context: AttachmentContext = prior ? { ...prior, paths: [...prior.paths] } : { compact: false, paths: [] };
  const documents: AttachmentCandidate[] = [];
  if (!object(value)) return { documents, context };
  const x = value;
  const capturedAt = documentTimestamp(x.timestamp ?? x.message?.timestamp);
  const uuid = typeof x.uuid === "string" && x.uuid.length <= 256 ? x.uuid : undefined;
  if ((x.type === "system" && x.subtype === "compact_boundary") || x.isCompactSummary === true ||
      (x.type === "attachment" && x.attachment?.type === "compact_file_reference")) {
    return { documents, context: { compact: true, paths: [] } };
  }
  // A fresh assistant or explicit harness prompt ends restoration. Old restored
  // user records without prompt provenance cannot reopen attachment capture.
  if (x.type === "assistant") return { documents, context: { compact: false, paths: [] } };
  const content = x.message?.content;
  const toolResult = Array.isArray(content) && content.some(b => b?.type === "tool_result");
  if (x.type === "user" && x.isMeta !== true && x.isVisibleInTranscriptOnly !== true && !toolResult && !x.toolUseResult) {
    if (x.promptSource === "sdk" || x.promptSource === "cli" || x.turnOrigin === "sdk") context.compact = false;
    if (context.compact) return { documents, context };
    context = { compact: false, paths: mentionPaths(content, project), parent: uuid, suppliedAt: capturedAt };
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type !== "document" || !object(b.source)) continue;
      const s = b.source;
      if (s.type === "text" && typeof s.data === "string" && ["text/plain", "text/markdown"].includes(s.media_type)) {
        documents.push({ origin: "prompt", format: s.media_type, capturedAt, text: s.data, title: b.title });
      } else if (s.type === "base64" && s.media_type === "application/pdf") {
        documents.push({ origin: "prompt", format: "application/pdf", capturedAt, payload: removed(s.data, payloads), title: b.title });
      }
    }
    return { documents, context };
  }
  if (context.compact) return { documents, context };
  if (x.type === "attachment") {
    if (!uuid || !context.parent || x.parentUuid !== context.parent) return { documents, context: { compact: false, paths: [] } };
    context.parent = uuid;
    const a = x.attachment;
    const c = a?.content;
    const path = filePath(c?.file?.filePath, project);
    if (a?.type === "file" && path && context.paths.includes(path)) {
      if (c.type === "text" && typeof c.file.content === "string") {
        documents.push({ origin: "mention", format: /\.md(?:own)?$/i.test(path) ? "text/markdown" : "text/plain",
          filePath: path, text: c.file.content, capturedAt, suppliedAt: context.suppliedAt });
      } else if (c.type === "pdf") {
        documents.push({ origin: "mention", format: "application/pdf", filePath: path,
          payload: removed(c.file.base64, payloads), capturedAt, suppliedAt: context.suppliedAt });
      }
    }
    return { documents, context };
  }
  const r = x.toolUseResult;
  if (x.type === "user" && toolResult && object(r) && (r.type === "pdf" || r.type === "parts")) {
    const path = filePath(r.file?.filePath, project);
    if (path && (r.type === "pdf" || extname(path).toLowerCase() === ".pdf")) {
      documents.push({ origin: "read", format: "application/pdf", filePath: path,
        payload: r.type === "pdf" ? removed(r.file?.base64, payloads) : undefined, capturedAt });
    }
  }
  return { documents, context };
}

export const MAX_ATTACHMENT_INDEX_BYTES = 4 * 1024 * 1024;
// Base64 alone at this size exhausts an envelope; final metadata sizing is stricter.
const MAX_PDF_BYTES = Math.floor(MAX_DOCUMENT_EXPERIENCE_BYTES * 3 / 4);
class TooLarge extends Error {}
function pdfContent(bytes: Buffer): boolean {
  return /^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString("ascii")) &&
    bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from("%%EOF"));
}
/** A bounded regular-file snapshot; includes descriptor and path replacement checks. */
export function readPdfSnapshot(path: string, afterRead?: () => void): Buffer {
  const physical = realpathSync(path);
  const entry = lstatSync(physical);
  if (!entry.isFile()) throw new Error("not_regular");
  if (entry.size > MAX_PDF_BYTES) throw new TooLarge();
  let fd = -1;
  try {
    fd = openSync(physical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || !sameSnapshot(entry, before)) throw new Error("changed");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw new Error("changed");
      offset += n;
    }
    afterRead?.();
    if (!sameSnapshot(before, fstatSync(fd)) || !sameSnapshot(before, lstatSync(physical)) || realpathSync(path) !== physical) throw new Error("changed");
    if (!pdfContent(bytes)) throw new Error("not_pdf");
    return bytes;
  } finally { if (fd >= 0) closeSync(fd); }
}

export interface AttachmentObservation { documentId: string; revision: string; chunkCount: number; capturedAt: string }
function validObservation(x: unknown): x is AttachmentObservation {
  const v = x as AttachmentObservation | null;
  return !!v && typeof v.documentId === "string" && /^[a-f0-9]{64}$/.test(v.documentId) &&
    typeof v.revision === "string" && /^[a-f0-9]{64}$/.test(v.revision) &&
    Number.isSafeInteger(v.chunkCount) && v.chunkCount > 0 &&
    typeof v.capturedAt === "string" && documentTimestamp(v.capturedAt) === v.capturedAt;
}
export interface PreparedAttachments {
  records: DocumentRecord[];
  observations: Record<string, AttachmentObservation>;
  captured: number;
  skipped: number;
  tooLarge: number;
}
export function prepareAttachments(projectRoot: string, harness: EventSource, candidates: AttachmentCandidate[], opts: {
  consentedAt?: string; enabled: boolean; scrub: Scrubber; maxIndexBytes?: number; afterRead?: () => void;
}): PreparedAttachments {
  const maxIndexBytes = opts.maxIndexBytes ?? MAX_ATTACHMENT_INDEX_BYTES;
  const result: PreparedAttachments = { records: [], observations: {}, captured: 0, skipped: 0, tooLarge: 0 };
  const consent = documentTimestamp(opts.consentedAt);
  if (!opts.enabled || !consent) return result;
  result.observations = readDocumentIndex(projectRoot, "attachments.json", validObservation, maxIndexBytes);
  const root = physicalPath(projectRoot);
  for (const c of candidates) {
    const capturedAt = documentTimestamp(c.capturedAt);
    if (!capturedAt || capturedAt < consent || (c.origin === "mention" && (!c.suppliedAt || c.suppliedAt < consent))) { result.skipped++; continue; }
    try {
      let text: string | undefined, bytes: Buffer | undefined;
      if (c.format === "application/pdf") {
        if (c.payload) {
          if (!c.payload.valid) throw new Error("invalid_payload");
          if (c.payload.bytes > MAX_PDF_BYTES) throw new TooLarge();
          bytes = Buffer.from(c.payload.content, "base64");
          if (!pdfContent(bytes)) throw new Error("not_pdf");
        } else if (c.filePath) bytes = readPdfSnapshot(c.filePath, opts.afterRead);
        else throw new Error("missing_payload");
      } else if (typeof c.text === "string") text = opts.scrub(c.text);
      else throw new Error("missing_text");
      const revision = sha256(bytes ?? text!);
      const path = c.filePath && physicalPath(c.filePath);
      const scoped = root && path && isScopedToProject(path, root);
      const sourcePath = scoped ? normalizeLogicalPath(relative(root, path)) : c.filePath ? basename(c.filePath) : "supplied-document";
      const key = scoped ? sourcePath : `sha256:${revision}`;
      const documentId = sha256(`attachment\0${harness}\0${resolve(projectRoot)}\0${key}`);
      const prior = result.observations[documentId];
      if (prior && prior.revision === revision) {
        if (capturedAt > prior.capturedAt) result.observations[documentId] = { ...prior, capturedAt };
        continue;
      }
      if (prior && capturedAt <= prior.capturedAt) { result.skipped++; continue; }
      const metadata = { kind: "agent-attachment" as const, documentId, sourcePath: opts.scrub(sourcePath),
        title: boundedTitle(opts.scrub(typeof c.title === "string" ? c.title : basename(sourcePath))),
        format: c.format, origin: c.origin, revision, capturedAt, deleted: false as const };
      const record = (payload: { text: string } | { encoding: "base64"; content: string; mediaType: "application/pdf" }, chunkIndex: number, chunkCount: number): DocumentRecord => ({
        type: "doc", src: harness, sid: `attachment-${documentId}`, proj: projectRoot,
        data: { ...metadata, ...payload, chunkIndex, chunkCount } as AgentAttachmentDocument,
      });
      let records: DocumentRecord[];
      if (bytes) {
        const doc = record({ encoding: "base64", content: bytes.toString("base64"), mediaType: "application/pdf" }, 0, 1);
        if (jsonBytes(doc) >= MAX_DOCUMENT_EXPERIENCE_BYTES) throw new TooLarge();
        records = [doc];
      } else {
        const chunks = chunkText(text!, (part, i, n) => record({ text: part }, i, n));
        if (!chunks.length) throw new TooLarge();
        records = chunks.map((part, i) => record({ text: part }, i, chunks.length));
      }
      result.records.push(...records); result.captured++;
      Object.defineProperty(result.observations, documentId, { value: { documentId, revision, chunkCount: records.length, capturedAt }, enumerable: true, writable: true, configurable: true });
    } catch (e) { if (e instanceof TooLarge) result.tooLarge++; else result.skipped++; }
  }
  // Evict the oldest observed entries, including unchanged-content observations.
  let size = jsonBytes({ version: 1, documents: result.observations });
  let count = Object.keys(result.observations).length;
  for (const entry of Object.values(result.observations).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.documentId.localeCompare(b.documentId))) {
    if (size <= maxIndexBytes) break;
    size -= jsonBytes(entry.documentId) + 1 + jsonBytes(entry) + (count-- > 1 ? 1 : 0);
    delete result.observations[entry.documentId];
  }
  return result;
}
/** Called only after the trajectory+document append is accepted, under the capture lock. */
export function commitAttachments(root: string, prepared: PreparedAttachments, maxBytes = MAX_ATTACHMENT_INDEX_BYTES): boolean {
  return writeDocumentIndex(root, "attachments.json", prepared.observations, maxBytes);
}
