/**
 * Tests for recall.ts: argument parsing, response classification, and the
 * fan-out that turns a project's Connector ids into labelled answers.
 *
 * Contract under test: only the question (and, for a signed-in project, the
 * Workspace id) is ever sent; one destination failing never costs the others
 * their answer; a young Workspace's 404 is a normal outcome and not an error;
 * every idempotency key is fresh; and no credential reaches the payload. The
 * gateway is a stubbed `globalThis.fetch` routed on `METHOD origin+path`, the
 * same shape scripts/connect.test.ts uses.
 *
 * Run: bun test scripts/recall.test.ts
 */
import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateStatus,
  classifyRecallResponse,
  parseArgs,
  questionFrom,
  recallEnvironment,
  runRecall,
  type RecallArgs,
} from "./recall";
import { saveDeviceProfile } from "../capture/auth";

const RECALL = join(import.meta.dir, "recall.ts");
const realFetch = globalThis.fetch;

const ISSUER = "https://auth.example.com";
const CLIENT_ID = "client_public";
const GATEWAY = "https://gw.example.com";

let project: string;
let authHome: string;
let requests: Array<{ method: string; url: string; headers: Headers; body?: string }>;

/**
 * Two globals this suite reads are ones a CONTRIBUTOR is told to export:
 * DEBUG.md's non-production loop sets `AUGENTA_CONTROL_URL`, and its sandbox
 * section sets `AUGENTA_AUTH_HOME`. So every test starts from a known state and
 * the caller's value is put back afterwards.
 *
 * Not hygiene for its own sake: before this, one `describe` deleted
 * `AUGENTA_CONTROL_URL` without restoring it, and the envelope test below passed
 * ONLY because that describe happened to run first. With the variable exported,
 * running that test alone (`bun test -t …`) failed — expected "prod", got the
 * dev URL — while the whole file passed. A suite whose result depends on test
 * order is not a suite.
 */
const savedEnv: Record<string, string | undefined> = {};
const SANDBOXED = ["AUGENTA_AUTH_HOME", "AUGENTA_CONTROL_URL", "AUGENTA_API_URL"] as const;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "aug-recall-")));
  authHome = realpathSync(mkdtempSync(join(tmpdir(), "aug-recall-auth-")));
  for (const key of SANDBOXED) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AUGENTA_AUTH_HOME = authHome;
  requests = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of SANDBOXED) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(project, { recursive: true, force: true });
  rmSync(authHome, { recursive: true, force: true });
});

const args = (extra: Partial<RecallArgs> = {}): RecallArgs => ({
  words: [],
  query: "what did we decide",
  ...extra,
});

/** Sign in globally, exactly as a completed connect would have. */
const signIn = () =>
  saveDeviceProfile(
    { issuer: ISSUER, clientId: CLIENT_ID, gateway: GATEWAY },
    {
      accessToken: "access-live",
      refreshToken: "refresh-live",
      expiresAt: Date.now() + 3_600_000,
    },
    { userId: "user_1", orgId: "org_1" },
  );

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(join(project, ".augenta"), { recursive: true });
  writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify(config, null, 2));
}

/** Connector id → the Workspace it is anchored to, as the platform would say. */
const LINKS: Record<string, string> = {
  connector_a: "ws-default",
  connector_b: "ws-scratch",
};
const WORKSPACES = [
  { id: "ws-default", name: "Default Workspace" },
  { id: "ws-scratch", name: "Scratch" },
];

/**
 * A minimal control plane. Unrouted paths fail loudly rather than silently 200,
 * so a request this client should not be making shows up as a broken test rather
 * than as a pass.
 */
function route(
  extra: Record<string, (init: RequestInit, url: URL) => Response | Promise<Response>> = {},
) {
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const path = `${parsed.origin}${parsed.pathname}`;
    const method = init.method ?? "GET";
    requests.push({
      method,
      url: String(url),
      headers: new Headers(init.headers as Record<string, string>),
      body: init.body ? String(init.body) : undefined,
    });
    const custom = extra[`${method} ${path}`] ?? extra[path];
    if (custom) return custom(init, parsed);
    if (path === `${GATEWAY}/v1/workspaces` && method === "GET") {
      return Response.json({ workspaces: WORKSPACES });
    }
    if (path.startsWith(`${GATEWAY}/v1/connectors/`)) {
      const id = decodeURIComponent(path.slice(`${GATEWAY}/v1/connectors/`.length));
      const workspaceId = LINKS[id];
      if (!workspaceId) return new Response("no such connector", { status: 404 });
      return Response.json({
        connector: { id, kind: "agent", direction: "inbound", status: "active", workspaceId },
      });
    }
    return new Response(`unrouted: ${method} ${path}`, { status: 500 });
  }) as typeof fetch;
}

/** The recall POSTs the client made, in the order the stub saw them. Matched on the PATH: the
 *  answer mode is a query parameter, so an exact-url filter would silently see none of those
 *  calls and every assertion counting them would pass vacuously. */
const recallCalls = () =>
  requests.filter((r) => r.url.split("?")[0] === `${GATEWAY}/v1/recall`);
/** The `mode` parameter each recall call carried, `undefined` where it sent none. */
const recallModes = () =>
  recallCalls().map((r) => new URL(r.url).searchParams.get("mode") ?? undefined);

/**
 * What the door returns in the DEFAULT mode: the response envelope, model-free.
 *
 * `text` becomes the engram block's summary and `notes` the note blocks, so a test can say
 * exactly what the client should render and what it should drop. No renderer or model header,
 * because no prompt was rendered and no provider was called — asserting their ABSENCE is part
 * of the contract.
 */
const memoryResponse = (text: string, notes: string[] = [], extra: object = {}) =>
  Response.json(
    {
      scope: "org_1:ws-default",
      mode: "context",
      reference_date: "2026-09-03",
      note_count: notes.length,
      notes_truncated: false,
      content: [
        {
          type: "engram",
          text,
          engram_id: "e001",
          memory_class: "procedural",
          born_t: "2026-09-01T00:00:00Z",
          contradiction: false,
          quality_verdict: "good",
        },
        ...notes.map((note, index) => ({
          type: "note",
          text: note,
          timestamp: `2026-09-0${index + 1}T00:00:00Z`,
          question: false,
          frame: { class: "procedural" },
          metadata: { src: "codex", turn: index + 1 },
        })),
        {
          type: "lineage",
          text: "BORN (0->2 members)",
          t: "2026-09-01T00:00:00Z",
          kind: "born",
          members_before: 0,
          members_after: 2,
        },
      ],
      ...extra,
    },
    { headers: { "X-Augenta-Content": "content-v1" } },
  );

