/**
 * Augenta SessionStart hook — two jobs, via `hookSpecificOutput`:
 *
 *  Unconnected project → prompt exactly once per project, through
 *  `additionalContext` on both harnesses; nothing starts a turn on its own.
 *  SessionStart is the earliest point a plugin can act. On Claude Code that
 *  context is hidden model context, so it is agent-directed: the model acts on
 *  it at the user's first turn and runs the connect skill. Claude Code's
 *  `initialUserMessage` is deliberately NOT used. It applies only to `-p` runs,
 *  where it would put a connect turn ahead of a headless caller's own prompt,
 *  and does nothing in an interactive session. Codex's SessionStart schema
 *  accepts only `hookEventName` and `additionalContext`, so it receives the
 *  user-facing reminder and the user invokes `$augenta:connect` (or asks to
 *  connect) explicitly. Because that reminder is the one automatic prompt the
 *  project will ever get, it must NAME that invocation — narrating a connection
 *  the hook is not starting would leave the user with no next step.
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
import { recordHealth } from "../capture/health";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { isCodexHarness } from "./harness";
import { ephemeralProject } from "../capture/environment";
import { captureEnabled, captureGate, configPath, controlUrl, loadProjectConfig, resolveProjectRoot } from "../capture/config";
import { environmentLabel } from "../capture/platform";
import { Outbox } from "../capture/outbox";
import { spawnShipper } from "../capture/shipper";
import { captureAgentMemory } from "../capture/memory";
import { storedProfileUserId, takeAuthNotice } from "../capture/auth";
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

// On Codex, additionalContext becomes a developer message the user may see (see
// harness.ts), so we inject clean user-facing facts instead of internal agent
// instructions.
const codex = isCodexHarness(transcriptPath);
// How the user invokes connect in THIS harness. Codex has no slash commands, so
// its prompts name the `$` form alongside the plain-English ask. Every prompt
// below that asks the user to act routes through this.
const connectAction = codex ? "$augenta:connect or Connect Augenta" : "/augenta:connect";
const projectPath = cwd || process.cwd();

// --- Once-per-key prompts, remembered in the user's home ---------------------
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

/**
 * True exactly once per key, recording it as it answers. If the record cannot be
 * persisted it answers false: better silent than a prompt loop on every session.
 * In a cloud session the home is new each time, so "once" is once per session.
 */
function firstTime(key: string): boolean {
  const markers = readMarkers(markerPath);
  if (markers[key]) return false;
  try {
    mkdirSync(stateDir, { recursive: true });
    markers[key] = new Date().toISOString();
    const tmp = markerPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(markers));
    renameSync(tmp, markerPath);
  } catch {
    return false;
  }
  return true;
}

