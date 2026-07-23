#!/usr/bin/env bun
/**
 * Augenta UserPromptSubmit hook — one job: mark the start of a new agent TURN.
 *
 * A *turn* is one UserPromptSubmit→Stop cycle. This hook bumps the
 * per-transcript turn ordinal so the capture hook can stamp it onto this turn's
 * events and the Stop-hook flush can group them into one experience. It emits
 * NOTHING (no additionalContext, no stdout) and is a silent no-op for projects
 * that haven't opted in via `.augenta/config.json`.
 */
import { TurnState } from "../capture/turn-cursor";
import { projectConfig, captureEnabled } from "../capture/config";

// Read what we need off the UserPromptSubmit payload (stdin). We must consume
// stdin either way so the process doesn't hang.
let transcriptPath: string | undefined;
let cwd: string | undefined;
try {
  const payload = JSON.parse(await Bun.stdin.text()) as { transcript_path?: unknown; cwd?: unknown };
  if (typeof payload.transcript_path === "string") transcriptPath = payload.transcript_path;
  if (typeof payload.cwd === "string") cwd = payload.cwd;
} catch {
  /* no / non-JSON stdin — fine */
}

// Best-effort turn bookkeeping — never block the prompt over it.
try {
  const cfg = projectConfig(cwd);
  if (transcriptPath && cfg && captureEnabled(cfg)) {
    new TurnState(cfg.projectRoot).bump(transcriptPath);
  }
} catch {
  /* turn bookkeeping is best-effort */
}

process.exit(0);