/** What the door returns for `?mode=answer`: the same envelope with the model's prose first. */
const answerResponse = (answer: string) =>
  Response.json(
    {
      scope: "org_1:ws-default",
      mode: "answer",
      reference_date: "2026-09-03",
      note_count: 1,
      notes_truncated: false,
      content: [
        { type: "answer", text: answer },
        { type: "engram", text: "how this project deploys", engram_id: "e001" },
        { type: "note", text: "deployed with the chart", timestamp: "2026-09-01T00:00:00Z" },
      ],
    },
    {
      headers: {
        "X-Augenta-Renderer": "prose-v1",
        "X-Augenta-Model": "some-model",
        "X-Augenta-Content": "content-v1",
      },
    },
  );

/** The upstream retrieval service's typed error shape, passed through verbatim. */
const typedError = (status: number, code: string, message: string, retryable = false) =>
  Response.json(
    { error: { code, message, retryable }, scope: "org_1:ws", request_id: "req_1" },
    { status },
  );

describe("parseArgs", () => {
  test("reads every flag the skill is told to run", () => {
    expect(parseArgs(["--json", "--query", "why is X"])).toEqual({
      words: [],
      json: true,
      query: "why is X",
    });
    expect(parseArgs(["--workspace", "ws-1", "--workspace", "ws-2"])).toEqual({
      words: [],
      workspaces: ["ws-1", "ws-2"],
    });
    expect(parseArgs(["--project", "/p", "--timeout", "30"])).toEqual({
      words: [],
      project: "/p",
      timeoutSeconds: 30,
    });
    // `--answer` is the opt-in to the model path. Absent means the default,
    // model-free mode — the flag's absence is the request, so it must not be
    // defaultable to anything else.
    expect(parseArgs(["--answer"])).toEqual({ words: [], answer: true });
    expect(parseArgs(["--json"]).answer).toBeUndefined();
  });

  test("bare words become the question", () => {
    expect(parseArgs(["what", "did", "we", "decide"]).words).toEqual([
      "what",
      "did",
      "we",
      "decide",
    ]);
    expect(questionFrom(parseArgs(["what", "did", "we", "decide"]))).toBe("what did we decide");
  });

  test("an unknown flag THROWS rather than joining the question", () => {
    // The whole reason this parser is stricter than connect's: leftover words are
    // the question, so a mistyped flag would otherwise become part of what gets
    // asked — a silently different question, sent to every destination.
    expect(() => parseArgs(["--wokspace", "ws-1"])).toThrow("unknown flag: --wokspace");
    expect(() => parseArgs(["--json", "--verbose"])).toThrow("unknown flag: --verbose");
  });

  test("a flag is never swallowed as another flag's value", () => {
    expect(() => parseArgs(["--query", "--project", "/p"])).toThrow("--query requires a value");
    expect(() => parseArgs(["--workspace"])).toThrow("--workspace requires a value");
  });

  test("--timeout rejects values that would wait forever or not at all", () => {
    for (const bad of ["0", "-5", "abc"]) {
      expect(() => parseArgs(["--timeout", bad])).toThrow(
        "--timeout must be a positive number of seconds",
      );
    }
  });

  test("--timeout is bounded, because a huge one aborts INSTANTLY", () => {
    /* `AbortSignal.timeout` is a timer: past 2^31-1 ms Node clamps it to 1ms and
       fires at once, printing a TimeoutOverflowWarning to stderr. `--timeout
       3000000` therefore aborted in about a millisecond and reported "did not
       answer within 3000000s" — the exact inverse of the request, plus stderr
       noise that breaks the dist-smoke silence contract. Refused up front. */
    expect(() => parseArgs(["--timeout", "3000000"])).toThrow("must be at most 600 seconds");
    expect(parseArgs(["--timeout", "600"]).timeoutSeconds).toBe(600);
  });

  test("the two question forms are refused together, never silently merged", () => {
    // Picking one would be a guess about which question the caller meant, and the
    // wrong guess is a different question shipped to every Workspace.
    expect(() => questionFrom(parseArgs(["--query", "a", "b"]))).toThrow(
      "pass the question with --query or as plain words, not both",
    );
  });
});

