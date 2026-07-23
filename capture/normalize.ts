/**
 * Transcript → capture-event normalizers — barrel.
 *
 * One module per transcript shape so each owns exactly one format (single
 * responsibility), over a shared incremental-tail core:
 *   • {@link ./normalize-core}   — the cursor/seq bookkeeping + I/O-free contract
 *   • {@link ./normalize-claude} — Claude Code transcript JSONL
 *   • {@link ./normalize-codex}  — Codex rollout JSONL
 *
 * `capture.ts` selects a normalizer by harness; everything else imports the names
 * it needs from here, so call sites don't depend on which module owns each shape.
 */
export type { Scrubber, NormalizeCtx, NormalizeResult, NormalizeOpts } from "./normalize-core";
export { normalizeClaudeTranscript } from "./normalize-claude";
export { normalizeCodexRollout, codexSessionFromPath } from "./normalize-codex";
