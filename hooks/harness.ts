/**
 * Which agent harness is running a hook, inferred from the hook payload's
 * `transcript_path`. Codex records sessions at `~/.codex/sessions/.../rollout-*.jsonl`;
 * Claude Code uses `~/.claude/projects/.../*.jsonl`.
 *
 * This matters because the two harnesses render hook output DIFFERENTLY: Claude
 * Code treats `hookSpecificOutput.additionalContext` as HIDDEN model context,
 * whereas Codex materializes it as a VISIBLE developer message and has no
 * hidden-context channel at all. So on Codex the hooks must never inject internal
 * scaffolding (the curation nudge, agent-only instructions)
 * — the user would see it.
 */
export function isCodexHarness(transcriptPath: string | undefined | null): boolean {
  if (!transcriptPath) return false;
  const p = transcriptPath.replace(/\\/g, "/");
  const configuredHome = process.env.CODEX_HOME?.replace(/\\/g, "/").replace(/\/+$/, "");
  return /\/\.codex\//.test(p) ||
    /\/rollout-[^/]*\.jsonl$/i.test(p) ||
    Boolean(configuredHome && (p === configuredHome || p.startsWith(configuredHome + "/")));
}

/**
 * Content-based harness fallback for when the transcript PATH matches neither
 * harness's pattern (e.g. a nonstandard CODEX_HOME) — sniffing the shape of
 * one transcript line instead. Codex lines are `{ timestamp, type, payload }`
 * envelopes with no `message` field; Claude Code lines are `{ type: user |
 * assistant | system | summary, message: {...} }`. Returns undefined when the
 * line matches neither shape, so the caller can fall back to a fixed default
 * — capture.ts's G7 synthetic marker is the loud backstop if that default
 * still guesses wrong.
 */
export function sniffHarness(line: string): "codex" | "claude-code" | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const o = parsed as Record<string, unknown>;
  const hasMessage = typeof o.message === "object" && o.message !== null;
  const hasPayload = typeof o.payload === "object" && o.payload !== null;

  if (typeof o.type === "string" && hasPayload && !hasMessage) return "codex";
  if ((typeof o.type === "string" && ["user", "assistant", "system", "summary"].includes(o.type)) || hasMessage) {
    return "claude-code";
  }
  return undefined;
}