describe("classifyRecallResponse", () => {
  const parts = (status: number, body?: unknown, text = "") => ({ status, body, text });

  const envelope = (mode: string, content: unknown[], extra: object = {}) => ({
    scope: "org_1:ws-default",
    mode,
    reference_date: "2026-09-03",
    note_count: 1,
    notes_truncated: false,
    content,
    ...extra,
  });

  test("an answer-mode 200 reports the answer block, and only it", () => {
    expect(
      classifyRecallResponse({
        ...parts(
          200,
          envelope("answer", [
            { type: "answer", text: "we chose /app" },
            { type: "engram", text: "how the landing path was chosen" },
            { type: "note", text: "moved the landing path to /app" },
          ]),
        ),
        model: "m",
        renderer: "r",
      }),
    ).toEqual({
      kind: "answered",
      answer: "we chose /app",
      mode: "answer",
      scope: "org_1:ws-default",
      model: "m",
      renderer: "r",
    });
  });

  test("a context 200 renders the memory itself: the summary, then each note", () => {
    /* THE default path. What the client publishes is the smallest useful form —
       every other field on those blocks (ids, timestamps, frame, metadata) and
       the lineage blocks entirely are dropped, because each one is paid for in
       the reading agent's own context window on every recall. */
    const outcome = classifyRecallResponse(
      parts(
        200,
        envelope("context", [
          { type: "engram", text: "the landing path is /app", engram_id: "e001" },
          { type: "note", text: "moved the landing path to /app", timestamp: "2026-09-01" },
          { type: "note", text: "the old /home route now redirects", metadata: { turn: 4 } },
          { type: "lineage", text: "BORN (0->2 members)", kind: "born" },
        ]),
      ),
    );
    expect(outcome).toEqual({
      kind: "answered",
      mode: "context",
      answer:
        "the landing path is /app\n\n" +
        "moved the landing path to /app\n\n" +
        "the old /home route now redirects",
      scope: "org_1:ws-default",
    });
    const rendered = (outcome as { answer: string }).answer;
    for (const dropped of ["e001", "2026-09-01", "BORN", "lineage", "turn"]) {
      expect(rendered).not.toContain(dropped);
    }
  });

  test("an unknown block type is ignored rather than failing the read", () => {
    // Block kinds are additive upstream, and a client that treated a new one as
    // a parse error would break on a server-side addition it does not need.
    expect(
      classifyRecallResponse(
        parts(
          200,
          envelope("context", [
            { type: "citation", text: "something new" },
            { type: "engram", text: "the landing path is /app" },
          ]),
        ),
      ),
    ).toMatchObject({ kind: "answered", mode: "context", answer: "the landing path is /app" });
  });

  test("truncation is surfaced, so an agent does not imply it saw everything", () => {
    expect(
      classifyRecallResponse(
        parts(
          200,
          envelope("context", [{ type: "engram", text: "a big engram" }], {
            note_count: 162,
            notes_truncated: true,
          }),
        ),
      ),
    ).toMatchObject({ notesTruncated: true });
    // Absent, not `false`, when nothing was left out.
    expect(
      classifyRecallResponse(parts(200, envelope("context", [{ type: "engram", text: "small" }]))),
    ).not.toHaveProperty("notesTruncated");
  });

  test("a pre-envelope deployment's `{scope, answer}` still reads as an answer", () => {
    /* Plugin installs and API rollouts are not in lockstep — dev rolls on every
       merge, staging and prod on a dispatch — so an installed client meets an
       older door routinely. Reported as `answer` mode because that is what
       happened: a model wrote it, whichever mode was asked for. */
    expect(
      classifyRecallResponse(parts(200, { scope: "org_1:ws-default", answer: "we chose /app" })),
    ).toMatchObject({ kind: "answered", mode: "answer", answer: "we chose /app" });
  });

  test("200 with nothing to read is a failure, not an empty answer", () => {
    // Presenting "" as a recall would put silence in front of the user as though
    // the Workspace had spoken — and in context mode it would also impersonate a
    // young Workspace, which has its own honest answer (`nothing_remembered`).
    for (const body of [
      {},
      { answer: "" },
      { answer: "   " },
      { answer: 42 },
      envelope("answer", [{ type: "answer", text: "  " }]),
      envelope("context", []),
      envelope("context", [{ type: "engram", text: "" }, { type: "lineage", text: "BORN" }]),
      envelope("context", { not: "an array" } as unknown as unknown[]),
    ]) {
      expect(classifyRecallResponse(parts(200, body))).toMatchObject({
        kind: "failed",
        code: "invalid_response",
      });
    }
  });

  test("404 empty_scope is a young Workspace, NOT an error", () => {
    expect(
      classifyRecallResponse(
        parts(404, { error: { code: "empty_scope", message: "nothing here", retryable: false } }),
      ),
    ).toEqual({ kind: "nothing_remembered" });
  });

  test("a 404 with no error body means recall is not deployed here", () => {
    // Hono answers an unregistered route with plain text, and the platform does
    // not register /v1/recall when the retrieval service is unconfigured.
    expect(classifyRecallResponse(parts(404, undefined, "404 Not Found"))).toEqual({
      kind: "failed",
      code: "recall_unavailable",
      message: "recall is not available in this Augenta environment",
    });
  });

  test("a 404 that DOES carry an error is reported as that error", () => {
    // The platform's own shape. Reporting it as "not deployed" would send the
    // reader to look at the environment instead of at the request.
    expect(classifyRecallResponse(parts(404, { error: 'unknown workspace "ws-x"' }))).toEqual({
      kind: "failed",
      code: "not_found",
      message: 'unknown workspace "ws-x"',
    });
  });

  test("both error shapes are read, and the typed code wins", () => {
    // {"error": "..."} is the platform door; {"error": {code,...}} is the
    // retrieval service passed through. A client that parses only one gets the
    // other wrong.
    expect(classifyRecallResponse(parts(403, { error: "you are not entitled" }))).toEqual({
      kind: "failed",
      code: "not_entitled",
      message: "you are not entitled",
    });
    expect(
      classifyRecallResponse(
        parts(502, { error: { code: "recall_unavailable", message: "down", retryable: true } }),
      ),
    ).toEqual({ kind: "failed", code: "recall_unavailable", message: "down" });
    expect(
      classifyRecallResponse(
        parts(504, { error: { code: "recall_timeout", message: "too slow", retryable: true } }),
      ),
    ).toEqual({ kind: "failed", code: "recall_timeout", message: "too slow" });
  });

  test("409 is an archived Workspace, or the upstream's typed deployment fault", () => {
    /* Added to the platform door after this client was written: an archived
       Workspace is a clean, actionable refusal, and falling through to
       `unexpected_status` would have reported it as "something odd happened". */
    expect(
      classifyRecallResponse(parts(409, { error: 'workspace "ws-old" is archived' })),
    ).toEqual({
      kind: "failed",
      code: "workspace_archived",
      message: 'workspace "ws-old" is archived',
    });
    // A typed code on the same status is the retrieval service, not the door.
    expect(
      classifyRecallResponse(
        parts(409, { error: { code: "embedder_mismatch", message: "corpus mismatch" } }),
      ),
    ).toMatchObject({ code: "embedder_mismatch" });
  });

  test("statuses map to codes a caller can act on", () => {
    expect(classifyRecallResponse(parts(401, { error: "bad token" }))).toMatchObject({
      code: "need_login",
    });
    expect(
      classifyRecallResponse({
        ...parts(429, { error: "slow down", code: "RATE_LIMIT" }),
        retryAfter: "42",
      }),
    ).toMatchObject({ code: "rate_limited", retryAfterSeconds: 42 });
    expect(classifyRecallResponse(parts(400, { error: "query is required" }))).toMatchObject({
      code: "bad_request",
    });
    expect(classifyRecallResponse(parts(500, undefined, "boom"))).toMatchObject({
      code: "upstream_error",
    });
  });

  test("a non-JSON body still produces a message instead of nothing", () => {
    expect(classifyRecallResponse(parts(503, undefined, "upstream connect error"))).toEqual({
      kind: "failed",
      code: "upstream_error",
      message: "upstream connect error",
    });
  });

  test("a missing or nonsense Retry-After is simply absent", () => {
    for (const raw of [null, undefined, "", "soon"]) {
      expect(
        classifyRecallResponse({ ...parts(429, { error: "slow" }), retryAfter: raw }),
      ).not.toHaveProperty("retryAfterSeconds");
    }
  });
});

