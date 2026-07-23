/**
 * Deterministic Codex (OpenAI Codex CLI) rollout → canonical {@link CaptureEvent}s.
 *
 * Codex records sessions as a DIFFERENT JSONL shape than Claude: each line is a
 * `{ timestamp, type, payload }` envelope. The signal lives in `response_item`
 * lines (the OpenAI Responses API item that was persisted); `event_msg` lines
 * (user_message / agent_message / token_count / task_*) are UI-stream duplicates
 * of those items, so we read only `response_item` to avoid double-counting. This
 * mirrors the Codex mapping the bulk importer already uses
 * (skills/import/references/source_formats.md) so live capture and import agree.
 * The expanded payload coverage (custom_tool_call(+_output), web_search_call,
 * agent_message, local_shell_call(+_output)) and the keep-signal `default`
 * fallback EXTEND that mapping — the importer should mirror them to stay aligned.
 *
 * This module is the single place that knows the Codex rollout shape; cursor
 * bookkeeping is shared via {@link tailToEvents}. Pure: no I/O, no network, no LLM.
 */
import { type CaptureEvent, type EventKind, type EventRole, type ToolStatus } from "./event";
import { tailToEvents, type NormalizeCtx, type NormalizeOpts, type NormalizeResult, type Scrubber } from "./normalize-core";

interface CodexContentBlock {
  type?: string;
  /** input_text / output_text / text / summary_text all carry the text here. */
  text?: string;
}

interface CodexPayload {
  /** message | function_call | function_call_output | reasoning | custom_tool_call | … */
  type?: string;
  role?: string; // message: user | assistant | developer | system | tool
  content?: unknown; // message / agent_message: CodexContentBlock[]
  name?: string; // function_call / custom_tool_call: tool name
  arguments?: string; // function_call: JSON-encoded args
  input?: unknown; // custom_tool_call: the tool's raw (often non-JSON) input
  call_id?: string;
  output?: unknown; // function_call_output / custom_tool_call_output
  summary?: unknown; // reasoning: CodexContentBlock[]
  action?: unknown; // web_search_call: { type: "search", query, queries } | { type: "open_page", url }
  author?: string; // agent_message: sub-agent path this message is FROM
  recipient?: string; // agent_message: sub-agent path this message is TO
}

interface CodexLine {
  timestamp?: string;
  type?: string; // session_meta | response_item | event_msg | turn_context | …
  payload?: CodexPayload;
}

/**
 * Flatten a Codex Responses-API content/summary array to text. A block with
 * no `.text` but a string `.type` (`encrypted_content`, `input_image`,
 * `refusal`, …) still carries signal — a sub-agent message with an encrypted
 * payload block would otherwise flatten to nothing even though the block
 * itself is real — so it becomes a `[type]` placeholder rather than being
 * silently dropped.
 */
function extractCodexText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as CodexContentBlock[]) {
      if (!block || typeof block !== "object") continue;
      if (typeof block.text === "string") parts.push(block.text);
      else if (typeof block.type === "string") parts.push(`[${block.type}]`);
    }
    return parts.join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

/**
 * Best-effort exit-code sniff for `custom_tool_call_output`: Codex stringifies
 * its output as `{ output, metadata: { exit_code } }` — a non-zero exit code
 * means the underlying command failed even though the response item itself
 * always reports `status: "completed"`. Falls back to "ok" on anything that
 * isn't that exact shape (a non-JSON string, or JSON without the field).
 */
function toolStatusFromOutput(output: unknown): ToolStatus {
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output) as { metadata?: { exit_code?: unknown } };
      if (typeof parsed.metadata?.exit_code === "number" && parsed.metadata.exit_code !== 0) return "error";
    } catch {
      /* not JSON, or no metadata — default to ok */
    }
  }
  return "ok";
}

/**
 * Session id from a rollout path — the UUID in `rollout-<iso>-<uuid>.jsonl`.
 * Available on every hook fire regardless of tail position, so events always
 * carry a stable, non-empty `gen_ai.conversation.id` even when a later tail no
 * longer includes the `session_meta` header line.
 */
export function codexSessionFromPath(path: string): string | undefined {
  const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path.replace(/\\/g, "/"));
  return m?.[1];
}