/** A short digest of the unreadable config's bytes (empty when it cannot be read). */
function staleConfigDigest(): string {
  let bytes: Buffer | string = "";
  try {
    bytes = readFileSync(configPath(configuredRoot!));
  } catch {
    /* an unreadable file still prompts, once */
  }
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

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
    recordHealth(connectedRoot, "dispatch", "started");
    const action = connectAction;
    const notices: string[] = [];
    const environment = environmentLabel(controlUrl(cfg));
    if (environment !== "prod") {
      const names = (cfg?.workspaces ?? cfg?.destinations)?.map((workspace) => workspace.workspaceName || workspace.workspaceId).join(", ");
      notices.push(`Augenta: this project is connected to the ${environment} environment, not production${names ? `, feeding ${names}` : ""}.`);
    }
    const authNotice = takeAuthNotice(connectedRoot);
    if (authNotice === "badkey") {
      /* Worded apart from the two below, not just with a different noun, because
         the remedy is different in kind. This project authenticates with a platform
         key from its own config file; there is no sign-in to redo and no browser to
         do it in. Naming the connect command here would be actively wrong — without
         --api-key it takes the oauth branch and overwrites this config — so it is
         the one notice that tells the user NOT to run it. */
      notices.push(
        "Augenta has queued capture: the platform key in .augenta/config.json was refused (401). " +
          "Check that the key is complete and current, and that its Connector is still enabled; " +
          "capture resumes on its own once a request is accepted. " +
          `Do not run ${action} to fix this — it starts a browser sign-in and would replace this project's key config.`,
      );
    } else if (authNotice) {
      const reason =
        authNotice === "relogin"
          ? "a new Augenta sign-in"
          : "a valid inbound Connector";
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
  } else {
    // Connected, but capture is off HERE for a reason connect fixes: this machine
    // has no sign-in for the config's profile, or this checkout has not joined a
    // (typically committed) config, or joined it as someone else, or its
    // Workspaces changed since it did. Said once per exact connection and person,
    // so a pulled change to the Workspaces, or a different sign-in, is raised
    // again. The kill switch stays silent, as above.
    const gate = captureGate(cfg!);
    if (gate === "signed_out" || gate === "not_adopted") {
      const identity = createHash("sha256")
        .update([
          cfg!.profileId ?? "",
          cfg!.projectKey ?? "",
          ...(cfg!.workspaces ?? []).map((workspace) => workspace.workspaceId).sort(),
          (cfg!.profileId && storedProfileUserId(cfg!.profileId)) || "",
        ].join("\0"))
        .digest("hex")
        .slice(0, 16);
      if (firstTime(`join:${connectedRoot}:${identity}`)) {
        const names = (cfg!.workspaces ?? cfg!.destinations ?? []).map((workspace) => workspace.workspaceName || workspace.workspaceId).join(", ");
        const environment = environmentLabel(controlUrl(cfg));
        const where = [cfg!.org?.name, environment === "prod" ? undefined : `the ${environment} environment`]
          .filter(Boolean)
          .join(", ");
        const reason = gate === "signed_out"
          ? "this machine is not signed in to Augenta for it"
          : cfg!.join === "signin"
            ? "this checkout joined it under a different sign-in"
            : cfg!.join === "workspaces"
              ? "its Workspaces changed since this checkout joined"
              : "this checkout has not joined it";
        const additionalContext = codex
          ? `Augenta: this project is set up to send capture to ${names}${where ? ` (${where})` : ""}, but capture is off in this checkout because ${reason}. Run ${connectAction} to join it.`
          : `[Augenta] This project's .augenta/config.json sends Augenta capture to ${names}${where ? ` (${where})` : ""}, ` +
            `but capture is off in this checkout because ${reason}. Tell the user, and offer to run the augenta ` +
            "connect skill (/augenta:connect): it signs in if needed and asks them to confirm those Workspaces " +
            "before capture starts. Do not start a sign-in without their go-ahead. Tokens and API keys must " +
            "never be pasted into the chat.";
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
      }
    }
  }
  process.exit(0);
}

// A stale config is a DIFFERENT prompt from "you never connected this project":
// the user did connect, and their config stopped being readable. It gets its own
// one-shot key, and deliberately ignores the pre-0.3.0 marker — every project
// with a legacy config has one, and honoring it here would re-silence exactly
// the users this prompt exists for. Recording the key is what makes this the
// project's only automatic fire ever — for that file. The key carries a hash of
// the unreadable bytes, because a project that already reconnected through an
// earlier format change holds the bare key, and a later change that makes its
// config unreadable again must still say so rather than turn capture off in silence.
const markerKey = staleConfig ? `reconnect:${projectPath}:${staleConfigDigest()}` : projectPath;
if (!staleConfig && readMarkers(legacyMarkerPath)[projectPath]) process.exit(0);
// A throwaway session outside any checkout cannot keep a connection (connect
// refuses it), and its home, where this marker lives, is new every time: the
// prompt could never succeed and would come back every session.
if (ephemeralProject(projectPath)) process.exit(0);
if (!firstTime(markerKey)) process.exit(0);

// Codex may show additionalContext verbatim, so its wording stays clean and
// user-facing; Claude Code's is agent-directed and may carry scaffolding.
// Nothing auto-starts on either harness, so these state the fact AND the
// invocation — this is the project's only automatic prompt, and one that
// narrated a connection nobody is making would strand the user with no next step.
const codexContext = staleConfig
  ? `Augenta's saved connection for this project can no longer be read, so capture is off. Run ${connectAction} to reconnect it.`
  : `Augenta isn't connected for this project yet. Run ${connectAction} to connect it.`;

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

// The same two fields on both harnesses: Codex rejects any other SessionStart
// key, and Claude Code's initialUserMessage is -p only (see the header).
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
process.exit(0);
