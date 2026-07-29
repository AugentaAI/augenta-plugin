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
 *   cursor.json   { shipped: <min offset>, links?: { <neurolinkId>: <offset> } }
 *
 * ONE spool, N cursors. A project may feed several Neurospaces, and each
 * destination is an independent Neurolink that can be down on its own, so each
 * keeps its OWN byte offset in `links`. `shipped` is the derived MINIMUM across
 * them: it is what bounds reclamation (below), and writing the min rather than
 * the max is deliberate — an older build that only understands the scalar
 * re-ships bytes some destinations already accepted (idempotent server-side)
 * instead of silently skipping bytes the laggard never saw. When `links` is
 * present it is authoritative and `shipped` is ignored on read; a project with a
 * single unnamed destination (a platform key) still uses the bare scalar.
 *
 * Durability choices: appends use O_APPEND so each line is positioned at EOF, and
 * the single-flight shipper lock keeps writers from interleaving; the cursor is
 * written temp-then-rename so a crash never leaves a half-written watermark, and
 * per-destination advances MAX-MERGE the keys they do not own so a shipper that
 * reclaimed a stale lock can never write back another destination's older
 * offset. A spool size cap bounds local disk when the backend is unreachable for
 * a long stretch (e.g. the /v1/experiences route not yet deployed); because
 * reclamation is min-gated, a single wedged destination would otherwise fill
 * that cap for everyone, which is what {@link Outbox.enforceLag} bounds. Pure
 * builtins only, so this runs from the installed plugin location with no
 * node_modules.
 */
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import type { CaptureEvent, DocumentRecord, RawRecord } from "./event";
import { ensureAugentaDir } from "./augenta-dir";

const NEWLINE = 0x0a;

/** Stop buffering past this spool size — protects local disk when nothing drains. */
export const MAX_SPOOL_BYTES = 50 * 1024 * 1024;

/**
 * How far behind its peers one destination may fall before it is declared
 * DERELICT and fast-forwarded (see {@link Outbox.enforceLag}).
 *
 * Reclamation is min-gated, so without this a permanently broken Neurolink — a
 * 403 is classified TRANSIENT and so retries forever — pins the spool until it
 * hits {@link MAX_SPOOL_BYTES}, at which point `append` starts refusing records
 * for EVERY destination. A third of the spool cap leaves room for the healthy
 * destinations to keep working while the laggard is still recoverable.
 */
export const MAX_DEST_LAG_BYTES = 16 * 1024 * 1024;

/**
 * Consecutive drains a destination must spend over the lag cap, shipping nothing
 * while a peer moves, before {@link Outbox.enforceLag} discards its backlog.
 *
 * The hysteresis is the whole safety margin. A single transient failure — a 10s
 * POST timeout on a big body over a just-recovered link, a 429, a Neurospace-
 * scoped 5xx — looks identical to a dead Neurolink for exactly one drain, and
 * treating them the same would delete a week of offline capture on the first
 * reconnect. Over several consecutive drains they stop looking alike.
 */
export const LAG_STRIKES = 3;

