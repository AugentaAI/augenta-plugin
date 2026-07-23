#!/usr/bin/env bun
/**
 * Augenta shipper — drains the project's outbox to the Augenta backend as
 * turn-grouped EXPERIENCES (the wire shape of `POST /v1/experiences`).
 *
 * Runs DETACHED, off the hook's critical path (spawned fire-and-forget by
 * capture.ts on the Stop fire — the agent-turn boundary), with the project root
 * as argv[2]. It is the one place that touches the network: it groups the
 * buffered trajectory records by (src, sid, proj, turn) into trajectory
 * `Experience` envelopes — CaptureEvents fill `events` (scrubbed, applied
 * before they reached the outbox), RawRecords fill `data` (otherwise-raw
 * transcript lines structurally sanitized for opaque reasoning artifacts).
 * Standalone scrubbed memory documents pass
 * through as `type: "doc"` envelopes with no `events` field. The shipper sends
 * them together as `{ experiences: [...] }`; the server owns everything
 * downstream.
 *
 * Guarantees:
 *   • Single-flight — a .lock in the outbox dir stops concurrent triggers from
 *     double-shipping; a stale lock (crashed shipper) is reclaimed after a
 *     timeout.
 *   • Idempotent — per-event identity (sid, seq) is content-stable server-side
 *     (identity derives from the event seqs), so a retry of the same batch
 *     dedupes; an experience split across batches yields two envelopes with the
 *     same sid and disjoint seq ranges, which the server lands as two records
 *     (merged on read).
 *   • Fail-safe — on a TRANSIENT failure (network error, 401/403/408/429/5xx),
 *     the cursor is NOT advanced; the batch stays in the outbox and the next
 *     Stop retries it. A PERMANENT rejection (400/413/422 — the door will
 *     never accept these exact bytes) is quarantined to
 *     `.augenta/outbox/rejected.jsonl` instead of retried forever; the
 *     cursor advances past it so one bad body can't wedge everything behind it.
 *   • Bounded — every envelope is forced under MAX_EXPERIENCE_BYTES by a
 *     ladder (keep as much of the raw `data` channel as fits, with a loud
 *     marker for what didn't → split the steps into envelopes with disjoint
 *     seq ranges → truncate a single giant step's text with a loud marker),
 *     and every POST body is packed under MAX_BODY_BYTES, so an oversized
 *     request can never 500/413 server-side (the backend's per-event size limit
 *     and gateway body caps) and wedge the outbox in a retry loop. The scrubbed
 *     events always ship.
 *
 * No-op without the project's `.augenta/config.json` (consent + key travel
 * together). Pure Bun/Node builtins so it runs from the installed plugin
 * location.
 */
import { join, dirname } from "node:path";
import { mkdirSync, openSync, writeSync, closeSync, unlinkSync, statSync, appendFileSync } from "node:fs";
import { Outbox, isDocumentRecord, isRawRecord, type SpoolRecord } from "./outbox";
import type { CaptureEvent, DocumentExperience, Experience, TrajectoryExperience } from "./event";
import { experiencesUrl, loadProjectConfig, captureEnabled } from "./config";
import { sanitizeTelemetryJsonl } from "./sanitize";

/**
 * Per-envelope byte budget: an experience whose JSON form exceeds this many
 * UTF-8 BYTES is forced under it by {@link boundExperienceSize}'s ladder —
 * keep as much of the raw `data` channel as fits (a loud marker names what
 * didn't), then split the steps into envelopes with disjoint seq ranges, then
 * (last resort) truncate a single giant step's text with a loud marker. Guards
 * the backend's per-event size limit — an
 * oversized envelope would be rejected there and wedge the outbox in a permanent
 * retry loop (the cursor advances only on 2xx). Measured in BYTES
 * (Buffer.byteLength), not string length: the backend limit is a byte limit, and
 * CJK text is ~3 UTF-8 bytes per UTF-16 unit, so `.length` would under-count 3×.
 */
export const MAX_EXPERIENCE_BYTES = 512 * 1024;

