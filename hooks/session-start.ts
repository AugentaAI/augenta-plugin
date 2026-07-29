#!/usr/bin/env bun
/**
 * Augenta SessionStart hook — two jobs, via `hookSpecificOutput`:
 *
 *  Unconnected project → auto-fire the connect skill exactly once per project.
 *  SessionStart is the earliest point a plugin can act, and its output can carry
 *  `initialUserMessage`, which creates the first user turn on its own — so connect
 *  starts without the user typing anything (`/augenta:connect` on Claude Code; a
 *  natural-language ask on Codex, which has no slash commands).
 *
 *  Run-once-per-project guarantee: fire only when the project has NO USABLE
 *  `.augenta/config.json` AND has not been auto-prompted before. The prompted
 *  marker lives in the USER's home (~/.augenta/state/connect-prompted.json, a
 *  {projectPath: isoDate} map, honoring AUGENTA_HOME) — deliberately NOT in the
 *  project: planting a `.augenta/` dir in every repo the user merely opens would
 *  be invasive before they've consented. It is the plugin's only home-dir state.
 *  The pre-0.3.0 map (init-prompted.json) is still READ, so renaming the skill
 *  doesn't re-prompt every project a user already dismissed.
 *
 *  "Usable" means the current parser accepts it. A config file it rejects — a
 *  pre-0.3.0 `{apiKey}` file from the removed setup.ts, or a truncated write —
 *  counts as UNCONNECTED, and gets its own one-shot reconnect prompt. Left on
 *  the connected path it would be the worst of both worlds: capture off, and
 *  the prompt below unreachable forever, since that is gated on the file's
 *  ABSENCE. Silent permanent death is the one outcome this hook must not have.
 *
 *  Connected project → scan memory changes, then give a STRANDED outbox a
 *  chance to drain. SessionEnd is the ordinary end-of-session drain; this is the
 *  backstop for when neither it nor the final Stop got to run (crash, SIGKILL)
 *  or the drain failed mid-flight. SessionStart is then the next guaranteed hook
 *  fire, so it spawns the same detached shipper capture.ts uses whenever the
 *  scan or an earlier session left pending bytes. The shipper's single-flight
 *  `.lock` prevents concurrent drains.
 *
 *  Everything else is silent: a connected project with nothing pending
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
import { takeAuthNotice } from "../capture/auth";
import { readStdin } from "../runtime/node";

// SessionStart passes a JSON payload on stdin; we need the transcript path (to
// tell which harness we're in) and cwd (to find the project), and we must
// consume stdin either way so the process doesn't hang.
let transcriptPath: string | undefined;
let cwd: string | undefined;
try {
  const payload = JSON.parse(await readStdin()) as { transcript_path?: unknown; cwd?: unknown };
  if (typeof payload.transcript_path === "string") transcriptPath = payload.transcript_path;
  if (typeof payload.cwd === "string") cwd = payload.cwd;
} catch {
  /* no / non-JSON stdin — fine */
}

// On Codex, additionalContext is shown to the user (no hidden channel), so we
// inject clean user-facing facts instead of internal agent instructions.
const codex = isCodexHarness(transcriptPath);
const projectPath = cwd || process.cwd();

