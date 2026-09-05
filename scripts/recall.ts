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
 */
import { randomUUID } from "node:crypto";
import { isMain } from "../runtime/node";
import {
  DEFAULT_GATEWAY,
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
 * The wait this side of the hop, in seconds.
 *
 * Deliberately LONGER than the platform's own 60s deadline on the retrieval
 * service. An answer is one full model turn, so the platform is the component
 * that should decide a call took too long — it can say `recall_timeout` and mean
 * it. If this bound were the tighter one, every slow answer would surface as a
 * local abort with nothing to report, and the distinction between "too slow" and
 * "unreachable" would be lost on the way out.
 */
const DEFAULT_TIMEOUT_SECONDS = 75;

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
      args.timeoutSeconds = value;
    } else if (flag.startsWith("--")) {
      throw new Error(`unknown flag: ${flag}`);
    } else {
      args.words.push(flag);
    }
  }
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

export interface RecallAnswer extends Destination {
  /** The retrieval service's own scope string, reported verbatim for an audit
   *  trail. Never composed here — this client does not know the org id. */
  scope?: string;
  answer: string;
  model?: string;
  renderer?: string;
}

export type NothingRemembered = Destination;

export interface RecallFailure extends Destination {
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
  /** Destinations the project config lists whose Connector this sign-in cannot
   *  read at all. Reported rather than dropped: the project is still SHIPPING to
   *  them, so their silence is a fact about the sign-in, not about the Workspace. */
  unresolvedConnectorIds?: string[];
  code?: string;
  message?: string;
  environment: string;
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

export type Outcome =
  | { kind: "answered"; answer: string; scope?: string; model?: string; renderer?: string }
  | { kind: "nothing_remembered" }
  | { kind: "failed"; code: string; message: string; retryAfterSeconds?: number };

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
    const answer =
      typeof (body as { answer?: unknown })?.answer === "string"
        ? ((body as { answer: string }).answer)
        : "";
    if (!answer.trim()) {
      // A 200 with no answer is not an answer. Reporting it as one would put an
      // empty string in front of the user as though the Workspace had spoken.
      return {
        kind: "failed",
        code: "invalid_response",
        message: "Augenta answered without an answer",
      };
    }
    const scope = (body as { scope?: unknown }).scope;
    return {
      kind: "answered",
      answer,
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
  if (status === 429) {
    return {
      kind: "failed",
      code: "rate_limited",
      message: say("Augenta is rate limiting recall requests"),
      ...(retryAfterSeconds(parts.retryAfter) !== undefined
        ? { retryAfterSeconds: retryAfterSeconds(parts.retryAfter)! }
        : {}),
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
    profileId?: string;
    apiKey?: string;
  },
  destination: Destination,
): Promise<Outcome> {
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
    return classifyRecallResponse({
      status: response.status,
      body: parsed,
      text,
      model: response.headers.get("x-augenta-model") ?? undefined,
      renderer: response.headers.get("x-augenta-renderer") ?? undefined,
      retryAfter: response.headers.get("retry-after"),
    });
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
}): string {
  const { answers, nothingRemembered, failed } = payload;
  const total = answers.length + nothingRemembered.length + failed.length;
  if (total === 0) return "error";
  if (answers.length === total) return "answered";
  if (nothingRemembered.length === total) return "nothing_remembered";
  if (failed.length === total) {
    // Every destination refused for the same reason, so the reason IS the
    // verdict — the caller should act on it once, not once per Workspace.
    if (failed.every((f) => f.code === "need_login")) return "need_login";
    if (failed.every((f) => f.code === "recall_unavailable")) return "recall_unavailable";
    return "error";
  }
  return "partially_answered";
}

function fail(
  status: string,
  code: string,
  message: string,
  query: string,
  environment: string,
  startedAt: number,
): RecallPayload {
  return {
    status,
    query,
    answers: [],
    nothingRemembered: [],
    failed: [],
    code,
    message,
    environment,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Resolve the project's destinations from its config.
 *
 * A Connector id is what the config stores; a Workspace id is what the recall
 * door needs. The two are only connected on the platform, so each id costs one
 * GET — done in parallel, and with three distinct outcomes that must not be
 * collapsed. `undefined` means 403/404, i.e. this sign-in cannot see the link at
 * all (reported as unresolved). A THROW means the request itself failed, which
 * is a destination that could not be asked (reported as failed) — treating a
 * network blip as "the Connector is gone" would quietly narrow the fan-out.
 */
async function resolveDestinations(
  profileId: string,
  gateway: string,
  connectorIds: readonly string[],
): Promise<{
  destinations: Destination[];
  unresolvedConnectorIds: string[];
  failed: RecallFailure[];
  needLogin: boolean;
}> {
  const destinations: Destination[] = [];
  const unresolvedConnectorIds: string[] = [];
  const failed: RecallFailure[] = [];
  let needLogin = false;
  const resolved = await Promise.all(
    connectorIds.map(async (id) => {
      try {
        return { id, link: await currentConnector(profileId, gateway, id) };
      } catch (error) {
        return { id, error };
      }
    }),
  );
  for (const entry of resolved) {
    if ("error" in entry && entry.error !== undefined) {
      if (entry.error instanceof ReLoginRequiredError) {
        needLogin = true;
        continue;
      }
      failed.push({
        connectorId: entry.id,
        code: "network",
        message: describeError(entry.error),
      });
      continue;
    }
    const link = (entry as { link?: { id: string; workspaceId: string } }).link;
    if (!link) {
      unresolvedConnectorIds.push(entry.id);
      continue;
    }
    destinations.push({ connectorId: link.id, workspaceId: link.workspaceId });
  }
  return { destinations, unresolvedConnectorIds, failed, needLogin };
}

/**
 * Name the environment honestly.
 *
 * `environmentLabel` reads the control URL, which is what connect selects an
 * environment with. Recall never touches the control plane: it posts to the
 * GATEWAY the project config points at. So a project connected to dev, run
 * without `AUGENTA_CONTROL_URL` set, would be reported as `prod` while its
 * question goes somewhere else entirely. Either coordinate being non-default is
 * enough to say so.
 */
export function recallEnvironment(gateway: string): string {
  const label = environmentLabel();
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
  if (!query) {
    return fail("error", "query_required", "ask a question: recall takes the text to look up", query, environment, startedAt);
  }
  if (query.length > MAX_QUERY_CHARS) {
    return fail(
      "error",
      "query_too_long",
      `the question is ${query.length} characters; Augenta accepts ${MAX_QUERY_CHARS}`,
      query,
      environment,
      startedAt,
    );
  }

  const projectRoot = resolveProjectRoot(resolved.projectRoot);
  if (!projectRoot) {
    return fail(
      "not_connected",
      "not_connected",
      "this project is not connected to Augenta; run the connect skill first",
      query,
      environment,
      startedAt,
    );
  }
  const cfg = loadProjectConfig(projectRoot);
  if (!cfg) {
    // resolveProjectRoot only returns a directory whose config file EXISTS, so
    // this branch is a file that is present and unreadable — a different thing to
    // tell the user than "you never connected".
    return fail(
      "not_connected",
      "unreadable_config",
      "this project's Augenta config cannot be read; reconnect with the connect skill",
      query,
      environment,
      startedAt,
    );
  }
  const gateway = gatewayBase(cfg);
  environment = recallEnvironment(gateway);

  const answers: RecallAnswer[] = [];
  const nothingRemembered: NothingRemembered[] = [];
  const failed: RecallFailure[] = [];
  let unresolvedConnectorIds: string[] = [];
  let destinations: Destination[] = [];
  let ctx: { url: string; query: string; timeoutMs: number; profileId?: string; apiKey?: string };

  const timeoutMs = (args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const url = `${gateway}/v1/recall`;

  if (cfg.authMode === "oauth") {
    const profileId = cfg.profileId!;
    if (!getAuthProfile(profileId)) {
      return fail(
        "need_login",
        "need_login",
        "this project's Augenta sign-in is missing; sign in again with the connect skill",
        query,
        environment,
        startedAt,
      );
    }
    const resolution = await resolveDestinations(profileId, gateway, cfg.connectorIds ?? []);
    if (resolution.needLogin) {
      return fail(
        "need_login",
        "need_login",
        "this project's Augenta sign-in has expired; sign in again with the connect skill",
        query,
        environment,
        startedAt,
      );
    }
    destinations = resolution.destinations;
    unresolvedConnectorIds = resolution.unresolvedConnectorIds;
    failed.push(...resolution.failed);
    /* Names are a LABEL, not a routing input — the Workspace id is what gets
       sent. So the list is best effort: a failed or slow listing costs the
       answers their human-readable heading, never the answers themselves. */
    const named = await fetchAllWorkspaces(profileId, gateway).catch(() => [] as Workspace[]);
    for (const destination of destinations) {
      const name = named.find((workspace) => workspace.id === destination.workspaceId)?.name;
      if (name) destination.workspaceName = name;
    }
    if (args.workspaces?.length) {
      const requested = new Set(args.workspaces);
      const unknown = args.workspaces.filter(
        (id) => !destinations.some((destination) => destination.workspaceId === id),
      );
      if (unknown.length > 0) {
        return fail(
          "error",
          "unknown_workspace",
          `this project does not feed ${unknown.join(", ")}; recall can only ask the Workspaces it sends to`,
          query,
          environment,
          startedAt,
        );
      }
      destinations = destinations.filter(
        (destination) => destination.workspaceId && requested.has(destination.workspaceId),
      );
    }
    ctx = { url, query, timeoutMs, profileId };
  } else {
    if (args.workspaces?.length) {
      // A platform key is assigned to exactly one Connector, which is anchored to
      // exactly one Workspace: the key's assignment IS the route, so there is no
      // set here to narrow. Refused rather than ignored — silently dropping the
      // flag would answer a different question than the one that was asked.
      return fail(
        "error",
        "workspace_not_selectable",
        "this project uses a platform key, whose Connector fixes the Workspace; --workspace selects nothing",
        query,
        environment,
        startedAt,
      );
    }
    destinations = [{}];
    ctx = { url, query, timeoutMs, apiKey: cfg.apiKey };
  }

  if (destinations.length === 0 && failed.length === 0) {
    return {
      ...fail(
        "error",
        "no_destination",
        unresolvedConnectorIds.length > 0
          ? `this project lists ${unresolvedConnectorIds.join(", ")}, but ${unresolvedConnectorIds.length === 1 ? "it is" : "they are"} not readable with this sign-in; reconnect`
          : "this project has no destination to ask; reconnect with the connect skill",
        query,
        environment,
        startedAt,
      ),
      ...(unresolvedConnectorIds.length > 0 ? { unresolvedConnectorIds } : {}),
    };
  }

  /* Parallel on purpose. Each answer is a full model turn behind the door, so
     asking three Workspaces in series would cost three deadlines and routinely
     overrun the agent tool call that is waiting on this. */
  const outcomes = await Promise.all(
    destinations.map(async (destination) => ({
      destination,
      outcome: await askDestination(ctx, destination),
    })),
  );
  for (const { destination, outcome } of outcomes) {
    // `kind` is the discriminator this loop branches on and has no meaning in the
    // payload, so it is destructured away rather than published as a second status.
    if (outcome.kind === "answered") {
      const { kind: _answered, ...fields } = outcome;
      answers.push({ ...destination, ...fields });
    } else if (outcome.kind === "nothing_remembered") {
      nothingRemembered.push({ ...destination });
    } else {
      const { kind: _failed, ...fields } = outcome;
      failed.push({ ...destination, ...fields });
    }
  }

  const status = aggregateStatus({ answers, nothingRemembered, failed });
  return {
    status,
    query,
    answers,
    nothingRemembered,
    failed,
    ...(unresolvedConnectorIds.length > 0 ? { unresolvedConnectorIds } : {}),
    environment,
    elapsedMs: Date.now() - startedAt,
  };
}

/** The bare (non-`--json`) rendering. A person reading a terminal wants the
 *  answers, with enough heading to tell which Workspace each came from. */
function printPayload(payload: RecallPayload): void {
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
    const envelope = {
      ...payload,
      projectRoot: resolved.projectRoot,
      ...(resolved.worktreeRedirect ? { worktreeRedirect: resolved.worktreeRedirect } : {}),
    };
    if (args.json) {
      console.log(JSON.stringify(envelope, null, 2));
    } else {
      printPayload(payload);
    }
    // Only a genuine error is a failed exit. `nothing_remembered` is a young
    // Workspace and `not_connected` is a project that never opted in; making
    // either non-zero would turn a normal answer into a broken command.
    if (payload.status === "error") process.exitCode = 1;
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