/**
 * Per-POST body budget: experiences are greedily packed into `{experiences:
 * [...]}` bodies no larger than this. Bounds the request against gateway
 * body caps (a 413 is a non-2xx → the same permanent retry wedge) and keeps
 * each upload comfortably inside the shipper's 10s timeout. Any single
 * bounded experience (≤ MAX_EXPERIENCE_BYTES) always fits a body alone.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** UTF-8 byte size of a value's JSON form — the wire measure everywhere here. */
function jsonBytes(x: unknown): number {
  return Buffer.byteLength(JSON.stringify(x), "utf8");
}

/** Appended to a truncated step's text so the elision is loud downstream. */
export const TRUNCATION_MARKER = " …[augenta: step text truncated — exceeded the single-envelope wire cap]";

/** Largest prefix of the step's text (plus the loud marker) that keeps the
 *  step's JSON form within `budget` bytes — binary search on the slice point.
 *  seq/kind/role/ref are untouched, so record identity and ordering survive. */
function truncateEventText(e: CaptureEvent, budget: number): CaptureEvent {
  let lo = 0;
  let hi = e.text.length;
  let best: CaptureEvent = { ...e, text: TRUNCATION_MARKER.trimStart() };
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = { ...e, text: e.text.slice(0, mid) + TRUNCATION_MARKER };
    if (jsonBytes(candidate) <= budget) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Group buffered records into turn-scoped trajectory experiences: one per
 * (src, sid, proj, turn), first-seen order preserved, intra-group order as
 * buffered (events seq-ascending by construction). CaptureEvents fill
 * `events`; RawRecords' raw strings fill `data` (omitted when the group has
 * none). Records missing a turn stamp bucket as turn 0. The turn is only the
 * GROUPING key — it rides on each step (trajectory-domain data), never on the
 * envelope. Groups with ZERO events are DROPPED: a trajectory without steps is
 * unshippable — the server derives record identity from the event seqs. Pure —
 * exported for tests.
 */
export function groupIntoExperiences(records: SpoolRecord[]): Experience[] {
  const groups = new Map<string, TrajectoryExperience>();
  const experiences: Experience[] = [];
  for (const r of records) {
    // Documents are already complete, standalone experiences. In particular,
    // never create an `events` property for them: the two wire contracts are
    // intentionally disjoint.
    if (isDocumentRecord(r)) {
      experiences.push(r);
      continue;
    }
    const turn = typeof r.turn === "number" && r.turn >= 0 ? r.turn : 0;
    const key = `${r.src} ${r.sid} ${r.proj} ${turn}`;
    let g = groups.get(key);
    if (!g) {
      g = { src: r.src, sid: r.sid, proj: r.proj, type: "trajectory", events: [] };
      groups.set(key, g);
      experiences.push(g);
    }
    if (isRawRecord(r)) {
      // Re-sanitize here so records queued by an older plugin release cannot
      // bypass the capture-time privacy boundary. Malformed legacy lines are
      // dropped because they cannot be structurally sanitized.
      const raw = sanitizeTelemetryJsonl(r.raw);
      if (raw !== undefined) (g.data ??= []).push(raw);
    }
    else g.events.push(r);
  }
  return experiences.filter((experience) => experience.type === "doc" || experience.events.length > 0);
}

/** Appended as the final element of a turn's `data` array when the raw
 *  channel didn't fully fit under the cap — loud, so the elision is visible
 *  downstream instead of a silently truncated (or vanished) raw channel. */
function rawDropMarker(kept: number, total: number): string {
  return `[augenta: ${total - kept} of ${total} raw line(s) dropped — envelope exceeded the single-envelope wire cap]`;
}

