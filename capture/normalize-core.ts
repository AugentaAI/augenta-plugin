/**
 * Shared core for the per-harness transcript normalizers.
 *
 * Owns the ONE thing every normalizer has in common — the incremental-tail
 * bookkeeping (byte offset + monotonic seq) — and the I/O-free contract types.
 * The harness-specific shape knowledge lives in the sibling modules
 * (`normalize-claude.ts`, `normalize-codex.ts`); this module knows nothing about
 * any transcript format. Pure: no I/O, no network, no LLM.
 */
import type { CaptureEvent, EventSource } from "./event";
import { sanitizeTelemetryRecord } from "./sanitize";

/** A scrub function applied to step text client-side before it is placed into a {@link CaptureEvent}. */
export type Scrubber = (text: string) => string;

/** Context the transcript lines don't carry but the hook payload does. */
export interface NormalizeCtx {
  /** Fallback session id (from the hook payload) when a line omits its own. */
  sessionId: string;
  /** Project root (cwd from the hook payload). */
  project: string;
  /** Absolute transcript path, used to build `ref` (and, for Codex, the session id). */
  transcriptPath: string;
  /** Which harness produced this transcript; defaults per-normalizer when absent. */
  harness?: EventSource;
}

export interface NormalizeResult {
  events: CaptureEvent[];
  /** One entry per consumed NON-BLANK, valid JSON line, structurally sanitized
   *  but otherwise raw — the raw-telemetry channel's feedstock. `sid` is the SAME per-line
   *  derivation the sibling event got (the event's own sid when the line
   *  produced one), so a turn's raws always group into the same experience
   *  as its steps — a divergent sid would orphan the raws into a zero-event
   *  group that ship drops silently. */
  raws: Array<{ raw: string; sid: string }>;
  /** Next `seq` to assign (so a follow-up tail continues monotonically). */
  nextSeq: number;
  /** Byte offset just past the last consumed line (the new tail cursor). */
  nextOffset: number;
}

/** Shared input for the per-harness normalizers (Claude transcript / Codex rollout). */
export interface NormalizeOpts {
  /** Raw JSONL lines tailed since `startOffset` (no trailing newline). */
  lines: string[];
  ctx: NormalizeCtx;
  /** Next sequence number for this session. */
  startSeq: number;
  /** Byte offset the tail started at (for `ref.off` + the advancing cursor). */
  startOffset: number;
  scrub?: Scrubber;
}

/**
 * Walk new JSONL lines tracking the byte offset + monotonic seq, delegating each
 * non-blank line to `toEvent`. This is the single place the incremental-tail
 * bookkeeping lives, so every harness normalizer shares identical cursor
 * semantics: `ref.off` points exactly at the source line and `nextOffset`
 * advances the caller's cursor, keeping capture incremental and idempotent across
 * hook firings. `toEvent` returns null to skip a line (unparseable, blank of
 * signal, or an event type we don't map) without consuming a seq.
 *
 * Every non-blank valid JSON line — event-producing or skipped — is also
 * surfaced in `raws`, structurally sanitized, carrying the sid its sibling
 * event got (or `lineSid`'s per-line derivation when no event was produced).
 * The line is parsed and sanitized once, then the same value feeds both
 * callbacks and raw serialization. Keeping the two channels' sid derivation in
 * ONE walk is what guarantees a turn's raws and steps land in the same
 * experience on every harness.
 */
export function tailToEvents(
  lines: string[],
  startSeq: number,
  startOffset: number,
  toEvent: (sanitized: unknown, seq: number, off: number) => CaptureEvent | null,
  lineSid: (sanitized: unknown) => string,
): NormalizeResult {
  const events: CaptureEvent[] = [];
  const raws: Array<{ raw: string; sid: string }> = [];
  let seq = startSeq;
  let off = startOffset;

  for (const raw of lines) {
    // Byte offset of THIS line's start; advance past it (+1 for the newline) after.
    const lineOff = off;
    off += Buffer.byteLength(raw, "utf8") + 1;

    const trimmed = raw.trim();
    if (!trimmed) continue;

    // A malformed transcript line still advances the cursor but cannot be
    // structurally sanitized, so it is intentionally excluded from both
    // normalization and raw egress.
    const sanitized = sanitizeTelemetryRecord(raw);
    if (sanitized === undefined) continue;

    const event = toEvent(sanitized.value, seq, lineOff);
    if (event) {
      events.push(event);
      seq += 1;
    }
    raws.push({ raw: sanitized.json, sid: event ? event.sid : lineSid(sanitized.value) });
  }

  return { events, raws, nextSeq: seq, nextOffset: off };
}
