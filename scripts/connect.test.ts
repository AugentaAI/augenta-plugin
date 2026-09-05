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
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
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
  verifyProjectKey,
  selectedWorkspaces,
  startLogin,
  writeApiKeyConfig,
  writeOAuthConfig,
  WORKSPACE_LIST_MAX_PAGES,
  WORKSPACE_LIST_PAGE_SIZE,
  type WorkspacePrompts,
} from "./connect";
import { Outbox } from "../capture/outbox";
import {
  profileIdFor,
  readPendingLogin,
  saveDeviceProfile,
  savePendingLogin,
} from "../capture/auth";
import * as nodeRuntime from "../runtime/node";

// `startLogin` -> `beginDeviceLogin` opens a browser unless the caller passes
// `openBrowser: false` (capture/auth.ts). `startLogin` takes no such option and
// should not grow one for a test, so the seam every caller shares is stubbed here
// instead. Without this, three tests below hand the fixture URL to `open`/`xdg-open`
// and a full `bun test` puts three real tabs on auth.example.com in the developer's
// browser. Nothing is sent there -- the HTTP endpoint is routed to a stub and the
// domain is IANA-reserved -- but a test suite has no business driving the desktop.
//
// The real module is spread first: it also exports `readStdin` and `isMain`, and the
// CLI subprocess tests need both to keep working.
const browserLaunches: string[][] = [];
mock.module("../runtime/node", () => ({
  ...nodeRuntime,
  openBrowser: (command: string[]) => {
    browserLaunches.push(command);
  },
}));

const CONNECT = join(import.meta.dir, "connect.ts");
const realFetch = globalThis.fetch;

let project: string;
beforeEach(() => (project = realpathSync(mkdtempSync(join(tmpdir(), "aug-connect-")))));
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(project, { recursive: true, force: true });
});

