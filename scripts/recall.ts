/**
 * Ask the Workspaces this project feeds what they remember, and print the answers.
 *
 * The mirror image of `scripts/connect.ts`: connect is the WRITE door and this is
 * the READ one. Everything about it follows from that.
 *
 * It is a pure read, so it is NOT gated on `AUGENTA_CAPTURE_ENABLED` — that
 * switch turns capture off, and a project whose owner stopped sending may still
 * legitimately ask what was already remembered. What governs recall is the same
 * thing that governs everything else here: the presence of a readable
 * `.augenta/config.json`. No config, no question leaves the machine.
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
 * TOKEN MINIMISATION IS THIS CLIENT'S JOB, deliberately. The door hands back a
 * flat, ordered block list and makes trimming trivial (`type` + `text` on every
 * block, `text` first); it does not decide how small the rendering should be,
 * because that depends on whose context window it is about to enter. So
 * `renderContext` below keeps the engram summary and each note's text and drops
 * everything else — ids, timestamps, frames, metadata, lineage. Anything added
 * back is paid for in the user's own context window on every recall.
 */
import { randomUUID } from "node:crypto";
import { isMain } from "../runtime/node";
import {
  DEFAULT_GATEWAY,
  controlUrl,
  gatewayBase,
  loadProjectConfig,
  resolveProjectRoot,
  type ProjectConfig,
} from "../capture/config";
import { fetchWithProfile, getAuthProfile, ReLoginRequiredError } from "../capture/auth";
import {
  currentConnector,
  describeError,
  environmentLabel,
  fetchAllWorkspaces,
  type Workspace,
} from "../capture/platform";
import { resolveProject, type ResolvedProject } from "../capture/project";

/**
 * The context-mode wait, in seconds. Retains the rollout ceiling for older
 * platforms that ignore the explicit mode and still run a model. The current
 * platform enforces its own 15s context deadline.
 */
const DEFAULT_TIMEOUT_SECONDS = 75;

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

/** Mirrors the door's own `MAX_QUERY_CHARS`. Checked here as well so an
 *  over-long question costs one local error instead of one rejected round trip
 *  per destination. */
const MAX_QUERY_CHARS = 4096;

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
  if (args.answer && args.context) throw new Error("--answer and --context cannot be used together");
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

/** One destination the question is asked of. `workspaceId` is absent only in
 *  platform-key mode, where the key's own assignment is the route. */
interface Destination {
  connectorId?: string;
  workspaceId?: string;
  workspaceName?: string;
}

export interface RecallFallback {
  requested: "answer";
  reason: "answerer_unavailable" | "consent_required";
}

export interface RecallAnswer extends Destination {
  fallback?: RecallFallback;
  /** The retrieval service's own scope string, reported verbatim for an audit
   *  trail. Never composed here — the recorded org id is for display only. */
  scope?: string;
  /**
   * What this Workspace returned, as text to read.
   *
   * In default `answer` mode it is prose a model wrote. In `context` mode it
   * is the MEMORY ITSELF — the matched engram's summary followed by each
   * supporting note — and the agent reading this payload is what turns it into
   * an answer. `mode` says which, and SKILL.md branches its wording on it: a
   * recalled note presented as though Augenta had answered would attribute a
   * claim to a summariser that never ran.
   */
  answer: string;
  /** Which mode produced `answer`. Read off the door's own `mode` field, not
   *  assumed from the flag that was passed. */
  mode: "context" | "answer";
  /** Present and `true` only when the door capped the notes it sent, so an agent
   *  answering from this memory can say it is working from part of it rather
   *  than implying it saw everything. */
  notesTruncated?: boolean;
  model?: string;
  renderer?: string;
}

export type NothingRemembered = Destination & { fallback?: RecallFallback };

