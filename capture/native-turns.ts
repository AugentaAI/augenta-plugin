/** Codex rollout turn boundaries, observed on the desktop and CLI.
 * A message is never a turn boundary. Unknown history stays explicitly unknown.
 * State is committed with the byte cursor, not the optional prompt-hook counter.
 */
import type { NormalizeOpts, NormalizeResult } from "./normalize-core";
import { normalizeCodexRollout } from "./normalize-codex";
import type { CaptureEvent, RawRecord } from "./event";

export interface NativeTurns {
  ids: Record<string, number>;
  ordinal: number;
  active?: string;
  eligible?: boolean;
  captureSince?: string;
}
export type TurnSource = "native" | "unknown";

export function validNativeTurns(value: unknown): value is NativeTurns {
  if (!value || typeof value !== "object") return false;
  const s = value as NativeTurns;
  return Number.isSafeInteger(s.ordinal) && s.ordinal >= 0 && !!s.ids &&
    typeof s.ids === "object" && !Array.isArray(s.ids) &&
    Object.values(s.ids).every(n => Number.isSafeInteger(n) && n > 0 && n <= s.ordinal) &&
    (s.active === undefined || (typeof s.active === "string" && Object.hasOwn(s.ids, s.active))) &&
    (s.eligible === undefined || typeof s.eligible === "boolean") &&
    (s.captureSince === undefined || typeof s.captureSince === "string");
}

export function normalizeNativeTurns(
  opts: NormalizeOpts,
  prior?: NativeTurns,
  captureSince?: string,
): NormalizeResult & { records: Array<CaptureEvent | RawRecord>; turns: NativeTurns } {
  const turns: NativeTurns = prior
    ? { ...prior, ids: { ...prior.ids } }
    : { ids: {}, ordinal: 0 };
  // Reconnecting can change consent while a turn is still in flight. Never
  // reuse eligibility granted under an earlier destination selection.
  if (turns.captureSince !== captureSince && turns.active) turns.eligible = false;
  turns.captureSince = captureSince;
  const events: CaptureEvent[] = [];
  const raws: NormalizeResult["raws"] = [];
  const records: Array<CaptureEvent | RawRecord> = [];
  let nextSeq = opts.startSeq;
  let nextOffset = opts.startOffset;
  let model = opts.ctx.model;
  let batch: string[] = [];
  let batchTurn = 0;
  let batchSource: TurnSource = "unknown";
  let batchEligible = !captureSince;
  const since = captureSince ? Date.parse(captureSince) : undefined;

  const flush = () => {
    if (!batch.length) return;
    const result = normalizeCodexRollout({ ...opts, lines: batch,
      startSeq: nextSeq, startOffset: nextOffset, ctx: { ...opts.ctx, model } });
    nextOffset = result.nextOffset;
    model = result.lastModel ?? model;
    if (batchEligible) {
      nextSeq = result.nextSeq;
      const rawRecords = result.raws.map(({ raw, sid }) => ({ raw, sid,
        src: "codex" as const, proj: opts.ctx.project, turn: batchTurn }));
      for (const e of result.events) { e.turn = batchTurn; e.turn_source = batchSource; }
      // Every raw-only group needs its own step, including preamble/unknown data.
      const covered = new Set(result.events.map(e => e.sid));
      for (const sid of new Set(result.raws.map(r => r.sid))) {
        if (covered.has(sid)) continue;
        result.events.push({ src: "codex", sid, proj: opts.ctx.project,
          ts: timestampOf(result.raws[0]?.raw), seq: nextSeq++, kind: "session", role: "system",
          turn: batchTurn, turn_source: batchSource,
          text: "[augenta: transcript records with no mappable steps — raw channel attached]" });
      }
      events.push(...result.events); raws.push(...result.raws);
      records.push(...result.events, ...rawRecords);
    }
    batch = [];
  };

  for (const line of opts.lines) {
    let x: { type?: string; timestamp?: string; payload?: { type?: string; turn_id?: string } } | undefined;
    try { x = JSON.parse(line); } catch { /* still consume its bytes */ }
    const p = x?.payload;
    const starts = (x?.type === "event_msg" && p?.type === "task_started") || x?.type === "turn_context";
    const ends = x?.type === "event_msg" && ["task_complete", "turn_aborted"].includes(p?.type ?? "");
    if (starts && typeof p?.turn_id === "string" && p.turn_id.length > 0 && p.turn_id.length <= 256) {
      if (turns.active !== p.turn_id) {
        flush();
        if (!Object.hasOwn(turns.ids, p.turn_id)) {
          Object.defineProperty(turns.ids, p.turn_id, { value: ++turns.ordinal, enumerable: true, writable: true, configurable: true });
        }
        turns.active = p.turn_id;
        // A mid-task connection excludes the entire already-started turn.
        const timestamp = Date.parse(x?.timestamp ?? "");
        turns.eligible = since === undefined || (Number.isFinite(timestamp) && timestamp >= since);
      }
    }
    const turn = turns.active ? turns.ids[turns.active]! : 0;
    const source: TurnSource = turns.active ? "native" : "unknown";
    const eligible = turns.active ? turns.eligible !== false : since === undefined;
    if (batch.length && (turn !== batchTurn || source !== batchSource || eligible !== batchEligible)) flush();
    batchTurn = turn; batchSource = source; batchEligible = eligible;
    batch.push(line);
    if (ends && p?.turn_id === turns.active) {
      flush();
      delete turns.active; delete turns.eligible;
    }
  }
  flush();
  return { events, raws, records, nextSeq, nextOffset, lastModel: model, turns };
}

function timestampOf(raw: string | undefined): string {
  try {
    const timestamp = JSON.parse(raw ?? "{}").timestamp;
    if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))) return timestamp;
  } catch { /* unknown schemas get a capture timestamp */ }
  return new Date().toISOString();
}