/**
 * Rung 1.5: the events alone already fit under the cap
 * ({@link MAX_EXPERIENCE_BYTES}); keep as much of `data` as fits alongside them
 * rather than dropping the whole raw channel. Walks `data` IN ORDER, keeping
 * each line whose own JSON cost still fits the remaining budget (the cap,
 * minus the size of an envelope carrying an EMPTY data array, minus the
 * marker's own cost — reserved up front so the marker can never itself be
 * squeezed out by the lines it's summarizing). Budgeting against the
 * empty-data envelope (not the events-only object) folds in the `,"data":[]`
 * framing, so the returned envelope is provably ≤ the cap rather than
 * overshooting it by that ~9-byte structural overhead. If anything had to be
 * skipped, the kept prefix gets ONE trailing marker line; if literally nothing
 * fits, `data` becomes `[marker]` (never an empty array — the wire contract
 * forbids that, and a marker-only array is legal and loud). Pure — exported
 * for tests.
 */
export function boundRawData(
  eventsOnly: Omit<TrajectoryExperience, "data">,
  data: string[] | undefined,
): TrajectoryExperience {
  if (!data || data.length === 0) return eventsOnly;

  // The TRUE size of an envelope with an empty data array — includes the
  // `,"data":[]` framing that budgeting against the events-only object omits.
  const base = jsonBytes({ ...eventsOnly, data: [] });
  // Reserve the WORST-CASE marker cost up front: `total - kept` only shrinks
  // as `kept` grows, so kept=0 is always the longest (most digits) the
  // marker string can be.
  const markerCost = jsonBytes(rawDropMarker(0, data.length)) + 1; // +1 for the array-separator comma
  const budget = MAX_EXPERIENCE_BYTES - base - markerCost;
  if (budget < 0) return eventsOnly; // not even the marker fits — omit `data` entirely rather than bust the cap

  const kept: string[] = [];
  let bytes = 0;
  for (const line of data) {
    const cost = jsonBytes(line) + 1;
    if (bytes + cost > budget) break; // in order — stop at the first line that no longer fits
    kept.push(line);
    bytes += cost;
  }

  if (kept.length === data.length) return { ...eventsOnly, data: kept }; // everything fit after all — no marker needed
  return { ...eventsOnly, data: [...kept, rawDropMarker(kept.length, data.length)] };
}

/**
 * Force one experience under {@link MAX_EXPERIENCE_BYTES}, three rungs deep:
 *
 *   1. Fits → ship as-is (the overwhelmingly common case).
 *   1.5. `events` alone fit, but the full envelope didn't — keep as much of
 *      the raw `data` channel as fits ({@link boundRawData}), loudly marking
 *      what didn't. Record identity is events-derived, so a retry that reshapes
 *      `data` overwrites the same record (last-writer-wins there already); and
 *      since the bounding is pure over the SAME unadvanced spool bytes, a
 *      retry reproduces the identical envelope byte-for-byte.
 *   2. Split the steps into envelopes with DISJOINT CONTIGUOUS seq ranges —
 *      contract-legal: same sid, disjoint ranges land as separate records,
 *      merged on read (identical to a turn split across POST batches). Within
 *      the split, a single step that alone busts the envelope gets its text
 *      truncated with a loud marker ({@link TRUNCATION_MARKER}) — seq and
 *      identity fields survive, so nothing downstream loses its place.
 *
 * The result envelopes always fit, so the scrubbed events ALWAYS ship — no
 * input can wedge the outbox against the backend's byte limit. Pure — exported
 * for tests.
 */
/** Loud last-resort marker for a malformed/pre-existing oversized document.
 * Normal document records are split before they reach the outbox. */
export const DOCUMENT_TRUNCATION_MARKER = " …[augenta: document text truncated — exceeded the single-envelope wire cap]";

