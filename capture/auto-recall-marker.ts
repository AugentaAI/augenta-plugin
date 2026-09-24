/**
 * The automatic-recall block's frozen marker, and the transcript shapes it is
 * recognized in.
 *
 * The UserPromptSubmit hook (`hooks/user-prompt.ts`) asks the project's
 * Workspaces what they remember about the prompt and hands the answer to the
 * model as hook context. Both harnesses then write that context into the
 * transcript, and capture would ship it straight back to the same Workspaces: a
 * memory re-ingested on every prompt, and one Workspace's memory copied into
 * every other destination. So capture drops it (`capture/normalize-core.ts`).
 *
 * The hook and capture agree on ONE thing, this string, which is why it lives in
 * a leaf module with no imports: capture must not import the hook's recall and
 * auth code (Bun keeps whole modules), and the hook must not import capture.
 *
 * FROZEN. Never change the value. A resumed Claude Code session replays its old
 * transcript lines, and Codex compaction copies old developer messages forward,
 * so a block written by any earlier version must still be recognized. It is
 * plain ASCII with no quote, backslash or newline, so it survives JSON escaping
 * verbatim inside Claude's `hook_success.stdout` copy of the hook's raw output.
 */
export const AUTO_RECALL_SENTINEL = "[augenta-recall:v1]";

function hasSentinel(value: unknown): boolean {
  if (typeof value === "string") return value.includes(AUTO_RECALL_SENTINEL);
  if (Array.isArray(value)) return value.some(hasSentinel);
  return false;
}

/**
 * A Claude Code hook attachment line carrying the automatic-recall block.
 *
 * Claude Code records one hook's context as `attachment.type:
 * "hook_additional_context"` (text in `content[]` and again in the line's
 * `rendered`), and the hook's raw stdout as `hook_success` or
 * `hook_non_blocking_error` (`stdout`). Every `hook_*` attachment is checked so
 * no copy survives. Only attachment lines match: a user message that quotes the
 * marker is the user's own words and stays captured.
 */
export function isClaudeAutoRecallRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const line = value as { type?: unknown; attachment?: unknown };
  if (line.type !== "attachment") return false;
  const attachment = line.attachment as { type?: unknown; content?: unknown; stdout?: unknown } | undefined;
  if (!attachment || typeof attachment !== "object") return false;
  if (typeof attachment.type !== "string" || !attachment.type.startsWith("hook_")) return false;
  return hasSentinel(attachment.content) || hasSentinel(attachment.stdout);
}

/** A Codex developer message whose text carries the automatic-recall block. */
export function isCodexAutoRecallItem(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as { type?: unknown; role?: unknown; content?: unknown };
  if (item.type !== "message" || item.role !== "developer") return false;
  if (typeof item.content === "string") return hasSentinel(item.content);
  if (!Array.isArray(item.content)) return false;
  return item.content.some((block) =>
    !!block && typeof block === "object" && hasSentinel((block as { text?: unknown }).text));
}

/** A Codex rollout `response_item` line wrapping such a developer message. */
export function isCodexAutoRecallRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const line = value as { type?: unknown; payload?: unknown };
  return line.type === "response_item" && isCodexAutoRecallItem(line.payload);
}

/**
 * A Codex `compacted` line with every automatic-recall developer message
 * removed from the histories it carries forward, or `undefined` when there was
 * nothing to remove. Compaction copies earlier developer messages into
 * `payload.replacement_history`, so without this one compaction would ship every
 * recall block of the session back at once.
 */
export function stripCodexAutoRecallHistory(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const line = value as { type?: unknown; payload?: unknown };
  if (line.type !== "compacted" || !line.payload || typeof line.payload !== "object") return undefined;
  const payload = line.payload as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...payload };
  for (const [key, entry] of Object.entries(payload)) {
    if (!Array.isArray(entry)) continue;
    const kept = entry.filter((item) => !isCodexAutoRecallItem(item));
    if (kept.length !== entry.length) {
      next[key] = kept;
      changed = true;
    }
  }
  return changed ? { ...line, payload: next } : undefined;
}
