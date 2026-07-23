/**
 * Deterministic Claude Code transcript → canonical {@link CaptureEvent}s.
 *
 * The transcript at `transcript_path` is JSONL, one event per line, in
 * Anthropic's shape — the same format the bulk harvester parses. This module is
 * the single place that knows THAT shape; the rest of the client speaks only
 * neutral capture events (the server lands them verbatim in the experience lake). Pure and
 * model-call-free: no I/O, no network, no LLM.
 *
 * Mapping is 1:1 (one transcript line → at most one event) so that `seq` is the
 * line's position in the session and `ref.off` is the exact byte offset of the
 * source line — the step's provenance anchor (the raw lines themselves also
 * ship structurally sanitized in the experience's `data` channel). The flattened content
 * (tool-use / tool-result / thinking) is preserved in `text` (scrubbed
 * client-side, shipped verbatim); the `ref` still points back to the exact
 * source line. Cursor bookkeeping is shared via {@link tailToEvents}.
 */
import { type CaptureEvent, type EventKind, type EventRole, type ToolStatus } from "./event";
import { tailToEvents, type NormalizeCtx, type NormalizeOpts, type NormalizeResult, type Scrubber } from "./normalize-core";

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

interface TranscriptLine {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: string;
    /** The generative model that produced this turn (present on assistant lines). */
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

/**
 * Flatten an Anthropic-style content field to text, mirroring the harvester's
 * `extract_text` so live capture and bulk import agree byte-for-byte on the
 * shared block types (text/thinking/tool_use/tool_result). Captures thinking
 * and tool blocks too — Augenta wants the full reasoning trace. The `default`
 * arm's `[type]` placeholders (image, redacted_thinking, …) are a capture-side
 * EXTENSION beyond the harvester's original set — the importer should mirror
 * it to keep the two in lockstep on those blocks.
 */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as ContentBlock[]) {
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          parts.push(block.text ?? "");
          break;
        case "thinking":
          // Empty thought blocks are retained in the local transcript only;
          // emitting a bare marker upstream adds no usable signal.
          if (typeof block.thinking === "string" && block.thinking.trim()) parts.push("[thinking] " + block.thinking);
          break;
        case "tool_use":
          parts.push(`[tool_use:${block.name}] ` + JSON.stringify(block.input ?? {}));
          break;
        case "tool_result": {
          const tr = block.content;
          parts.push(`[tool_result] ${typeof tr === "string" ? tr : JSON.stringify(tr ?? "")}`);
          break;
        }
        default:
          // Any other block shape (image, redacted_thinking, document,
          // server_tool_use, or a future type this file hasn't seen yet) still
          // carries real signal — an image-only turn must not flatten to
          // empty text and get dropped as if nothing happened.
          if (typeof block.type === "string") parts.push(`[${block.type}]`);
          break;
      }
    }
    return parts.join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

/** First tool_use block's name, if the message contains one (for `tool_name`). */
function firstToolName(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content as ContentBlock[]) {
    if (block && block.type === "tool_use" && typeof block.name === "string") return block.name;
  }
  return undefined;
}

/** True if any tool_result block in the content reported an error. */
function hasToolError(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return (content as ContentBlock[]).some((b) => b && b.type === "tool_result" && b.is_error === true);
}

/** Does the content carry any tool_use block? */
function hasToolUse(content: unknown): boolean {
  return Array.isArray(content) && (content as ContentBlock[]).some((b) => b && b.type === "tool_use");
}

/** Does the content carry any tool_result block? */
function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && (content as ContentBlock[]).some((b) => b && b.type === "tool_result");
}

