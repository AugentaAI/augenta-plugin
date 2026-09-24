/**
 * The recall request layer: ask the Workspaces a project feeds what they
 * remember, and classify every answer.
 *
 * Two callers share it, and an entrypoint may not import another entrypoint
 * (bundling would inline the imported file's `isMain` block and run the wrong
 * body first — AGENTS.md → "The runtime boundary"), so it lives in this plain
 * module rather than in either of them:
 *
 *   • `scripts/recall.ts`, the READ door's CLI, which the recall skill runs when
 *     the user or agent asks. Its defaults are this module's defaults: one
 *     attempt per request, a 75s ceiling, a refreshing sign-in, live names.
 *   • the UserPromptSubmit hook (`hooks/auto-recall.ts`), which asks with the
 *     user's prompt on every turn under a hard budget. It opts into the
 *     deadline, the transient retries and a stored bearer that never refreshes.
 *
 * It is a pure read, so NOTHING here consults the capture kill switch: explicit
 * recall is deliberately not gated on it, and the hook applies its own gate
 * before calling in. What governs recall is a readable `.augenta/config.json`.
 *
 * ONLY THE QUESTION LEAVES. The request body is the query text and — for a
 * signed-in project — the Workspace id. No transcript, no file contents, no
 * credential in any payload this returns: a sign-in token travels in the
 * authorization header only, and a platform key from the project config.
 *
 * TWO MODES, WITH ANSWER AS THE CLI's DEFAULT. Every URL carries an explicit
 * `?mode=`. If answer mode returns 503 answerer_unavailable or
 * consent_required, it retries once as context and marks the outcome so the
 * caller can explain the fallback.
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
import {
  DEFAULT_GATEWAY,
  controlUrl,
  gatewayBase,
  loadProjectConfig,
  resolveProjectRoot,
  type ProjectConfig,
} from "./config";
import { REQUEST_TIMEOUT_MS, fetchWithProfile, getAuthProfile, ReLoginRequiredError } from "./auth";
import {
  AugentaRequestError,
  describeError,
  environmentLabel,
  fetchAllWorkspaces,
  inspectConnector,
  type AuthorizedFetch,
  type Workspace,
} from "./platform";

/** Mirrors the door's own `MAX_QUERY_CHARS`. Checked here as well so an
 *  over-long question costs one local error instead of one rejected round trip
 *  per destination. */
export const MAX_QUERY_CHARS = 4096;

/**
 * The least time worth starting a request with, under a deadline. A request
 * given less than this would spend it on the TLS handshake and report a
 * timeout that says nothing about Augenta.
 */
const MIN_ATTEMPT_MS = 200;

/** Waits between transient attempts, first retry then second. */
const RETRY_BACKOFF_MS = [150, 300];

/**
 * Typed door codes that arrive with a 5xx but are NOT transient. Recall not
 * deployed, a forward the door refused, and the two answer-mode states the
 * context fallback already handles would all answer the same way again.
 */
const NON_TRANSIENT_CODES = new Set([
  "recall_unavailable",
  "recall_forward_rejected",
  "answerer_unavailable",
  "consent_required",
]);

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
   * In `answer` mode it is prose a model wrote. In `context` mode it is the
   * MEMORY ITSELF — the matched engram's summary followed by each supporting
   * note — and the agent reading this payload is what turns it into an answer.
   * `mode` says which, and every consumer branches its wording on it: a recalled
   * note presented as though Augenta had answered would attribute a claim to a
   * summariser that never ran.
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

