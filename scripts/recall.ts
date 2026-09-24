/**
 * Ask the Workspaces this project feeds what they remember, and print the answers.
 *
 * The mirror image of `scripts/connect.ts`: connect is the WRITE door and this is
 * the READ one. Everything about it follows from that.
 *
 * It is a pure read, so it is NOT gated on `AUGENTA_CAPTURE_ENABLED` — that
 * switch turns capture off, and a project whose owner stopped sending may still
 * legitimately ask what was already remembered. (The automatic recall the
 * prompt hook makes IS gated on it, because it sends prompt text nobody asked it
 * to; that gate lives in hooks/auto-recall.ts, never here.) What governs recall
 * is the same thing that governs everything else here: the presence of a
 * readable `.augenta/config.json`. No config, no question leaves the machine.
 *
 * It fans out. A connected project may feed several Workspaces, each of which
 * remembers separately, so the default is to ask ALL of them in parallel and
 * label every answer with the Workspace it came from. `--workspace` narrows that
 * to a subset the caller names. One destination failing never costs the others
 * their answer — the payload reports answered, nothing-remembered and failed
 * destinations side by side, which is why the aggregate `status` has a
 * `partially_answered` value rather than collapsing to a boolean.
 *
 * ONLY THE QUESTION LEAVES. The request body is the query text and — for a
 * signed-in project — the Workspace id. No transcript, no file contents, no
 * credential in any payload this prints: the token travels inside
 * `fetchWithProfile` from `~/.augenta/auth.json`, and a platform key from the
 * project config, exactly as the shipper does it. The agent is the normal caller
 * of `--json`, so everything it can read has to be safe to paste into a chat.
 *
 * TWO MODES, WITH ANSWER AS THE DEFAULT. The client explicitly requests
 * `?mode=answer`; `--context` requests matched memory without a model turn.
 * If answer mode returns 503 answerer_unavailable or consent_required, retry
 * once as context and mark the outcome so the caller can explain the fallback.
 *
 * The request layer itself — classification, the live Connector checks, the
 * fan-out, context rendering — lives in `capture/recall-client.ts`, because the
 * prompt hook asks too and an entrypoint may not import another entrypoint.
 * This file is the command: its flags, its question, its ceilings, its output.
 */
import { isMain } from "../runtime/node";
import { describeError } from "../capture/platform";
import { resolveProject, type ResolvedProject } from "../capture/project";
import { askWorkspaces, type RecallPayload } from "../capture/recall-client";

export {
  aggregateStatus,
  askWorkspaces,
  classifyRecallResponse,
  MAX_QUERY_CHARS,
  recallEnvironment,
  renderContext,
} from "../capture/recall-client";
export type {
  NothingRemembered,
  Outcome,
  RecallAnswer,
  RecallFailure,
  RecallFallback,
  RecallPayload,
  RecallRequest,
  RecallResponseParts,
} from "../capture/recall-client";

/**
 * The context-mode wait, in seconds. Retains the rollout ceiling for older
 * platforms that ignore the explicit mode and still run a model. The current
 * platform enforces its own 15s context deadline.
 */
const CONTEXT_TIMEOUT_SECONDS = 75;

/**
 * The wait for `--answer`, in seconds. Clears the platform's own 60s deadline on
 * that mode by the same margin, and for the same reason.
 *
 * The two are separate constants rather than one because the modes are bounded
 * by different things: this one waits on a provider's model turn (itself capped
 * at 30s upstream), the other may still reach a legacy answer-only platform.
 */
const ANSWER_TIMEOUT_SECONDS = 75;

/**
 * The largest `--timeout` this accepts, and why there is a ceiling at all.
 *
 * `AbortSignal.timeout` is a timer, so a delay past 2^31-1 ms does not wait
 * longer — Node clamps it to 1ms and fires AT ONCE, printing a
 * `TimeoutOverflowWarning` to stderr on the way. The result is the exact
 * inverse of the request: `--timeout 3000000` aborts in about a millisecond and
 * then reports "Augenta did not answer within 3000000s", which is false. So the
 * bound is refused up front rather than silently inverted. Ten minutes is
 * already an order of magnitude past the platform's own 60s deadline.
 */
const MAX_TIMEOUT_SECONDS = 600;

const MODE_CONFLICT_MESSAGE = "--answer and --context cannot be used together";

export interface RecallArgs {
  json?: boolean;
  query?: string;
  /** Bare words, joined into the question when `--query` was not given. */
  words: string[];
  /** Narrow the fan-out to these Workspace ids. Empty means every destination. */
  workspaces?: string[];
  timeoutSeconds?: number;
  project?: string;
  answer?: boolean;
  context?: boolean;
}

/**
 * Strict, unlike connect's parser: an unrecognized `--flag` THROWS.
 *
 * Connect can tolerate one because every verb is explicit and a stray flag just
 * selects no verb. Here the leftover words ARE the question, so a mistyped
 * `--wokspace ws-1` would otherwise become part of what gets asked and shipped —
 * a silently different question, sent to every destination.
 */
