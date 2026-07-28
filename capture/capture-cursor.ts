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
  /**
   * Set by PreCompact: the harness is about to REWRITE this transcript, so the
   * stored `offset` is about to stop meaning anything. The next fire re-baselines
   * to the file's current size instead of slicing from a stale offset, then
   * clears this. PostCompact clears it immediately where the harness fires one
   * (Codex); Claude Code may only fire PreCompact, which is why the next
   * ORDINARY fire must also be able to consume it.
   */
  rebaseline?: boolean;
  /**
   * Last model seen on this transcript. Only Codex needs it — it announces the
   * model on a `turn_context` line rather than per item, so a mid-turn fire
   * whose tail no longer contains that line needs the value carried forward.
   */
  model?: string;
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
   *  `offset` and `seq` must be non-negative INTEGERS: a corrupted float `seq`
   *  would seed non-integer step seqs that the ingest door 400s (wedging the
   *  outbox permanently), and a float `offset` would mis-slice the byte tail. A
   *  bad cursor falls back to ZERO — a clean rescan beats a wedge.
   *
   *  The optional `rebaseline`/`model` hints are validated but NOT load-bearing,
   *  so a bad value is dropped rather than nuking the whole cursor: they only
   *  refine behavior, while a fallback to ZERO would force a full re-scan and
   *  re-emit every line in the transcript as duplicate events. Wrong hint, right
   *  bytes beats right hint, duplicated bytes. */
  get(transcriptPath: string): CaptureCursor {
    const c = this.readAll()[transcriptPath];
    if (!c || !Number.isInteger(c.offset) || c.offset < 0 || !Number.isInteger(c.seq) || c.seq < 0) {
      return { ...ZERO };
    }
    return {
      offset: c.offset,
      seq: c.seq,
      ...(c.rebaseline === true ? { rebaseline: true } : {}),
      ...(typeof c.model === "string" && c.model ? { model: c.model } : {}),
    };
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