/** What one recall asks, and how hard it tries. */
export interface RecallRequest {
  query: string;
  mode: "answer" | "context";
  /** Narrow the fan-out to these Workspace ids. Empty means every destination. */
  workspaces?: string[];
  /** Per-request ceiling for `mode`, in ms. */
  timeoutMs: number;
  /** Per-request ceiling for the answer-to-context fallback leg, in ms. */
  contextTimeoutMs: number;
  /**
   * Absolute epoch ms. No request starts after it, and every request is cut at
   * it. Absent — the CLI — each request gets exactly its own ceiling.
   */
  deadlineAt?: number;
  /** Extra attempts on a transient failure, per destination. Default 0. */
  retries?: number;
  /** Look up live Workspace names for the headings. Default true. */
  refreshNames?: boolean;
  /**
   * How a signed-in project authorizes. `"profile"` (the default) goes through
   * `fetchWithProfile`, which may refresh the sign-in. `{ bearer }` is a token
   * the caller already holds: plain requests, no lock, never a refresh, and a
   * 401 is `need_login`. Ignored for a platform-key project.
   */
  auth?: "profile" | { bearer: string };
  /** Test seam for the retry backoff. */
  sleep?: (ms: number) => Promise<void>;
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

interface AskContext {
  url: string;
  query: string;
  timeoutMs: number;
  contextTimeoutMs: number;
  fetcher: AuthorizedFetch;
  deadlineAt?: number;
  retries: number;
  sleep: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The timeout one request may use, in whole milliseconds, or `undefined` when a
 * deadline leaves too little to start one.
 *
 * Whole and positive on purpose: Node's `AbortSignal.timeout` THROWS
 * `ERR_OUT_OF_RANGE` on a fractional or negative delay (Bun does not, so only
 * the shipped bundle would see it), and the throw would surface as a
 * "network" failure for a request that never left.
 */
function requestTimeout(ceilingMs: number, deadlineAt: number | undefined): number | undefined {
  if (deadlineAt === undefined) return Math.max(1, Math.floor(ceilingMs));
  const remaining = deadlineAt - Date.now();
  if (remaining < MIN_ATTEMPT_MS) return undefined;
  return Math.max(1, Math.floor(Math.min(ceilingMs, remaining)));
}

/** Room for a retry: its backoff plus a request worth starting. */
function hasRoomFor(waitMs: number, deadlineAt: number | undefined): boolean {
  return deadlineAt === undefined || deadlineAt - Date.now() >= waitMs + MIN_ATTEMPT_MS;
}

function outOfTime(): Outcome {
  return {
    kind: "failed",
    code: "recall_timeout",
    message: "Augenta did not answer within the time allowed",
  };
}

/**
 * One POST, classified, plus whether a retry could change the result.
 *
 * Transient means the transport failed (not a timeout: under a deadline the
 * time is already spent, and without one the CLI makes one attempt anyway) or
 * a 500/502/503/504 whose body does not mark it final. It is decided from the
 * raw response here, never stored on the Outcome, so `failed[]` in the payload
 * carries exactly the fields it always has.
 */
async function askOnce(
  ctx: AskContext,
  destination: Destination,
): Promise<{ outcome: Outcome; transient: boolean; retryAfterMs?: number }> {
  const timeoutMs = requestTimeout(ctx.timeoutMs, ctx.deadlineAt);
  if (timeoutMs === undefined) return { outcome: outOfTime(), transient: false };
  /* The client owns its contract: every URL carries an explicit mode. */
  const headers: Record<string, string> = {
    "content-type": "application/json",
    /* Fresh per destination, per call AND per attempt. The door namespaces an
       activation by (principal, key), so reusing one key across two
       destinations or two different questions is a 409 on a perfectly valid
       request — and a 409 without a typed code reads as `workspace_archived`,
       which would wrongly mark a healthy link unresolved. A retry after a
       request the door did process therefore records a second activation. */
    "idempotency-key": randomUUID(),
  };
  const body = JSON.stringify(
    destination.workspaceId ? { query: ctx.query, workspace: destination.workspaceId } : { query: ctx.query },
  );
  try {
    const response = await ctx.fetcher(ctx.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
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
      return { outcome: { ...fallback, fallback: { requested: "answer", reason: outcome.code } }, transient: false };
    }
    const { code } = errorFields(parsed, text);
    const final = (parsed as { error?: { retryable?: unknown } } | undefined)?.error?.retryable === false;
    const transient = [500, 502, 503, 504].includes(response.status) && !final &&
      !(code && NON_TRANSIENT_CODES.has(code));
    const wait = retryAfterSeconds(response.headers.get("retry-after"));
    return { outcome, transient, ...(wait !== undefined ? { retryAfterMs: wait * 1000 } : {}) };
  } catch (error) {
    if (error instanceof ReLoginRequiredError) {
      return { outcome: { kind: "failed", code: "need_login", message: error.message }, transient: false };
    }
    const name = (error as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        outcome: {
          kind: "failed",
          code: "recall_timeout",
          message: `Augenta did not answer within ${Math.round(timeoutMs / 1000)}s`,
        },
        transient: false,
      };
    }
    return { outcome: { kind: "failed", code: "network", message: describeError(error) }, transient: true };
  }
}

/** One destination asked, with at most `ctx.retries` more attempts on a
 *  transient failure. Everything that can go wrong on the wire lands here as an
 *  {@link Outcome} so the fan-out never rejects and one bad destination cannot
 *  take the others down with it. */
async function askDestination(ctx: AskContext, destination: Destination): Promise<Outcome> {
  for (let attempt = 0; ; attempt++) {
    const { outcome, transient, retryAfterMs } = await askOnce(ctx, destination);
    if (!transient || attempt >= ctx.retries) return outcome;
    const wait = retryAfterMs ?? RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]!;
    if (!hasRoomFor(wait, ctx.deadlineAt)) return outcome;
    await ctx.sleep(wait);
  }
}