describe("parseArgs", () => {
  test("--verify-only is a boolean and takes no value", () => {
    expect(parseArgs(["--verify-only"])).toEqual({ verifyOnly: true });
    // It must not swallow the next token the way a value flag does, or
    // `--verify-only --project /p` would lose the project.
    expect(parseArgs(["--verify-only", "--project", "/p"])).toEqual({
      verifyOnly: true,
      project: "/p",
    });
    // And it never implies a key: this path reads the one already on disk.
    expect(parseArgs(["--verify-only"]).apiKey).toBeUndefined();
  });

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
    const path = writeApiKeyConfig(project, "sk-aug-test.secret", "http://gw.example.com");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      authMode: "api-key",
      apiKey: "sk-aug-test.secret",
      endpoint: "http://gw.example.com",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(project, ".augenta", ".gitignore"), "utf8")).toBe("*\n");
  });

  test("omits endpoint when not given", () => {
    const path = writeApiKeyConfig(project, "sk-aug-test.secret");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      authMode: "api-key",
      apiKey: "sk-aug-test.secret",
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
        "AugentaKey sk-aug-live.secret",
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
      "sk-aug-live.secret",
      "https://gw.example.com/",
    );

    expect(result.connector.id).toBe("connector_123");
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual({
      authMode: "api-key",
      apiKey: "sk-aug-live.secret",
      endpoint: "https://gw.example.com",
    });
  });

  /* --verify-only. The file path is the documented way to configure an autonomous
     client, and it gave up the one thing `--api-key` did well: checking the key
     against the gateway BEFORE anything depends on it. This restores that check
     while leaving the secret where it was put — read from the config, never an argv
     entry that every local process can see. */
  describe("--verify-only", () => {
    const connectorsOk = () =>
      Response.json({
        connectors: [
          {
            id: "connector_v",
            kind: "agent",
            direction: "inbound",
            status: "active",
            workspaceId: "ws-default",
          },
        ],
      });

    test("reads the key from the config and writes nothing", async () => {
      const path = writeApiKeyConfig(project, "sk-aug-ondisk.secret", "https://gw.example.com");
      const before = readFileSync(path, "utf8");
      let seen = "";
      globalThis.fetch = (async (url, init) => {
        seen = new Headers(init?.headers).get("authorization") ?? "";
        expect(String(url)).toBe("https://gw.example.com/v1/connectors");
        return connectorsOk();
      }) as typeof fetch;

      const { connector, gateway } = await verifyProjectKey(project);

      // The key came off disk, not from a caller — that is the whole point.
      expect(seen).toBe("AugentaKey sk-aug-ondisk.secret");
      expect(connector.id).toBe("connector_v");
      // ...and the project's OWN endpoint was verified, not the default gateway.
      expect(gateway).toBe("https://gw.example.com");
      expect(readFileSync(path, "utf8")).toBe(before);
    });

    /* The bug this pins: the shipper reaches the door through gatewayBase, which
       reads AUGENTA_API_URL BEFORE the config's endpoint. A hand-rolled
       `endpoint || DEFAULT` here verified a different host than capture ships to,
       so a green check could mean nothing. */
    test("verifies the gateway the SHIPPER would use, env override included", async () => {
      writeApiKeyConfig(project, "sk-aug-env.secret", "https://config.example.com");
      const seen: string[] = [];
      globalThis.fetch = (async (url, _init) => {
        seen.push(String(url));
        return connectorsOk();
      }) as typeof fetch;

      const previous = process.env.AUGENTA_API_URL;
      process.env.AUGENTA_API_URL = "https://env.example.com";
      try {
        const { gateway } = await verifyProjectKey(project);
        expect(gateway).toBe("https://env.example.com");
        expect(seen).toEqual(["https://env.example.com/v1/connectors"]);
      } finally {
        if (previous === undefined) delete process.env.AUGENTA_API_URL;
        else process.env.AUGENTA_API_URL = previous;
      }
    });

    test("an explicit --endpoint still wins over both", async () => {
      writeApiKeyConfig(project, "sk-aug-env.secret", "https://config.example.com");
      const seen: string[] = [];
      globalThis.fetch = (async (url, _init) => {
        seen.push(String(url));
        return connectorsOk();
      }) as typeof fetch;

      const previous = process.env.AUGENTA_API_URL;
      process.env.AUGENTA_API_URL = "https://env.example.com";
      try {
        const { gateway } = await verifyProjectKey(project, "https://flag.example.com/");
        expect(gateway).toBe("https://flag.example.com");
        expect(seen).toEqual(["https://flag.example.com/v1/connectors"]);
      } finally {
        if (previous === undefined) delete process.env.AUGENTA_API_URL;
        else process.env.AUGENTA_API_URL = previous;
      }
    });

    test("--verify-only with --api-key is refused, not quietly redirected", () => {
      writeApiKeyConfig(project, "sk-aug-ondisk.secret");
      const r = spawnSync("bun", [CONNECT, "--verify-only", "--api-key", "sk-aug-other.secret"], {
        cwd: project,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Otherwise it reports "the platform key is accepted" about the on-disk key
      // while the user named a different one on the command line.
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("drop --api-key");
    });

    test("a refused key is an error, not a silent pass", async () => {
      writeApiKeyConfig(project, "sk-aug-stale.secret", "https://gw.example.com");
      globalThis.fetch = (async (_url, _init) =>
        new Response("no", { status: 401 })) as typeof fetch;

      await expect(verifyProjectKey(project)).rejects.toThrow("401");
    });

    test("refuses an oauth project instead of pretending to verify one", async () => {
      writeOAuthConfig(project, "profile_1", ["connector_1"]);
      let called = false;
      globalThis.fetch = (async (_url, _init) => {
        called = true;
        return connectorsOk();
      }) as typeof fetch;

      await expect(verifyProjectKey(project)).rejects.toThrow("configured for oauth");
      // Its credential is in the global auth file, so there is nothing here to check.
      expect(called).toBe(false);
    });

    test("an unconfigured project says so rather than reporting success", async () => {
      await expect(verifyProjectKey(project)).rejects.toThrow("nothing to verify");
    });

    test("the CLI surfaces it and still writes nothing", () => {
      writeApiKeyConfig(project, "sk-aug-cli.secret", "http://127.0.0.1:1/unreachable");
      const before = readFileSync(join(project, ".augenta", "config.json"), "utf8");
      const r = spawnSync("bun", [CONNECT, "--verify-only"], {
        cwd: project,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Unreachable gateway, so this asserts the failure path end to end: the flag
      // is recognised, it reaches the network, and it exits non-zero without ever
      // touching the config.
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Augenta connect:");
      expect(readFileSync(join(project, ".augenta", "config.json"), "utf8")).toBe(before);
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
      connectWithApiKey(project, "sk-aug-live.secret", "https://gw.example.com"),
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

  /** Minimal control plane. Unrouted paths fail loudly rather than silently 200.
   *
   *  `path` is normalized to origin+pathname and the query is handed to the
   *  handler separately, so the exact-string routes below keep matching now that
   *  `GET /v1/workspaces` carries `?limit=` and `?cursor=`. `requests` still
   *  records the FULL url — several assertions read the query off it. */
  function route(extra: Record<string, (query: URLSearchParams) => Response> = {}) {
    globalThis.fetch = (async (url, init) => {
      const full = String(url);
      const parsed = new URL(full);
      const path = `${parsed.origin}${parsed.pathname}`;
      const query = parsed.searchParams;
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      requests.push(`${method} ${full}`);
      const custom = extra[`${method} ${path}`] ?? extra[path];
      if (custom) return custom(query);
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
        /* Paged like the real door: keyset over the list index, `nextCursor`
           only while rows remain. A stub that always answered the whole list
           would let an unbounded or non-advancing loop pass. */
        const limit = Math.min(Number(query.get("limit")) || 50, 200);
        const rawCursor = query.get("cursor");
        const from = rawCursor === null ? 0 : Number(rawCursor);
        /* 400, not an empty 200. `Number("garbage")` is NaN and
           `slice(NaN, NaN)` is `[]` with no cursor, so the tolerant version
           answered a mangled cursor with a SUCCESSFUL empty list — and the
           client then reported "no active Workspaces", which sends the reader to
           the wrong end. A stub that cannot fail cannot catch the bug it exists
           to catch. */
        if (!Number.isInteger(from) || from < 0) {
          return Response.json({ error: `stub: uninterpretable cursor ${rawCursor}` }, { status: 400 });
        }
        const page = liveWorkspaces.slice(from, from + limit);
        const next = from + limit < liveWorkspaces.length ? String(from + limit) : undefined;
        return Response.json({ workspaces: page, ...(next ? { nextCursor: next } : {}) });
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

  test("follows nextCursor and offers the UNION, still Default-first", async () => {
    /* The consent surface has to be the whole list. Splitting the Default
       Workspace onto the SECOND page is the arrangement that matters: a
       first-page-only client would offer "Scratch" alone and the user would ship
       their work somewhere they did not choose — with no error to notice. */
    await signIn();
    route({
      [`GET ${GATEWAY}/v1/workspaces`]: (query) =>
        query.get("cursor") === "p2"
          ? Response.json({ workspaces: [{ id: "ws_01ABC", name: "Default Workspace" }] })
          : Response.json({ workspaces: [{ id: "ws_01HZY", name: "Scratch" }], nextCursor: "p2" }),
    });

    const payload = await probeConnection({ projectRoot: project }, baseArgs);

    expect(payload.workspaces).toEqual([
      { id: "ws_01ABC", name: "Default Workspace" },
      { id: "ws_01HZY", name: "Scratch" },
    ]);
    /* Asserted on the PARSED query rather than an exact string: parameter order
       is `URLSearchParams` insertion order, and reordering it is behaviour-neutral
       — a test that fails on it sends the reader hunting a paging bug that is not
       there. What matters is that both pages ask for the largest page the API
       gives, and that only the second carries the cursor. */
    const asked = requests
      .filter((r) => r.startsWith(`GET ${GATEWAY}/v1/workspaces?`))
      .map((r) => new URL(r.slice("GET ".length)).searchParams)
      .map((q) => ({ limit: q.get("limit"), cursor: q.get("cursor") }));
    expect(asked).toEqual([
      { limit: String(WORKSPACE_LIST_PAGE_SIZE), cursor: null },
      { limit: String(WORKSPACE_LIST_PAGE_SIZE), cursor: "p2" },
    ]);
  });

  test("a cursor that never ends REFUSES rather than offering a partial list", async () => {
    /* The one place this plugin prefers an error to a result. Every other list
       here is a display; this one is the question "which Workspaces may this
       project write into", and a truncated answer is a wrong answer the user
       cannot see is wrong.

       An ADVANCING cursor, so the walk runs to the ceiling rather than tripping
       the stall guard below. The ceiling is derived from the constants, not
       restated: a raised ceiling should not fail this test as if the message
       were wrong. */
    await signIn();
    let issued = 0;
    route({
      [`GET ${GATEWAY}/v1/workspaces`]: () =>
        Response.json({
          workspaces: [{ id: `ws_${issued}`, name: `W${issued}` }],
          nextCursor: `page-${++issued}`,
        }),
    });

    await expect(probeConnection({ projectRoot: project }, baseArgs)).rejects.toThrow(
      new RegExp(`did not finish within ${WORKSPACE_LIST_MAX_PAGES} pages of ${WORKSPACE_LIST_PAGE_SIZE}`),
    );
    // Bounded, and bounded at the ceiling — not one request more.
    expect(requests.filter((r) => r.includes("/v1/workspaces?")).length).toBe(WORKSPACE_LIST_MAX_PAGES);
  });

  test("a cursor that does not ADVANCE fails immediately, naming the API", async () => {
    /* Distinguished from the case above on purpose. A server that repeats a
       cursor is stuck; without this guard it costs the full ten round trips,
       accumulates the same page ten times, and then blames the organization's
       size for what is an API bug. */
    await signIn();
    route({
      [`GET ${GATEWAY}/v1/workspaces`]: () =>
        Response.json({ workspaces: [{ id: "ws_1", name: "One" }], nextCursor: "stuck" }),
    });

    await expect(probeConnection({ projectRoot: project }, baseArgs)).rejects.toThrow(
      /same page cursor twice/,
    );
    // TWO requests, not ten: the first learns the cursor, the second proves it stuck.
    expect(requests.filter((r) => r.includes("/v1/workspaces?")).length).toBe(2);
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

  // The stub above is only worth having if it is still in the path. Assert the
  // launch it captured rather than letting it swallow silently: if `mock.module`
  // stops resolving to the module `capture/auth` imports, this fails here instead
  // of quietly putting a tab on the developer's screen again.
  test("starting a login hands the verification URL to the browser opener, stubbed", async () => {
    browserLaunches.length = 0;
    route({
      [`POST ${ISSUER}/oauth2/device_authorization`]: () =>
        Response.json({
          device_code: "device_secret_open",
          user_code: "OPEN-CODE",
          verification_uri_complete: `${ISSUER}/device?user_code=OPEN-CODE`,
          verification_uri: `${ISSUER}/device`,
          interval: 5,
          expires_in: 600,
        }),
    });

    await startLogin(baseArgs);

    expect(browserLaunches).toHaveLength(1);
    expect(browserLaunches[0]?.[browserLaunches[0].length - 1]).toBe(
      `${ISSUER}/device?user_code=OPEN-CODE`,
    );
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
      apiKey: "sk-aug-live.secret",
      probe: true,
    });

    expect(payload).toMatchObject({ status: "error", code: "api_key_not_supported" });
    expect(JSON.stringify(payload)).not.toContain("sk-aug-live.secret");
  });

  test("JSON mode without a verb explains the verbs instead of guessing", async () => {
    const payload = await runJsonVerb({ projectRoot: project }, baseArgs);
    expect(payload).toMatchObject({ status: "error", code: "no_verb" });
  });
});