// --- Connected? An ancestor has a .augenta/config.json the parser ACCEPTS. ----
const configuredRoot = resolveProjectRoot(projectPath);
const cfg = configuredRoot ? loadProjectConfig(configuredRoot) : undefined;
/** A config file exists, but this plugin version cannot read it. */
const staleConfig = Boolean(configuredRoot) && !cfg;
const connectedRoot = cfg ? configuredRoot : undefined;
if (connectedRoot) {
  // Everything below is gated on capture actually being live. With the kill
  // switch thrown this hook owes the user silence, and a pending notice is not
  // an exception: nagging about a connection they deliberately switched off is
  // noise. Leaving the marker unread also keeps it — it surfaces on the first
  // session after capture is re-enabled, which is when it becomes actionable.
  if (captureEnabled(cfg)) {
    const action = codex ? "$augenta:connect or Connect Augenta" : "/augenta:connect";
    const notices: string[] = [];
    const authNotice = takeAuthNotice(connectedRoot);
    if (authNotice) {
      const reason =
        authNotice === "relogin"
          ? "a new Augenta sign-in"
          : "a valid inbound Neurolink";
      notices.push(
        `Augenta has queued capture waiting for ${reason}. Run ${action}; queued records will resume shipping after reconnecting.`,
      );
    }
    // Reported SEPARATELY from the auth notice, and never merged into it: these
    // records are gone, not queued, so the reconnect wording above would be a
    // false reassurance — and takeAuthNotice reports only its most urgent marker,
    // which would let a concurrent 401 swallow this entirely.
    const discarded = new Outbox(connectedRoot).takeDiscarded();
    if (discarded?.length) {
      const detail = discarded
        .map((d) => `${d.destKey} (spool bytes ${d.from}..${d.to})`)
        .join(", ");
      notices.push(
        `Augenta DISCARDED unshipped records for ${discarded.length === 1 ? "a destination" : "destinations"} that fell too far behind its peers: ${detail}. Those records are gone and will not be retried. Capture to the other destinations is unaffected. If that destination should still receive this project, run ${action} to verify it, or remove it from the project's destinations.`,
      );
    }
    if (notices.length > 0) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: notices.join(" ") } }));
    }
    // A stranded spool (a prior session's final Stop never fired, or failed
    // before it could drain) otherwise waits for THIS session's own Stop —
    // give it a chance to drain now instead. Memory generated after the
    // previous session ended is picked up first, so the one detached shipper
    // below delivers both.
    try {
      captureAgentMemory({
        projectRoot: connectedRoot,
        harness: codex ? "codex" : "claude-code",
        transcriptPath,
      });
    } catch {
      /* memory discovery is best-effort and this hook must remain silent */
    }
    if (new Outbox(connectedRoot).hasPendingBytes()) spawnShipper(connectedRoot);
  }
  process.exit(0);
}

// --- Prompted before? Check the once-per-project marker map. ------------------
const home = process.env.AUGENTA_HOME ?? homedir();
const stateDir = join(home, ".augenta", "state");
const markerPath = join(stateDir, "connect-prompted.json");
// The pre-0.3.0 map, written when this hook prompted for `/augenta:init`. Read,
// never written: renaming the skill must not re-prompt projects the user has
// already dismissed once.
const legacyMarkerPath = join(stateDir, "init-prompted.json");

function readMarkers(path: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// A stale config is a DIFFERENT prompt from "you never connected this project":
// the user did connect, and their config stopped being readable. It gets its own
// one-shot key, and deliberately ignores the pre-0.3.0 marker — every project
// with a legacy config has one, and honoring it here would re-silence exactly
// the users this prompt exists for.
const markerKey = staleConfig ? `reconnect:${projectPath}` : projectPath;
const markers = readMarkers(markerPath);
if (markers[markerKey]) process.exit(0);
if (!staleConfig && readMarkers(legacyMarkerPath)[projectPath]) process.exit(0);

// Record that we've auto-prompted this project, so this is its only automatic
// fire ever. If the marker can't be persisted, don't fire — better silent than
// a prompt loop on every session.
try {
  mkdirSync(stateDir, { recursive: true });
  markers[markerKey] = new Date().toISOString();
  const tmp = markerPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(markers));
  renameSync(tmp, markerPath);
} catch {
  process.exit(0);
}

// Codex shows additionalContext verbatim, so its wording stays clean and
// user-facing; Claude Code's is agent-directed and may carry scaffolding.
const codexContext = staleConfig
  ? "Augenta's saved connection for this project can no longer be read — reconnecting."
  : "Augenta isn't connected for this project yet — starting connection.";

const claudeContext = staleConfig
  ? "[Augenta] This project has an .augenta/config.json that this plugin version " +
    "cannot read — it predates the current connection format, or the write was " +
    "truncated — so capture is silently off. This is the one automatic prompt it " +
    "will ever get. Run the augenta connect skill now (/augenta:connect) to " +
    "reconnect it; anything already queued in the outbox ships once it succeeds. " +
    "Tokens and API keys must never be pasted into the chat."
  : "[Augenta] This project has not been connected for Augenta capture and this " +
    "is the one automatic prompt it will ever get. Run the augenta connect skill now " +
    "(/augenta:connect): it explains what capture does, then drives connect's --json " +
    "verbs itself so the user only answers one question and, at most, clicks one " +
    "sign-in link. Tokens and API keys must never be pasted into the chat.";

const additionalContext = codex ? codexContext : claudeContext;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
      // Auto-create the first turn so connect begins without user input. Codex has
      // no slash commands, so ask in natural language there — the same phrase as
      // the Codex manifest's defaultPrompt.
      initialUserMessage: codex ? "Connect Augenta" : "/augenta:connect",
    },
  }),
);
process.exit(0);