function boundDocumentExperience(exp: DocumentExperience): DocumentExperience[] {
  if (jsonBytes(exp) <= MAX_EXPERIENCE_BYTES) return [exp];
  let lo = 0;
  let hi = exp.data.text.length;
  let best: DocumentExperience | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const end = mid > 0 && mid < exp.data.text.length &&
      /[\uD800-\uDBFF]/.test(exp.data.text[mid - 1]!) &&
      /[\uDC00-\uDFFF]/.test(exp.data.text[mid]!)
      ? mid - 1
      : mid;
    const candidate: DocumentExperience = {
      ...exp,
      data: { ...exp.data, text: exp.data.text.slice(0, end) + DOCUMENT_TRUNCATION_MARKER },
    };
    if (jsonBytes(candidate) <= MAX_EXPERIENCE_BYTES) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Static document metadata should never be this large (the scanner bounds
  // titles), but returning an empty list is safer than permanently wedging a
  // malformed local outbox record on an over-limit POST.
  return best ? [best] : [];
}

export function boundExperienceSize(exp: TrajectoryExperience): TrajectoryExperience[];
export function boundExperienceSize(exp: DocumentExperience): DocumentExperience[];
export function boundExperienceSize(exp: Experience): Experience[];
export function boundExperienceSize(exp: Experience): Experience[] {
  if (exp.type === "doc") return boundDocumentExperience(exp);
  if (jsonBytes(exp) <= MAX_EXPERIENCE_BYTES) return [exp];
  const { data, ...eventsOnly } = exp;
  if (jsonBytes(eventsOnly) <= MAX_EXPERIENCE_BYTES) return [boundRawData(eventsOnly, data)];

  // Greedy contiguous split. Chunk cost is tracked as the empty-envelope base
  // plus each step's own JSON bytes (+1 comma) — a slight overestimate, which
  // only ever splits a hair earlier than strictly needed, never over-packs.
  const base = jsonBytes({ ...eventsOnly, events: [] });
  const out: TrajectoryExperience[] = [];
  let chunk: CaptureEvent[] = [];
  let chunkBytes = base;
  for (const step of eventsOnly.events) {
    let bounded = step;
    let cost = jsonBytes(bounded) + 1;
    if (base + cost > MAX_EXPERIENCE_BYTES) {
      bounded = truncateEventText(step, MAX_EXPERIENCE_BYTES - base - 1);
      cost = jsonBytes(bounded) + 1;
    }
    if (chunk.length > 0 && chunkBytes + cost > MAX_EXPERIENCE_BYTES) {
      out.push({ ...eventsOnly, events: chunk });
      chunk = [];
      chunkBytes = base;
    }
    chunk.push(bounded);
    chunkBytes += cost;
  }
  if (chunk.length > 0) out.push({ ...eventsOnly, events: chunk });
  return out;
}

/**
 * Greedily pack bounded experiences into `{experiences: [...]}` POST bodies no
 * larger than {@link MAX_BODY_BYTES}, order-preserving. Every input is already
 * ≤ MAX_EXPERIENCE_BYTES (< the body budget), so each body holds at least one
 * experience and packing always terminates. Pure — exported for tests.
 */
export function packBodies(experiences: Experience[]): Experience[][] {
  const wrapper = jsonBytes({ experiences: [] });
  const bodies: Experience[][] = [];
  let cur: Experience[] = [];
  let bytes = wrapper;
  for (const x of experiences) {
    const cost = jsonBytes(x) + 1;
    if (cur.length > 0 && bytes + cost > MAX_BODY_BYTES) {
      bodies.push(cur);
      cur = [];
      bytes = wrapper;
    }
    cur.push(x);
    bytes += cost;
  }
  if (cur.length > 0) bodies.push(cur);
  return bodies;
}

/** Result of one POST: the HTTP status, plus (on non-2xx) the door's own
 *  rejection message — capped so a verbose error body can't bloat the
 *  quarantine file it may get written into. */
export interface PostResult {
  status: number;
  /** Response body text, ≤2KB, present only on a non-2xx status. */
  errText?: string;
}

/** Response bodies captured into a quarantine entry are capped here — the
 *  door's rejection message is precise and short; this just bounds the worst case. */
const MAX_ERR_TEXT_CHARS = 2048;

/** POST one batch of experiences; returns the HTTP status (+ error body text
 *  on non-2xx). Throws on network/timeout error. */
export async function postExperiences(
  url: string,
  token: string | undefined,
  experiences: Experience[],
): Promise<PostResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The Augenta API key, sent in BOTH locations so one shipper works everywhere:
      // the hosted gateway validates the subscription-key header, while a local raw
      // receiver reads `Authorization: Bearer`. Identity is resolved from the key
      // server-side; the copy the receiver doesn't use is inert.
      ...(token ? { authorization: `Bearer ${token}`, "ocp-apim-subscription-key": token } : {}),
    },
    body: JSON.stringify({ experiences }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status >= 200 && res.status < 300) return { status: res.status };
  const errText = await res.text().catch(() => "");
  return { status: res.status, errText: errText.slice(0, MAX_ERR_TEXT_CHARS) };
}