export interface RecallFailure extends Destination {
  fallback?: RecallFallback;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export interface RecallPayload {
  status: string;
  query: string;
  answers: RecallAnswer[];
  nothingRemembered: NothingRemembered[];
  failed: RecallFailure[];
  /** Recorded links that failed live validation or whose Workspace refused recall.
   *  Reported rather than dropped; the project still lists them for capture. */
  unresolvedConnectorIds?: string[];
  code?: string;
  message?: string;
  environment: string;
  organization?: string;
  /**
   * The directory whose `.augenta/config.json` was used — NOT the directory the
   * search started from.
   *
   * `resolveProjectRoot` walks UPWARD, so running from `~/code/api/src/deep`
   * uses the config at `~/code/api`. Reporting the starting directory instead
   * would name a project recall did not ask, and SKILL.md tells the agent to
   * relay this path to the user. With no config found anywhere there is nothing
   * to name, so it falls back to where the search began — which is the honest
   * answer to "where did you look?".
   */
  projectRoot: string;
  elapsedMs: number;
}

/* -------------------------------------------------------------------------
 * Response classification.
 *
 * Two error shapes reach this client for one logical call, and both are real:
 *
 *   {"error": "workspace is required"}                        — the platform door
 *   {"error": {code, message, retryable}, "scope", "request_id"} — the retrieval
 *                                                                 service, passed
 *                                                                 through verbatim
 *
 * The typed one's `code` IS the contract — `empty_scope` is a 404 that means
 * "this Workspace is young", not a fault — so it is read first and only then
 * fallen back on. Kept as a pure function over the parts of a response so the
 * whole table can be exercised without a server.
 * ---------------------------------------------------------------------- */

export interface RecallResponseParts {
  status: number;
  /** The parsed JSON body, or `undefined` when the body was not JSON. */
  body?: unknown;
  /** The raw body text, used for a message when there is no JSON to read. */
  text: string;
  model?: string;
  renderer?: string;
  retryAfter?: string | null;
}

export type Outcome = (
  | {
      kind: "answered";
      answer: string;
      mode: "context" | "answer";
      notesTruncated?: boolean;
      scope?: string;
      model?: string;
      renderer?: string;
    }
  | { kind: "nothing_remembered" }
  | { kind: "failed"; code: string; message: string; retryAfterSeconds?: number }
) & { fallback?: RecallFallback };

/** One content block off the door's `content[]`. Read structurally rather than
 *  typed: block kinds are additive upstream and an unknown `type` must be
 *  IGNORED, never a parse failure. */
type ContentBlock = { type?: unknown; text?: unknown };

function blocksOf(body: unknown, type: string): ContentBlock[] {
  const content = (body as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is ContentBlock =>
      !!block && typeof block === "object" && (block as ContentBlock).type === type,
  );
}

function textOf(block: ContentBlock | undefined): string {
  return typeof block?.text === "string" ? block.text : "";
}

/**
 * The smallest useful rendering of a context response: the engram's summary,
 * then each supporting note, and nothing else.
 *
 * Everything dropped here is dropped on purpose, and each has a reason beyond
 * "fewer tokens": the engram id and node ids are handles this client has nothing
 * to do with, `frame`/`metadata` describe what KIND of observation a note was
 * rather than what it says, and the lineage blocks are the engram's own history
 * — interesting to a console, noise inside a question's answer. Timestamps are
 * the one real loss (a temporal question is harder to answer without them) and
 * are the first thing to add back if that proves to matter; the door sends them
 * on every note and a `reference_date` beside them.
 *
 * Blank-line separated so the summary reads as a claim and the notes as the
 * evidence under it, with no invented labels asserting more structure than that.
 */
export function renderContext(body: unknown): string {
  const parts = [
    ...blocksOf(body, "engram").map(textOf),
    ...blocksOf(body, "note").map(textOf),
  ].filter((text) => text.trim());
  return parts.join("\n\n");
}

function errorFields(
  body: unknown,
  text: string,
): { code?: string; message?: string; structured: boolean } {
  const error = (body as { error?: unknown } | undefined)?.error;
  if (error && typeof error === "object") {
    const typed = error as { code?: unknown; message?: unknown };
    return {
      code: typeof typed.code === "string" ? typed.code : undefined,
      message: typeof typed.message === "string" ? typed.message : undefined,
      structured: true,
    };
  }
  if (typeof error === "string") {
    // The platform door's own shape. Its 429 carries a sibling `code`.
    const sibling = (body as { code?: unknown }).code;
    return {
      code: typeof sibling === "string" ? sibling : undefined,
      message: error,
      structured: true,
    };
  }
  const trimmed = text.trim();
  return {
    message: trimmed ? trimmed.slice(0, 400) : undefined,
    structured: false,
  };
}

function retryAfterSeconds(raw: string | null | undefined): number | undefined {
  // The emptiness check is not redundant: `Number("")` is 0, so without it a
  // missing or blank `Retry-After` would be reported as "wait 0 seconds" — an
  // invitation to retry immediately, which is the opposite of what a 429 asks
  // for. An HTTP-date form also yields NaN here and is likewise reported as
  // absent, which is honest: this client has no wait to offer.
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined;
}

export function classifyRecallResponse(parts: RecallResponseParts): Outcome {
  const { status, body, text } = parts;
  if (status === 200) {
    /* The MODE is read off the response, never assumed from the flag that was
       passed: the door decides, and a client that assumed would mislabel a
       payload the moment the two disagreed. `mode` absent is a pre-envelope
       deployment (see the legacy arm below) or a proxy that dropped the field;
       an `answer` block present is then the honest reading. */
    const declared = (body as { mode?: unknown } | undefined)?.mode;
    const answerBlock = textOf(blocksOf(body, "answer")[0]);
    const legacyAnswer =
      typeof (body as { answer?: unknown } | undefined)?.answer === "string"
        ? (body as { answer: string }).answer
        : "";
    const mode: "context" | "answer" =
      declared === "context"
        ? "context"
        : declared === "answer" || answerBlock || legacyAnswer
          ? "answer"
          : "context";
    /* An older API — one deployed before the content envelope — answers
       `{scope, answer}` and ignores the `mode` parameter entirely. Plugin
       installs and API rollouts are not in lockstep (dev rolls on every merge,
       staging and prod on a dispatch), so a client that only understood the new
       shape would report `invalid_response` for a perfectly good answer from an
       environment that has not rolled yet. Reported as `answer` mode because
       that is what happened: a model wrote it, whichever mode was asked for. */
    const answer = mode === "answer" ? answerBlock || legacyAnswer : renderContext(body);
    if (!answer.trim()) {
      /* A 200 with nothing to read is not a recall. Reporting it as one would
         put an empty string in front of the user as though the Workspace had
         spoken — and in context mode it would also look like a young Workspace,
         which has its own honest answer (`404 empty_scope`, reported as
         `nothing_remembered`) that this must not be confused with. */
      return {
        kind: "failed",
        code: "invalid_response",
        message:
          mode === "answer"
            ? "Augenta answered without an answer"
            : "Augenta returned no memory to read",
      };
    }
    const scope = (body as { scope?: unknown }).scope;
    return {
      kind: "answered",
      answer,
      mode,
      ...((body as { notes_truncated?: unknown }).notes_truncated === true
        ? { notesTruncated: true }
        : {}),
      ...(typeof scope === "string" ? { scope } : {}),
      ...(parts.model ? { model: parts.model } : {}),
      ...(parts.renderer ? { renderer: parts.renderer } : {}),
    };
  }
  const { code, message, structured } = errorFields(body, text);
  const say = (fallback: string) => message ?? fallback;
  if (status === 404) {
    // NOT an error. A Workspace nobody has fed yet has nothing to remember, and
    // saying "recall failed" about that would send the user to look for a fault.
    if (code === "empty_scope") return { kind: "nothing_remembered" };
    if (!structured) {
      // No error body at all means the route is not registered — recall is not
      // deployed in this Augenta environment, which is a property of the
      // environment rather than of the question or the credential.
      return {
        kind: "failed",
        code: "recall_unavailable",
        message: "recall is not available in this Augenta environment",
      };
    }
    return { kind: "failed", code: code ?? "not_found", message: say("Augenta returned 404") };
  }
  if (status === 401) {
    return {
      kind: "failed",
      code: "need_login",
      message: say("the Augenta sign-in was rejected; sign in again with the connect skill"),
    };
  }
  if (status === 403) {
    return {
      kind: "failed",
      code: "not_entitled",
      message: say("this sign-in is not entitled to read that Workspace"),
    };
  }
  if (status === 409) {
    /* Two meanings, told apart by the body. The platform door answers 409 for an
       ARCHIVED Workspace — its Workspace routes' own spelling for "this exists,
       you may see it, and it is closed" — and passes the retrieval service's
       typed `embedder_mismatch` through with the same status, which is a
       deployment fault rather than anything the asker did. A typed code wins;
       otherwise this is the archived case. */
    return {
      kind: "failed",
      code: code ?? "workspace_archived",
      message: say("that Workspace is archived and cannot be read"),
    };
  }
  if (status === 429) {
    const retryAfter = retryAfterSeconds(parts.retryAfter);
    return {
      kind: "failed",
      code: "rate_limited",
      message: say("Augenta is rate limiting recall requests"),
      ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
    };
  }
  if (status === 400) {
    return {
      kind: "failed",
      code: code ?? "bad_request",
      message: say("Augenta rejected the recall request"),
    };
  }
  if (status >= 500) {
    /* 502 and 504 carry the door's own typed codes — `recall_unavailable`,
       `recall_timeout`, `recall_forward_rejected` — which say more than the
       status does, so they are used as-is. */
    return {
      kind: "failed",
      code: code ?? "upstream_error",
      message: say(`Augenta returned ${status}`),
    };
  }
  return {
    kind: "failed",
    code: code ?? "unexpected_status",
    message: say(`Augenta returned ${status}`),
  };
}

/* ---------------------------------------------------------------------- */

/** One POST, classified. Everything that can go wrong on the wire lands here as
 *  an {@link Outcome} so the fan-out never rejects and one bad destination
 *  cannot take the others down with it. */
async function askDestination(
  ctx: {
    url: string;
    query: string;
    timeoutMs: number;
    contextTimeoutMs: number;
    profileId?: string;
    apiKey?: string;
  },
  destination: Destination,
): Promise<Outcome> {
  /* The client owns its contract: every URL carries an explicit mode. */
  const headers: Record<string, string> = {
    "content-type": "application/json",
    /* Fresh per destination AND per call. The door namespaces an activation by
       (principal, key), so reusing one key across two destinations or two
       different questions is a 409 on a perfectly valid request. */
    "idempotency-key": randomUUID(),
  };
  const body = JSON.stringify(
    destination.workspaceId ? { query: ctx.query, workspace: destination.workspaceId } : { query: ctx.query },
  );
  try {
    const response = ctx.profileId
      ? await fetchWithProfile(ctx.profileId, ctx.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(ctx.timeoutMs),
        })
      : await fetch(ctx.url, {
          method: "POST",
          headers: { ...headers, authorization: `AugentaKey ${ctx.apiKey}` },
          body,
          signal: AbortSignal.timeout(ctx.timeoutMs),
        });
    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const outcome = classifyRecallResponse({
      status: response.status,
      body: parsed,
      text,
      model: response.headers.get("x-augenta-model") ?? undefined,
      renderer: response.headers.get("x-augenta-renderer") ?? undefined,
      retryAfter: response.headers.get("retry-after"),
    });
    const url = new URL(ctx.url);
    if (response.status === 503 && url.searchParams.get("mode") === "answer" &&
        outcome.kind === "failed" &&
        (outcome.code === "answerer_unavailable" || outcome.code === "consent_required")) {
      url.searchParams.set("mode", "context");
      const fallback = await askDestination(
        { ...ctx, url: url.toString(), timeoutMs: ctx.contextTimeoutMs }, destination,
      );
      return { ...fallback, fallback: { requested: "answer", reason: outcome.code } };
    }
    return outcome;
  } catch (error) {
    if (error instanceof ReLoginRequiredError) {
      return { kind: "failed", code: "need_login", message: error.message };
    }
    const name = (error as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        kind: "failed",
        code: "recall_timeout",
        message: `Augenta did not answer within ${Math.round(ctx.timeoutMs / 1000)}s`,
      };
    }
    return { kind: "failed", code: "network", message: describeError(error) };
  }
}

