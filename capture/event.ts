/**
 * Slim capture-event contract — the neutral shape the plugin buffers locally and
 * ships (grouped per agent turn) to the Augenta backend's `/v1/experiences`
 * door. The plugin normalizes + SCRUBS each trajectory step CLIENT-SIDE into one
 * of these events; the SERVER owns everything downstream. This is the
 * thin-client boundary: event text passes through the secret scrub (`scrub.ts`),
 * while raw transcript JSON is structurally sanitized — see the privacy note
 * below.
 *
 * Pure builtins only (no node:crypto, no I/O, no network), so it runs from the
 * installed plugin location (which has no node_modules). `CaptureEvent` MUST
 * stay in lockstep with the Augenta backend's ingest contract; the plugin is
 * the producing side for the `Experience` envelope.
 *
 * Privacy: the scrub covers `events[].text` — step text is SCRUBBED of secrets
 * (`scrub.ts`) and then shipped VERBATIM (uncapped) so the full reasoning trace
 * reaches the backend, with `ref` also pointing back into the harness's own
 * transcript on disk. The envelope's `data` channel is not secret-scrubbed or
 * normalized, but opaque reasoning signatures/encrypted content and empty
 * thought fields are removed before storage and again before egress. The
 * project's `.augenta/config.json` opt-in covers BOTH channels. The
 * tenant/Neurospace is intentionally absent: it is resolved SERVER-SIDE from
 * the Augenta API key. The client never asserts identity.
 */

/** Which agent harness produced the trajectory. */
export type EventSource = "claude-code" | "codex";
/** Coarse shape of a trajectory step. */
export type EventKind = "tool" | "msg" | "error" | "outcome" | "session";
/** Who/what produced the step. */
export type EventRole = "user" | "assistant" | "tool" | "system";
/** Outcome of a tool call (only meaningful when `kind === "tool"`). */
export type ToolStatus = "ok" | "error";

/**
 * One neutral capture event — one STEP of a trajectory experience's `events`.
 * Identity is content-derived (sid, seq), so a retry/replay of the same logical
 * step lands idempotently server-side (record identity is deterministic in
 * the steps' seq range). `text` is already scrubbed client-side and shipped
 * verbatim, so a replay carries the same bytes.
 */
export interface CaptureEvent {
  src: EventSource;
  sid: string;
  proj: string;
  ts: string;
  seq: number;
  /**
   * Which agent TURN (one UserPromptSubmit→Stop cycle) this step belongs to,
   * stamped from the per-transcript turn cursor. 0 for pre-first-prompt events
   * (session preamble). The flush groups steps into experiences by this —
   * trajectory-domain data; it rides on the step, not the envelope.
   */
  turn?: number;
  kind: EventKind;
  role: EventRole;
  tool_name?: string;
  tool_status?: ToolStatus;
  in_tok?: number | null;
  out_tok?: number | null;
  /** The generative model that produced the turn (e.g. claude-opus-4-8); omitted if unknown. */
  model?: string;
  /** Pre-scrubbed step text (verbatim, uncapped). */
  text: string;
  ref?: { path: string; off: number };
}

/**
 * A trajectory envelope — the `/v1/experiences` unit for agent activity. Two
 * channels:
 *
 *   • `events` — the normalized, SCRUBBED trajectory steps ({@link CaptureEvent}).
 *   • `data`   — raw telemetry: the transcript JSONL lines the capture pass
 *     consumed for this turn, structurally sanitized and serialized as strings.
 *     They remain secret-unscrubbed and otherwise unnormalized by design (the
 *     project opt-in is consent for both channels). Omitted when the turn
 *     contributed no raw lines.
 *
 * One experience per agent turn is producer behavior keyed by the steps' own
 * `turn` ordinal, not an envelope field. Wire shape:
 *
 *   POST {gateway}/v1/experiences
 *   { "experiences": [ { src, sid, proj, type: "trajectory", events: CaptureEvent[], data?: string[] } ] }
 *
 * An experience split across POST batches yields two envelopes with the same
 * sid and disjoint seq ranges — they land as two server-side records, merged on
 * read; per-step identity (sid, seq) keeps retries idempotent.
 */
export interface TrajectoryExperience {
  src: EventSource;
  sid: string;
  proj: string;
  type: "trajectory";
  events: CaptureEvent[];
  data?: string[];
}

/**
 * A scrubbed, standalone agent-memory document. Unlike a trajectory this is
 * never derived from, or attached to, raw transcript telemetry.
 */
export interface AgentMemoryDocument {
  kind: "agent-memory";
  /** Stable, content-independent identity for this logical source document. */
  documentId: string;
  /** Logical path relative to the harness memory root; never a home-directory path. */
  sourcePath: string;
  title: string;
  format: "text/markdown";
  /** Scrubbed document text for this chunk (empty only for a tombstone). */
  text: string;
  sourceUpdatedAt: string;
  capturedAt: string;
  /** Hash of the scrubbed complete document text and deletion state. */
  revision: string;
  deleted: boolean;
  /** Zero-based position within this revision. */
  chunkIndex: number;
  chunkCount: number;
}

/** A standalone document experience. Documents deliberately have no `events` field. */
export interface DocumentExperience {
  src: EventSource;
  sid: string;
  proj: string;
  type: "doc";
  data: AgentMemoryDocument;
}

/** Any experience accepted by the `/v1/experiences` endpoint. */
export type Experience = TrajectoryExperience | DocumentExperience;

/** The durable outbox representation of a document experience. */
export type DocumentRecord = DocumentExperience;

/**
 * The spool wrapper for ONE structurally sanitized raw transcript line. Built
 * by capture for every consumed non-blank valid JSON complete line —
 * including lines that produced no {@link CaptureEvent} (the cursor advances
 * past them; without a wrapper they would be lost). Carries the same
 * src/sid/proj context and the same `turn` stamp its sibling events get, so the
 * flush groups a turn's raws into the same {@link Experience} as its steps
 * (`data`). It is not secret-scrubbed, but opaque reasoning artifacts and empty
 * thought fields are removed before storage and again before egress.
 */
export interface RawRecord {
  raw: string;
  src: EventSource;
  sid: string;
  proj: string;
  turn?: number;
}