/**
 * A recorded link, checked live. One retry on a transient failure when the
 * caller allows retries (the GET is idempotent), and a deadline-bounded signal
 * when there is a deadline. Without either — the CLI — it is exactly
 * `currentConnector`: one request under fetchWithProfile's own timeout.
 */
async function checkLink(
  fetcher: AuthorizedFetch,
  gateway: string,
  connectorId: string | undefined,
  deadlineAt: number | undefined,
  retries: number,
  sleep: (ms: number) => Promise<void>,
) {
  for (let attempt = 0; ; attempt++) {
    let signal: AbortSignal | undefined;
    if (deadlineAt !== undefined) {
      const timeoutMs = requestTimeout(REQUEST_TIMEOUT_MS, deadlineAt);
      if (timeoutMs === undefined) throw new Error("no time left to check the Connector");
      signal = AbortSignal.timeout(timeoutMs);
    }
    try {
      return await inspectConnector(fetcher, gateway, connectorId, signal);
    } catch (error) {
      const name = (error as Error)?.name;
      const transient = error instanceof AugentaRequestError
        ? error.status >= 500
        : !(error instanceof ReLoginRequiredError) && name !== "TimeoutError" && name !== "AbortError";
      const wait = RETRY_BACKOFF_MS[0]!;
      if (!transient || attempt >= Math.min(retries, 1) || !hasRoomFor(wait, deadlineAt)) throw error;
      await sleep(wait);
    }
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

/**
 * Ask every Workspace the project at (or above) `searchRoot` feeds.
 *
 * Every Connector is checked live before its question is sent; the checks and
 * the questions each run in parallel across destinations. See RecallRequest for
 * the knobs the prompt hook turns and the CLI leaves at their defaults.
 */
export async function askWorkspaces(searchRoot: string, request: RecallRequest): Promise<RecallPayload> {
  const startedAt = Date.now();
  const { query, mode, deadlineAt } = request;
  const retries = Math.max(0, Math.floor(request.retries ?? 0));
  const sleep = request.sleep ?? defaultSleep;
  /* Environment is reported on EVERY payload, including the ones that never got
     as far as a config, so a caller can always say which Augenta it was talking
     about. Re-derived once the gateway is known. */
  let environment = recallEnvironment(DEFAULT_GATEWAY);
  /* Likewise the project: until a config is found this is where the search
     STARTED, and afterwards the directory it was found in. See RecallPayload. */
  let projectRoot = searchRoot;
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

  const found = resolveProjectRoot(searchRoot);
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
  let fetcher: AuthorizedFetch;

  const url = `${gateway}/v1/recall?mode=${mode}`;

  if (cfg.authMode === "oauth") {
    const profileId = cfg.profileId!;
    const bearer = typeof request.auth === "object" ? request.auth.bearer : undefined;
    if (bearer === undefined && !getAuthProfile(profileId)) {
      return bail(
        "need_login",
        "need_login",
        "this project's Augenta sign-in is missing; sign in again with the connect skill",
      );
    }
    /* Looked up at call time, never captured: tests swap `globalThis.fetch`. */
    fetcher = bearer !== undefined
      ? (target, init) => fetch(target, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${bearer}` },
        })
      : (target, init) => fetchWithProfile(profileId, target, init);
    destinations = (cfg.destinations ?? []).map((destination) => ({ ...destination }));
    if (request.workspaces?.length) {
      const requested = new Set(request.workspaces);
      const unknown = request.workspaces.filter(
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
        return { destination, connector: await checkLink(fetcher, gateway, destination.connectorId, deadlineAt, retries, sleep) };
      } catch (error) {
        return { destination, error };
      }
    }));
    destinations = [];
    for (const entry of inspected) {
      if ("error" in entry) {
        /* A stored bearer never refreshes, so a 401 on the check is the sign-in
           itself being refused — the same verdict the POST would reach. Under
           fetchWithProfile a 401 has already been refreshed once, and the CLI's
           long-standing report of what is left is kept as it was. */
        const refused = entry.error instanceof ReLoginRequiredError ||
          (bearer !== undefined && entry.error instanceof AugentaRequestError && entry.error.status === 401);
        failed.push({
          ...entry.destination,
          code: refused ? "need_login" : "network",
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
    if (destinations.length > 0 && request.refreshNames !== false) {
      // Names do not authorize a read. Start their best-effort lookup only after
      // link checks pass, then overlap it with recall instead of waiting on it.
      names = fetchAllWorkspaces(profileId, gateway).catch(() => [] as Workspace[]);
    }
  } else {
    if (request.workspaces?.length) {
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
    fetcher = (target, init) => fetch(target, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `AugentaKey ${apiKey}` },
    });
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

  const ctx: AskContext = {
    url,
    query,
    timeoutMs: request.timeoutMs,
    contextTimeoutMs: request.contextTimeoutMs,
    fetcher,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    retries,
    sleep,
  };

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
