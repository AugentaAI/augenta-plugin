/**
 * Tests for connect.ts helpers and the platform-key CLI path.
 *
 * Contract under test: the advanced `--api-key` config lands at
 * `<project>/.augenta/config.json` with mode 0600 inside the self-gitignored
 * dir; project resolution is --project > git toplevel > cwd; no network is
 * involved (nothing here serves HTTP). The CLI surface is driven as a real
 * subprocess; the pure helpers directly.
 *
 * Run: bun test scripts/connect.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitLogin,
  createWorkspaceForSelection,
  connectToWorkspaces,
  connectWithApiKey,
  parseArgs,
  probeConnection,
  resolveProject,
  resolveTargetProject,
  runJsonVerb,
  selectedWorkspaces,
  startLogin,
  writeApiKeyConfig,
  writeOAuthConfig,
  type WorkspacePrompts,
} from "./connect";
import { Outbox } from "../capture/outbox";
import {
  profileIdFor,
  readPendingLogin,
  saveDeviceProfile,
  savePendingLogin,
} from "../capture/auth";

const CONNECT = join(import.meta.dir, "connect.ts");
const realFetch = globalThis.fetch;

let project: string;
beforeEach(() => (project = realpathSync(mkdtempSync(join(tmpdir(), "aug-connect-")))));
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(project, { recursive: true, force: true });
});

describe("parseArgs", () => {
  test("reads key, project, gateway, and control URL without legacy aliases", () => {
    expect(parseArgs(["--api-key", "k1"])).toEqual({ apiKey: "k1" });
    expect(parseArgs(["--apiKey", "k2"])).toEqual({});
    expect(
      parseArgs([
        "--api-key",
        "k",
        "--project",
        "/p",
        "--endpoint",
        "http://x",
        "--control-url",
        "https://dev.example.com",
      ]),
    ).toEqual({
      apiKey: "k",
      project: "/p",
      endpoint: "http://x",
      controlUrl: "https://dev.example.com",
    });
  });

  test("a flag is never swallowed as another flag's value", () => {
    // This used to store "--project" as the API key and go on to write a config
    // with it — a typo that only surfaced later as an unexplained 401.
    expect(() => parseArgs(["--api-key", "--project", "/p"])).toThrow(
      "--api-key requires a value",
    );
    expect(() => parseArgs(["--endpoint"])).toThrow("--endpoint requires a value");
    expect(() => parseArgs(["--harness", "emacs"])).toThrow(
      "--harness must be claude-code or codex",
    );
  });

  test("accepts every JSON verb the connect skill is told to run", () => {
    // Paired with contract.test.ts, which asserts the skill NAMES these. One test
    // catches the skill drifting from the CLI, the other the CLI drifting from the
    // skill — either alone leaves a flow that reads correct and fails at runtime.
    expect(parseArgs(["--json", "--probe"])).toEqual({ json: true, probe: true });
    expect(parseArgs(["--json", "--login"])).toEqual({ json: true, login: true });
    expect(parseArgs(["--json", "--await-login"])).toEqual({
      json: true,
      awaitLogin: true,
    });
    expect(parseArgs(["--json", "--workspace", "ws-default"])).toEqual({
      json: true,
      workspaces: ["ws-default"],
    });
    expect(parseArgs(["--json", "--create-workspace", "Research"])).toEqual({
      json: true,
      createWorkspace: "Research",
    });
    expect(parseArgs(["--json", "--await-login", "--wait", "240"])).toEqual({
      json: true,
      awaitLogin: true,
      waitSeconds: 240,
    });
    expect(parseArgs(["--profile", "profile_1"])).toEqual({ profile: "profile_1" });
  });

  test("--wait rejects values that would poll forever or not at all", () => {
    for (const bad of ["0", "-5", "abc"]) {
      expect(() => parseArgs(["--wait", bad])).toThrow(
        "--wait must be a positive number of seconds",
      );
    }
  });
});

describe("resolveTargetProject", () => {
  test("--project wins", () => {
    expect(resolveTargetProject({ project: "/explicit" }, project)).toBe("/explicit");
  });

  test("falls back to the git toplevel of cwd", () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    const sub = join(project, "src");
    mkdirSync(sub);
    expect(realpathSync(resolveTargetProject({}, sub))).toBe(project);
  });

  test("falls back to cwd outside a git repo", () => {
    expect(resolveTargetProject({}, project)).toBe(project);
  });
});

/**
 * Worktrees. `--show-toplevel` returns the LINKED WORKTREE's root, while capture
 * only ever walks UPWARD from cwd looking for `.augenta/config.json`. Connecting
 * from an out-of-tree worktree (`~/.codex/worktrees/<id>/<name>`) therefore wrote
 * a config the real repo could never see: the user completed the whole flow and
 * every hook kept silently no-opping.
 */