/**
 * Statuses the door returns for a DETERMINISTIC rejection — the same bytes
 * will 400/413/422 again no matter how many times they're retried. Anything
 * else (401/403/408/429/5xx, network errors) is treated as transient: the
 * slice is kept and the whole drain stops, so a fixable condition (bad key
 * rotated back in, backend recovers, rate limit clears) gets retried as-is.
 */
const PERMANENT_STATUSES = new Set([400, 413, 422]);

/** One quarantined POST body — the exact bytes the door permanently rejected,
 *  preserved for manual replay (see `.augenta/outbox/rejected.jsonl`). */
interface RejectedEntry {
  ts: string;
  status: number;
  error?: string;
  experiences: Experience[];
}

/** Stop growing the quarantine file past this size — same "cap rather than
 *  wedge the disk" posture as the spool itself; a runaway rejection stream
 *  shouldn't fill the user's project either. */
export const MAX_REJECTED_BYTES = 10 * 1024 * 1024;

function rejectedPath(projectRoot: string): string {
  return join(projectRoot, ".augenta", "outbox", "rejected.jsonl");
}

/** Append quarantine entries for permanently-rejected bodies. No-op for an
 *  empty batch or a full quarantine file (dropped rather than grown further —
 *  the cursor still advances past these records regardless; the outbox must
 *  never wedge even when the quarantine file itself is full). */
function appendRejected(projectRoot: string, entries: RejectedEntry[]): void {
  if (entries.length === 0) return;
  const path = rejectedPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (statSync(path).size >= MAX_REJECTED_BYTES) return;
  } catch {
    /* no file yet — fine */
  }
  appendFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

export interface DrainOptions {
  url: string;
  token?: string;
  /** Project root holding .augenta/ — the outbox being drained. */
  projectRoot: string;
  /** Max spool records per slice — events, raws, and documents combined. */
  maxBatch?: number;
  /** Safety cap on batches per drain (a runaway backstop). */
  maxBatches?: number;
}

export interface DrainResult {
  shipped: number;
  batches: number;
  /** HTTP status of the last POST (0 if a network error stopped the drain). */
  lastStatus: number;
}

/**
 * Drain the outbox in slices until empty, a POST is TRANSIENTLY rejected, or
 * the slice cap is hit. `maxBatch` bounds all spool record kinds per
 * slice; each experience is size-bounded ({@link boundExperienceSize}) and the
 * slice's envelopes are packed into ≤{@link MAX_BODY_BYTES} bodies
 * ({@link packBodies}) before POSTing.
 *
 * Each body's response is one of three outcomes: 2xx ships normally; a
 * {@link PERMANENT_STATUSES} rejection (400/413/422 — a deterministic
 * "these bytes are wrong," never fixed by retrying) quarantines that body to
 * `.augenta/outbox/rejected.jsonl` and moves on to the next body in the SAME
 * slice; anything else (401/403/408/429/5xx, network error) is transient —
 * the WHOLE slice is kept pending and the drain stops, so a fixable condition
 * gets retried as-is next time.
 *
 * Quarantine entries are buffered in memory per slice and only written once
 * the slice is known to fully advance — a transient failure elsewhere in the
 * SAME slice discards the buffered candidates instead of persisting them, so
 * a retried slice can never double-quarantine a body it already wrote once.
 *
 * The ship cursor advances only once every body of the slice got either a
 * 2xx or a permanent rejection — the already-accepted bodies simply
 * redeliver next time on a transient failure (deterministic record identity
 * server-side makes that an idempotent overwrite). Compacts the spool once
 * anything shipped. Never throws.
 */