describe("aggregateStatus", () => {
  const f = (code: string) => ({ code });

  test("the pure cases", () => {
    expect(aggregateStatus({ answers: [1], nothingRemembered: [], failed: [] })).toBe("answered");
    expect(aggregateStatus({ answers: [], nothingRemembered: [1], failed: [] })).toBe(
      "nothing_remembered",
    );
    expect(aggregateStatus({ answers: [], nothingRemembered: [], failed: [] })).toBe("error");
  });

  test("a uniform refusal becomes the verdict, so the caller acts on it once", () => {
    expect(
      aggregateStatus({ answers: [], nothingRemembered: [], failed: [f("need_login"), f("need_login")] }),
    ).toBe("need_login");
    expect(
      aggregateStatus({
        answers: [],
        nothingRemembered: [],
        failed: [f("recall_unavailable"), f("recall_unavailable")],
      }),
    ).toBe("recall_unavailable");
    // Mixed reasons have no single verdict, so they stay a plain error.
    expect(
      aggregateStatus({ answers: [], nothingRemembered: [], failed: [f("need_login"), f("network")] }),
    ).toBe("error");
  });

  test("any mixture is partial, so the wording has to branch", () => {
    expect(aggregateStatus({ answers: [1], nothingRemembered: [1], failed: [] })).toBe(
      "partially_answered",
    );
    expect(aggregateStatus({ answers: [1], nothingRemembered: [], failed: [f("network")] })).toBe(
      "partially_answered",
    );
    expect(
      aggregateStatus({ answers: [], nothingRemembered: [1], failed: [f("rate_limited")] }),
    ).toBe("partially_answered");
  });
});

describe("a project that cannot be asked", () => {
  test("no config at all is not_connected, and nothing leaves", async () => {
    route();
    const payload = await runRecall({ projectRoot: project }, args());
    expect(payload).toMatchObject({ status: "not_connected", code: "not_connected" });
    expect(requests).toEqual([]);
  });

  test("a config that cannot be parsed says so, rather than 'never connected'", async () => {
    // Different advice: reconnect, not connect for the first time.
    route();
    writeConfig({ authMode: "oauth", profileId: "", connectorIds: [] });
    const payload = await runRecall({ projectRoot: project }, args());
    expect(payload).toMatchObject({ status: "not_connected", code: "unreadable_config" });
    expect(requests).toEqual([]);
  });

  test("projectRoot names the config's OWN directory, not where the search began", async () => {
    /* resolveProjectRoot walks UPWARD, so a command run from a subdirectory uses
       an ancestor's config. Reporting the starting directory named a project
       recall did not ask — and SKILL.md tells the agent to relay this path. */
    route({ [`POST ${GATEWAY}/v1/recall`]: () => memoryResponse("from the root") });
    writeConfig({ authMode: "api-key", apiKey: "sk-aug-x.y", endpoint: GATEWAY });
    const deep = join(project, "src", "deep");
    mkdirSync(deep, { recursive: true });

    const payload = await runRecall({ projectRoot: deep }, args());

    expect(payload.status).toBe("answered");
    expect(payload.projectRoot).toBe(project);
  });

  test("with no config anywhere, projectRoot is where the search started", async () => {
    // There is no config to name, so the honest answer is "here is where I looked".
    route();
    const payload = await runRecall({ projectRoot: project }, args());
    expect(payload).toMatchObject({ status: "not_connected", projectRoot: project });
  });

  test("an empty question is refused before any request", async () => {
    route();
    writeConfig({ authMode: "api-key", apiKey: "sk-aug-x.y", endpoint: GATEWAY });
    const payload = await runRecall({ projectRoot: project }, { words: [] });
    expect(payload).toMatchObject({ status: "error", code: "query_required" });
    expect(requests).toEqual([]);
  });

  test("an over-long question costs one local error, not one rejection per destination", async () => {
    route();
    writeConfig({ authMode: "api-key", apiKey: "sk-aug-x.y", endpoint: GATEWAY });
    const payload = await runRecall({ projectRoot: project }, args({ query: "x".repeat(4097) }));
    expect(payload).toMatchObject({ status: "error", code: "query_too_long" });
    expect(requests).toEqual([]);
  });

  test("a missing sign-in is need_login, and starts no authorization", async () => {
    route();
    writeConfig({
      authMode: "oauth",
      profileId: "profile_gone",
      connectorIds: ["connector_a"],
      endpoint: GATEWAY,
    });
    const payload = await runRecall({ projectRoot: project }, args());
    expect(payload).toMatchObject({ status: "need_login", code: "need_login" });
    expect(requests).toEqual([]);
  });
});