/** Classify one Codex `response_item` payload into a canonical event shape. */
function classifyCodex(p: CodexPayload): {
  kind: EventKind;
  role: EventRole;
  tool_name?: string;
  tool_status?: ToolStatus;
  text: string;
} | null {
  switch (p.type) {
    case "message": {
      const text = extractCodexText(p.content);
      if (p.role === "assistant") return { kind: "msg", role: "assistant", text };
      if (p.role === "user") return { kind: "msg", role: "user", text };
      // developer / system / anything else → a system note (don't drop signal).
      return { kind: "session", role: "system", text };
    }
    case "function_call": {
      const args = typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {});
      return { kind: "tool", role: "assistant", tool_name: p.name, text: `[tool_use:${p.name}] ${args}` };
    }
    case "function_call_output": {
      const out = p.output;
      return { kind: "tool", role: "tool", tool_status: "ok", text: `[tool_result] ${typeof out === "string" ? out : JSON.stringify(out ?? "")}` };
    }
    case "reasoning": {
      const summary = extractCodexText(p.summary ?? p.content);
      return { kind: "msg", role: "assistant", text: summary ? "[thinking] " + summary : "" };
    }
    // Codex's own custom-tool channel (e.g. apply_patch) — same shape as
    // function_call/function_call_output, just a different item type. `input`
    // is the tool's raw argument text (often not JSON, e.g. a patch diff), so
    // it's used as-is rather than re-encoded.
    case "custom_tool_call": {
      const input = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {});
      return { kind: "tool", role: "assistant", tool_name: p.name, text: `[tool_use:${p.name}] ${input}` };
    }
    case "custom_tool_call_output": {
      const out = p.output;
      return {
        kind: "tool",
        role: "tool",
        tool_status: toolStatusFromOutput(out),
        text: `[tool_result] ${typeof out === "string" ? out : JSON.stringify(out ?? "")}`,
      };
    }
    // Defensive: not observed in local rollouts (Codex ≥0.63 records shell via
    // function_call/custom_tool_call instead), but the Responses API item type
    // exists — mirror function_call's shape so it can never silently zero out
    // if a future/older Codex build emits it directly.
    case "local_shell_call": {
      const args = typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {});
      return { kind: "tool", role: "assistant", tool_name: p.name ?? "shell", text: `[tool_use:${p.name ?? "shell"}] ${args}` };
    }
    case "local_shell_call_output": {
      const out = p.output;
      return { kind: "tool", role: "tool", tool_status: "ok", text: `[tool_result] ${typeof out === "string" ? out : JSON.stringify(out ?? "")}` };
    }
    // The action carries the query (`{type:"search", query, queries}`) or the
    // page (`{type:"open_page", url}`) — serialized as-is rather than picking
    // one field, so either shape (or a future one) still carries its signal.
    case "web_search_call":
      return { kind: "tool", role: "assistant", tool_name: "web_search", text: `[tool_use:web_search] ${JSON.stringify(p.action ?? {})}` };
    // Codex's sub-agent orchestration channel: one agent messaging another
    // (author/recipient are sub-agent task paths, not user/assistant roles).
    case "agent_message":
      return { kind: "msg", role: "assistant", text: `[agent_message ${p.author ?? "?"}→${p.recipient ?? "?"}] ${extractCodexText(p.content)}` };
    default: {
      // Keep-signal fallback mirroring the Claude normalizer's unknown-type
      // handling: no response_item type — including one the Responses API
      // adds after this file was last updated — can ever silently zero out.
      const text = extractCodexText(p.content) || (typeof p.output === "string" ? p.output : "") || JSON.stringify(p);
      return { kind: "session", role: "system", text: `[codex:${p.type}] ${text}` };
    }
  }
}

/** One Codex rollout line → at most one {@link CaptureEvent} (only `response_item` lines map). */
function normalizeCodexLine(line: CodexLine, ctx: NormalizeCtx, seq: number, off: number, scrub: Scrubber): CaptureEvent | null {
  if (line.type !== "response_item" || !line.payload) return null;
  const cls = classifyCodex(line.payload);
  if (!cls) return null;

  // Scrub runs CLIENT-SIDE and covers EVENT TEXT ONLY — the envelope's raw
  // `data` channel separately removes opaque reasoning artifacts under the project opt-in.
  const text = scrub(cls.text).trim();
  if (!text) return null;

  return {
    src: ctx.harness ?? "codex",
    // The rollout filename embeds the canonical conversation UUID and is present on
    // every fire, so it leads; the hook-payload id (which capture defaults to
    // "unknown") is only the fallback.
    sid: codexSessionFromPath(ctx.transcriptPath) || ctx.sessionId,
    proj: ctx.project,
    ts: line.timestamp || new Date().toISOString(),
    seq,
    kind: cls.kind,
    role: cls.role,
    ...(cls.tool_name !== undefined ? { tool_name: cls.tool_name } : {}),
    ...(cls.tool_status !== undefined ? { tool_status: cls.tool_status } : {}),
    // Codex reports usage in a separate token_count event, not on the item line,
    // so per-event token counts are unreported (null, not zero).
    in_tok: null,
    out_tok: null,
    text,
    ref: { path: ctx.transcriptPath, off },
  };
}

/**
 * Normalize a batch of new Codex rollout lines into canonical events. Same
 * incremental-tail contract and return shape as the Claude normalizer — only the
 * per-line parse + classification differs.
 */
export function normalizeCodexRollout(opts: NormalizeOpts): NormalizeResult {
  const { lines, ctx, startSeq, startOffset } = opts;
  const scrub = opts.scrub ?? ((t) => t);
  return tailToEvents(
    lines,
    startSeq,
    startOffset,
    (sanitized, seq, off) => {
      if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return null;
      return normalizeCodexLine(sanitized as CodexLine, ctx, seq, off, scrub);
    },
    // Codex sid is per-transcript, not per-line: the rollout filename's UUID
    // leads (present on every fire), hook-payload id as fallback — identical
    // to normalizeCodexLine's derivation.
    () => codexSessionFromPath(ctx.transcriptPath) || ctx.sessionId,
  );
}