describe("resolveProject in a linked worktree", () => {
  let worktree: string;

  const initRepoWithWorktree = () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: project },
    );
    // Deliberately OUTSIDE the repo, mirroring how the harnesses lay worktrees out.
    worktree = join(mkdtempSync(join(tmpdir(), "aug-wt-")), "checkout");
    execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "wt"], {
      cwd: project,
    });
  };

  beforeEach(initRepoWithWorktree);
  afterEach(() => rmSync(worktree, { recursive: true, force: true }));

  test("redirects to the main checkout and reports the redirect", () => {
    const resolved = resolveProject({}, worktree);

    expect(realpathSync(resolved.projectRoot)).toBe(project);
    expect(resolved.worktreeRedirect).toBeDefined();
    expect(realpathSync(resolved.worktreeRedirect!.from)).toBe(
      realpathSync(worktree),
    );
    expect(realpathSync(resolved.worktreeRedirect!.to)).toBe(project);
  });

  test("redirects from a subdirectory of the worktree too", () => {
    const deep = join(worktree, "src", "deep");
    mkdirSync(deep, { recursive: true });
    expect(realpathSync(resolveProject({}, deep).projectRoot)).toBe(project);
  });

  test("a plain repo is never redirected", () => {
    const sub = join(project, "src");
    mkdirSync(sub, { recursive: true });
    const resolved = resolveProject({}, sub);

    expect(realpathSync(resolved.projectRoot)).toBe(project);
    expect(resolved.worktreeRedirect).toBeUndefined();
  });

  test("--project still wins, so connecting a worktree stays possible", () => {
    const resolved = resolveProject({ project: worktree }, worktree);

    expect(resolved.projectRoot).toBe(worktree);
    expect(resolved.worktreeRedirect).toBeUndefined();
  });
});

describe("project config writers", () => {
  test("writes platform-key config 0600 inside the self-gitignored dir", () => {
    const path = writeApiKeyConfig(project, "key_test.secret", "http://gw.example.com");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      authMode: "api-key",
      apiKey: "key_test.secret",
      endpoint: "http://gw.example.com",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(project, ".augenta", ".gitignore"), "utf8")).toBe("*\n");
  });

  test("omits endpoint when not given", () => {
    const path = writeApiKeyConfig(project, "key_test.secret");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      authMode: "api-key",
      apiKey: "key_test.secret",
    });
  });

  test("oauth config contains only the profile, Connectors, and endpoint override", () => {
    const path = writeOAuthConfig(
      project,
      "profile_123",
      ["connector_456", "connector_789"],
      "https://dev.example.com",
    );
    // Only the plural spelling is emitted: writing both would let an older
    // installed plugin read the scalar and go quietly single-destination.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      authMode: "oauth",
      profileId: "profile_123",
      connectorIds: ["connector_456", "connector_789"],
      endpoint: "https://dev.example.com",
    });
  });

  test("refuses to write an OAuth config without a destination", () => {
    expect(() => writeOAuthConfig(project, "profile_123", [])).toThrow(
      "requires at least one Connector",
    );
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
  });
});

describe("CLI subprocess", () => {
  test("non-interactive OAuth flow exits with actionable guidance", () => {
    const r = spawnSync("bun", [CONNECT], {
      cwd: project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("interactive terminal");
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
  });

});

describe("platform-key connection", () => {
  test("verifies the assigned inbound Connector before writing config", async () => {
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("https://gw.example.com/v1/connectors");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "AugentaKey key_live.secret",
      );
      return Response.json({
        connectors: [
          {
            id: "connector_123",
            kind: "agent",
            direction: "inbound",
            status: "active",
            workspaceId: "ws-default",
          },
        ],
      });
    }) as typeof fetch;

    const result = await connectWithApiKey(
      project,
      "key_live.secret",
      "https://gw.example.com/",
    );

    expect(result.connector.id).toBe("connector_123");
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual({
      authMode: "api-key",
      apiKey: "key_live.secret",
      endpoint: "https://gw.example.com",
    });
  });

  test("does not enable capture for a disabled or outbound assignment", async () => {
    globalThis.fetch = (async (_url, _init) =>
      Response.json({
        connectors: [
          {
            id: "connector_out",
            kind: "service",
            direction: "outbound",
            status: "active",
            workspaceId: "ws-default",
          },
        ],
      })) as typeof fetch;

    await expect(
      connectWithApiKey(project, "key_live.secret", "https://gw.example.com"),
    ).rejects.toThrow("active inbound Connector");
    expect(() =>
      statSync(join(project, ".augenta", "config.json")),
    ).toThrow();
  });
});

/**
 * Agent-driven JSON mode. The contract: one object per verb, no prompting, and
 * never a credential in the payload — the connect skill pastes these straight
 * into a chat transcript. `--probe` additionally must start no authorization, so
 * consent can be asked for before anything leaves the machine.
 */