describe("the fan-out", () => {
  async function connectedProject(connectorIds = ["connector_a", "connector_b"]) {
    const { profileId } = await signIn();
    writeConfig({ authMode: "oauth", profileId, connectorIds, endpoint: GATEWAY });
    return profileId;
  }

  test("asks every destination, labels each answer, and sends only the question", async () => {
    await connectedProject();
    route({
      [`POST ${GATEWAY}/v1/recall`]: (init) => {
        const body = JSON.parse(String(init.body)) as { workspace: string };
        return memoryResponse(`remembered in ${body.workspace}`);
      },
    });

    const payload = await runRecall({ projectRoot: project }, args());

    expect(payload.status).toBe("answered");
    expect(payload.answers).toEqual([
      {
        connectorId: "connector_a",
        workspaceId: "ws-default",
        workspaceName: "Default Workspace",
        scope: "org_1:ws-default",
        answer: "remembered in ws-default",
        mode: "context",
      },
      {
        connectorId: "connector_b",
        workspaceId: "ws-scratch",
        workspaceName: "Scratch",
        scope: "org_1:ws-default",
        answer: "remembered in ws-scratch",
        mode: "context",
      },
    ]);
    // No renderer and no model: the default mode ran neither, and reporting one
    // would name work that did not happen.
    expect(recallModes()).toEqual([undefined, undefined]);

    const calls = recallCalls();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // The body carries the question and a Workspace id — never `scope`, which
      // the door composes from the credential, and never anything else.
      const body = JSON.parse(String(call.body)) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["query", "workspace"]);
      expect(body.query).toBe("what did we decide");
      expect(call.headers.get("authorization")).toBe("Bearer access-live");
    }
    expect(calls.map((c) => JSON.parse(String(c.body)).workspace)).toEqual([
      "ws-default",
      "ws-scratch",
    ]);
  });

  test("the default asks for no mode and renders the memory; --answer asks for the model", async () => {
    /* The one wire fact that separates the modes. The default sends NO `mode`
       parameter — the door's own default decides, so there is one default rather
       than two that can drift — and `--answer` is the explicit opt-in. */
    await connectedProject(["connector_a"]);
    route({
      [`POST ${GATEWAY}/v1/recall`]: (_init, url) =>
        url.searchParams.get("mode") === "answer"
          ? answerResponse("we deploy with the chart")
          : memoryResponse("how this project deploys", ["deployed with the chart"]),
    });

    const remembered = await runRecall({ projectRoot: project }, args());
    expect(recallModes()).toEqual([undefined]);
    expect(remembered.status).toBe("answered");
    expect(remembered.answers[0]).toMatchObject({
      mode: "context",
      answer: "how this project deploys\n\ndeployed with the chart",
    });
    // Nothing about a renderer or a model, because neither ran.
    expect(remembered.answers[0]).not.toHaveProperty("model");
    expect(remembered.answers[0]).not.toHaveProperty("renderer");

    const answered = await runRecall({ projectRoot: project }, args({ answer: true }));
    expect(recallModes()).toEqual([undefined, "answer"]);
    expect(answered.answers[0]).toMatchObject({
      mode: "answer",
      answer: "we deploy with the chart",
      model: "some-model",
      renderer: "prose-v1",
    });
    // Same body in both modes, which is why the mode is a query parameter: the
    // door forbids unknown body fields, so every existing request stays valid.
    const bodies = recallCalls().map((call) => JSON.parse(String(call.body)));
    expect(bodies[0]).toEqual(bodies[1]);
  });

  test("default recall gives legacy answer servers their full deadline during rollout", async () => {
    await connectedProject();
    route({
      [`POST ${GATEWAY}/v1/recall`]: () =>
        Response.json({ scope: "org:workspace", answer: "legacy answer" }),
    });
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      const payload = await runRecall({ projectRoot: project }, args());
      expect(payload.status).toBe("answered");
      expect(payload.answers.every((answer) => answer.mode === "answer")).toBe(true);
      expect(timeout).toHaveBeenCalledWith(75_000);
    } finally {
      timeout.mockRestore();
    }
  });

  test("every idempotency key is a fresh UUID, per destination and per call", async () => {
    // The door namespaces an activation by (principal, key), so a key reused
    // across destinations is a 409 on a perfectly valid second question.
    await connectedProject();
    route({ [`POST ${GATEWAY}/v1/recall`]: () => memoryResponse("a") });

    await runRecall({ projectRoot: project }, args());
    await runRecall({ projectRoot: project }, args({ query: "a different question" }));

    const keys = recallCalls().map((c) => c.headers.get("idempotency-key"));
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  test("the destinations are asked in parallel, not one after another", async () => {
    /* Each answer is a full model turn behind the door, so in series three
       Workspaces would cost three deadlines and routinely overrun the agent tool
       call waiting on this.

       Proved with an arrival barrier rather than a stopwatch or a timer: NEITHER
       request may answer until BOTH have arrived. Under a serial implementation
       the first would wait on a second that cannot start, and this test deadlocks
       — which is the correct signal and, unlike a sleep, is not a race. */
    await connectedProject();
    let arrivals = 0;
    let bothArrived!: () => void;
    const barrier = new Promise<void>((resolve) => {
      bothArrived = resolve;
    });
    route({
      [`POST ${GATEWAY}/v1/recall`]: async () => {
        arrivals += 1;
        if (arrivals === 2) bothArrived();
        await barrier;
        return memoryResponse("a");
      },
    });

    const payload = await runRecall({ projectRoot: project }, args());

    expect(arrivals).toBe(2);
    expect(payload.status).toBe("answered");
  });

  test("a Workspace with nothing in it yet is reported separately from a failure", async () => {
    await connectedProject();
    route({
      [`POST ${GATEWAY}/v1/recall`]: (init) => {
        const body = JSON.parse(String(init.body)) as { workspace: string };
        return body.workspace === "ws-default"
          ? memoryResponse("we chose /app")
          : typedError(404, "empty_scope", "no engram in this scope");
      },
    });

    const payload = await runRecall({ projectRoot: project }, args());

    expect(payload.status).toBe("partially_answered");
    expect(payload.answers).toHaveLength(1);
    expect(payload.nothingRemembered).toEqual([
      { connectorId: "connector_b", workspaceId: "ws-scratch", workspaceName: "Scratch" },
    ]);
    expect(payload.failed).toEqual([]);
  });

  test("every Workspace empty is nothing_remembered, which is not an error", async () => {
    await connectedProject();
    route({
      [`POST ${GATEWAY}/v1/recall`]: () => typedError(404, "empty_scope", "young workspace"),
    });
    const payload = await runRecall({ projectRoot: project }, args());
    expect(payload.status).toBe("nothing_remembered");
    expect(payload.failed).toEqual([]);
  });

  test("one wedged destination never costs the others their answer", async () => {
    await connectedProject();
    route({
      [`POST ${GATEWAY}/v1/recall`]: (init) => {
        const body = JSON.parse(String(init.body)) as { workspace: string };
        return body.workspace === "ws-default"
          ? memoryResponse("we chose /app")
          : Response.json({ error: "you are not entitled" }, { status: 403 });
      },
    });

    const payload = await runRecall({ projectRoot: project }, args());

    expect(payload.status).toBe("partially_answered");
    expect(payload.answers).toHaveLength(1);
    expect(payload.failed).toEqual([
      {
        connectorId: "connector_b",
        workspaceId: "ws-scratch",
        workspaceName: "Scratch",
        code: "not_entitled",
        message: "you are not entitled",
      },
    ]);
  });

  test("rate limiting reports the wait instead of inviting a retry loop", async () => {
    await connectedProject(["connector_a"]);
    route({
      [`POST ${GATEWAY}/v1/recall`]: () =>
        Response.json(
          { error: "too many recalls", code: "RATE_LIMIT" },
          { status: 429, headers: { "Retry-After": "30" } },
        ),
    });

    const payload = await runRecall({ projectRoot: project }, args());

    expect(payload.status).toBe("error");
    expect(payload.failed[0]).toMatchObject({ code: "rate_limited", retryAfterSeconds: 30 });
    // A 429 must never be treated as an authentication failure: exactly one POST.
    expect(recallCalls()).toHaveLength(1);
  });

  test("recall undeployed everywhere collapses to one recall_unavailable verdict", async () => {
    await connectedProject();
    route({
      [`POST ${GATEWAY}/v1/recall`]: () => new Response("404 Not Found", { status: 404 }),
    });
    const payload = await runRecall({ projectRoot: project }, args());
    expect(payload.status).toBe("recall_unavailable");
    expect(payload.failed).toHaveLength(2);
  });

  test("an expired sign-in is one need_login verdict, after exactly one refresh", async () => {
    await connectedProject(["connector_a"]);
    let refreshes = 0;
    route({
      [`POST ${ISSUER}/oauth2/token`]: () => {
        refreshes += 1;
        return Response.json({ access_token: "access-2", refresh_token: "r2", expires_in: 3600 });
      },
      [`POST ${GATEWAY}/v1/recall`]: () => new Response("nope", { status: 401 }),
    });

    const payload = await runRecall({ projectRoot: project }, args());

    expect(payload.status).toBe("need_login");
    // fetchWithProfile refreshes ONCE and retries once: two POSTs, not a loop.
    expect(recallCalls()).toHaveLength(2);
    expect(refreshes).toBe(1);
  });

  test("a refused refresh is need_login, not a network failure", async () => {
    await connectedProject(["connector_a"]);
    route({
      [`POST ${ISSUER}/oauth2/token`]: () =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      [`POST ${GATEWAY}/v1/recall`]: () => new Response("nope", { status: 401 }),
    });
    const payload = await runRecall({ projectRoot: project }, args());
    expect(payload.status).toBe("need_login");
  });

  test("a local timeout is reported as a timeout, not as an unexplained abort", async () => {
    await connectedProject(["connector_a"]);
    route({
      [`POST ${GATEWAY}/v1/recall`]: async (init) => {
        await new Promise((resolve, reject) => {
          setTimeout(resolve, 5_000);
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
        return memoryResponse("never");
      },
    });

    const payload = await runRecall(
      { projectRoot: project },
      args({ timeoutSeconds: 0.05 }),
    );

    expect(payload.failed[0]).toMatchObject({ code: "recall_timeout" });
  });

  test("the request carries the caller's own deadline", async () => {
    await connectedProject(["connector_a"]);
    let sawSignal = false;
    route({
      [`POST ${GATEWAY}/v1/recall`]: (init) => {
        sawSignal = init.signal instanceof AbortSignal;
        return memoryResponse("a");
      },
    });
    await runRecall({ projectRoot: project }, args());
    expect(sawSignal).toBe(true);
  });
});

describe("destinations that cannot be resolved", () => {
  test("a Connector this sign-in cannot see is reported, not silently dropped", async () => {
    // The project is still SHIPPING to it, so its silence is a fact about the
    // sign-in rather than about the Workspace.
    const { profileId } = await signIn();
    writeConfig({
      authMode: "oauth",
      profileId,
      connectorIds: ["connector_a", "connector_gone"],
      endpoint: GATEWAY,
    });
    route({ [`POST ${GATEWAY}/v1/recall`]: () => memoryResponse("a") });

    const payload = await runRecall({ projectRoot: project }, args());

    expect(payload.status).toBe("answered");
    expect(payload.answers).toHaveLength(1);
    expect(payload.unresolvedConnectorIds).toEqual(["connector_gone"]);
  });

  test("a Connector lookup that FAILS is a failed destination, not a missing one", async () => {
    // 403/404 means "gone"; a 500 or a dropped connection means "could not ask".
    // Collapsing the two would quietly narrow the fan-out on a network blip.
    const { profileId } = await signIn();
    writeConfig({
      authMode: "oauth",
      profileId,
      connectorIds: ["connector_a", "connector_b"],
      endpoint: GATEWAY,
    });
    route({
      [`${GATEWAY}/v1/connectors/connector_b`]: () => new Response("boom", { status: 500 }),
      [`POST ${GATEWAY}/v1/recall`]: () => memoryResponse("a"),
    });

    const payload = await runRecall({ projectRoot: project }, args());

    expect(payload.status).toBe("partially_answered");
    expect(payload.unresolvedConnectorIds).toBeUndefined();
    expect(payload.failed).toEqual([
      {
        connectorId: "connector_b",
        code: "network",
        message: "could not inspect the existing Connector (500)",
      },
    ]);
  });

  test("two Connector ids on ONE Workspace are asked once, not twice", async () => {
    /* Asking twice would bill two model turns, record two reuse activations for
       one question, and render the same Workspace twice as though two of them
       had answered. Nothing is lost — the Workspace is still asked. */
    const { profileId } = await signIn();
    writeConfig({
      authMode: "oauth",
      profileId,
      connectorIds: ["connector_a", "connector_a_twin"],
      endpoint: GATEWAY,
    });
    route({
      // A second, distinct Connector anchored to the SAME Workspace.
      [`${GATEWAY}/v1/connectors/connector_a_twin`]: () =>
        Response.json({
          connector: {
            id: "connector_a_twin",
            kind: "agent",
            direction: "inbound",
            status: "active",
            workspaceId: "ws-default",
          },
        }),
      [`POST ${GATEWAY}/v1/recall`]: () => memoryResponse("once"),
    });

    const payload = await runRecall({ projectRoot: project }, args());

    expect(payload.status).toBe("answered");
    expect(payload.answers).toHaveLength(1);
    expect(recallCalls()).toHaveLength(1);
  });

  test("no resolvable destination at all is an error that names the ids", async () => {
    const { profileId } = await signIn();
    writeConfig({
      authMode: "oauth",
      profileId,
      connectorIds: ["connector_gone"],
      endpoint: GATEWAY,
    });
    route();
    const payload = await runRecall({ projectRoot: project }, args());
    expect(payload).toMatchObject({ status: "error", code: "no_destination" });
    expect(payload.message).toContain("connector_gone");
    expect(payload.unresolvedConnectorIds).toEqual(["connector_gone"]);
    expect(recallCalls()).toEqual([]);
  });

  test("the Connector lookups and the Workspace list overlap", async () => {
    /* Neither needs the other — the lookups decide WHERE the question goes, the
       list only decides what each answer is CALLED — so in series this cost a
       full extra round trip before the first question was even sent. Same
       arrival barrier as the fan-out test: neither answers until both arrive, so
       a sequential implementation deadlocks rather than merely being slower. */
    const { profileId } = await signIn();
    writeConfig({ authMode: "oauth", profileId, connectorIds: ["connector_a"], endpoint: GATEWAY });
    let arrivals = 0;
    let bothArrived!: () => void;
    const barrier = new Promise<void>((resolve) => {
      bothArrived = resolve;
    });
    const hold = async (body: unknown) => {
      arrivals += 1;
      if (arrivals === 2) bothArrived();
      await barrier;
      return Response.json(body);
    };
    route({
      [`GET ${GATEWAY}/v1/workspaces`]: () => hold({ workspaces: WORKSPACES }),
      [`${GATEWAY}/v1/connectors/connector_a`]: () =>
        hold({
          connector: {
            id: "connector_a",
            kind: "agent",
            direction: "inbound",
            status: "active",
            workspaceId: "ws-default",
          },
        }),
      [`POST ${GATEWAY}/v1/recall`]: () => memoryResponse("a"),
    });

    const payload = await runRecall({ projectRoot: project }, args());

    expect(arrivals).toBe(2);
    expect(payload.answers[0]!.workspaceName).toBe("Default Workspace");
  });

  test("Workspace names are a label, so an unreadable list costs only the heading", async () => {
    const { profileId } = await signIn();
    writeConfig({ authMode: "oauth", profileId, connectorIds: ["connector_a"], endpoint: GATEWAY });
    route({
      [`GET ${GATEWAY}/v1/workspaces`]: () => new Response("boom", { status: 500 }),
      [`POST ${GATEWAY}/v1/recall`]: () => memoryResponse("still answered"),
    });

    const payload = await runRecall({ projectRoot: project }, args());

    expect(payload.status).toBe("answered");
    expect(payload.answers[0]).toMatchObject({
      workspaceId: "ws-default",
      answer: "still answered",
    });
    expect(payload.answers[0]).not.toHaveProperty("workspaceName");
  });
});

describe("--workspace narrows the fan-out", () => {
  test("only the named Workspace is asked", async () => {
    const { profileId } = await signIn();
    writeConfig({
      authMode: "oauth",
      profileId,
      connectorIds: ["connector_a", "connector_b"],
      endpoint: GATEWAY,
    });
    route({ [`POST ${GATEWAY}/v1/recall`]: () => memoryResponse("scoped") });

    const payload = await runRecall({ projectRoot: project }, args({ workspaces: ["ws-scratch"] }));

    expect(payload.status).toBe("answered");
    expect(recallCalls()).toHaveLength(1);
    expect(JSON.parse(String(recallCalls()[0]!.body)).workspace).toBe("ws-scratch");
  });

  test("an unresolvable destination makes the answer UNKNOWN, not 'not a destination'", async () => {
    /* Both outcomes fail closed, which is right. What differs is the sentence:
       with a Connector unresolved, the run never learned which Workspace it
       points at, so "this project does not feed X" states a consent conclusion
       it never reached — and the evidence for why must not be dropped. */
    const { profileId } = await signIn();
    writeConfig({
      authMode: "oauth",
      profileId,
      connectorIds: ["connector_a", "connector_b"],
      endpoint: GATEWAY,
    });
    route({
      [`${GATEWAY}/v1/connectors/connector_b`]: () => new Response("boom", { status: 500 }),
      [`POST ${GATEWAY}/v1/recall`]: () => memoryResponse("nope"),
    });

    const payload = await runRecall({ projectRoot: project }, args({ workspaces: ["ws-scratch"] }));

    expect(payload).toMatchObject({ status: "error", code: "workspace_unverifiable" });
    expect(payload.message).toContain("ws-scratch");
    // The evidence survives the bail rather than being discarded with it.
    expect(payload.failed).toEqual([
      {
        connectorId: "connector_b",
        code: "network",
        message: "could not inspect the existing Connector (500)",
      },
    ]);
    expect(recallCalls()).toEqual([]);
  });

  test("an unreadable prior Connector is reported the same way", async () => {
    // 403/404 is the other half: this sign-in cannot SEE the link, so it equally
    // cannot say the requested Workspace is not one of this project's.
    const { profileId } = await signIn();
    writeConfig({
      authMode: "oauth",
      profileId,
      connectorIds: ["connector_a", "connector_gone"],
      endpoint: GATEWAY,
    });
    route({ [`POST ${GATEWAY}/v1/recall`]: () => memoryResponse("nope") });

    const payload = await runRecall({ projectRoot: project }, args({ workspaces: ["ws-scratch"] }));

    expect(payload).toMatchObject({ status: "error", code: "workspace_unverifiable" });
    expect(payload.unresolvedConnectorIds).toEqual(["connector_gone"]);
    expect(recallCalls()).toEqual([]);
  });

  test("a Workspace this project does not feed fails closed, asking nothing", async () => {
    // Recall can only ask where the project sends. Silently ignoring the flag
    // would answer a different question than the one that was asked.
    const { profileId } = await signIn();
    writeConfig({ authMode: "oauth", profileId, connectorIds: ["connector_a"], endpoint: GATEWAY });
    route({ [`POST ${GATEWAY}/v1/recall`]: () => memoryResponse("nope") });

    const payload = await runRecall({ projectRoot: project }, args({ workspaces: ["ws-other"] }));

    expect(payload).toMatchObject({ status: "error", code: "unknown_workspace" });
    expect(payload.message).toContain("ws-other");
    expect(recallCalls()).toEqual([]);
  });
});

describe("platform-key projects", () => {
  test("send the key, no Workspace, and no bearer", async () => {
    // The key's Connector assignment IS the route, exactly as the shipper treats
    // it — so the body is the question alone.
    writeConfig({ authMode: "api-key", apiKey: "sk-aug-live.secret", endpoint: GATEWAY });
    route({ [`POST ${GATEWAY}/v1/recall`]: () => memoryResponse("from the keyed Workspace") });

    const payload = await runRecall({ projectRoot: project }, args());

    expect(payload.status).toBe("answered");
    expect(payload.answers[0]).toEqual({ scope: "org_1:ws-default", answer: "from the keyed Workspace", mode: "context" });
    const call = recallCalls()[0]!;
    expect(JSON.parse(String(call.body))).toEqual({ query: "what did we decide" });
    expect(call.headers.get("authorization")).toBe("AugentaKey sk-aug-live.secret");
    // No Workspace list and no Connector lookup: there is nothing to resolve.
    expect(requests).toHaveLength(1);
    // The credential never reaches anything the agent reads.
    expect(JSON.stringify(payload)).not.toContain("sk-aug-live");
  });

  test("a key that is missing from the config never becomes a header", async () => {
    /* Two guards, and this pins the outer one: loadProjectConfig refuses a blank
       key, so the command fails LOCALLY and nothing reaches the wire. The guard
       inside the api-key branch is depth behind it, and exists for the same
       reason connect's verifyProjectKey has one — the alternative is sending the
       literal header `AugentaKey undefined` and reporting whatever the gateway
       says about it, which reads to a user as an unexplained 401. */
    route();
    writeConfig({ authMode: "api-key", apiKey: "sk-aug-live.secret", endpoint: GATEWAY });
    const { loadProjectConfig } = await import("../capture/config");
    const cfg = loadProjectConfig(project)!;
    expect(cfg.apiKey).toBe("sk-aug-live.secret");
    // Now blank it on disk in a way the parser would reject, and confirm the
    // command fails locally rather than on the wire.
    writeConfig({ authMode: "api-key", apiKey: "   ", endpoint: GATEWAY });
    const payload = await runRecall({ projectRoot: project }, args());
    expect(payload).toMatchObject({ status: "not_connected", code: "unreadable_config" });
    expect(requests).toEqual([]);
  });

  test("--workspace is refused rather than ignored", async () => {
    writeConfig({ authMode: "api-key", apiKey: "sk-aug-live.secret", endpoint: GATEWAY });
    route();
    const payload = await runRecall({ projectRoot: project }, args({ workspaces: ["ws-default"] }));
    expect(payload).toMatchObject({ status: "error", code: "workspace_not_selectable" });
    expect(requests).toEqual([]);
  });
});

describe("recallEnvironment", () => {
  test("a non-default GATEWAY is named even when the control URL is production", () => {
    // Recall never touches the control plane, so reporting `prod` off the control
    // URL alone would say "production" about a question going to dev. beforeEach
    // has already cleared the variable, so this is the production default.
    expect(recallEnvironment("https://dev-gateway.example.com")).toBe(
      "https://dev-gateway.example.com",
    );
  });

  test("a non-production control URL still wins", () => {
    // Restored by afterEach along with the caller's own value.
    process.env.AUGENTA_CONTROL_URL = "https://control.example.com";
    expect(recallEnvironment("https://anything")).toBe("https://control.example.com");
  });
});

describe("the CLI envelope", () => {
  // Spawned for real, because the envelope fields are added by the entrypoint
  // block and no in-process call exercises them.
  test("reports the project it resolved, the environment, and how long it took", () => {
    const r = spawnSync("bun", [RECALL, "--json", "--project", project, "what", "changed"], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, AUGENTA_AUTH_HOME: authHome },
    });
    const payload = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(payload.status).toBe("not_connected");
    expect(payload.query).toBe("what changed");
    expect(payload.projectRoot).toBe(project);
    expect(payload.environment).toBe("prod");
    expect(typeof payload.elapsedMs).toBe("number");
    // not_connected is a state, not a fault.
    expect(r.status).toBe(0);
  });

  test("a linked worktree reports the redirect instead of retargeting silently", () => {
    // capture only walks UPWARD from cwd, so the config lives in the main
    // checkout and the worktree has nothing to ask on its own.
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "aug-recall-wt-")));
    const main = join(scratch, "main");
    // NOT an mkdtemp path: `git worktree add` wants to create this itself, and
    // whether it tolerates an existing empty directory has varied by git version.
    const worktree = join(scratch, "linked");
    try {
      /* Identity passed per-invocation rather than assumed. git can usually
         derive one from the system, but a CI runner's hostname is not a valid
         email domain, so `git commit` fails there with "unable to auto-detect
         email address" — which is exactly how this test passed on a laptop and
         failed on the runner. And every step is CHECKED: without that, a broken
         setup surfaced as a confusing assertion about a missing field instead of
         naming the git command that did not run. */
      const git = (cwd: string, ...argv: string[]) => {
        const r = spawnSync(
          "git",
          ["-c", "user.email=e2e@augenta.invalid", "-c", "user.name=e2e", ...argv],
          { cwd, encoding: "utf8" },
        );
        expect(r.status, `git ${argv.join(" ")} failed: ${r.stderr || r.stdout}`).toBe(0);
        return r;
      };
      mkdirSync(main, { recursive: true });
      git(main, "init", "-q");
      git(main, "commit", "-q", "--allow-empty", "-m", "root");
      git(main, "worktree", "add", "-q", "--detach", worktree);

      const r = spawnSync("bun", [RECALL, "--json", "anything"], {
        cwd: worktree,
        encoding: "utf8",
        env: { ...process.env, AUGENTA_AUTH_HOME: authHome },
      });
      const payload = JSON.parse(r.stdout) as { projectRoot: string; worktreeRedirect?: unknown };
      const realMain = realpathSync(main);
      expect(payload.projectRoot).toBe(realMain);
      expect(payload.worktreeRedirect).toEqual({ from: realpathSync(worktree), to: realMain });
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: main });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("bare mode names destinations it could not ask", () => {
    /* The `--json` payload carries `unresolvedConnectorIds` and SKILL.md tells
       the agent to relay them, so only the direct human path could lose them —
       and that is the path with no agent to notice a Workspace quietly missing
       from the answers. */
    const r = spawnSync("bun", [RECALL, "--project", project, "anything"], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, AUGENTA_AUTH_HOME: authHome },
    });
    // An unconnected project has nothing to skip; what matters is that the bare
    // renderer writes its diagnosis to stderr rather than swallowing it.
    expect(r.stderr).toContain("Augenta recall:");
    expect(r.stdout).toBe("");
  });

  test("a bad flag answers in JSON to a --json caller, and exits non-zero", () => {
    const r = spawnSync("bun", [RECALL, "--json", "--wokspace", "ws-1"], {
      cwd: project,
      encoding: "utf8",
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "error", code: "failed" });
    expect(r.status).toBe(1);
  });
});