/**
 * The aggregate verdict.
 *
 * A status rather than a pair of arrays to inspect, because the SKILL has to
 * branch its wording on this — "here is what your Workspaces remember" and "one
 * of them is rate limited" are different messages — and branching on a named
 * status is more reliable than remembering to check whether an array is empty.
 */
export function aggregateStatus(payload: {
  answers: unknown[];
  nothingRemembered: unknown[];
  failed: Array<{ code: string }>;
  unresolvedConnectorIds?: string[];
}): string {
  const { answers, nothingRemembered, failed } = payload;
  const total = answers.length + nothingRemembered.length + failed.length + (payload.unresolvedConnectorIds?.length ?? 0);
  if (total === 0) return "error";
  if (answers.length === total) return "answered";
  if (nothingRemembered.length === total) return "nothing_remembered";
  if (answers.length + nothingRemembered.length === 0) {
    // Every destination refused for the same reason, so the reason IS the
    // verdict — the caller should act on it once, not once per Workspace.
    if (failed.length === 0) return "error";
    if (failed.every((f) => f.code === "need_login")) return "need_login";
    if (failed.every((f) => f.code === "recall_unavailable")) return "recall_unavailable";
    if (failed.every((f) => f.code === "recall_timeout")) return "recall_timeout";
    return "error";
  }
  return "partially_answered";
}

