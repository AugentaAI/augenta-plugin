/**
 * Per-transcript capture cursor — where the live tail left off.
 *
 * Capture is hook-triggered and incremental: each PostToolUse/Stop fires, we
 * tail only the NEW bytes of the transcript since last time, and assign the next
 * monotonic `seq`. That bookkeeping lives here, keyed by absolute transcript
 * path under <project>/.augenta/state/capture.json:
 *
 *   { "/abs/transcript.jsonl": { "offset": 48213, "seq": 142 }, ... }
 *
 * Distinct from the outbox's ship cursor (how much has been SHIPPED) — this is
 * how much has been CAPTURED from each source transcript. Atomic writes
 * (temp-then-rename) so a crash never corrupts the map. Pure builtins only.
 */
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { ensureAugentaDir } from "./augenta-dir";

export interface CaptureCursor {
  /** Byte offset in the transcript already consumed. */
  offset: number;
  /** Next per-session sequence number to assign. */
  seq: number;
}

const ZERO: CaptureCursor = { offset: 0, seq: 0 };

export class CaptureState {
  readonly path: string;
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.path = join(projectRoot, ".augenta", "state", "capture.json");
  }

  private readAll(): Record<string, CaptureCursor> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, CaptureCursor>) : {};
    } catch {
      return {}; // corrupt map → start clean rather than wedge capture
    }
  }

  /** Cursor for a transcript; {offset:0, seq:0} when unseen or malformed.
   *  Both fields must be non-negative INTEGERS: a corrupted float `seq` would
   *  seed non-integer step seqs that the ingest door 400s (wedging the outbox
   *  permanently), and a float `offset` would mis-slice the byte tail. A bad
   *  cursor falls back to ZERO — a clean rescan beats a wedge. */
  get(transcriptPath: string): CaptureCursor {
    const c = this.readAll()[transcriptPath];
    return c && Number.isInteger(c.offset) && c.offset >= 0 && Number.isInteger(c.seq) && c.seq >= 0
      ? c
      : { ...ZERO };
  }

  /** Persist the advanced cursor for a transcript (atomic). */
  set(transcriptPath: string, cursor: CaptureCursor): void {
    ensureAugentaDir(this.projectRoot); // dir + self-gitignore invariant
    mkdirSync(dirname(this.path), { recursive: true });
    const all = this.readAll();
    all[transcriptPath] = cursor;
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(all));
    renameSync(tmp, this.path);
  }
}