describe("JSON verbs", () => {
  const CONTROL = "https://control.example.com";
  const ISSUER = "https://auth.example.com";
  const GATEWAY = "https://gw.example.com";
  const baseArgs = { json: true, controlUrl: CONTROL };

  let authHome: string;
  let requests: string[];
  let liveWorkspaces: Array<{ id: string; name: string }>;
  /** Links the fake control plane knows about, keyed by id. */
  let links: Map<string, Record<string, unknown>>;

  /** Register a pre-existing Connector, as a prior connection would have. */
  const seedLink = (id: string, workspaceId: string) =>
    links.set(id, {
      id,
      kind: "agent",
      direction: "inbound",
      status: "active",
      workspaceId,
    });

  beforeEach(() => {
    authHome = mkdtempSync(join(tmpdir(), "aug-json-auth-"));
    process.env.AUGENTA_AUTH_HOME = authHome;
    requests = [];
    links = new Map();
    liveWorkspaces = WORKSPACES.map((workspace) => ({ ...workspace }));
  });
  afterEach(() => {
    delete process.env.AUGENTA_AUTH_HOME;
    rmSync(authHome, { recursive: true, force: true });
  });

  const WORKSPACES = [
    { id: "ws-default", name: "Default Workspace" },
    { id: "ws-scratch", name: "Scratch" },
  ];

  /** Minimal control plane. Unrouted paths fail loudly rather than silently 200. */
  function route(extra: Record<string, () => Response> = {}) {
    globalThis.fetch = (async (url, init) => {
      const path = String(url);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      requests.push(`${method} ${path}`);
      const custom = extra[`${method} ${path}`] ?? extra[path];
      if (custom) return custom();
      if (path === `${CONTROL}/.well-known/augenta.json`) {
        return Response.json({
          issuer: ISSUER,
          clientId: "client_public",
          gateway: GATEWAY,
        });
      }
      if (path === `${GATEWAY}/v1/me`) {
        return Response.json({
          user: { id: "user_1", name: "Rin", email: "rin@example.com" },
          org: { id: "org_1", name: "Example Org" },
        });
      }
      if (path === `${GATEWAY}/v1/workspaces` && method === "POST") {
        const body = JSON.parse(String((init as RequestInit).body)) as {
          name: string;
        };
        expect(new Headers((init as RequestInit).headers).get("content-type")).toBe(
          "application/json",
        );
        const workspace = { id: `ws-${body.name.toLowerCase()}`, name: body.name };
        liveWorkspaces.push(workspace);
        return Response.json({
          workspace: {
            ...workspace,
            orgId: "org_1",
            createdByUserId: "user_1",
          },
        });
      }
      if (path === `${GATEWAY}/v1/workspaces` && method === "GET") {
        return Response.json({ workspaces: liveWorkspaces });
      }
      // Creates a link in whichever Workspace the body asks for, so a fan-out
      // cannot pass by accident against a mock that always answers "ws-default".
      if (path === `${GATEWAY}/v1/connectors` && method === "POST") {
        const body = JSON.parse(String((init as RequestInit).body)) as {
          workspaceId: string;
        };
        const id =
          body.workspaceId === "ws-default"
            ? "connector_new"
            : `connector_${body.workspaceId}`;
        seedLink(id, body.workspaceId);
        return Response.json({ connector: links.get(id) });
      }
      if (path.startsWith(`${GATEWAY}/v1/connectors/`)) {
        const id = decodeURIComponent(path.slice(`${GATEWAY}/v1/connectors/`.length));
        const existing = links.get(id);
        if (!existing) return new Response("no such connector", { status: 404 });
        // A PATCH must never move a link between Workspaces.
        if (method === "PATCH") {
          const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
          expect(body).not.toHaveProperty("workspaceId");
        }
        return Response.json({ connector: existing });
      }
      return new Response(`unrouted: ${method} ${path}`, { status: 500 });
    }) as typeof fetch;
  }

  const signIn = () =>
    saveDeviceProfile(
      { issuer: ISSUER, clientId: "client_public", gateway: GATEWAY },
      {
        accessToken: "access-live",
        refreshToken: "refresh-live",
        expiresAt: Date.now() + 3_600_000,
      },
      { userId: "user_1", orgId: "org_1" },
    );

  test("probe reports need_login and starts no authorization", async () => {
    route();

    const payload = await probeConnection({ projectRoot: project }, baseArgs);

    expect(payload).toMatchObject({ status: "need_login", alreadyConnected: false });
    // The whole point of a separate probe: nothing may leave the machine before
    // the user has been told what connecting does and agreed to it.
    expect(requests.some((r) => r.includes("device_authorization"))).toBe(false);
  });

  test("probe lists Workspaces for an existing sign-in", async () => {
    await signIn();
    route();

    const payload = await probeConnection({ projectRoot: project }, baseArgs);

    expect(payload.status).toBe("need_workspace");
    expect(payload.workspaces).toEqual(WORKSPACES);
    expect(payload.signedInAs).toEqual({
      name: "Rin",
      email: "rin@example.com",
      organization: "Example Org",
    });
    expect(JSON.stringify(payload)).not.toContain("access-live");
  });

  test("always lists Default Workspace first, keyed on its NAME", async () => {
    // Deliberately opaque ids: the provisioned NAME is what README and SKILL.md
    // promise a user, and it is the only part of a Workspace this plugin has a
    // contract over. Sorting on a guessed id literal would pass a fixture that
    // seeds that literal and do nothing at all in the field.
    const remote = [
      { id: "ws_01HZY", name: "Scratch" },
      { id: "ws_01ABC", name: "Default Workspace" },
    ];
    await signIn();
    route({
      [`GET ${GATEWAY}/v1/workspaces`]: () => Response.json({ workspaces: remote }),
    });

    const payload = await probeConnection({ projectRoot: project }, baseArgs);

    expect(payload.workspaces).toEqual([remote[1], remote[0]]);
  });

  test("an organization without a Default Workspace still lists every choice", async () => {
    await signIn();
    const remote = [
      { id: "ws_01HZY", name: "Scratch" },
      { id: "ws_01ABC", name: "Research" },
    ];
    route({
      [`GET ${GATEWAY}/v1/workspaces`]: () => Response.json({ workspaces: remote }),
    });

    const payload = await probeConnection({ projectRoot: project }, baseArgs);

    expect(payload.workspaces).toEqual(remote);
  });

  test("the create verb refreshes choices and does not connect", async () => {
    await signIn();
    route();

    const payload = await runJsonVerb(
      { projectRoot: project },
      { ...baseArgs, createWorkspace: "Research" },
    );

    expect(payload).toMatchObject({
      status: "need_workspace",
      createdWorkspace: { id: "ws-research", name: "Research" },
      workspaces: [...WORKSPACES, { id: "ws-research", name: "Research" }],
    });
    expect(requests).toContain(`POST ${GATEWAY}/v1/workspaces`);
    expect(requests.some((request) => request.includes("/v1/connectors"))).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("createdByUserId");
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
  });

  test("refuses to create and connect in one call", async () => {
    // Two mutations with the consent question BETWEEN them. Honouring whichever
    // one this dispatch reaches first would either connect a set chosen before
    // the new Workspace existed, or drop the connect request on the floor.
    await signIn();
    route();

    const payload = await runJsonVerb(
      { projectRoot: project },
      { ...baseArgs, createWorkspace: "Research", workspaces: ["ws-default"] },
    );

    expect(payload).toMatchObject({ status: "error", code: "conflicting_verbs" });
    expect(requests).toEqual([]);
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
  });

  test("reports that creation succeeded when refreshing the list fails", async () => {
    await signIn();
    route({
      [`GET ${GATEWAY}/v1/workspaces`]: () =>
        new Response("temporarily unavailable", { status: 503 }),
    });

    const payload = await createWorkspaceForSelection(
      { projectRoot: project },
      { ...baseArgs, createWorkspace: "Research" },
    );

    expect(payload).toMatchObject({
      status: "workspace_created",
      createdWorkspace: { id: "ws-research", name: "Research" },
    });
    expect(String(payload.message)).toContain("do not create it again");
    expect(requests).toContain(`POST ${GATEWAY}/v1/workspaces`);
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
  });

  /**
   * The terminal menu loop, driven through its injected prompts. Everything above
   * exercises the `--json` verbs an agent calls; a human running `connect` in a
   * terminal takes this path instead, and its rules — create is chosen alone, the
   * refreshed set is asked again, a created Workspace is NOT pre-marked — live
   * only here.
   */
  describe("the interactive Workspace menu", () => {
    /** Answers indices into each rendered menu, recording what the user saw. */
    function scriptedPrompts(
      answers: number[][],
      name = "Research",
    ): {
      prompts: WorkspacePrompts;
      menus: Array<Array<{ label: string; marked: boolean }>>;
      names: number;
    } {
      const menus: Array<Array<{ label: string; marked: boolean }>> = [];
      const state = { names: 0 };
      const prompts: WorkspacePrompts = {
        chooseMany: async (_prompt, values, label, opts = {}) => {
          menus.push(
            values.map((value) => ({
              label: label(value),
              marked: opts.preselected?.(value) ?? false,
            })),
          );
          const answer = answers[menus.length - 1];
          if (!answer) throw new Error(`no scripted answer for menu ${menus.length}`);
          return answer.map((index) => values[index]!);
        },
        askWorkspaceName: async () => {
          state.names++;
          return name;
        },
      };
      return {
        prompts,
        menus,
        get names() {
          return state.names;
        },
      };
    }

    const profileId = () =>
      profileIdFor({ issuer: ISSUER, clientId: "client_public", gateway: GATEWAY }, "org_1");

    test("re-asks when create is picked alongside a Workspace, and creates nothing", async () => {
      await signIn();
      route();
      const scripted = scriptedPrompts([[0, 2], [1]]);

      const chosen = await selectedWorkspaces(
        profileId(),
        GATEWAY,
        "Example Org",
        [],
        WORKSPACES,
        scripted.prompts,
      );

      expect(chosen).toEqual([WORKSPACES[1]!]);
      expect(scripted.menus).toHaveLength(2);
      expect(scripted.names).toBe(0);
      expect(requests.some((request) => request.includes("/v1/workspaces"))).toBe(false);
    });

    test("a created Workspace is offered UNMARKED and must be selected", async () => {
      // `[x]` means "this project already feeds it". Creating a Workspace
      // connects nothing, so pre-marking it would put a destination the user has
      // never affirmed into the answer they are about to give.
      await signIn();
      route();
      const scripted = scriptedPrompts([[2], [2]]);

      const chosen = await selectedWorkspaces(
        profileId(),
        GATEWAY,
        "Example Org",
        [],
        WORKSPACES,
        scripted.prompts,
      );

      expect(scripted.names).toBe(1);
      expect(requests).toContain(`POST ${GATEWAY}/v1/workspaces`);
      expect(scripted.menus[1]).toEqual([
        { label: "Default Workspace (ws-default)", marked: false },
        { label: "Scratch (ws-scratch)", marked: false },
        { label: "Research (ws-research)", marked: false },
        { label: "Create a new Workspace", marked: false },
      ]);
      expect(chosen).toEqual([{ id: "ws-research", name: "Research" }]);
    });

    test("current destinations stay marked across a creation", async () => {
      await signIn();
      route();
      const scripted = scriptedPrompts([[2], [0, 2]]);

      const chosen = await selectedWorkspaces(
        profileId(),
        GATEWAY,
        "Example Org",
        ["ws-default"],
        WORKSPACES,
        scripted.prompts,
      );

      expect(scripted.menus[0]![0]).toEqual({
        label: "Default Workspace (ws-default)",
        marked: true,
      });
      expect(scripted.menus[1]!.map((entry) => entry.marked)).toEqual([
        true,
        false,
        false,
        false,
      ]);
      expect(chosen).toEqual([WORKSPACES[0]!, { id: "ws-research", name: "Research" }]);
    });
  });

  test("refuses an empty Workspace name without making a request", async () => {
    const payload = await createWorkspaceForSelection(
      { projectRoot: project },
      { ...baseArgs, createWorkspace: "   " },
    );

    expect(payload).toMatchObject({
      status: "error",
      code: "workspace_name_required",
    });
    expect(requests).toEqual([]);
  });

  test("an already-connected project still reaches the Workspace choice", async () => {
    // Reconnecting is how a user verifies or changes the destinations, so a prior
    // config is reported as fields and must never short-circuit the flow.
    await signIn();
    writeOAuthConfig(project, "profile_stale", ["connector_old"]);
    route();
    seedLink("connector_old", "ws-scratch");

    const payload = await probeConnection({ projectRoot: project }, baseArgs);

    expect(payload).toMatchObject({
      status: "need_workspace",
      alreadyConnected: true,
      // Resolved to a NAME, which is what the caller pre-selects with.
      destinations: [
        {
          connectorId: "connector_old",
          workspaceId: "ws-scratch",
          workspaceName: "Scratch",
        },
      ],
      unresolvedConnectorIds: [],
    });
  });

  test("a prior link the user can no longer see is REPORTED, never dropped", async () => {
    // The project is still shipping to it. Omitting it would quietly lose a live
    // destination from the pre-selection and, since the answer is the complete
    // set, from the config on the next reconnect.
    await signIn();
    writeOAuthConfig(project, "profile_stale", ["connector_gone"]);
    route(); // nothing seeded — the GET 404s

    const payload = await probeConnection({ projectRoot: project }, baseArgs);

    expect(payload).toMatchObject({
      status: "need_workspace",
      alreadyConnected: true,
      destinations: [],
      unresolvedConnectorIds: ["connector_gone"],
    });
  });

  test("an unparseable config does not block reconnecting", async () => {
    await signIn();
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), "{ not json");
    route();

    await expect(
      probeConnection({ projectRoot: project }, baseArgs),
    ).resolves.toMatchObject({ status: "need_workspace", alreadyConnected: false });
  });

  test("login returns the clickable link and withholds the device code", async () => {
    route({
      [`POST ${ISSUER}/oauth2/device_authorization`]: () =>
        Response.json({
          device_code: "device_secret",
          user_code: "WDJB-MJHT",
          verification_uri_complete: `${ISSUER}/device?user_code=WDJB-MJHT`,
          verification_uri: `${ISSUER}/device`,
          interval: 5,
          expires_in: 600,
        }),
    });

    const payload = await startLogin(baseArgs);

    expect(payload).toMatchObject({
      status: "login_started",
      verificationUri: `${ISSUER}/device?user_code=WDJB-MJHT`,
      userCode: "WDJB-MJHT",
    });
    expect(payload.expiresInSeconds).toBeGreaterThan(0);
    // The device code redeems the grant. It belongs in the 0600 pending file and
    // nowhere near a payload the agent will paste into chat.
    expect(JSON.stringify(payload)).not.toContain("device_secret");
    expect(readPendingLogin()?.deviceCode).toBe("device_secret");
  });

  test("login is idempotent while a grant is live — same link, no second mint", async () => {
    // Issue #8: an agent that re-ran --login instead of waiting minted a fresh
    // grant each time and overwrote the last, invalidating the very link the
    // user was mid-way through opening. Unattended that is an unbounded loop of
    // dead links. Re-calling must hand back the LIVE one.
    let minted = 0;
    route({
      [`POST ${ISSUER}/oauth2/device_authorization`]: () => {
        minted += 1;
        return Response.json({
          device_code: `device_secret_${minted}`,
          user_code: `CODE-${minted}`,
          verification_uri_complete: `${ISSUER}/device?user_code=CODE-${minted}`,
          verification_uri: `${ISSUER}/device`,
          interval: 5,
          expires_in: 600,
        });
      },
    });

    const first = await startLogin(baseArgs);
    const second = await startLogin(baseArgs);

    expect(minted).toBe(1);
    expect(second.verificationUri).toBe(first.verificationUri);
    expect(second.userCode).toBe(first.userCode);
    // The stored grant is still the one the user is holding, not a replacement.
    expect(readPendingLogin()?.deviceCode).toBe("device_secret_1");
    // Still a real countdown rather than a frozen echo of the first call.
    expect(second.expiresInSeconds).toBeGreaterThan(0);
  });

  test("login mints fresh once the live grant has expired", async () => {
    // The other side of the guard: `readPendingLogin` treats an expired grant as
    // absent, so a dead link must never wedge a later connect onto itself.
    savePendingLogin({
      deviceCode: "stale_secret",
      userCode: "STALE-CODE",
      verificationUri: `${ISSUER}/device?user_code=STALE-CODE`,
      issuer: ISSUER,
      clientId: "client_test",
      gateway: GATEWAY,
      intervalMs: 5000,
      expiresAt: Date.now() - 1000,
    });
    route({
      [`POST ${ISSUER}/oauth2/device_authorization`]: () =>
        Response.json({
          device_code: "device_secret_fresh",
          user_code: "FRESH-CODE",
          verification_uri_complete: `${ISSUER}/device?user_code=FRESH-CODE`,
          verification_uri: `${ISSUER}/device`,
          interval: 5,
          expires_in: 600,
        }),
    });

    const payload = await startLogin(baseArgs);

    expect(payload.userCode).toBe("FRESH-CODE");
    expect(readPendingLogin()?.deviceCode).toBe("device_secret_fresh");
  });

  test("await-login reports pending while the link is still good", async () => {
    savePendingLogin({
      deviceCode: "device_secret",
      userCode: "WDJB-MJHT",
      verificationUri: `${ISSUER}/device`,
      issuer: ISSUER,
      clientId: "client_public",
      gateway: GATEWAY,
      intervalMs: 1,
      expiresAt: Date.now() + 600_000,
    });
    route({
      [`POST ${ISSUER}/oauth2/token`]: () =>
        Response.json({ error: "authorization_pending" }, { status: 400 }),
    });

    const payload = await awaitLogin({ ...baseArgs, waitSeconds: 0.03 });

    expect(payload.status).toBe("login_pending");
    // Still redeemable, so the caller can ask again instead of restarting.
    expect(readPendingLogin()).toBeDefined();
  });

  test("await-login saves the profile and hands back the Workspace choice", async () => {
    savePendingLogin({
      deviceCode: "device_secret",
      userCode: "WDJB-MJHT",
      verificationUri: `${ISSUER}/device`,
      issuer: ISSUER,
      clientId: "client_public",
      gateway: GATEWAY,
      intervalMs: 1,
      expiresAt: Date.now() + 600_000,
    });
    route({
      [`POST ${ISSUER}/oauth2/token`]: () =>
        Response.json({
          access_token: "access-fresh",
          refresh_token: "refresh-fresh",
          expires_in: 3600,
        }),
    });

    const payload = await awaitLogin({ ...baseArgs, waitSeconds: 5 });

    // Login and listing in one call: the user picks a target immediately after
    // clicking, with no extra round trip.
    expect(payload.status).toBe("need_workspace");
    expect(payload.workspaces).toEqual(WORKSPACES);
    expect(readPendingLogin()).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("refresh-fresh");
  });

  test("a declined sign-in clears the pending state and says which failure it was", async () => {
    savePendingLogin({
      deviceCode: "device_secret",
      userCode: "WDJB-MJHT",
      verificationUri: `${ISSUER}/device`,
      issuer: ISSUER,
      clientId: "client_public",
      gateway: GATEWAY,
      intervalMs: 1,
      expiresAt: Date.now() + 600_000,
    });
    route({
      [`POST ${ISSUER}/oauth2/token`]: () =>
        Response.json({ error: "access_denied" }, { status: 400 }),
    });

    const payload = await awaitLogin({ ...baseArgs, waitSeconds: 5 });

    expect(payload).toMatchObject({ status: "error", code: "login_denied" });
    expect(readPendingLogin()).toBeUndefined();
  });

  test("a pending sign-in from another environment is refused, not redeemed", async () => {
    savePendingLogin({
      deviceCode: "device_secret",
      userCode: "WDJB-MJHT",
      verificationUri: "https://auth.other.example.com/device",
      issuer: "https://auth.other.example.com",
      clientId: "client_public",
      gateway: GATEWAY,
      intervalMs: 1,
      expiresAt: Date.now() + 600_000,
    });
    route();

    const payload = await awaitLogin(baseArgs);

    expect(payload).toMatchObject({ status: "error", code: "no_pending_login" });
    expect(readPendingLogin()).toBeUndefined();
    expect(requests.some((r) => r.includes("/oauth2/token"))).toBe(false);
  });

  test("connecting binds the chosen Workspace and writes the project config", async () => {
    await signIn();
    route();

    const payload = await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-default"],
    });

    expect(payload).toMatchObject({
      status: "connected",
      destinations: [
        {
          connectorId: "connector_new",
          workspaceId: "ws-default",
          workspaceName: "Default Workspace",
          action: "created",
        },
      ],
    });
    // No top-level scalar alias: it would invite the caller to report only the
    // first destination, which is the under-disclosure this release must prevent.
    expect(payload).not.toHaveProperty("connectorId");
    expect(payload).not.toHaveProperty("workspaceName");
    expect(JSON.parse(readFileSync(join(project, ".augenta", "config.json"), "utf8")))
      .toEqual({
        authMode: "oauth",
        profileId: profileIdFor(
          { issuer: ISSUER, clientId: "client_public", gateway: GATEWAY },
          "org_1",
        ),
        connectorIds: ["connector_new"],
        endpoint: GATEWAY,
      });
  });

  test("connecting SEVERAL Workspaces creates one Connector each", async () => {
    await signIn();
    route();

    const payload = await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-scratch", "ws-default"],
    });

    expect(payload).toMatchObject({ status: "connected" });
    // Live-list order, not flag order, so the config is byte-deterministic.
    expect((payload.destinations as Array<{ workspaceId: string }>).map((d) => d.workspaceId))
      .toEqual(["ws-default", "ws-scratch"]);
    expect(
      JSON.parse(readFileSync(join(project, ".augenta", "config.json"), "utf8")).connectorIds,
    ).toEqual(["connector_new", "connector_ws-scratch"]);
  });

  test("refuses to connect without at least one Workspace", async () => {
    await signIn();
    route();

    const payload = await connectToWorkspaces(
      { projectRoot: project },
      { ...baseArgs, workspaces: [] },
    );

    expect(payload).toMatchObject({
      status: "error",
      code: "workspace_required",
    });
    expect(requests.some((request) => request.includes("/v1/connectors"))).toBe(false);
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
  });

  test("a kept destination's link is ADOPTED, never stolen for a new one", async () => {
    // The pre-fan-out code retargeted the single link by PATCHing a new
    // workspaceId onto it. Under fan-out that would steal the link belonging to a
    // destination the user KEPT and relabel history already attached to it.
    await signIn();
    writeOAuthConfig(project, "profile_stale", ["connector_new"]);
    route();
    seedLink("connector_new", "ws-default"); // prior connection to ws-default

    const payload = await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-default", "ws-scratch"], // keep ws-default, add ws-scratch
    });

    expect(payload).toMatchObject({
      status: "connected",
      destinations: [
        { workspaceId: "ws-default", connectorId: "connector_new", action: "adopted" },
        { workspaceId: "ws-scratch", connectorId: "connector_ws-scratch", action: "created" },
      ],
    });
    // Exactly one POST — for the ADDED destination only. (The route's PATCH
    // handler separately asserts no workspaceId is ever sent.)
    expect(requests.filter((r) => r === `POST ${GATEWAY}/v1/connectors`).length).toBe(1);
    expect(requests.some((r) => r === `PATCH ${GATEWAY}/v1/connectors/connector_new`)).toBe(true);
  });

  test("a DESELECTED destination is dropped from config but never destroyed", async () => {
    // Dropping the id stops shipping immediately and locally. Disabling or
    // deleting the link would be an org-level mutation nobody was asked about, and
    // a network call that can half-fail after the user was told "done".
    await signIn();
    writeOAuthConfig(project, "profile_stale", ["connector_new", "connector_ws-scratch"]);
    route();
    seedLink("connector_new", "ws-default");
    seedLink("connector_ws-scratch", "ws-scratch");

    const payload = await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-default"], // ws-scratch deselected
    });

    expect(payload).toMatchObject({
      status: "connected",
      removed: [
        {
          connectorId: "connector_ws-scratch",
          workspaceId: "ws-scratch",
          workspaceName: "Scratch",
          disposition: "left_in_place",
        },
      ],
    });
    expect(
      JSON.parse(readFileSync(join(project, ".augenta", "config.json"), "utf8")).connectorIds,
    ).toEqual(["connector_new"]);
    // Nothing destructive, and no attempt to disable the dropped link.
    expect(requests.some((r) => r.startsWith("DELETE "))).toBe(false);
    expect(requests.some((r) => r === `PATCH ${GATEWAY}/v1/connectors/connector_ws-scratch`)).toBe(false);
  });

  test("one bad id fails the WHOLE set closed — nothing created, no config", async () => {
    // If a single id does not match the live list, the answer does not match what
    // the user saw rendered, so none of it is trustworthy.
    await signIn();
    route();

    const payload = await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-default", "ws-typo", "ws-scratch"],
    });

    expect(payload).toMatchObject({
      status: "error",
      code: "unknown_workspace",
      unknown: ["ws-typo"],
    });
    expect(requests.some((r) => r === `POST ${GATEWAY}/v1/connectors`)).toBe(false);
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
  });

  test("a partial failure writes only the destinations that verified", async () => {
    // The invariant: the written set is always a SUBSET of the set the user just
    // confirmed. Shipping to fewer places than authorized never violates consent.
    await signIn();
    route({
      [`POST ${GATEWAY}/v1/connectors`]: () => {
        // First call (ws-default) succeeds, second (ws-scratch) fails.
        if (!links.has("connector_new")) {
          seedLink("connector_new", "ws-default");
          return Response.json({ connector: links.get("connector_new") });
        }
        return new Response("workspace unavailable", { status: 503 });
      },
    });

    const payload = await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-default", "ws-scratch"],
    });

    expect(payload).toMatchObject({
      status: "partially_connected",
      destinations: [{ workspaceId: "ws-default", connectorId: "connector_new" }],
      failed: [{ workspaceId: "ws-scratch", workspaceName: "Scratch" }],
    });
    const written = JSON.parse(
      readFileSync(join(project, ".augenta", "config.json"), "utf8"),
    ).connectorIds as string[];
    expect(written).toEqual(["connector_new"]);
    expect(written.every((id) => id !== "connector_ws-scratch")).toBe(true);
  });

  test("when NO destination links, nothing is written at all", async () => {
    await signIn();
    route({
      [`POST ${GATEWAY}/v1/connectors`]: () =>
        new Response("workspace unavailable", { status: 503 }),
    });

    const payload = await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-default", "ws-scratch"],
    });

    expect(payload).toMatchObject({ status: "error", code: "no_destination_linked" });
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
  });

  test("a kept destination that fails is flagged as one the project WAS feeding", async () => {
    // "Could not link X" reads as "X was not added". When X was already a
    // destination, the state actually changed: it is no longer being fed.
    await signIn();
    writeOAuthConfig(project, "profile_stale", ["connector_new", "connector_ws-scratch"]);
    route({
      // The link RESOLVES (so it is a known prior destination) but updating it
      // fails — which is what separates "kept but failed" from "unresolvable".
      [`PATCH ${GATEWAY}/v1/connectors/connector_ws-scratch`]: () =>
        new Response("gone sideways", { status: 503 }),
    });
    seedLink("connector_new", "ws-default");
    seedLink("connector_ws-scratch", "ws-scratch");

    const payload = await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-default", "ws-scratch"], // both KEPT
    });

    expect(payload).toMatchObject({
      status: "partially_connected",
      failed: [{ workspaceId: "ws-scratch", wasConnected: true }],
    });
    // It is a failure, not a deselection — never reported as "no longer sending".
    expect(payload).not.toHaveProperty("removed");
  });

  test("a prior link that no longer resolves is reported, not silently dropped", async () => {
    await signIn();
    writeOAuthConfig(project, "profile_stale", ["connector_new", "connector_ghost"]);
    route();
    seedLink("connector_new", "ws-default"); // connector_ghost 404s

    const payload = await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-default"],
    });

    expect(payload).toMatchObject({
      status: "connected",
      unresolvedConnectorIds: ["connector_ghost"],
    });
    expect(
      JSON.parse(readFileSync(join(project, ".augenta", "config.json"), "utf8")).connectorIds,
    ).toEqual(["connector_new"]);
  });

  test("an unreadable prior link does not abort the whole reconnect", async () => {
    // currentConnector throws on anything but 403/404; priorLinks must absorb that
    // — an unreadable prior link is exactly when reconnecting has to keep working.
    await signIn();
    writeOAuthConfig(project, "profile_stale", ["connector_boom"]);
    route({
      [`GET ${GATEWAY}/v1/connectors/connector_boom`]: () =>
        new Response("upstream on fire", { status: 500 }),
    });

    const payload = await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-default"],
    });

    expect(payload).toMatchObject({
      status: "connected",
      unresolvedConnectorIds: ["connector_boom"],
    });
  });

  test("connect stamps the outbox so a newly added destination gets no backlog", async () => {
    // The distinction between "adopted" and "created" only exists here; by the time
    // the shipper runs, a pre-fan-out cursor cannot tell which key earned its
    // watermark. See Outbox.registerDestinations.
    await signIn();
    writeOAuthConfig(project, "profile_stale", ["connector_new"]);
    route();
    seedLink("connector_new", "ws-default");

    const box = new Outbox(project);
    box.append([
      { src: "claude-code", sid: "s1", proj: project, ts: "2026-06-15T00:00:00.000Z", seq: 0, kind: "msg", role: "user", text: "before ws-scratch existed" },
    ]);
    box.advance(1); // a legacy scalar watermark, mid-spool

    await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-default", "ws-scratch"],
    });

    const cursor = JSON.parse(readFileSync(box.cursorPath, "utf8")) as {
      links?: Record<string, number>;
    };
    expect(cursor.links!["connector_new"]).toBe(1); // adopted → inherits
    expect(cursor.links!["connector_ws-scratch"]).toBe(statSync(box.spoolPath).size);
  });

  test("a repeated id is one destination, not two", async () => {
    await signIn();
    route();

    const payload = await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-default", "ws-default"],
    });

    expect((payload.destinations as unknown[]).length).toBe(1);
    expect(requests.filter((r) => r === `POST ${GATEWAY}/v1/connectors`).length).toBe(1);
  });

  test("connecting without a sign-in never writes a config", async () => {
    route();

    const payload = await connectToWorkspaces({ projectRoot: project }, {
      ...baseArgs,
      workspaces: ["ws-default"],
    });

    expect(payload).toMatchObject({ status: "error", code: "not_signed_in" });
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
  });

  test("the platform-key path is unavailable to JSON mode", async () => {
    // --api-key takes a secret as an argv value; an agent must never be the
    // process that handles one.
    const payload = await runJsonVerb({ projectRoot: project }, {
      ...baseArgs,
      apiKey: "key_live.secret",
      probe: true,
    });

    expect(payload).toMatchObject({ status: "error", code: "api_key_not_supported" });
    expect(JSON.stringify(payload)).not.toContain("key_live.secret");
  });

  test("JSON mode without a verb explains the verbs instead of guessing", async () => {
    const payload = await runJsonVerb({ projectRoot: project }, baseArgs);
    expect(payload).toMatchObject({ status: "error", code: "no_verb" });
  });
});