/**
 * Name the environment honestly.
 *
 * `environmentLabel` takes the resolved control URL, which is what connect selects an
 * environment with. Recall never touches the control plane: it posts to the
 * GATEWAY the project config points at. So a project connected to dev, run
 * without an override, uses its recorded control URL. Either coordinate being
 * non-default is enough to say so.
 */
export function recallEnvironment(gateway: string, cfg?: ProjectConfig): string {
  const label = environmentLabel(controlUrl(cfg));
  if (label !== "prod") return label;
  return gateway === DEFAULT_GATEWAY ? "prod" : gateway;
}

export async function runRecall(
  resolved: ResolvedProject,
  args: RecallArgs,
): Promise<RecallPayload> {
  const startedAt = Date.now();
  const query = questionFrom(args);
  /* Environment is reported on EVERY payload, including the ones that never got
     as far as a config, so a caller can always say which Augenta it was talking
     about. Re-derived once the gateway is known. */
  let environment = recallEnvironment(DEFAULT_GATEWAY);
  /* Likewise the project: until a config is found this is where the search
     STARTED, and afterwards the directory it was found in. See RecallPayload. */
  let projectRoot = resolved.projectRoot;
  let organization: string | undefined;

  /** Every early return. A closure rather than a six-parameter helper: `query`,
   *  `environment`, `projectRoot` and `startedAt` are the same at all eight call
   *  sites, and two same-typed pairs (`status`/`code`, `message`/`query`) were
   *  one transposition away from a payload that type-checks and lies. */
  const bail = (
    status: string,
    code: string,
    message: string,
    extra: Partial<RecallPayload> = {},
  ): RecallPayload => ({
    status,
    query,
    answers: [],
    nothingRemembered: [],
    failed: [],
    code,
    message,
    environment,
    ...(organization ? { organization } : {}),
    projectRoot,
    elapsedMs: Date.now() - startedAt,
    ...extra,
  });

  if (!query) {
    return bail("error", "query_required", "ask a question: recall takes the text to look up");
  }
  if (query.length > MAX_QUERY_CHARS) {
    return bail(
      "error",
      "query_too_long",
      `the question is ${query.length} characters; Augenta accepts ${MAX_QUERY_CHARS}`,
    );
  }

  const found = resolveProjectRoot(resolved.projectRoot);
  if (!found) {
    return bail(
      "not_connected",
      "not_connected",
      "this project is not connected to Augenta; run the connect skill first",
    );
  }
  projectRoot = found;
  const cfg = loadProjectConfig(projectRoot);
  if (!cfg) {
    // resolveProjectRoot only returns a directory whose config file EXISTS, so
    // this branch is a file that is present and unreadable — a different thing to
    // tell the user than "you never connected".
    return bail(
      "not_connected",
      "unreadable_config",
      "this project's Augenta config cannot be read; reconnect with the connect skill",
    );
  }
  const gateway = gatewayBase(cfg);
  environment = recallEnvironment(gateway, cfg);
  organization = cfg.org?.name ?? cfg.org?.id;

  const answers: RecallAnswer[] = [];
  const nothingRemembered: NothingRemembered[] = [];
  const failed: RecallFailure[] = [];
  const unresolvedConnectorIds: string[] = [];
  let names: Promise<Workspace[]> = Promise.resolve([]);
  let destinations: Destination[] = [];
  let ctx: Parameters<typeof askDestination>[0];

  if (args.answer && args.context) throw new Error("--answer and --context cannot be used together");
  const mode = args.context ? "context" : "answer";
  const contextTimeoutMs = (args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const timeoutMs = mode === "context" ? contextTimeoutMs : (args.timeoutSeconds ?? ANSWER_TIMEOUT_SECONDS) * 1000;
  const url = `${gateway}/v1/recall?mode=${mode}`;

  if (cfg.authMode === "oauth") {
    const profileId = cfg.profileId!;
    if (!getAuthProfile(profileId)) {
      return bail(
        "need_login",
        "need_login",
        "this project's Augenta sign-in is missing; sign in again with the connect skill",
      );
    }
    destinations = (cfg.destinations ?? []).map((destination) => ({ ...destination }));
    if (args.workspaces?.length) {
      const requested = new Set(args.workspaces);
      const unknown = args.workspaces.filter(
        (id) => !destinations.some((destination) => destination.workspaceId === id),
      );
      if (unknown.length > 0) {
        return bail(
          "error",
          "unknown_workspace",
          `this project does not feed ${unknown.join(", ")}; recall can only ask the Workspaces it sends to`,
        );
      }
      destinations = destinations.filter(
        (destination) => destination.workspaceId && requested.has(destination.workspaceId),
      );
    }
    const inspected = await Promise.all(destinations.map(async (destination) => {
      try {
        return { destination, connector: await currentConnector(profileId, gateway, destination.connectorId) };
      } catch (error) {
        return { destination, error };
      }
    }));
    destinations = [];
    for (const entry of inspected) {
      if ("error" in entry) {
        failed.push({
          ...entry.destination,
          code: entry.error instanceof ReLoginRequiredError ? "need_login" : "network",
          message: describeError(entry.error),
        });
      } else if (
        !entry.connector || entry.connector.status !== "active" ||
        entry.connector.id !== entry.destination.connectorId ||
        entry.connector.workspaceId !== entry.destination.workspaceId
      ) {
        unresolvedConnectorIds.push(entry.destination.connectorId!);
      } else {
        destinations.push(entry.destination);
      }
    }
    if (destinations.length > 0) {
      // Names do not authorize a read. Start their best-effort lookup only after
      // link checks pass, then overlap it with recall instead of waiting on it.
      names = fetchAllWorkspaces(profileId, gateway).catch(() => [] as Workspace[]);
    }
    ctx = { url, query, timeoutMs, contextTimeoutMs, profileId };
  } else {
    if (args.workspaces?.length) {
      // A platform key is assigned to exactly one Connector, which is anchored to
      // exactly one Workspace: the key's assignment IS the route, so there is no
      // set here to narrow. Refused rather than ignored — silently dropping the
      // flag would answer a different question than the one that was asked.
      return bail(
        "error",
        "workspace_not_selectable",
        "this project uses a platform key, whose Connector fixes the Workspace; --workspace selects nothing",
      );
    }
    const apiKey = cfg.apiKey?.trim();
    if (!apiKey) {
      /* loadProjectConfig already refuses an empty key, so this is unreachable
         today — asserted rather than `!`-ed for the same reason connect's
         verifyProjectKey does it: the alternative is sending the literal header
         `AugentaKey undefined` and reporting whatever the gateway says about it,
         which surfaces as an unexplained 401 instead of a local message. */
      return bail(
        "error",
        "unreadable_config",
        "this project's platform key is missing from its Augenta config; reconnect",
      );
    }
    destinations = [{}];
    ctx = { url, query, timeoutMs, contextTimeoutMs, apiKey };
  }

  if (destinations.length === 0 && failed.length === 0) {
    return bail(
      "error",
      "no_destination",
      unresolvedConnectorIds.length > 0
        ? `this project lists ${unresolvedConnectorIds.join(", ")}, but their links are disabled, inaccessible, or no longer match the saved Workspaces; reconnect`
        : "this project has no destination to ask; reconnect with the connect skill",
      unresolvedConnectorIds.length > 0 ? { unresolvedConnectorIds } : {},
    );
  }

  const linkedDestinations = destinations;
  destinations = destinations.filter((destination, index) =>
    destinations.findIndex((entry) => entry.workspaceId === destination.workspaceId) === index,
  );

  /* Parallel on purpose. Each answer is a full model turn behind the door, so
     asking three Workspaces in series would cost three deadlines and routinely
     overrun the agent tool call that is waiting on this. */
  const outcomes = await Promise.all(
    destinations.map(async (destination) => ({
      destination,
      outcome: await askDestination(ctx, destination),
    })),
  );
  const named = await names;
  for (const { destination, outcome } of outcomes) {
    const liveName = named.find((workspace) => workspace.id === destination.workspaceId)?.name;
    if (liveName) destination.workspaceName = liveName;
    // A verified link does not grant Workspace read access. Report affected link
    // ids, but preserve the door's code and message in failed for actionable advice.
    if (cfg.authMode === "oauth" && outcome.kind === "failed" &&
        ["not_entitled", "not_found", "workspace_archived", "workspace_not_found", "workspace_forbidden"].includes(outcome.code)) {
      unresolvedConnectorIds.push(...linkedDestinations
        .filter((entry) => entry.workspaceId === destination.workspaceId)
        .map((entry) => entry.connectorId!));
    }
    // `kind` is the discriminator this loop branches on and has no meaning in the
    // payload, so it is destructured away rather than published as a second status.
    if (outcome.kind === "answered") {
      const { kind: _answered, ...fields } = outcome;
      answers.push({ ...destination, ...fields });
    } else if (outcome.kind === "nothing_remembered") {
      const { kind: _nothing, ...fields } = outcome;
      nothingRemembered.push({ ...destination, ...fields });
    } else {
      const { kind: _failed, ...fields } = outcome;
      failed.push({ ...destination, ...fields });
    }
  }

  const status = aggregateStatus({ answers, nothingRemembered, failed, unresolvedConnectorIds });
  return {
    status,
    query,
    answers,
    nothingRemembered,
    failed,
    ...(unresolvedConnectorIds.length > 0 ? { unresolvedConnectorIds } : {}),
    environment,
    ...(organization ? { organization } : {}),
    projectRoot,
    elapsedMs: Date.now() - startedAt,
  };
}

/** The bare (non-`--json`) rendering. A person reading a terminal wants the
 *  answers, with enough heading to tell which Workspace each came from. */
function printPayload(payload: RecallPayload): void {
  for (const entry of [...payload.answers, ...payload.nothingRemembered, ...payload.failed]) {
    if (entry.fallback) {
      const label = entry.workspaceName ?? entry.workspaceId ?? "Augenta";
      console.log(`Augenta's model was unavailable in ${label} (${entry.fallback.reason}); requested memory instead.`);
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
      ...(resolved.worktreeRedirect ? { worktreeRedirect: resolved.worktreeRedirect } : {}),
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