export function parseArgs(argv: string[]): RecallArgs {
  const args: RecallArgs = { words: [] };
  const valueFor = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--json") {
      args.json = true;
    } else if (flag === "--answer") {
      args.answer = true;
    } else if (flag === "--context") {
      args.context = true;
    } else if (flag === "--query") {
      args.query = valueFor(flag, i++);
    } else if (flag === "--workspace") {
      (args.workspaces ??= []).push(valueFor(flag, i++));
    } else if (flag === "--project") {
      args.project = valueFor(flag, i++);
    } else if (flag === "--timeout") {
      const value = Number(valueFor(flag, i++));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--timeout must be a positive number of seconds");
      }
      if (value > MAX_TIMEOUT_SECONDS) {
        throw new Error(
          `--timeout must be at most ${MAX_TIMEOUT_SECONDS} seconds; a longer wait does not work (see MAX_TIMEOUT_SECONDS)`,
        );
      }
      args.timeoutSeconds = value;
    } else if (flag.startsWith("--")) {
      throw new Error(`unknown flag: ${flag}`);
    } else {
      args.words.push(flag);
    }
  }
  if (args.answer && args.context) throw new Error(MODE_CONFLICT_MESSAGE);
  return args;
}

/** The question, from whichever form the caller used. Refusing BOTH forms at
 *  once rather than silently preferring one: the two would be different
 *  questions, and picking one is a guess about which the caller meant. */
export function questionFrom(args: RecallArgs): string {
  const words = args.words.join(" ").trim();
  const flag = args.query?.trim() ?? "";
  if (flag && words) {
    throw new Error("pass the question with --query or as plain words, not both");
  }
  return flag || words;
}

/**
 * The CLI's recall: the question from whichever form the caller used, its mode,
 * and each mode's per-request ceiling — then the shared request layer does the
 * rest with its defaults, which are this command's contract: one attempt per
 * request, no overall deadline, a sign-in that may refresh, live Workspace names.
 */
export async function runRecall(
  resolved: ResolvedProject,
  args: RecallArgs,
): Promise<RecallPayload> {
  if (args.answer && args.context) throw new Error(MODE_CONFLICT_MESSAGE);
  const query = questionFrom(args);
  const mode = args.context ? "context" : "answer";
  const contextTimeoutMs = (args.timeoutSeconds ?? CONTEXT_TIMEOUT_SECONDS) * 1000;
  const timeoutMs = mode === "context" ? contextTimeoutMs : (args.timeoutSeconds ?? ANSWER_TIMEOUT_SECONDS) * 1000;
  return askWorkspaces(resolved.projectRoot, {
    query,
    mode,
    ...(args.workspaces ? { workspaces: args.workspaces } : {}),
    timeoutMs,
    contextTimeoutMs,
  });
}

/** The bare (non-`--json`) rendering. A person reading a terminal wants the
 *  answers, with enough heading to tell which Workspace each came from. */
function printPayload(payload: RecallPayload): void {
  for (const entry of [...payload.answers, ...payload.nothingRemembered, ...payload.failed]) {
    if (entry.fallback) {
      const label = entry.workspaceName ?? entry.workspaceId ?? "Augenta";
      const reason = entry.fallback.reason === "consent_required"
        ? `Model access is not acknowledged in ${label}; an administrator must acknowledge external-model access to enable answers`
        : `Augenta's model was unavailable in ${label}`;
      console.log(`${reason} (${entry.fallback.reason}); requested memory instead.`);
    }
  }
  for (const answer of payload.answers) {
    const label = answer.workspaceName ?? answer.workspaceId ?? "Augenta";
    console.log(`— ${label} —`);
    console.log(answer.answer);
    console.log("");
  }
  for (const entry of payload.nothingRemembered) {
    const label = entry.workspaceName ?? entry.workspaceId ?? "this Workspace";
    console.log(`Nothing remembered yet in ${label}.`);
  }
  for (const entry of payload.failed) {
    const label = entry.workspaceName ?? entry.workspaceId ?? entry.connectorId ?? "Augenta";
    console.error(`Augenta recall: could not ask ${label}: ${entry.message}`);
  }
  if (payload.unresolvedConnectorIds?.length) {
    // The `--json` payload reports these and SKILL.md tells the agent to say so,
    // so only the direct human path could lose them — and that is the path with
    // no agent to notice a destination quietly missing from the answers.
    console.error(
      `Augenta recall: no answer from ${payload.unresolvedConnectorIds.join(", ")} — ` +
        "those links could not be used or their Workspaces refused recall; see any Workspace failure above before reconnecting.",
    );
  }
  if (payload.message && payload.answers.length === 0) {
    console.error(`Augenta recall: ${payload.message}`);
  }
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  // Read straight off argv: parseArgs itself can throw, and a caller that asked
  // for JSON must get JSON back even for a bad flag.
  const wantsJson = argv.includes("--json");
  try {
    const args = parseArgs(argv);
    const resolved = resolveProject(args, process.cwd());
    const payload = await runRecall(resolved, args);
    /* `projectRoot` comes from the payload, not from `resolved`: the config is
       found by walking UPWARD, so the directory recall actually used is often an
       ancestor of the one the search began in. */
    const envelope = {
      ...payload,
    };
    if (args.json) {
      console.log(JSON.stringify(envelope, null, 2));
    } else {
      printPayload(payload);
    }
    // Only a genuine error is a failed exit. EVERY other status is a true answer
    // about a real project — a young Workspace (`nothing_remembered`), one that
    // never opted in (`not_connected`), a sign-in to redo (`need_login`), an
    // environment without recall (`recall_unavailable`), or a partial result —
    // and making any of them non-zero would turn a normal answer into a broken
    // command for anyone who scripts this.
    if (payload.status === "error" || payload.status === "recall_timeout") process.exitCode = 1;
  } catch (error) {
    const message = describeError(error);
    if (wantsJson) {
      console.log(JSON.stringify({ status: "error", code: "failed", message }, null, 2));
    } else {
      console.error(`Augenta recall: ${message}`);
    }
    process.exitCode = 1;
  }
}
