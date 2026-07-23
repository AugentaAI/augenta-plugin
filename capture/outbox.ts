/**
 * Durable local outbox — the project-scoped turn buffer between capture and the
 * shipper.
 *
 * Capture writes here and NOTHING ELSE in the hook's critical path: no network,
 * no model call. Steps accumulate across a turn (PostToolUse fires), and the
 * Stop-hook flush spawns a detached shipper that drains the spool to the backend
 * and advances a byte-offset high-watermark cursor. This is the reliability
 * primitive — a coding session on a plane keeps capturing; events drain when
 * connectivity returns, with no loss and no duplicates downstream.
 *
 * The spool is a TRANSIENT buffer, not a store of record: once records have
 * shipped, the local copy is reclaimable. It holds three kinds of line —
 * scrubbed CaptureEvents, structurally-sanitized RawRecords, and scrubbed standalone memory
 * documents. Layout (under <project>/.augenta/outbox/, created via
 * ensureAugentaDir so the dir always self-gitignores):
 *   spool.jsonl   append-only canonical records, one JSON per line
 *   cursor.json   { shipped: <byte offset already shipped> }
 *
 * Durability choices: appends use O_APPEND so each line is positioned at EOF, and
 * the single-flight shipper lock keeps writers from interleaving; the cursor is
 * written temp-then-rename so a crash never leaves a half-written watermark. A
 * spool size cap bounds local disk when the backend is unreachable for a long
 * stretch (e.g. the /v1/experiences route not yet deployed). Pure builtins only,
 * so this runs from the installed plugin location with no node_modules.
 */
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import type { CaptureEvent, DocumentRecord, RawRecord } from "./event";
import { ensureAugentaDir } from "./augenta-dir";

const NEWLINE = 0x0a;

/** Stop buffering past this spool size — protects local disk when nothing drains. */
export const MAX_SPOOL_BYTES = 50 * 1024 * 1024;

/** A durable spool line: a trajectory step, structurally-sanitized raw transcript line, or standalone
 * scrubbed memory document. */
export type SpoolRecord = CaptureEvent | RawRecord | DocumentRecord;

/**
 * A parsed spool line is a shippable {@link CaptureEvent} only if it carries the
 * fields the server needs; anything else (corrupt or legacy-format lines) is
 * silently DROPPED rather than shipped malformed — a bad line can never wedge
 * the shipper. `seq` must be an INTEGER, matching the door's rule: a corrupt
 * float-seq record, if shipped, would 400 every batch it rides in and wedge
 * the outbox (the cursor only advances on 2xx).
 */
export function isCaptureEvent(o: unknown): o is CaptureEvent {
  const e = o as Record<string, unknown> | null;
  return !!e && typeof e.sid === "string" && typeof e.text === "string" && Number.isInteger(e.seq);
}

/** A spool line is a {@link RawRecord} when it wraps a raw transcript line. */
export function isRawRecord(o: unknown): o is RawRecord {
  const e = o as Record<string, unknown> | null;
  return !!e && typeof e.raw === "string" && typeof e.sid === "string";
}

/** A spool line is a document record only when it has the complete standalone
 * document shape. Keeping this strict means a corrupt document can never make
 * a POST batch permanently fail and wedge the rest of the outbox. */
export function isDocumentRecord(o: unknown): o is DocumentRecord {
  const e = o as Record<string, unknown> | null;
  if (!e ||
    e.type !== "doc" ||
    (e.src !== "claude-code" && e.src !== "codex") ||
    typeof e.sid !== "string" ||
    typeof e.proj !== "string" ||
    e.proj.length === 0) return false;
  const data = e.data as Record<string, unknown> | null;
  if (!data ||
    data.kind !== "agent-memory" ||
    typeof data.documentId !== "string" || data.documentId.length === 0 ||
    typeof data.sourcePath !== "string" ||
    typeof data.title !== "string" ||
    data.format !== "text/markdown" ||
    typeof data.text !== "string" ||
    typeof data.sourceUpdatedAt !== "string" ||
    typeof data.capturedAt !== "string" ||
    typeof data.revision !== "string" || data.revision.length === 0 ||
    typeof data.deleted !== "boolean" ||
    typeof data.chunkIndex !== "number" || !Number.isInteger(data.chunkIndex) || data.chunkIndex < 0 ||
    typeof data.chunkCount !== "number" || !Number.isInteger(data.chunkCount) || data.chunkCount <= 0) return false;
  return data.chunkIndex < data.chunkCount && e.sid === `memory-${data.documentId}`;
}

export interface PendingBatch {
  /** All recognized record kinds, in spool (append) order. */
  records: SpoolRecord[];
  /** Byte offset in the spool just past the last returned record — pass to {@link Outbox.advance}. */
  endOffset: number;
  /** True when more pending records remain beyond this batch (hit `maxBatch`). */
  hasMore: boolean;
}

export class Outbox {
  readonly dir: string;
  readonly spoolPath: string;
  readonly cursorPath: string;
  private readonly projectRoot: string;
  private readonly maxSpoolBytes: number;

  constructor(projectRoot: string, opts: { maxSpoolBytes?: number } = {}) {
    this.projectRoot = projectRoot;
    this.dir = join(projectRoot, ".augenta", "outbox");
    this.spoolPath = join(this.dir, "spool.jsonl");
    this.cursorPath = join(this.dir, "cursor.json");
    this.maxSpoolBytes = opts.maxSpoolBytes ?? MAX_SPOOL_BYTES;
  }

  private ensure(): void {
    ensureAugentaDir(this.projectRoot); // dir + self-gitignore invariant
    mkdirSync(this.dir, { recursive: true });
  }