export async function drain(opts: DrainOptions): Promise<DrainResult> {
  const box = new Outbox(opts.projectRoot);
  const maxBatch = opts.maxBatch ?? 200;
  const maxBatches = opts.maxBatches ?? 50;

  let shipped = 0;
  let batches = 0;
  let lastStatus = 0;

  for (let i = 0; i < maxBatches; i++) {
    const pending = box.readPending(maxBatch);
    if (pending.records.length === 0) break;

    const experiences = groupIntoExperiences(pending.records).flatMap(boundExperienceSize);
    if (experiences.length === 0) {
      // Every group in this slice was zero-event (unshippable raws) — consume
      // it without a POST so orphaned raws can never wedge the spool.
      box.advance(pending.endOffset);
      shipped += pending.records.length;
      if (!pending.hasMore) break;
      continue;
    }

    let sliceOk = true;
    const quarantineBatch: RejectedEntry[] = [];
    try {
      for (const body of packBodies(experiences)) {
        const res = await postExperiences(opts.url, opts.token, body);
        lastStatus = res.status;
        if (lastStatus >= 200 && lastStatus < 300) {
          batches += 1;
          continue;
        }
        if (PERMANENT_STATUSES.has(lastStatus)) {
          // Deterministic rejection — quarantine this body and keep going
          // within the slice; committed only if the whole slice clears below.
          quarantineBatch.push({
            ts: new Date().toISOString(),
            status: lastStatus,
            ...(res.errText ? { error: res.errText } : {}),
            experiences: body,
          });
          continue;
        }
        sliceOk = false; // transient — keep the whole slice, discard this pass's quarantine candidates
        break;
      }
    } catch {
      break; // network/timeout — leave the cursor, retry on the next trigger
    }
    if (!sliceOk) break;

    if (quarantineBatch.length > 0) appendRejected(opts.projectRoot, quarantineBatch);
    box.advance(pending.endOffset);
    shipped += pending.records.length;
    if (!pending.hasMore) break;
  }

  if (shipped > 0) {
    box.compact();
    // A spool-overflow episode (see Outbox.markDropped in capture.ts) is only
    // resolved once the spool is genuinely empty again — clearing it earlier
    // would let a still-overflowing spool go silent on the NEXT drop.
    if (!box.hasPendingBytes()) box.clearDropEpisode();
  }
  return { shipped, batches, lastStatus };
}

// --- single-flight lock -----------------------------------------------------

const STALE_LOCK_MS = 60_000;

function lockPath(projectRoot: string): string {
  return join(projectRoot, ".augenta", "outbox", ".lock");
}

/** Acquire the outbox lock; reclaims a stale lock left by a crashed shipper. */
export function acquireLock(projectRoot: string): boolean {
  const lock = lockPath(projectRoot);
  mkdirSync(dirname(lock), { recursive: true });
  try {
    const fd = openSync(lock, "wx"); // O_CREAT | O_EXCL — fails if it exists
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
        unlinkSync(lock);
        return acquireLock(projectRoot); // one retry after reclaiming
      }
    } catch {
      /* lost a race on the lock file — treat as held */
    }
    return false;
  }
}

export function releaseLock(projectRoot: string): void {
  try {
    unlinkSync(lockPath(projectRoot));
  } catch {
    /* already gone */
  }
}

if (import.meta.main) {
  // The capture hook passes the project root as argv[2]; the project's own
  // config (consent + key + optional endpoint) decides whether and where to
  // ship. Missing/invalid argv or config → silent exit.
  const projectRoot = process.argv[2];
  const cfg = projectRoot ? loadProjectConfig(projectRoot) : undefined;
  if (cfg && captureEnabled(cfg) && acquireLock(cfg.projectRoot)) {
    try {
      await drain({ url: experiencesUrl(cfg), token: cfg.apiKey, projectRoot: cfg.projectRoot });
    } catch {
      /* never throw out of the detached shipper */
    } finally {
      releaseLock(cfg.projectRoot);
    }
  }
  process.exit(0);
}
