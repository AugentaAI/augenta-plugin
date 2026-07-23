/**
 * Project-memory capture.
 *
 * Memory is deliberately a second capture path: it is scanned only at session
 * boundaries, scrubbed before it reaches the durable outbox, and emitted as
 * standalone `type: "doc"` experiences. It never becomes a trajectory event
 * and is never placed in the raw transcript `data` channel.
 */
import { createHash } from "node:crypto";
import {
  type Dirent,
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentMemoryDocument, DocumentRecord, EventSource } from "./event";
import { ensureAugentaDir } from "./augenta-dir";
import { Outbox } from "./outbox";
import { scrub as defaultScrub } from "./scrub";
import type { Scrubber } from "./normalize";

/** The same per-experience wire cap the shipper enforces for trajectories. */
export const MAX_DOCUMENT_EXPERIENCE_BYTES = 512 * 1024;

type MemoryHarness = EventSource;

export interface MemoryCandidate {
  sourcePath: string;
  title: string;
  text: string;
  sourceUpdatedAt: string;
  /** Codex task-group identity, included in the stable document id. */
  taskGroup?: { header: string; scope: string };
}

interface MemoryStateEntry {
  source: MemoryHarness;
  documentId: string;
  sourcePath: string;
  title: string;
  sourceUpdatedAt: string;
  revision: string;
  chunkCount: number;
}

interface MemoryIndex {
  version: 1;
  documents: Record<string, MemoryStateEntry>;
}

export interface CaptureMemoryOptions {
  projectRoot: string;
  harness: MemoryHarness;
  /** Required to find Claude Code's sibling `memory/` directory. */
  transcriptPath?: string;
  /** Test seam and support for a nonstandard CODEX_HOME. */
  codexHome?: string;
  scrub?: Scrubber;
  outbox?: Outbox;
  maxSpoolBytes?: number;
  now?: () => Date;
}

export interface CaptureMemoryResult {
  /** Number of document records successfully accepted by the local outbox. */
  spooled: number;
  /** Number of changed/live logical documents successfully spooled. */
  changed: number;
  /** Number of successfully spooled deletion records. */
  tombstones: number;
  /** Whether the whole applicable memory source was read without an error. */
  complete: boolean;
}

interface ScanResult {
  complete: boolean;
  documents: MemoryCandidate[];
}