  /** Append records (events, raws, and/or documents) to the spool. No-op for
   *  an empty batch. Returns false — without writing anything — when the spool is
   *  already at cap, so the caller (capture.ts) can surface the drop loudly
   *  instead of records silently vanishing. */
  append(records: SpoolRecord[]): boolean {
    if (records.length === 0) return true;
    this.ensure();
    try {
      if (statSync(this.spoolPath).size >= this.maxSpoolBytes) return false; // cap: drop rather than fill the disk
    } catch {
      /* no spool yet — fine */
    }
    appendFileSync(this.spoolPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return true;
  }

  /** Append records BYPASSING the spool cap — used only for the loud
   *  overflow marker itself (bounded ~200B overshoot) so it always reaches
   *  the backend even while ordinary appends are being dropped. */
  forceAppend(records: SpoolRecord[]): void {
    if (records.length === 0) return;
    this.ensure();
    appendFileSync(this.spoolPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  private dropEpisodePath(): string {
    return join(this.dir, "dropped.json");
  }

  /**
   * True the FIRST time this is called during a continuous spool-overflow
   * episode; false on every subsequent call until {@link clearDropEpisode}
   * runs (once the spool fully drains). Backed by a file, not memory — each
   * hook fire is its own process — so capture can emit exactly ONE loud
   * marker per episode instead of one every fire the spool stays full.
   */
  markDropped(): boolean {
    this.ensure();
    const path = this.dropEpisodePath();
    if (existsSync(path)) return false; // episode already marked
    writeFileSync(path, JSON.stringify({ since: new Date().toISOString() }));
    return true;
  }

  /** Clear the drop-episode marker — called once the spool has fully drained. */
  clearDropEpisode(): void {
    try {
      unlinkSync(this.dropEpisodePath());
    } catch {
      /* already gone */
    }
  }

  /** Byte offset already shipped (0 when no/*corrupt* cursor). */
  private shippedOffset(): number {
    try {
      const c = JSON.parse(readFileSync(this.cursorPath, "utf8")) as { shipped?: unknown };
      return typeof c.shipped === "number" && c.shipped >= 0 ? c.shipped : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Cheap check for whether the spool has anything left to ship — a size
   * comparison only, never {@link readPending} (no read/parse of the spool
   * body). Lets a caller that fires on every session (SessionStart) check for
   * a stranded spool — left behind by a Stop that never fired or failed
   * before it could drain — without the cost of a real drain attempt.
   */
  hasPendingBytes(): boolean {
    try {
      return statSync(this.spoolPath).size > this.shippedOffset();
    } catch {
      return false; // no spool yet
    }
  }

  /**
   * Read up to `maxBatch` unshipped records (events, raws, and documents; spool
   * order preserved) starting at the cursor. Returns the records, the byte offset
   * just past the last one (`endOffset`), and whether more remain. `maxBatch`
   * counts every recognized record of either kind. Corrupt/unrecognized lines
   * are skipped but still advance the offset, so a single bad line can never
   * wedge the spool.
   */
  readPending(maxBatch = Infinity): PendingBatch {
    const shipped = this.shippedOffset();
    if (!existsSync(this.spoolPath)) return { records: [], endOffset: shipped, hasMore: false };

    const buf = readFileSync(this.spoolPath);
    const start = Math.min(shipped, buf.length);
    const records: SpoolRecord[] = [];
    let off = start;
    let hasMore = false;
    let cursor = start;

    while (cursor < buf.length) {
      const nl = buf.indexOf(NEWLINE, cursor);
      const lineEnd = nl === -1 ? buf.length : nl; // exclusive of the newline
      const next = nl === -1 ? buf.length : nl + 1; // start of the following line
      const text = buf.subarray(cursor, lineEnd).toString("utf8").trim();

      if (text) {
        if (records.length >= maxBatch) {
          hasMore = true;
          break; // stop BEFORE consuming this line; `off` stays at last good record
        }
        try {
          const parsed = JSON.parse(text);
          if (isCaptureEvent(parsed) || isRawRecord(parsed) || isDocumentRecord(parsed)) records.push(parsed);
          /* else: unrecognized line — drop it, still advance the offset */
        } catch {
          /* drop corrupt local line */
        }
      }
      off = next;
      cursor = next;
    }

    return { records, endOffset: off, hasMore };
  }

  /** Mark everything up to `endOffset` as shipped (atomic temp-then-rename). */
  advance(endOffset: number): void {
    this.ensure();
    const tmp = this.cursorPath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ shipped: endOffset }));
    renameSync(tmp, this.cursorPath);
  }

  /** Pending record count (cheap-ish; reads the spool). */
  pendingCount(): number {
    return this.readPending().records.length;
  }

  /**
   * Reclaim disk once the spool has FULLY drained. Conservative on purpose: it
   * only truncates when `shipped >= size`, never rewriting a partially-shipped
   * spool in place — that would risk losing an append that raced the rewrite.
   * The shipper calls this under its single-flight lock after a successful
   * drain. (A re-stat right before truncation keeps the residual race to the
   * sub-millisecond window between stat and truncate.)
   */
  compact(): void {
    if (!existsSync(this.spoolPath)) return;
    let size: number;
    try {
      size = statSync(this.spoolPath).size;
    } catch {
      return;
    }
    if (size > 0 && this.shippedOffset() >= size) {
      // Rename the spool atomically so any append that races after this point
      // lands in a fresh spool.jsonl rather than the archived copy. This shrinks
      // the TOCTOU window to a single syscall vs the old open+truncate sequence.
      const archivePath = this.spoolPath + ".archive";
      try {
        renameSync(this.spoolPath, archivePath);
      } catch {
        return;
      }
      this.advance(0);
      try {
        unlinkSync(archivePath);
      } catch {
        /* already gone */
      }
    }
  }
}