/** A destination fast-forwarded past records it never received. */
export interface DerelictDestination {
  destKey: string;
  from: number;
  to: number;
}

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
  private readonly maxDestLagBytes: number;

  constructor(
    projectRoot: string,
    opts: { maxSpoolBytes?: number; maxDestLagBytes?: number } = {},
  ) {
    this.projectRoot = projectRoot;
    this.dir = join(projectRoot, ".augenta", "outbox");
    this.spoolPath = join(this.dir, "spool.jsonl");
    this.cursorPath = join(this.dir, "cursor.json");
    this.maxSpoolBytes = opts.maxSpoolBytes ?? MAX_SPOOL_BYTES;
    this.maxDestLagBytes = opts.maxDestLagBytes ?? MAX_DEST_LAG_BYTES;
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

  private discardNoticePath(): string {
    return join(this.dir, "discarded.json");
  }

  /**
   * Record that records were permanently DISCARDED for a destination, for the
   * next SessionStart to report.
   *
   * Deliberately NOT one of `capture/auth.ts`'s notices. Those are consumed by
   * `takeAuthNotice`, which reports only the most urgent and unlinks the rest — so
   * a concurrent 401 would delete this one unread. Their shared wording ("queued
   * capture waiting for … queued records will resume shipping") is also the
   * opposite of the truth here: nothing is queued and nothing resumes. A silent
   * data deletion needs its own channel and its own sentence.
   */
  markDiscarded(entries: readonly DerelictDestination[]): void {
    if (entries.length === 0) return;
    this.ensure();
    try {
      writeFileSync(
        this.discardNoticePath(),
        JSON.stringify({ at: new Date().toISOString(), destinations: entries }),
      );
    } catch {
      /* best effort — never break a drain over a notice */
    }
  }

  /** Read and clear the discard notice. */
  takeDiscarded(): DerelictDestination[] | undefined {
    const path = this.discardNoticePath();
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        destinations?: unknown;
      };
      unlinkSync(path);
      if (!Array.isArray(parsed.destinations) || parsed.destinations.length === 0) {
        return undefined;
      }
      return parsed.destinations as DerelictDestination[];
    } catch {
      return undefined; // absent or unreadable
    }
  }

  /** A valid stored offset: a non-negative integer byte position. */
  private static offset(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : undefined;
  }

  /** A valid strike count: a non-negative integer. */
  private static strikes(value: unknown): Record<string, number> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const parsed: Record<string, number> = {};
    for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
      const n = Outbox.offset(count);
      if (!key || n === undefined) return {}; // corrupt — start the count over
      parsed[key] = n;
    }
    return parsed;
  }

  /**
   * The cursor as stored: the legacy scalar, plus the per-destination map when
   * one is present AND wholly valid. One bad member invalidates the whole map
   * rather than defaulting that key — falling back to the scalar (a MINIMUM)
   * can only re-ship, while a defaulted key could skip.
   *
   * `lagStrikes` counts consecutive drains in which a destination was over the
   * lag cap and shipped nothing while a peer moved — the hysteresis
   * {@link enforceLag} needs so a single failed request can never discard a
   * backlog. A corrupt count resets to zero, which can only DELAY a sweep.
   */
  private readCursor(): {
    shipped: number;
    links?: Record<string, number>;
    lagStrikes: Record<string, number>;
  } {
    let raw: { shipped?: unknown; links?: unknown; lagStrikes?: unknown };
    try {
      raw = JSON.parse(readFileSync(this.cursorPath, "utf8")) as typeof raw;
    } catch {
      return { shipped: 0, lagStrikes: {} }; // no cursor yet, or unparseable
    }
    const shipped = Outbox.offset(raw.shipped) ?? 0;
    const lagStrikes = Outbox.strikes(raw.lagStrikes);
    const links = raw.links;
    if (!links || typeof links !== "object" || Array.isArray(links)) {
      return { shipped, lagStrikes };
    }
    const parsed: Record<string, number> = {};
    for (const [key, value] of Object.entries(links as Record<string, unknown>)) {
      const off = Outbox.offset(value);
      if (!key || off === undefined) return { shipped, lagStrikes }; // corrupt map — use the scalar
      parsed[key] = off;
    }
    if (Object.keys(parsed).length === 0) return { shipped, lagStrikes };
    return { shipped, links: parsed, lagStrikes };
  }

  /** Write the cursor, always deriving `shipped` as the min of `links`. */
  private writeCursor(
    links: Record<string, number> | undefined,
    scalar?: number,
    lagStrikes: Record<string, number> = {},
  ): void {
    this.ensure();
    const strikes =
      Object.keys(lagStrikes).length > 0 ? { lagStrikes } : {};
    const body = links
      ? { shipped: Math.min(...Object.values(links)), links, ...strikes }
      : { shipped: scalar ?? 0 };
    const tmp = this.cursorPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, this.cursorPath);
  }

  /**
   * Byte offset already shipped to `destKey`.
   *
   * With no `destKey` this is the project-wide watermark — the MIN across
   * destinations when a map is present — which is what gates reclamation and
   * {@link hasPendingBytes}.
   *
   * An UNSEEDED `destKey` reads 0, not the min. {@link registerDestinations} is
   * what seeds keys, so this path is a caller bug, and 0 is the only value that
   * cannot skip: the min is only safe while some peer is still behind, so with
   * every peer caught up it would silently hide every record already shipped to
   * them from a destination that never received any of it.
   *
   * An offset PAST the spool end resets to 0. In normal operation that cannot
   * happen — every offset comes from a `readPending` over the same file — so it
   * means the spool was replaced under us: a crash, or a shipper that reclaimed a
   * stale lock, interleaving with {@link compact}. Resetting re-ships (idempotent
   * server-side); clamping to the spool END would instead keep skipping, and
   * nothing would ever flag it, because such a destination looks *ahead* of its
   * peers rather than behind them.
   */
  private shippedOffset(destKey?: string): number {
    const { shipped, links } = this.readCursor();
    const stored = destKey === undefined || !links ? shipped : (links[destKey] ?? 0);
    return stored > this.spoolEnd() ? 0 : stored;
  }

  /** Byte offset just past the last record in the spool. */
  private spoolEnd(): number {
    try {
      return statSync(this.spoolPath).size;
    } catch {
      return 0; // no spool yet
    }
  }

  /**
   * Reconcile the stored destination set with `keys`: seed the ones that are
   * new, DROP the ones no longer configured. Idempotent, at most one write, and
   * it must run under the shipper lock BEFORE the first POST of a drain — a
   * crash between a destination's first 2xx and its first {@link advance} would
   * otherwise re-seed it at a later spool end and silently skip records.
   *
   * A new destination seeds at the CURRENT SPOOL END, not at 0: a Neurospace the
   * user just added must not inherit another destination's backlog, which is a
   * data flow nobody consented to.
   *
   * Migrating off the legacy scalar is the subtle case. Everything below the
   * scalar was already reclaimed, so the destination that EARNED that watermark
   * should inherit it — but a destination added in the same reconnect must not,
   * or the pending tail (up to `MAX_SPOOL_BYTES` of transcripts captured before
   * that Neurospace was ever a destination) is shared with it. The cursor cannot
   * tell those two apart, so `opts.freshKeys` carries the answer down from
   * `scripts/connect.ts`, which knows exactly which links it just created versus
   * adopted. Absent that hint the conservative reading applies: with more than
   * one key and no prior map, nobody inherits.
   *
   * Dropping removed keys is what keeps a deselected destination from pinning
   * reclamation forever.
   */
  registerDestinations(
    keys: readonly string[],
    opts: { freshKeys?: readonly string[] } = {},
  ): void {
    const wanted = [...new Set(keys)];
    if (wanted.length === 0) return; // nothing to route to; leave the cursor alone
    const { shipped, links, lagStrikes } = this.readCursor();
    const spoolEnd = this.spoolEnd();
    const inheritsScalar = (key: string): boolean =>
      // With no watermark there is nothing to divide: a project connecting for the
      // first time must hand its whole spool to every destination it just chose.
      shipped === 0 ||
      (opts.freshKeys !== undefined
        ? !opts.freshKeys.includes(key)
        : wanted.length === 1);
    const next: Record<string, number> = {};
    for (const key of wanted) {
      next[key] =
        links?.[key] ?? (links ? spoolEnd : inheritsScalar(key) ? shipped : spoolEnd);
    }

    const unchanged =
      links !== undefined &&
      Object.keys(links).length === wanted.length &&
      wanted.every((key) => links[key] === next[key]);
    if (unchanged) return;
    // Carry strikes only for destinations that survive, so a removed-and-later-
    // re-added destination starts its hysteresis over.
    const strikes: Record<string, number> = {};
    for (const key of wanted) if (lagStrikes[key]) strikes[key] = lagStrikes[key]!;
    this.writeCursor(next, undefined, strikes);
  }

  /**
   * Hold every destination within {@link MAX_DEST_LAG_BYTES} of the furthest one,
   * discarding the excess for any destination that cannot keep up, and report what
   * was sacrificed so the caller can record it loudly.
   *
   * This DELETES captured records, so it is deliberately hard to trigger.
   *
   * `progressed` names the destinations that shipped something in the drain that
   * just ran. Two independent conditions must both hold before anything is
   * discarded:
   *
   *  1. **A peer is provably healthy.** With `progressed` empty nothing is ever
   *     swept — an offline stretch is the case the spool exists to survive, and it
   *     leaves every destination behind at once.
   *  2. **The laggard has failed repeatedly.** A destination must be over the cap
   *     and ship nothing across {@link LAG_STRIKES} CONSECUTIVE drains, counted in
   *     the cursor. One timed-out POST on the first drain after a week offline
   *     must not cost a week of records: that request is exactly as likely to be
   *     the recovering network as a dead Neurolink, and the difference only shows
   *     up over several attempts. Any successful ship resets the count.
   *
   * Lag is measured against the FURTHEST destination, not the nearest. Measuring
   * against the nearest let two simultaneously-wedged destinations shield each
   * other — neither lags "its peers", so the spool filled to
   * {@link MAX_SPOOL_BYTES} and `append` began refusing records for everyone,
   * which is the outcome this cap exists to prevent. Fast-forwarding to
   * `leader - cap` rather than to the leader also discards as little as possible
   * and leaves the spool bounded at roughly the cap. The new offset can land
   * mid-line; `readPending` skips the partial record and moves on.
   */
  enforceLag(progressed: readonly string[] = []): DerelictDestination[] {
    const { links, lagStrikes } = this.readCursor();
    if (!links || Object.keys(links).length < 2) return [];
    if (progressed.length === 0) return [];

    const leader = Math.max(...Object.values(links));
    const swept: DerelictDestination[] = [];
    const next = { ...links };
    const strikes: Record<string, number> = {};
    for (const [destKey, from] of Object.entries(links)) {
      // Any progress at all clears the record — by omission from `strikes`.
      if (progressed.includes(destKey)) continue;
      if (leader - from <= this.maxDestLagBytes) continue;
      const count = (lagStrikes[destKey] ?? 0) + 1;
      if (count < LAG_STRIKES) {
        strikes[destKey] = count; // still on probation
        continue;
      }
      const to = leader - this.maxDestLagBytes;
      if (to <= from) continue;
      next[destKey] = to;
      swept.push({ destKey, from, to });
    }
    const strikesChanged =
      Object.keys(strikes).length !== Object.keys(lagStrikes).length ||
      Object.entries(strikes).some(([key, count]) => lagStrikes[key] !== count);
    if (swept.length > 0 || strikesChanged) this.writeCursor(next, undefined, strikes);
    return swept;
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
   *
   * `destKey` scopes the read to one destination's cursor. Destinations sit at
   * different offsets, so they see different slice boundaries and the same turn
   * may be grouped into one experience for one and two for another — legal, and
   * idempotent server-side, since record identity is content-derived.
   */
  readPending(maxBatch = Infinity, destKey?: string): PendingBatch {
    const shipped = this.shippedOffset(destKey);
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

  /**
   * Mark everything up to `endOffset` as shipped (atomic temp-then-rename).
   *
   * With a `destKey` the other keys are carried forward with a MAX-MERGE against
   * a fresh read: a shipper never writes a value for a key it did not itself
   * achieve, except one at least as high as what it just read. That makes the
   * multi-key document monotonic, so a second shipper that reclaimed a stale
   * lock mid-drain can at worst cause a re-ship, never clobber a peer's progress
   * with an older offset.
   *
   * With no `destKey` this writes the bare scalar and DROPS any map — the
   * single-unnamed-destination form is then authoritative, which is what
   * switching a project to a platform key should mean.
   */
  advance(endOffset: number, destKey?: string): void {
    if (destKey === undefined) {
      this.writeCursor(undefined, endOffset);
      return;
    }
    // The fresh read IS the merge: peers are carried forward at whatever they
    // have reached since this drain started, and only our own key is raised.
    const { shipped, links, lagStrikes } = this.readCursor();
    const merged: Record<string, number> = { ...(links ?? {}) };
    merged[destKey] = Math.max(merged[destKey] ?? (links ? 0 : shipped), endOffset);
    // Carry the strike map through. Dropping it here would let a HEALTHY peer's
    // advance reset a laggard's count on every drain, so the hysteresis could
    // never accumulate and the lag cap would never fire at all.
    this.writeCursor(merged, undefined, lagStrikes);
  }

  /** Pending record count (cheap-ish; reads the spool). */
  pendingCount(destKey?: string): number {
    return this.readPending(Infinity, destKey).records.length;
  }

  /**
   * Reclaim disk once the spool has FULLY drained. Conservative on purpose: it
   * only truncates when `shipped >= size`, never rewriting a partially-shipped
   * spool in place — that would risk losing an append that raced the rewrite.
   * The shipper calls this under its single-flight lock after a successful
   * drain. (A re-stat right before truncation keeps the residual race to the
   * sub-millisecond window between stat and truncate.)
   *
   * `shipped` being the MIN across destinations is what makes this safe under
   * fan-out: nothing is reclaimed until EVERY destination has it. The flip side
   * is that one wedged destination pins the spool, which is what
   * {@link enforceLag} bounds.
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
      // EVERY destination restarts at 0, and the key set is preserved. Zeroing
      // only one key (or writing the bare scalar, which drops the map) would
      // leave a peer pointing into a spool that just restarted, silently
      // skipping the next N bytes it appends.
      const { links, lagStrikes } = this.readCursor();
      if (links) {
        this.writeCursor(
          Object.fromEntries(Object.keys(links).map((key) => [key, 0])),
          undefined,
          lagStrikes,
        );
      } else {
        this.advance(0);
      }
      try {
        unlinkSync(archivePath);
      } catch {
        /* already gone */
      }
    }
  }
}
