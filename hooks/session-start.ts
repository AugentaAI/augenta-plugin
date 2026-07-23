#!/usr/bin/env bun
/**
 * Augenta SessionStart hook — two jobs, via `hookSpecificOutput`:
 *
 *  Uninitialized project → auto-fire the init skill exactly once per project.
 *  SessionStart is the earliest point a plugin can act, and its output can carry
 *  `initialUserMessage`, which creates the first user turn on its own — so init
 *  starts without the user typing anything (`/augenta:init` on Claude Code; a
 *  natural-language ask on Codex, which has no slash commands).
 *
 *  Run-once-per-project guarantee: fire only when the project has NO
 *  `.augenta/config.json` AND has not been auto-prompted before. The prompted
 *  marker lives in the USER's home (~/.augenta/state/init-prompted.json, a
 *  {projectPath: isoDate} map, honoring AUGENTA_HOME) — deliberately NOT in the
 *  project: planting a `.augenta/` dir in every repo the user merely opens would
 *  be invasive before they've consented. It is the plugin's only home-dir state.
 *
 *  Initialized project → scan memory changes, then give a STRANDED outbox a
 *  chance to drain. If the final Stop of a prior session never fired (crash,
 *  killed terminal) or failed mid-drain, that spool would otherwise sit
 *  untouched until the NEXT session's own Stop. SessionStart is the next
 *  guaranteed hook fire, so it spawns the same detached shipper capture.ts
 *  uses whenever the scan or an earlier session left pending bytes. The
 *  shipper's single-flight `.lock` prevents concurrent drains.
 *
 *  Everything else is silent: an initialized project with nothing pending
 *  needs nothing injected (the plugin is push-only), and a previously-prompted
 *  project gets no nag.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { isCodexHarness } from "./harness";
import { captureEnabled, loadProjectConfig, resolveProjectRoot } from "../capture/config";
import { Outbox } from "../capture/outbox";
import { spawnShipper } from "../capture/capture";
import { captureAgentMemory } from "../capture/memory";

// SessionStart passes a JSON payload on stdin; we need the transcript path (to
// tell which harness we're in) and cwd (to find the project), and we must
// consume stdin either way so the process doesn't hang.
let transcriptPath: string | undefined;
let cwd: string | undefined;
try {
  const payload = JSON.parse(await Bun.stdin.text()) as { transcript_path?: unknown; cwd?: unknown };
  if (typeof payload.transcript_path === "string") transcriptPath = payload.transcript_path;
  if (typeof payload.cwd === "string") cwd = payload.cwd;
} catch {
  /* no / non-JSON stdin — fine */
}

// On Codex, additionalContext is shown to the user (no hidden channel), so we
// inject clean user-facing facts instead of internal agent instructions.
const codex = isCodexHarness(transcriptPath);
const projectPath = cwd || process.cwd();

// --- Initialized? The project (or an ancestor) has .augenta/config.json. ------
const initializedRoot = resolveProjectRoot(projectPath);
if (initializedRoot) {
  // A stranded spool (a prior session's final Stop never fired, or failed
  // before it could drain) otherwise waits for THIS session's own Stop —
  // give it a chance to drain now instead.
  const cfg = loadProjectConfig(initializedRoot);
  if (captureEnabled(cfg)) {
    // Pick up memory generated after the previous session ended before the
    // stranded-outbox check, so this same detached shipper can deliver both.
    try {
      captureAgentMemory({
        projectRoot: initializedRoot,
        harness: codex ? "codex" : "claude-code",
        transcriptPath,
      });
    } catch {
      /* memory discovery is best-effort and this hook must remain silent */
    }
    if (new Outbox(initializedRoot).hasPendingBytes()) spawnShipper(initializedRoot);
  }
  process.exit(0);
}

// --- Prompted before? Check the once-per-project marker map. ------------------
const home = process.env.AUGENTA_HOME ?? homedir();
const stateDir = join(home, ".augenta", "state");
const markerPath = join(stateDir, "init-prompted.json");

function readMarkers(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const markers = readMarkers();
if (markers[projectPath]) process.exit(0);

// Record that we've auto-prompted this project, so this is its only automatic
// fire ever. If the marker can't be persisted, don't fire — better silent than
// a prompt loop on every session.
try {
  mkdirSync(stateDir, { recursive: true });
  markers[projectPath] = new Date().toISOString();
  const tmp = markerPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(markers));
  renameSync(tmp, markerPath);
} catch {
  process.exit(0);
}

const additionalContext = codex
  ? // Codex shows this verbatim — clean, user-facing, no internal scaffolding.
    "Augenta isn't set up for this project yet — starting initialization."
  : "[Augenta] This project has not been initialized for Augenta capture and this " +
    "is the one automatic prompt it will ever get. Run the augenta init skill now " +
    "(/augenta:init): it explains what capture does and walks the user through " +
    "creating .augenta/config.json via a command they run in their OWN terminal — " +
    "the API key must never be pasted into the chat.";

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
      // Auto-create the first turn so init begins without user input. Codex has
      // no slash commands, so ask in natural language there — the same phrase as
      // the Codex manifest's defaultPrompt.
      initialUserMessage: codex ? "Initialize Augenta" : "/augenta:init",
    },
  }),
);
process.exit(0);