function sameSnapshot(before: Stats, after: Stats): boolean {
  return before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function memoryStatePath(projectRoot: string): string {
  return join(projectRoot, ".augenta", "state", "memory.json");
}

function validEntry(value: unknown): value is MemoryStateEntry {
  const e = value as Record<string, unknown> | null;
  return !!e &&
    (e.source === "claude-code" || e.source === "codex") &&
    typeof e.documentId === "string" &&
    typeof e.sourcePath === "string" &&
    typeof e.title === "string" &&
    typeof e.sourceUpdatedAt === "string" &&
    typeof e.revision === "string" &&
    Number.isInteger(e.chunkCount) && (e.chunkCount as number) > 0;
}

function readMemoryIndex(projectRoot: string): MemoryIndex {
  try {
    const parsed = JSON.parse(readFileSync(memoryStatePath(projectRoot), "utf8")) as Record<string, unknown>;
    const rawDocuments = parsed.documents as Record<string, unknown> | undefined;
    if (!parsed || parsed.version !== 1 || !rawDocuments || typeof rawDocuments !== "object") {
      return { version: 1, documents: {} };
    }
    const documents: Record<string, MemoryStateEntry> = {};
    for (const [id, entry] of Object.entries(rawDocuments)) {
      if (validEntry(entry) && entry.documentId === id) documents[id] = entry;
    }
    return { version: 1, documents };
  } catch {
    return { version: 1, documents: {} };
  }
}

/** Atomically persist state only after every record for a revision reached the outbox. */
function writeMemoryIndex(projectRoot: string, index: MemoryIndex): boolean {
  const stateDir = join(ensureAugentaDir(projectRoot), "state");
  const path = join(stateDir, "memory.json");
  const tmp = path + ".tmp";
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(index));
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

function boundedTitle(title: string): string {
  return [...title].slice(0, 512).join("");
}

function markdownTitle(text: string, fallback: string): string {
  const heading = markdownH1s(text)[0]?.title;
  // Keep document metadata comfortably below the envelope cap even if a source
  // contains a deliberately enormous heading.
  return boundedTitle(heading || fallback);
}

function normalizeLogicalPath(path: string): string {
  return path.split(sep).join("/");
}

/** Claude Code memory is sibling to the session transcript directory. */
function scanClaudeMemory(transcriptPath: string | undefined): ScanResult {
  if (!transcriptPath) return { complete: false, documents: [] };
  const root = join(dirname(transcriptPath), "memory");
  try {
    if (!existsSync(root) || !lstatSync(root).isDirectory()) return { complete: false, documents: [] };
  } catch {
    return { complete: false, documents: [] };
  }

  const documents: MemoryCandidate[] = [];
  let complete = true;
  const walk = (dir: string): void => {
    let directoryBefore: Stats;
    let entries: Dirent<string>[];
    try {
      directoryBefore = lstatSync(dir);
      if (!directoryBefore.isDirectory()) {
        complete = false;
        return;
      }
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      complete = false;
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      // Never follow links: a memory root may legitimately contain shortcuts,
      // but capture must not traverse outside the harness-owned source tree.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;
      try {
        // Re-stat protects the regular-file requirement if an entry changed
        // between readdir and read.
        const before = lstatSync(path);
        if (!before.isFile()) {
          complete = false;
          continue;
        }
        const text = readFileSync(path, "utf8");
        const after = lstatSync(path);
        if (!after.isFile() || !sameSnapshot(before, after)) {
          complete = false;
          continue;
        }
        const sourcePath = normalizeLogicalPath(relative(root, path));
        documents.push({
          sourcePath,
          title: markdownTitle(text, basename(entry.name, extname(entry.name))),
          text,
          sourceUpdatedAt: after.mtime.toISOString(),
        });
      } catch {
        complete = false;
      }
    }
    try {
      const directoryAfter = lstatSync(dir);
      if (!directoryAfter.isDirectory() || !sameSnapshot(directoryBefore, directoryAfter)) complete = false;
    } catch {
      complete = false;
    }
  };
  walk(root);
  return { complete, documents };
}

function isScopedToProject(scope: string, projectRoot: string): boolean {
  if (!isAbsolute(scope)) return false;
  const root = resolve(projectRoot);
  const target = resolve(scope);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

interface MarkdownH1 {
  start: number;
  contentStart: number;
  title: string;
}

/** Find real level-one Markdown headings while ignoring heading-shaped text in
 * fenced code blocks. Offsets preserve the exact source bytes of each section. */
function markdownH1s(text: string): MarkdownH1[] {
  const headings: MarkdownH1[] = [];
  let offset = 0;
  let fence: { marker: "`" | "~"; length: number } | undefined;
  for (const rawLine of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (rawLine.length === 0) continue;
    const line = (rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine).replace(/\r$/, "");
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const closing = new RegExp(`^ {0,3}\\${fence.marker}{${fence.length},}\\s*$`);
      if (closing.test(line)) fence = undefined;
    } else if (fenceMatch) {
      const run = fenceMatch[1]!;
      fence = { marker: run[0] as "`" | "~", length: run.length };
    } else {
      const heading = /^ {0,3}#(?!#)\s+(.+?)\s*$/.exec(line);
      if (heading) {
        const title = heading[1]!.replace(/\s+#+\s*$/, "").trim();
        headings.push({ start: offset, contentStart: offset + rawLine.length, title });
      }
    }
    offset += rawLine.length;
  }
  return headings;
}

/**
 * Split Codex's global MEMORY.md into Task Group H1 sections. Scope metadata
 * must be the first nonblank line after the heading; a body example that merely
 * mentions `applies_to: cwd=...` cannot grant capture scope. Any following H1,
 * including a profile or summary section, ends the Task Group.
 */
export function parseCodexTaskGroups(text: string, projectRoot: string): MemoryCandidate[] {
  const headings = markdownH1s(text);
  const documents: MemoryCandidate[] = [];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!;
    const taskGroup = /^Task Group:\s*(.+?)\s*$/.exec(heading.title);
    if (!taskGroup) continue;
    const end = headings[i + 1]?.start ?? text.length;
    const block = text.slice(heading.start, end);
    const header = taskGroup[1]!.trim();
    const firstBodyLine = text
      .slice(heading.contentStart, end)
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0);
    const scopeMatch = firstBodyLine ? /^ {0,3}applies_to:\s*cwd=(.+?)\s*$/.exec(firstBodyLine) : null;
    if (!scopeMatch) continue; // mandatory project scope; never capture global/unscoped memory
    const scope = scopeMatch[1]!.trim().replace(/^['"]|['"]$/g, "");
    if (!isScopedToProject(scope, projectRoot)) continue;
    const identity = sha256(`${header}\0${scope}`).slice(0, 24);
    documents.push({
      sourcePath: `MEMORY.md#task-group-${identity}`,
      title: boundedTitle(`Task Group: ${header}`),
      text: block,
      // Filled by the caller from MEMORY.md's mtime.
      sourceUpdatedAt: "",
      taskGroup: { header, scope },
    });
  }
  return documents;
}

function scanCodexMemory(projectRoot: string, codexHome: string | undefined): ScanResult {
  const root = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const path = join(root, "memories", "MEMORY.md");
  try {
    if (!existsSync(path)) return { complete: false, documents: [] };
    const linkBefore = lstatSync(path);
    const before = statSync(path);
    if (!before.isFile()) return { complete: false, documents: [] };
    const text = readFileSync(path, "utf8");
    const linkAfter = lstatSync(path);
    const after = statSync(path);
    if (!after.isFile() ||
      !sameSnapshot(linkBefore, linkAfter) ||
      !sameSnapshot(before, after)) return { complete: false, documents: [] };
    const sourceUpdatedAt = after.mtime.toISOString();
    return {
      complete: true,
      documents: parseCodexTaskGroups(text, projectRoot).map((doc) => ({ ...doc, sourceUpdatedAt })),
    };
  } catch {
    return { complete: false, documents: [] };
  }
}

function documentId(source: MemoryHarness, projectRoot: string, candidate: MemoryCandidate): string {
  const taskGroup = candidate.taskGroup;
  const discriminator = taskGroup ? `\0${taskGroup.header}\0${taskGroup.scope}` : "";
  return sha256(`${source}\0${resolve(projectRoot)}\0${candidate.sourcePath}${discriminator}`);
}

function revision(text: string, deleted: boolean): string {
  return sha256(`${deleted ? "deleted" : "live"}\0${text}`);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function safeBoundary(text: string, index: number): number {
  if (index > 0 && index < text.length) {
    const previous = text.charCodeAt(index - 1);
    const next = text.charCodeAt(index);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return index - 1;
  }
  return index;
}

function chunkText(
  text: string,
  makeRecord: (chunk: string, chunkIndex: number, chunkCount: number) => DocumentRecord,
): string[] {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  let start = 0;
  // Larger than any realistic document chunk index/count. If this envelope
  // fits, substituting the actual smaller numbers can only shrink it.
  const sizingIndex = 999_999_999;
  while (start < text.length) {
    let lo = start + 1;
    let hi = text.length;
    let best = -1;
    while (lo <= hi) {
      const rawMid = Math.floor((lo + hi) / 2);
      const mid = safeBoundary(text, rawMid);
      if (mid <= start) {
        lo = rawMid + 1;
        continue;
      }
      const chunk = text.slice(start, mid);
      if (jsonBytes(makeRecord(chunk, sizingIndex, sizingIndex)) < MAX_DOCUMENT_EXPERIENCE_BYTES) {
        best = mid;
        lo = rawMid + 1;
      } else {
        hi = rawMid - 1;
      }
    }
    if (best <= start) {
      // Metadata is bounded above, so a single Unicode scalar always fits. If
      // an impossible future schema breaks that invariant, fail closed instead
      // of spooling an over-limit experience that would wedge delivery.
      return [];
    }
    chunks.push(text.slice(start, best));
    start = best;
  }
  return chunks;
}

function makeLiveRecords(
  source: MemoryHarness,
  projectRoot: string,
  candidate: MemoryCandidate,
  scrubbedText: string,
  documentRevision: string,
  capturedAt: string,
): DocumentRecord[] {
  const id = documentId(source, projectRoot, candidate);
  const base: Omit<AgentMemoryDocument, "text" | "chunkIndex" | "chunkCount"> = {
    kind: "agent-memory",
    documentId: id,
    sourcePath: candidate.sourcePath,
    title: candidate.title,
    format: "text/markdown",
    sourceUpdatedAt: candidate.sourceUpdatedAt,
    capturedAt,
    revision: documentRevision,
    deleted: false,
  };
  const makeRecord = (text: string, chunkIndex: number, chunkCount: number): DocumentRecord => ({
    src: source,
    sid: `memory-${id}`,
    proj: projectRoot,
    type: "doc",
    data: { ...base, text, chunkIndex, chunkCount },
  });
  const chunks = chunkText(scrubbedText, makeRecord);
  return chunks.map((text, chunkIndex) => makeRecord(text, chunkIndex, chunks.length));
}

function makeTombstone(
  source: MemoryHarness,
  projectRoot: string,
  previous: MemoryStateEntry,
  capturedAt: string,
): DocumentRecord {
  const documentRevision = revision("", true);
  return {
    src: source,
    sid: `memory-${previous.documentId}`,
    proj: projectRoot,
    type: "doc",
    data: {
      kind: "agent-memory",
      documentId: previous.documentId,
      sourcePath: previous.sourcePath,
      title: previous.title,
      format: "text/markdown",
      text: "",
      // The source no longer exists; preserve its last observed update time so
      // consumers can distinguish a deletion from a newly-created empty file.
      sourceUpdatedAt: previous.sourceUpdatedAt,
      capturedAt,
      revision: documentRevision,
      deleted: true,
      chunkIndex: 0,
      chunkCount: 1,
    },
  };
}

/**
 * Scan the applicable harness memory and atomically (at the outbox/state
 * protocol level) queue changed document revisions. A full revision is always
 * appended in one outbox call; state advances only after that call succeeds.
 */
export function captureAgentMemory(opts: CaptureMemoryOptions): CaptureMemoryResult {
  const scan = opts.harness === "codex"
    ? scanCodexMemory(opts.projectRoot, opts.codexHome)
    : scanClaudeMemory(opts.transcriptPath);
  const empty: CaptureMemoryResult = { spooled: 0, changed: 0, tombstones: 0, complete: scan.complete };
  if (scan.documents.length === 0 && !scan.complete) return empty;

  const scrub = opts.scrub ?? defaultScrub;
  const capturedAt = (opts.now ?? (() => new Date()))().toISOString();
  const current = new Map<string, { candidate: MemoryCandidate; revision: string; records: DocumentRecord[] }>();
  try {
    for (const candidate of scan.documents) {
      const text = scrub(candidate.text);
      const id = documentId(opts.harness, opts.projectRoot, candidate);
      const documentRevision = revision(text, false);
      const scrubbedCandidate = { ...candidate, title: boundedTitle(scrub(candidate.title)) };
      current.set(id, {
        candidate: scrubbedCandidate,
        revision: documentRevision,
        records: makeLiveRecords(opts.harness, opts.projectRoot, scrubbedCandidate, text, documentRevision, capturedAt),
      });
    }
  } catch {
    return empty; // a scanner/scrubber failure never interferes with the hook
  }

  const oldIndex = readMemoryIndex(opts.projectRoot);
  const nextIndex: MemoryIndex = { version: 1, documents: { ...oldIndex.documents } };
  const records: DocumentRecord[] = [];
  let changed = 0;
  let tombstones = 0;

  for (const [id, live] of current) {
    const prior = oldIndex.documents[id];
    if (prior?.revision === live.revision &&
      prior.chunkCount === live.records.length &&
      prior.title === live.candidate.title) continue;
    // An empty `records` result means metadata would itself violate the envelope
    // cap. Leave state untouched so it can be retried after an upgrade/fix.
    if (live.records.length === 0) return empty;
    records.push(...live.records);
    changed += 1;
    nextIndex.documents[id] = {
      source: opts.harness,
      documentId: id,
      sourcePath: live.candidate.sourcePath,
      title: live.candidate.title,
      sourceUpdatedAt: live.candidate.sourceUpdatedAt,
      revision: live.revision,
      chunkCount: live.records.length,
    };
  }

  // Only a complete source scan can prove a previously observed document is
  // gone. Missing/unreadable/partial roots preserve state and therefore retry
  // safely on the next lifecycle boundary.
  if (scan.complete) {
    for (const [id, prior] of Object.entries(oldIndex.documents)) {
      if (prior.source !== opts.harness || current.has(id)) continue;
      records.push(makeTombstone(opts.harness, opts.projectRoot, prior, capturedAt));
      delete nextIndex.documents[id];
      tombstones += 1;
    }
  }

  if (records.length === 0) return empty;
  const outbox = opts.outbox ?? new Outbox(opts.projectRoot, { maxSpoolBytes: opts.maxSpoolBytes });
  let accepted = false;
  try {
    accepted = outbox.append(records);
  } catch {
    return empty;
  }
  if (!accepted || !writeMemoryIndex(opts.projectRoot, nextIndex)) return empty;
  return { spooled: records.length, changed, tombstones, complete: scan.complete };
}