/** Classify a transcript line into a canonical (kind, role) + optional tool fields. */
function classify(line: TranscriptLine): {
  kind: EventKind;
  role: EventRole;
  tool_name?: string;
  tool_status?: ToolStatus;
} | null {
  const etype = line.type;
  const content = line.message?.content;
  const msgRole = line.message?.role;

  if (etype === "assistant") {
    if (hasToolUse(content)) {
      return { kind: "tool", role: "assistant", tool_name: firstToolName(content) };
    }
    return { kind: "msg", role: "assistant" };
  }
  if (etype === "user") {
    if (hasToolResult(content)) {
      return { kind: "tool", role: "tool", tool_status: hasToolError(content) ? "error" : "ok" };
    }
    return { kind: "msg", role: "user" };
  }
  if (etype === "system" || etype === "summary") {
    return { kind: "session", role: "system" };
  }
  // Defensive: some transcripts surface top-level tool_use / tool_result lines.
  if (etype === "tool_use") return { kind: "tool", role: "assistant", tool_name: firstToolName(content) };
  if (etype === "tool_result") {
    return { kind: "tool", role: "tool", tool_status: hasToolError(content) ? "error" : "ok" };
  }
  // Unknown top-level type — keep it as a system note rather than dropping signal,
  // but only if we can reconcile a role. Otherwise skip.
  if (msgRole === "assistant" || msgRole === "user" || msgRole === "system") {
    return { kind: "msg", role: msgRole };
  }
  return null;
}

/** One parsed transcript line → at most one {@link CaptureEvent}. */
function normalizeLine(line: TranscriptLine, ctx: NormalizeCtx, seq: number, off: number, scrub: Scrubber): CaptureEvent | null {
  const cls = classify(line);
  if (!cls) return null;

  const rawText = extractText(line.message?.content);
  // Empty-content lines (e.g. a bare summary marker) carry no signal — skip them
  // rather than emit blank events that only cost bytes downstream. Scrub runs
  // CLIENT-SIDE here and covers EVENT TEXT ONLY — the envelope's raw `data`
  // channel separately removes opaque reasoning artifacts under the project opt-in.
  const text = scrub(rawText).trim();
  if (!text) return null;

  const usage = line.message?.usage;

  return {
    src: ctx.harness ?? "claude-code",
    sid: line.sessionId || ctx.sessionId,
    proj: ctx.project,
    ts: line.timestamp || line.message?.timestamp || new Date().toISOString(),
    seq,
    kind: cls.kind,
    role: cls.role,
    ...(cls.tool_name !== undefined ? { tool_name: cls.tool_name } : {}),
    ...(cls.tool_status !== undefined ? { tool_status: cls.tool_status } : {}),
    // Token counts are present on assistant turns; null (not absent) elsewhere so
    // the cost-benchmark instance can tell "unreported" from "zero".
    in_tok: usage?.input_tokens ?? null,
    out_tok: usage?.output_tokens ?? null,
    // The model is reported on assistant turns; absent elsewhere (then omitted).
    ...(line.message?.model ? { model: line.message.model } : {}),
    text,
    ref: { path: ctx.transcriptPath, off },
  };
}

/**
 * Normalize a batch of new Claude Code transcript lines into canonical events.
 *
 * Unparseable lines are skipped (never throw): a corrupt line must not stall the
 * whole tail or break the user's session.
 */
export function normalizeClaudeTranscript(opts: NormalizeOpts): NormalizeResult {
  const { lines, ctx, startSeq, startOffset } = opts;
  const scrub = opts.scrub ?? ((t) => t);
  return tailToEvents(
    lines,
    startSeq,
    startOffset,
    (sanitized, seq, off) => {
      if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return null;
      return normalizeLine(sanitized as TranscriptLine, ctx, seq, off, scrub);
    },
    // Per-line sid for skipped lines — the SAME `line.sessionId || ctx.sessionId`
    // derivation normalizeLine uses, so a resumed session's replayed history
    // lines (which keep their ORIGINAL sessionId) never split the raw channel
    // from its sibling events.
    (sanitized) =>
      sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
        ? ((sanitized as TranscriptLine).sessionId || ctx.sessionId)
        : ctx.sessionId,
  );
}
