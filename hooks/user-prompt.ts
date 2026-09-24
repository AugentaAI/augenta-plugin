/**
 * Augenta UserPromptSubmit hook — two jobs, in this order:
 *
 *  1. Mark the start of a new agent TURN. A *turn* is one UserPromptSubmit→Stop
 *     cycle. This bumps the per-transcript turn ordinal so the capture hook can
 *     stamp it onto this turn's events and the Stop-hook flush can group them
 *     into one experience. First, and synchronous, so nothing after it — a skip,
 *     a slow network, the harness killing the hook — can cost capture its turn.
 *
 *  2. Recall what the project's Workspaces remember about the prompt, and hand
 *     it to the model (hooks/auto-recall.ts has every rule). The ONLY output this
 *     hook ever writes is that block, as
 *     `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":…}}`
 *     — exactly those two keys, because Codex rejects any other and then drops
 *     the context. Anything short of an answer within the budget is silence.
 *
 * A silent no-op for projects that haven't opted in via `.augenta/config.json`.
 * Always exits 0 with nothing on stderr: the prompt must never be blocked or
 * decorated with an error over this.
 */
import { recordHealth } from "../capture/health";
import { TurnState } from "../capture/turn-cursor";
import { projectConfig, captureEnabled } from "../capture/config";
import { readStdin } from "../runtime/node";
import { AUTO_RECALL_BUDGET_MS, runAutoRecall } from "./auto-recall";

const startedAt = Date.now();

// A backstop only: every request is already bounded by the budget, and no token
// refresh ever runs in this process (auto-recall.ts), so exiting here cannot
// strand a half-rotated sign-in. unref'd, so an early finish exits at once.
let hardExit: ReturnType<typeof setTimeout> | undefined = setTimeout(() => process.exit(0), AUTO_RECALL_BUDGET_MS + 250);
hardExit.unref();

// Read what we need off the UserPromptSubmit payload (stdin). We must consume
// stdin either way so the process doesn't hang.
let transcriptPath: string | undefined;
let cwd: string | undefined;
let prompt: unknown;
try {
  const payload = JSON.parse(await readStdin()) as { transcript_path?: unknown; cwd?: unknown; prompt?: unknown };
  if (typeof payload.transcript_path === "string") transcriptPath = payload.transcript_path;
  if (typeof payload.cwd === "string") cwd = payload.cwd;
  prompt = payload.prompt;
} catch {
  /* no / non-JSON stdin — fine */
}

// Best-effort turn bookkeeping — never block the prompt over it.
try {
  const cfg = projectConfig(cwd);
  if (transcriptPath && cfg && captureEnabled(cfg)) {
    recordHealth(cfg.projectRoot, "dispatch", "started");
    new TurnState(cfg.projectRoot).bump(transcriptPath);
  }
} catch {
  /* turn bookkeeping is best-effort */
}

const additionalContext = await runAutoRecall({ prompt, cwd }, { startedAt });

if (additionalContext) {
  // Once writing starts the backstop must not cut the JSON in half: a truncated
  // object is invalid output to both harnesses, and several KB can outlast one
  // tick on an asynchronous pipe. Exit only when the write has flushed.
  clearTimeout(hardExit);
  hardExit = undefined;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }),
    () => process.exit(0),
  );
  // A reader that never drains the pipe must not hold the prompt past the budget.
  setTimeout(() => process.exit(0), 1_000).unref();
} else {
  process.exit(0);
}
