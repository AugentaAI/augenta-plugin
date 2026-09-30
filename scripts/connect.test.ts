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
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  symlinkSync,
  mkdirSync,
  readdirSync,
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
import { readLinks } from "../capture/links";
import { TEST_PROJECT_KEY, TEST_USER_ID, writeSharedConfig } from "../__tests__/fixtures";
import { SHARED_IGNORE } from "../capture/augenta-dir";
import { captureEnabled, loadProjectConfig, projectConfig, resolveProjectRoot } from "../capture/config";
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
// instead. Without this, every test below that reaches `startLogin` without a live
// pending login hands the fixture URL to `open`/`xdg-open`, and a full `bun test`
// puts real tabs on auth.example.com in the developer's browser. Nothing is sent
// there -- the device-authorization endpoint is routed to a stub and the domain is
// IANA-reserved -- but a test suite has no business driving the desktop.
//
// The real module is spread first: it also exports `readStdin` and `isMain`, and the
// CLI subprocess tests need both to keep working.
//
// Measured, not assumed: this mock is scoped to this file. A sibling test importing
// `runtime/node` in the same `bun test` run still gets the real `openBrowser`, so
// nothing here weakens another file's coverage.
const browserLaunches: string[] = [];
mock.module("../runtime/node", () => ({
  ...nodeRuntime,
  openBrowser: (url: string) => {
    browserLaunches.push(url);
  },
}));

function connectionRecord(profileId: string, connectorIds: string[], endpoint = "https://gw.example.com") {
  return {
    profileId, userId: TEST_USER_ID, projectKey: TEST_PROJECT_KEY,
    endpoint, controlUrl: "https://augenta.ai", org: { id: "org_1", name: "Example" },
    destinations: connectorIds.map((connectorId) => ({ connectorId, workspaceId: connectorId === "connector_ws-scratch" ? "ws-scratch" : "ws-default" })),
  };
}

const CONNECT = join(import.meta.dir, "connect.ts");
const realFetch = globalThis.fetch;

let project: string;
const URL_ENV_KEYS = ["AUGENTA_CONTROL_URL", "AUGENTA_API_URL", "AUGENTA_INGEST_URL", "AUGENTA_EPHEMERAL"] as const;
let savedUrlEnv: Record<string, string | undefined>;
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "aug-connect-")));
  savedUrlEnv = Object.fromEntries(URL_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of URL_ENV_KEYS) delete process.env[key];
  // Declared lasting, so the suite behaves the same when run inside a cloud
  // session; the throwaway-session tests set it themselves.
  process.env.AUGENTA_EPHEMERAL = "0";
});
afterEach(() => {
  for (const key of URL_ENV_KEYS) {
    if (savedUrlEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedUrlEnv[key];
  }
  globalThis.fetch = realFetch;
  rmSync(project, { recursive: true, force: true });
});

describe("parseArgs", () => {
  test("--auto-recall takes exactly on or off", () => {
    expect(parseArgs(["--auto-recall", "on"])).toEqual({ autoRecall: true });
    expect(parseArgs(["--auto-recall", "off"])).toEqual({ autoRecall: false });
    expect(() => parseArgs(["--auto-recall", "yes"])).toThrow("--auto-recall must be on or off");
    expect(() => parseArgs(["--auto-recall", "--json"])).toThrow("--auto-recall requires a value");
  });

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

/** Commands and capture agree on worktree-local consent. */
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
    // Physical, like `project` above: resolveProject realpaths its lookup.
    worktree = join(realpathSync(mkdtempSync(join(tmpdir(), "aug-wt-"))), "checkout");
    execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "wt"], {
      cwd: project,
    });
  };

  beforeEach(initRepoWithWorktree);
  afterEach(() => rmSync(worktree, { recursive: true, force: true }));

  test("uses the current worktree without redirecting", () => {
    const resolved = resolveProject({}, worktree);

    expect(realpathSync(resolved.projectRoot)).toBe(realpathSync(worktree));
  });

  test("writing the resolved connection enables only that worktree's capture lookup", () => {
    writeApiKeyConfig(project, "main-only");
    expect(projectConfig(worktree)).toBeUndefined();
    const deep = join(worktree, "src"); mkdirSync(deep);
    const resolved = resolveProject({}, deep);
    writeApiKeyConfig(resolved.projectRoot, "worktree-only");
    expect(projectConfig(deep)?.apiKey).toBe("worktree-only");
    expect(projectConfig(project)?.apiKey).toBe("main-only");
    expect(resolveProject({}, deep)).toEqual({ projectRoot: resolveProjectRoot(deep)! });
  });

  test("nested project config takes precedence, including invalid local config", () => {
    writeApiKeyConfig(worktree, "outer");
    const nested = join(worktree, "service"); mkdirSync(nested);
    writeApiKeyConfig(nested, "inner");
    const deep = join(nested, "src"); mkdirSync(deep);
    expect(resolveProject({}, deep).projectRoot).toBe(nested);
    expect(projectConfig(deep)?.apiKey).toBe("inner");
    writeFileSync(join(nested, ".augenta/config.json"), "broken");
    expect(resolveProject({}, deep).projectRoot).toBe(nested);
    expect(projectConfig(deep)).toBeUndefined();
  });

  test("deeply nested hooks discover the same config as the command", () => {
    const deep = join(worktree, ...Array(35).fill("d")); mkdirSync(deep, { recursive: true });
    writeApiKeyConfig(resolveProject({}, deep).projectRoot, "deep-project");
    expect(projectConfig(deep)?.apiKey).toBe("deep-project");
    expect(resolveProject({}, deep).projectRoot).toBe(resolveProjectRoot(deep)!);
  });

  test("a nested Git checkout or worktree does not inherit outer consent", () => {
    writeApiKeyConfig(project, "outer");
    for (const marker of ["file", "directory"]) {
      const inner = join(project, marker); mkdirSync(inner);
      if (marker === "file") writeFileSync(join(inner, ".git"), "gitdir: /missing");
      else mkdirSync(join(inner, ".git"));
      const deep = join(inner, "src"); mkdirSync(deep);
      expect(projectConfig(deep)).toBeUndefined();
    }
  });

  test("a symlink into a worktree subdirectory keeps the physical checkout boundary", () => {
    writeApiKeyConfig(project, "main-only");
    const deep = join(worktree, "src"); mkdirSync(deep);
    const alias = join(project, "linked-src"); symlinkSync(deep, alias, "dir");
    expect(projectConfig(alias)).toBeUndefined();
    expect(realpathSync(resolveProject({}, alias).projectRoot)).toBe(realpathSync(worktree));
    writeApiKeyConfig(worktree, "worktree-only");
    expect(projectConfig(alias)?.apiKey).toBe("worktree-only");
    expect(realpathSync(resolveProject({}, alias).projectRoot)).toBe(realpathSync(worktree));
  });

  test("uses the worktree from its subdirectories too", () => {
    const deep = join(worktree, "src", "deep");
    mkdirSync(deep, { recursive: true });
    expect(realpathSync(resolveProject({}, deep).projectRoot)).toBe(realpathSync(worktree));
  });

  test("a plain repo is never redirected", () => {
    const sub = join(project, "src");
    mkdirSync(sub, { recursive: true });
    const resolved = resolveProject({}, sub);

    expect(realpathSync(resolved.projectRoot)).toBe(project);
  });

  test("--project still wins, so connecting a worktree stays possible", () => {
    const resolved = resolveProject({ project: worktree }, worktree);

    expect(resolved.projectRoot).toBe(worktree);
  });
});

describe("project config writers", () => {
  test("writes platform-key config 0600 inside the self-gitignored dir", () => {
    const path = writeApiKeyConfig(project, "sk-aug-test.secret", "http://gw.example.com");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      authMode: "api-key",
      captureSince: expect.any(String),
      apiKey: "sk-aug-test.secret",
      autoRecall: false,
      endpoint: "http://gw.example.com",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(project, ".augenta", ".gitignore"), "utf8")).toBe("*\n");
  });

  test("omits endpoint when not given", () => {
    const path = writeApiKeyConfig(project, "sk-aug-test.secret");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      authMode: "api-key",
      captureSince: expect.any(String),
      apiKey: "sk-aug-test.secret",
      autoRecall: false,
    });
  });

  // Nobody is asked on the platform-key path, so the answer has to be written:
  // an absent key reads as "connected before the question existed", which is on.
  test("platform-key config records automatic recall off unless carried forward", () => {
    const off = JSON.parse(readFileSync(writeApiKeyConfig(project, "sk-aug-test.secret"), "utf8"));
    expect(off.autoRecall).toBe(false);
    const on = JSON.parse(
      readFileSync(writeApiKeyConfig(project, "sk-aug-test.secret", undefined, { autoRecall: true }), "utf8"),
    );
    expect(on.autoRecall).toBe(true);
  });

  test("oauth config records the organization, Workspaces and URLs; the links stay local", () => {
    const record = connectionRecord("profile_123", ["connector_456", "connector_ws-scratch"], "https://dev.example.com");
    const path = writeOAuthConfig(project, record);
    // The shared file names no Connector and no time: it may be committed, and
    // stays byte-identical when a re-affirmation changes nothing.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      authMode: "oauth",
      projectKey: TEST_PROJECT_KEY,
      profileId: "profile_123",
      controlUrl: "https://augenta.ai",
      endpoint: "https://dev.example.com",
      org: { id: "org_1", name: "Example" },
      workspaces: [{ workspaceId: "ws-default" }, { workspaceId: "ws-scratch" }],
      // Explicit even with no answer given: off is the question's default.
      autoRecall: false,
    });
    expect(readFileSync(path, "utf8")).not.toContain("connector_");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // No credential in it, so it may be committed; this checkout has joined it
    // with its own links, which never leave it.
    expect(readFileSync(join(project, ".augenta", ".gitignore"), "utf8")).toBe(SHARED_IGNORE);
    expect(readLinks(project)).toMatchObject({
      profileId: "profile_123",
      userId: TEST_USER_ID,
      projectKey: TEST_PROJECT_KEY,
      links: [{ workspaceId: "ws-default", connectorId: "connector_456" }, { workspaceId: "ws-scratch", connectorId: "connector_ws-scratch" }],
    });
    const again = readFileSync(path, "utf8");
    writeOAuthConfig(project, record);
    expect(readFileSync(path, "utf8")).toBe(again);
  });

  test("git sees only the browser config and its ignore file, never state or outbox", () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    writeOAuthConfig(project, connectionRecord("profile_123", ["connector_456"]));
    new Outbox(project).append([{ src: "claude-code", sid: "s", proj: project, ts: new Date().toISOString(), seq: 0, kind: "msg", role: "user", text: "x" }]);
    const visible = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: project })
      .toString().trim().split("\n").map((line) => line.slice(3)).sort();
    expect(visible).toEqual([".augenta/.gitignore", ".augenta/config.json"]);
  });

  test("an API-key config is never committable: local ignore form, and refused if already tracked", () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    writeOAuthConfig(project, connectionRecord("profile_123", ["connector_456"]));
    writeApiKeyConfig(project, "sk-aug-test.secret");
    expect(readFileSync(join(project, ".augenta", ".gitignore"), "utf8")).toBe("*\n");
    expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: project }).toString()).toBe("");

    writeOAuthConfig(project, connectionRecord("profile_123", ["connector_456"]));
    execFileSync("git", ["add", ".augenta/config.json"], { cwd: project });
    expect(() => writeApiKeyConfig(project, "sk-aug-test.secret")).toThrow("tracked by git");
    expect(readFileSync(join(project, ".augenta", "config.json"), "utf8")).not.toContain("sk-aug-test");
  });

  test("a user-authored .augenta/.gitignore is left exactly as it is", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", ".gitignore"), "outbox/\n");
    writeOAuthConfig(project, connectionRecord("profile_123", ["connector_456"]));
    expect(readFileSync(join(project, ".augenta", ".gitignore"), "utf8")).toBe("outbox/\n");
  });

  test("refuses to write an OAuth config without a destination", () => {
    expect(() => writeOAuthConfig(project, connectionRecord("profile_123", []))).toThrow(
      "requires at least one Connector",
    );
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
  });

  test("OAuth writer whitelists fields even when inputs contain extra credentials", () => {
    const connection = {
      ...connectionRecord("profile_123", ["connector_456"]),
      accessToken: "secret-not-for-project", authMode: "api-key",
      org: { id: "org_1", accessToken: "secret-not-for-project" },
      destinations: [{ connectorId: "connector_456", workspaceId: "ws-default", accessToken: "secret-not-for-project" }],
    };
    const path = writeOAuthConfig(project, connection);
    expect(readFileSync(path, "utf8")).not.toContain("secret-not-for-project");
    expect(loadProjectConfig(project)?.authMode).toBe("oauth");
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
  for (const field of ["id", "orgId", "workspaceId"] as const) {
    for (const value of [undefined, null, "", "   ", 42]) {
      test(`refuses invalid ${field}=${String(value)} without overwriting a usable config`, async () => {
        const path = writeApiKeyConfig(project, "sk-aug-existing.secret");
        const before = readFileSync(path, "utf8");
        globalThis.fetch = (async (_url, _init) => Response.json({ connectors: [{
          id: "connector_123", orgId: "org_1", workspaceId: "ws-default",
          status: "active", direction: "inbound", [field]: value,
        }] })) as typeof fetch;
        await expect(connectWithApiKey(project, "sk-aug-new.secret")).rejects.toThrow("non-empty id, orgId, and workspaceId");
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(loadProjectConfig(project)?.apiKey).toBe("sk-aug-existing.secret");
      });
    }
  }

  test("invalid assignment metadata creates no config on first connect", async () => {
    globalThis.fetch = (async (_url, _init) => Response.json({ connectors: [{
      id: "connector_123", status: "active", direction: "inbound",
    }] })) as typeof fetch;
    await expect(connectWithApiKey(project, "sk-aug-new.secret")).rejects.toThrow("non-empty id, orgId, and workspaceId");
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
  });

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
            orgId: "org_1",
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
    expect(loadProjectConfig(project)?.destinations).toEqual([{ connectorId: "connector_123", workspaceId: "ws-default" }]);
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual({
      authMode: "api-key",
      captureSince: expect.any(String),
      apiKey: "sk-aug-live.secret",
      endpoint: "https://gw.example.com",
      org: { id: "org_1" },
      destinations: [{ connectorId: "connector_123", workspaceId: "ws-default" }],
      autoRecall: false,
    });
  });

  // A key rotation rewrites the whole file, so an explicit `--auto-recall off`
  // — or on — has to survive it rather than reverting to the default.
  test("carries a prior automatic-recall answer through a key rotation", async () => {
    writeApiKeyConfig(project, "sk-aug-old.secret", "https://gw.example.com", { autoRecall: true });
    globalThis.fetch = (async (_url, _init) =>
      Response.json({
        connectors: [
          { id: "connector_123", orgId: "org_1", direction: "inbound", status: "active", workspaceId: "ws-default" },
        ],
      })) as typeof fetch;

    const { path } = await connectWithApiKey(project, "sk-aug-new.secret", "https://gw.example.com/");
    expect(JSON.parse(readFileSync(path, "utf8")).autoRecall).toBe(true);
    // An explicit answer on the command line wins over the carried one.
    await connectWithApiKey(project, "sk-aug-new.secret", "https://gw.example.com/", false);
    expect(JSON.parse(readFileSync(path, "utf8")).autoRecall).toBe(false);
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
            orgId: "org_1",
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
      writeOAuthConfig(project, connectionRecord("profile_1", ["connector_1"]));
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
            orgId: "org_1",
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
  /** Who `/v1/me` says is signed in, and whether they manage the organization.
   *  Like the real door, a member reads and lists only their own links; a
   *  manager reads and lists everyone's. */
  let currentUser: string;
  let manager: boolean;

  /** Register a pre-existing Connector, as a prior connection would have. */
  const seedLink = (id: string, workspaceId: string, owner = TEST_USER_ID, extra: Record<string, unknown> = {}) =>
    links.set(id, {
      id,
      kind: "agent",
      direction: "inbound",
      status: "active",
      workspaceId,
      ownerUserId: owner,
      _etag: "revision-1",
      ...extra,
    });
  const visible = (link: Record<string, unknown>) => manager || link.ownerUserId === currentUser;

  beforeEach(() => {
    authHome = mkdtempSync(join(tmpdir(), "aug-json-auth-"));
    process.env.AUGENTA_AUTH_HOME = authHome;
    requests = [];
    links = new Map();
    currentUser = TEST_USER_ID;
    manager = false;
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
  function route(extra: Record<string, (query: URLSearchParams, init?: RequestInit) => Response> = {}) {
    globalThis.fetch = (async (url, init) => {
      const full = String(url);
      const parsed = new URL(full);
      const path = `${parsed.origin}${parsed.pathname}`;
      const query = parsed.searchParams;
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      requests.push(`${method} ${full}`);
      const custom = extra[`${method} ${path}`] ?? extra[path];
      if (custom) return custom(query, init);
      if (path === `${CONTROL}/.well-known/augenta.json`) {
        return Response.json({
          issuer: ISSUER,
          clientId: "client_public",
          gateway: GATEWAY,
        });
      }
      if (path === `${GATEWAY}/v1/me`) {
        return Response.json({
          user: currentUser === TEST_USER_ID
            ? { id: currentUser, name: "Rin", email: "rin@example.com" }
            : { id: currentUser, name: "Sam", email: `${currentUser}@example.com` },
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
      // The owner is always the caller, as on the real door.
      if (path === `${GATEWAY}/v1/connectors` && method === "POST") {
        const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> & {
          workspaceId: string;
        };
        const base = body.workspaceId === "ws-default" ? "connector_new" : `connector_${body.workspaceId}`;
        const id = currentUser === TEST_USER_ID ? base : `${base}_${currentUser}`;
        seedLink(id, body.workspaceId, currentUser, { ...body, createdAt: new Date().toISOString() });
        return Response.json({ connector: links.get(id) });
      }
      if (path === `${GATEWAY}/v1/connectors` && method === "GET") {
        const connectors = [...links.values()].filter((link) =>
          visible(link) &&
          (!query.get("kind") || link.kind === query.get("kind")) &&
          (!query.get("status") || link.status === query.get("status")) &&
          (!query.get("workspaceId") || link.workspaceId === query.get("workspaceId")));
        return Response.json({ connectors });
      }
      if (path.startsWith(`${GATEWAY}/v1/connectors/`)) {
        const id = decodeURIComponent(path.slice(`${GATEWAY}/v1/connectors/`.length));
        const existing = links.get(id);
        if (!existing || !visible(existing)) return new Response("no such connector", { status: 404 });
        // A PATCH must never move a link between Workspaces.
        if (method === "PATCH") {
          const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
          expect(body).not.toHaveProperty("workspaceId");
          Object.assign(existing, body);
        }
        return Response.json({ connector: existing });
      }
      return new Response(`unrouted: ${method} ${path}`, { status: 500 });
    }) as typeof fetch;
  }

  /** Sign in as `userId`, who is also who the fake platform then says is
   *  signed in. One organization, so everyone gets the same profile id. */
  const signIn = (userId = TEST_USER_ID) => {
    currentUser = userId;
    return saveDeviceProfile(
      { issuer: ISSUER, clientId: "client_public", gateway: GATEWAY },
      {
        accessToken: "access-live",
        refreshToken: "refresh-live",
        expiresAt: Date.now() + 3_600_000,
      },
      { userId, orgId: "org_1" },
    );
  };

  test("repair refuses, sending nothing, when the environment points the checkout at another gateway", async () => {
    const { profileId } = await signIn();
    const file = writeOAuthConfig(project, connectionRecord(profileId, ["connector_new"]));
    const original = readFileSync(file, "utf8");
    process.env.AUGENTA_API_URL = "https://wrong.example.com";
    route();
    seedLink("connector_new", "ws-default");
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, repairHarness: true, harness: "codex" });
    expect(payload).toMatchObject({ status: "error", code: "gateway_mismatch" });
    expect(String(payload.message)).toContain("https://wrong.example.com");
    expect(requests).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  test("metadata-only repair preserves config, cursor and route, on the sign-in's own gateway", async () => {
    const { profileId } = await signIn();
    const file = writeOAuthConfig(project, connectionRecord(profileId, ["connector_new"]));
    const original = readFileSync(file, "utf8");
    const box = new Outbox(project);
    box.advance(17, "connector_new");
    const beforeCursor = readFileSync(box.cursorPath, "utf8");
    // Repair never selects an environment: the saved one stands.
    process.env.AUGENTA_CONTROL_URL = "https://wrong.example.com";
    route({ [`PATCH ${GATEWAY}/v1/connectors/connector_new`]: (_query, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ harness: "codex", _etag: "revision-1" });
      expect(new Headers(init?.headers).get("if-match")).toBe("revision-1");
      return Response.json({ connector: { ...links.get("connector_new"), harness: "codex" } });
    } });
    seedLink("connector_new", "ws-default");
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, repairHarness: true, harness: "codex" });
    expect(payload).toMatchObject({ status: "harness_repaired", repaired: ["connector_new"], failed: [] });
    expect(payload).not.toHaveProperty("environmentChange");
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readFileSync(box.cursorPath, "utf8")).toBe(beforeCursor);
    expect(requests).toEqual([`GET ${GATEWAY}/v1/connectors/connector_new`, `PATCH ${GATEWAY}/v1/connectors/connector_new`]);
  });

  test("repair refuses ambiguous commands before any network or write", async () => {
    route();
    expect(parseArgs(["--json", "--repair-harness", "--harness", "codex"]).repairHarness).toBe(true);
    for (const extra of [{ health: true }, { workspaces: [] }, { probe: true }, { profile: "other" }, { endpoint: GATEWAY }, { controlUrl: CONTROL }, { verifyOnly: true }]) {
      expect(await runJsonVerb({ projectRoot: project }, { json: true, repairHarness: true, harness: "codex", ...extra })).toMatchObject({ status: "error", code: "conflicting_verbs" });
    }
    expect(await runJsonVerb({ projectRoot: project }, { json: true, repairHarness: true })).toMatchObject({ code: "harness_required" });
    expect(await runJsonVerb({ projectRoot: project }, { json: true, repairHarness: true, harness: "codex" })).toMatchObject({ code: "oauth_connection_required" });
    expect(requests).toEqual([]);
  });

  test("repair rejects retargeted, disabled, non-agent and unversioned Connectors", async () => {
    const { profileId } = await signIn();
    writeOAuthConfig(project, connectionRecord(profileId, ["connector_new"]));
    for (const change of [{ workspaceId: "other" }, { status: "disabled" }, { kind: "service" }, { _etag: undefined }, { id: "other" }]) {
      route(); seedLink("connector_new", "ws-default");
      Object.assign(links.get("connector_new")!, change);
      const payload = await runJsonVerb({ projectRoot: project }, { json: true, repairHarness: true, harness: "codex" });
      expect(payload).toMatchObject({ status: "error", repaired: [], failed: [expect.objectContaining({ connectorId: "connector_new" })] });
    }
    expect(requests.every(r => r.startsWith("GET "))).toBe(true);
  });

  test("repair reports partial success and keeps failed destinations for retry", async () => {
    const { profileId } = await signIn();
    const file = writeOAuthConfig(project, connectionRecord(profileId, ["connector_new", "connector_ws-scratch"]));
    const original = readFileSync(file, "utf8");
    route({ [`PATCH ${GATEWAY}/v1/connectors/connector_ws-scratch`]: () => new Response("conflict", { status: 412 }) });
    seedLink("connector_new", "ws-default"); seedLink("connector_ws-scratch", "ws-scratch");
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, repairHarness: true, harness: "codex" });
    expect(payload).toMatchObject({ status: "error", repaired: ["connector_new"], failed: [expect.objectContaining({ connectorId: "connector_ws-scratch" })] });
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  test("repair does not report success when the server fails to confirm the label", async () => {
    const { profileId } = await signIn();
    writeOAuthConfig(project, connectionRecord(profileId, ["connector_new"]));
    route({ [`PATCH ${GATEWAY}/v1/connectors/connector_new`]: () => Response.json({ connector: links.get("connector_new") }) });
    seedLink("connector_new", "ws-default");
    expect(await runJsonVerb({ projectRoot: project }, { json: true, repairHarness: true, harness: "codex" })).toMatchObject({ status: "error", repaired: [] });
  });

  test("repair rejects a response whose Connector became disabled during the update", async () => {
    const { profileId } = await signIn();
    writeOAuthConfig(project, connectionRecord(profileId, ["connector_new"]));
    route({ ["PATCH " + GATEWAY + "/v1/connectors/connector_new"]: () => Response.json({
      connector: { ...links.get("connector_new"), harness: "codex", status: "disabled" },
    }) });
    seedLink("connector_new", "ws-default");
    expect(await runJsonVerb({ projectRoot: project }, { json: true, repairHarness: true, harness: "codex" }))
      .toMatchObject({ status: "error", repaired: [], failed: [expect.objectContaining({ connectorId: "connector_new" })] });
  });

  for (const adopt of [false, true]) for (const harness of [undefined, "codex", "claude-code"] as const) {
    test(`registration ${adopt ? "PATCH" : "POST"} preserves explicit or unknown identity: ${harness}`, async () => {
      const keys = ["CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_HOME", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CLAUDECODE"];
      const saved = keys.map(key => process.env[key]);
      try {
        for (const key of keys) delete process.env[key];
        const { profileId } = await signIn();
        if (adopt) writeOAuthConfig(project, connectionRecord(profileId, ["connector_new"]));
        let inspected = false;
        route({ [`${adopt ? "PATCH" : "POST"} ${GATEWAY}/v1/connectors${adopt ? "/connector_new" : ""}`]: (_query, init) => {
          const body = JSON.parse(String(init?.body));
          if (harness) expect(body.harness).toBe(harness);
          else expect(body).not.toHaveProperty("harness");
          inspected = true;
          return Response.json({ connector: { ...links.get("connector_new"), harness: harness ?? "codex" } });
        } });
        seedLink("connector_new", "ws-default");
        expect(await runJsonVerb({ projectRoot: project }, { ...baseArgs, harness, workspaces: ["ws-default"] })).toMatchObject({ status: "connected" });
        expect(inspected).toBe(true);
      } finally {
        keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
      }
    });
  }

  test("probe reports need_login and starts no authorization", async () => {
    route();

    const payload = await probeConnection({ projectRoot: project }, baseArgs);

    expect(payload).toMatchObject({ status: "need_login", alreadyConnected: false });
    // The whole point of a separate probe: nothing may leave the machine before
    // the user has been told what connecting does and agreed to it.
    expect(requests.some((r) => r.includes("device_authorization"))).toBe(false);
  });

  test("probe discovers the saved environment and reports local names before live resolution", async () => {
    const { profileId } = await signIn();
    writeOAuthConfig(project, {
      ...connectionRecord(profileId, ["connector_new"]), controlUrl: CONTROL,
      org: { id: "org_1", name: "Saved Org" },
      destinations: [{ connectorId: "connector_new", workspaceId: "ws-default", workspaceName: "Saved name" }],
    });
    seedLink("connector_new", "ws-default");
    route();
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, probe: true });
    expect(requests).toContain(`GET ${CONTROL}/.well-known/augenta.json`);
    expect(payload.environment).toBe(CONTROL);
    expect(payload.environmentChange).toBeUndefined();
    expect(payload.current).toMatchObject({ environment: CONTROL, organization: "Saved Org", destinations: [{ workspaceName: "Saved name" }] });
    expect(payload.destinations).toMatchObject([{ workspaceName: "Default Workspace" }]);
  });

  test("an env override reports the environment change and an explicit flag wins", async () => {
    writeOAuthConfig(project, { ...connectionRecord("profile_saved", ["connector_new"]), controlUrl: "https://saved.example.com" });
    process.env.AUGENTA_CONTROL_URL = CONTROL;
    route();
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, probe: true });
    expect(payload.environmentChange).toEqual({ from: "https://saved.example.com", to: CONTROL });
    expect(payload.current).toMatchObject({ environment: "https://saved.example.com" });
    expect(requests).toContain(`GET ${CONTROL}/.well-known/augenta.json`);
    process.env.AUGENTA_CONTROL_URL = "https://ignored.example.com";
    const explicit = await runJsonVerb({ projectRoot: project }, { ...baseArgs, probe: true });
    expect(explicit.environment).toBe(CONTROL);
    expect(explicit.current).toMatchObject({ environment: "https://saved.example.com" });
    expect(requests.map((request) => new URL(request.slice(request.indexOf(" ") + 1)).hostname)).not.toContain("ignored.example.com");
  });

  test("probe retains the saved connection when discovery is offline, without exposing credentials", async () => {
    writeApiKeyConfig(project, "sk-private.secret", GATEWAY, {
      controlUrl: CONTROL, org: { id: "org_saved", name: "Saved Org" },
      destinations: [{ connectorId: "connector_new", workspaceId: "ws-default", workspaceName: "Saved Workspace" }],
    });
    process.env.AUGENTA_CONTROL_URL = "https://offline.example.com";
    route({ ["GET https://offline.example.com/.well-known/augenta.json"]: () => { throw new Error("offline"); } });
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, probe: true });
    expect(payload).toMatchObject({ status: "error", message: "offline", environment: "https://offline.example.com", current: { environment: CONTROL, organization: "Saved Org", destinations: [{ workspaceName: "Saved Workspace" }] } });
    expect(JSON.stringify(payload)).not.toContain("sk-private.secret");
  });

  for (const override of ["flag", "env"] as const) {
    test(`a control ${override} switch discovers the new gateway instead of reusing the saved one`, async () => {
      const { profileId } = await signIn();
      writeOAuthConfig(project, {
        ...connectionRecord(profileId, ["connector_new"], "https://old-gateway.example.com"),
        controlUrl: "https://old-control.example.com",
      });
      if (override === "env") process.env.AUGENTA_CONTROL_URL = CONTROL;
      route();
      const payload = await runJsonVerb({ projectRoot: project }, {
        json: true, probe: true, ...(override === "flag" ? { controlUrl: CONTROL } : {}),
      });
      expect(payload.status).toBe("need_workspace");
      expect(requests).toContain(`GET ${GATEWAY}/v1/me`);
      expect(requests.map((request) => new URL(request.slice(request.indexOf(" ") + 1)).hostname)).not.toContain("old-gateway.example.com");
      expect(payload.current).toMatchObject({ environment: "https://old-control.example.com" });
    });
  }

  test("connect never takes its gateway from the file, so a saved one gets no sign-in", async () => {
    // The file can be a pulled commit: whoever wrote it must not choose where
    // this person signs in to and sends their token.
    await signIn();
    writeOAuthConfig(project, { ...connectionRecord("saved", ["connector_new"]), controlUrl: CONTROL });
    route({ [`GET ${CONTROL}/.well-known/augenta.json`]: () =>
      Response.json({ issuer: ISSUER, clientId: "client_public", gateway: "https://discovered.example.com" }) });
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, probe: true });
    expect(payload.status).toBe("need_login");
    expect(payload).not.toHaveProperty("gatewayOverride");
    expect(requests.some((request) => request.includes(GATEWAY))).toBe(false);
  });

  test("a gateway override is disclosed on every connect payload", async () => {
    await signIn();
    process.env.AUGENTA_API_URL = `${GATEWAY}/`;
    route({ [`GET ${CONTROL}/.well-known/augenta.json`]: () =>
      Response.json({ issuer: ISSUER, clientId: "client_public", gateway: "https://discovered.example.com" }) });
    const payload = await runJsonVerb({ projectRoot: project }, { ...baseArgs, probe: true });
    expect(payload).toMatchObject({ status: "need_workspace", gatewayOverride: GATEWAY });
    expect((await runJsonVerb({ projectRoot: project }, { ...baseArgs, endpoint: GATEWAY, probe: true })).gatewayOverride).toBe(GATEWAY);
    delete process.env.AUGENTA_API_URL;
    route();
    expect(await runJsonVerb({ projectRoot: project }, { ...baseArgs, probe: true })).not.toHaveProperty("gatewayOverride");
  });

  test("reconnect refreshes an automatically recorded gateway in the same environment", async () => {
    const { profileId } = await signIn();
    writeOAuthConfig(project, {
      ...connectionRecord(profileId, ["connector_new"], "https://retired.example.com"),
      controlUrl: CONTROL, discoveredGateway: "https://retired.example.com",
    });
    route();
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, workspaces: ["ws-default"] });
    expect(payload.status).toBe("connected");
    expect(loadProjectConfig(project)).toMatchObject({ endpoint: GATEWAY, discoveredGateway: GATEWAY });
    expect(requests.map((request) => new URL(request.slice(request.indexOf(" ") + 1)).hostname)).not.toContain("retired.example.com");
  });

  test("a hand-edited or pulled endpoint stops capture, sends nothing there, and reconnecting restores discovery's", async () => {
    const { profileId } = await signIn();
    writeOAuthConfig(project, {
      ...connectionRecord(profileId, ["connector_new"], "https://evil.example.com"), controlUrl: CONTROL,
      discoveredGateway: "https://evil.example.com",
    });
    seedLink("connector_new", "ws-default");
    // Links name the recorded Workspaces under this sign-in, but the file points
    // away from the gateway that sign-in was made for.
    expect(loadProjectConfig(project)).toMatchObject({ join: "gateway" });
    expect(loadProjectConfig(project)).not.toHaveProperty("destinations");
    route();
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, workspaces: ["ws-default"] });
    expect(payload.status).toBe("connected");
    expect(loadProjectConfig(project)).toMatchObject({ endpoint: GATEWAY, discoveredGateway: GATEWAY, join: "joined" });
    expect(requests.some((request) => request.includes("evil.example.com"))).toBe(false);
  });

  test("joining a config that points away from this sign-in's gateway is refused before anything is sent", async () => {
    const { profileId } = await signIn();
    writeSharedConfig(project, {
      profileId,
      destinations: [{ connectorId: "connector_new", workspaceId: "ws-default" }],
      extra: { endpoint: "https://evil.example.com", controlUrl: CONTROL, org: { id: "org_1", name: "Example Org" } },
    });
    route();
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, adopt: true });
    expect(payload).toMatchObject({ status: "error", code: "gateway_mismatch", organization: "Example Org" });
    expect(String(payload.message)).toContain("https://evil.example.com");
    expect(requests.filter((request) => !request.includes("/.well-known/"))).toEqual([]);
    expect(existsSync(join(project, ".augenta", "state", "links.json"))).toBe(false);
  });

  test("new connections mark discovery-derived endpoints but explicit overrides remain pinned", async () => {
    await signIn();
    route();
    expect((await runJsonVerb({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] })).status).toBe("connected");
    expect(loadProjectConfig(project)?.discoveredGateway).toBe(GATEWAY);
    expect((await runJsonVerb({ projectRoot: project }, { ...baseArgs, endpoint: GATEWAY, workspaces: ["ws-default"] })).status).toBe("connected");
    expect(loadProjectConfig(project)?.discoveredGateway).toBeUndefined();
  });

  test("probe identifies a platform-key connection without exposing or replacing its key", async () => {
    await signIn();
    const path = writeApiKeyConfig(project, "sk-aug-existing.secret", GATEWAY, { controlUrl: CONTROL });
    const saved = readFileSync(path, "utf8");
    route();
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, probe: true });
    expect(payload).toMatchObject({ alreadyConnected: true, current: { authMode: "api-key" } });
    expect(JSON.stringify(payload)).not.toContain("sk-aug-existing.secret");
    expect(readFileSync(path, "utf8")).toBe(saved);
  });

  for (const override of ["flag", "env"] as const) {
    test(`an explicit gateway ${override} still wins during an environment switch`, async () => {
      await signIn();
      writeOAuthConfig(project, {
        ...connectionRecord("saved", ["connector_new"], "https://old-gateway.example.com"),
        controlUrl: "https://old-control.example.com",
      });
      process.env.AUGENTA_API_URL = override === "env" ? GATEWAY : "https://ignored.example.com";
      route({ [`GET ${CONTROL}/.well-known/augenta.json`]: () =>
        Response.json({ issuer: ISSUER, clientId: "client_public", gateway: "https://discovered.example.com" }) });
      const payload = await runJsonVerb({ projectRoot: project }, {
        ...baseArgs, probe: true, ...(override === "flag" ? { endpoint: GATEWAY } : {}),
      });
      expect(payload.status).toBe("need_workspace");
      expect(requests).toContain(`GET ${GATEWAY}/v1/me`);
    });
  }

  test("reconnect keeps a hand-set ingest path only on the gateway's origin", async () => {
    const { profileId } = await signIn();
    writeOAuthConfig(project, { ...connectionRecord(profileId, ["connector_new"]), controlUrl: CONTROL, ingestUrl: "http://127.0.0.1:30080/v1/experiences" });
    // Capture carries the token, so another origin is not joined here at all.
    expect(loadProjectConfig(project)).toMatchObject({ join: "gateway" });
    seedLink("connector_new", "ws-default");
    route();
    expect((await runJsonVerb({ projectRoot: project }, { json: true, workspaces: ["ws-default"] })).status).toBe("connected");
    expect(JSON.parse(readFileSync(join(project, ".augenta", "config.json"), "utf8"))).not.toHaveProperty("ingestUrl");
    writeOAuthConfig(project, { ...connectionRecord(profileId, ["connector_new"]), controlUrl: CONTROL, ingestUrl: `${GATEWAY}/v2/experiences` });
    expect(loadProjectConfig(project)).toMatchObject({ join: "joined" });
    expect((await runJsonVerb({ projectRoot: project }, { json: true, workspaces: ["ws-default"] })).status).toBe("connected");
    expect(JSON.parse(readFileSync(join(project, ".augenta", "config.json"), "utf8")).ingestUrl).toBe(`${GATEWAY}/v2/experiences`);
    // The file's value is what is judged, not the environment's override.
    writeOAuthConfig(project, { ...connectionRecord(profileId, ["connector_new"]), controlUrl: CONTROL, ingestUrl: "https://evil.example.com/v1/experiences" });
    process.env.AUGENTA_INGEST_URL = `${GATEWAY}/v3/experiences`;
    expect((await runJsonVerb({ projectRoot: project }, { json: true, workspaces: ["ws-default"] })).status).toBe("connected");
    expect(JSON.parse(readFileSync(join(project, ".augenta", "config.json"), "utf8"))).not.toHaveProperty("ingestUrl");
  });

  test("reconnect writes verified destination names", async () => {
    const { profileId } = await signIn();
    writeOAuthConfig(project, { ...connectionRecord(profileId, ["connector_new"]), controlUrl: CONTROL });
    seedLink("connector_new", "ws-default");
    route();
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, workspaces: ["ws-default"] });
    expect(payload.status).toBe("connected");
    const saved = JSON.parse(readFileSync(join(project, ".augenta", "config.json"), "utf8"));
    expect(saved).toMatchObject({ controlUrl: CONTROL, endpoint: GATEWAY, org: { id: "org_1", name: "Example Org" }, workspaces: [{ workspaceId: "ws-default", workspaceName: "Default Workspace" }] });
    expect(saved).not.toHaveProperty("connectorIds");
    expect(saved).not.toHaveProperty("destinations");
    expect(loadProjectConfig(project)?.destinations).toEqual([{ connectorId: "connector_new", workspaceId: "ws-default", workspaceName: "Default Workspace" }]);
    expect(statSync(join(project, ".augenta", "config.json")).mode & 0o777).toBe(0o600);
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
    const { profileId } = await signIn();
    writeOAuthConfig(project, connectionRecord(profileId, ["connector_ws-scratch"]));
    route();
    seedLink("connector_ws-scratch", "ws-scratch");

    const payload = await probeConnection({ projectRoot: project }, baseArgs);

    expect(payload).toMatchObject({
      status: "need_workspace",
      alreadyConnected: true,
      adopted: true,
      // The recorded Workspace, resolved to a NAME, which is what the caller
      // pre-selects with, and this person's own link into it.
      destinations: [
        {
          connectorId: "connector_ws-scratch",
          workspaceId: "ws-scratch",
          workspaceName: "Scratch",
        },
      ],
      unresolvedConnectorIds: [],
    });
  });

  test("an unjoined checkout pre-selects the recorded Workspaces and names no one's link", async () => {
    // A teammate's committed config: the recorded set is still the set the
    // answer re-affirms, but the links behind it are not this person's.
    await signIn("user_2");
    writeSharedConfig(project, {
      profileId: (await signIn("user_2")).profileId,
      destinations: [{ connectorId: "connector_ws-scratch", workspaceId: "ws-scratch", workspaceName: "Saved" }],
      extra: { controlUrl: CONTROL, org: { id: "org_1", name: "Example Org" } },
    });
    seedLink("connector_ws-scratch", "ws-scratch", TEST_USER_ID);
    route();

    const payload = await probeConnection({ projectRoot: project }, baseArgs);

    expect(payload).toMatchObject({
      status: "need_workspace",
      alreadyConnected: true,
      adopted: false,
      destinations: [{ workspaceId: "ws-scratch", workspaceName: "Scratch" }],
      unresolvedConnectorIds: [],
    });
    expect(JSON.stringify(payload)).not.toContain("connector_ws-scratch");
  });

  test("a prior link the user can no longer see is REPORTED, never dropped", async () => {
    // The project is still shipping to it. Omitting it would quietly lose a live
    // destination from the pre-selection and, since the answer is the complete
    // set, from the config on the next reconnect.
    const { profileId } = await signIn();
    writeOAuthConfig(project, connectionRecord(profileId, ["connector_gone"]));
    route(); // nothing seeded — the GET 404s

    const payload = await probeConnection({ projectRoot: project }, baseArgs);

    expect(payload).toMatchObject({
      status: "need_workspace",
      alreadyConnected: true,
      // Still recorded, so still pre-selected; only the link behind it is gone.
      destinations: [{ workspaceId: "ws-default", workspaceName: "Default Workspace" }],
      unresolvedConnectorIds: ["connector_gone"],
    });
    expect((payload.destinations as Array<Record<string, unknown>>)[0]).not.toHaveProperty("connectorId");
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

    // Only the URL crosses: the opener program is fixed per platform (urlOpener).
    expect(browserLaunches).toEqual([`${ISSUER}/device?user_code=OPEN-CODE`]);
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
        projectKey: expect.any(String),
        profileId: profileIdFor(
          { issuer: ISSUER, clientId: "client_public", gateway: GATEWAY },
          "org_1",
        ),
        workspaces: [{ workspaceId: "ws-default", workspaceName: "Default Workspace" }],
        controlUrl: CONTROL,
        org: { id: "org_1", name: "Example Org" },
        endpoint: GATEWAY,
        discoveredGateway: GATEWAY,
        autoRecall: false,
      });
    expect(readLinks(project)).toMatchObject({ userId: TEST_USER_ID, links: [{ workspaceId: "ws-default", connectorId: "connector_new" }] });
    // The new link carries the project's key, which is how this person's other
    // checkouts find it.
    expect((links.get("connector_new")!.metadata as Record<string, unknown>).projectKey).toBe(loadProjectConfig(project)!.projectKey);
    expect(payload.autoRecall).toBe("off");
  });

  test("--auto-recall rides along with --workspace, and a reconnect keeps the explicit answer", async () => {
    await signIn();
    route();
    const on = await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"], autoRecall: true });
    expect(on.autoRecall).toBe("on");
    expect(loadProjectConfig(project)?.autoRecall).toBe(true);

    // No flag on the reconnect: the previous EXPLICIT answer is kept, not reset.
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    expect(loadProjectConfig(project)?.autoRecall).toBe(true);
  });

  test("a config that never recorded an answer is connected with automatic recall off", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    // Simulate a config written before the question existed.
    const path = join(project, ".augenta", "config.json");
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy.autoRecall;
    writeFileSync(path, JSON.stringify(legacy));
    expect(loadProjectConfig(project)?.autoRecall).toBeUndefined();

    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    expect(loadProjectConfig(project)?.autoRecall).toBe(false);
  });

  test("--auto-recall alone changes that one setting and nothing else", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    const path = join(project, ".augenta", "config.json");
    const before = JSON.parse(readFileSync(path, "utf8"));

    const payload = await runJsonVerb({ projectRoot: project }, { json: true, autoRecall: false });
    expect(payload).toMatchObject({ status: "auto_recall_updated", autoRecall: "off" });
    const linksBefore = readFileSync(join(project, ".augenta", "state", "links.json"), "utf8");
    const payload2 = await runJsonVerb({ projectRoot: project }, { json: true, autoRecall: true });
    expect(payload2).toMatchObject({ status: "auto_recall_updated" });
    const after = JSON.parse(readFileSync(path, "utf8"));
    // The links in particular: their joinedAt is the Codex boundary.
    expect(after).toEqual({ ...before, autoRecall: true });
    expect(readFileSync(join(project, ".augenta", "state", "links.json"), "utf8")).toBe(linksBefore);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(project, ".augenta")).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("--auto-recall and --repair-harness need this checkout to have joined", async () => {
    // Automatic recall's answer is in the shared file, so it changes for everyone
    // who pulls it; a checkout that never joined has not agreed to the connection.
    const { profileId } = await signIn();
    writeSharedConfig(project, {
      profileId,
      destinations: [{ connectorId: "connector_new", workspaceId: "ws-default" }],
      extra: { controlUrl: CONTROL, endpoint: GATEWAY },
    });
    const bytes = readFileSync(join(project, ".augenta", "config.json"), "utf8");
    route();
    expect(await runJsonVerb({ projectRoot: project }, { json: true, autoRecall: true }))
      .toMatchObject({ status: "error", code: "not_joined" });
    expect(await runJsonVerb({ projectRoot: project }, { json: true, repairHarness: true, harness: "codex" }))
      .toMatchObject({ status: "error", code: "not_joined" });
    expect(readFileSync(join(project, ".augenta", "config.json"), "utf8")).toBe(bytes);
    expect(requests).toEqual([]);
    // Health reads an unjoined checkout without tripping over its missing routes.
    expect(await runJsonVerb({ projectRoot: project }, { json: true, health: true }))
      .toMatchObject({ status: "capture_health", gate: "not_adopted", destinations: 0, nextStep: "adopt" });
  });

  test("--repair-harness never touches a link that is not this person's", async () => {
    const { profileId } = await signIn();
    writeOAuthConfig(project, connectionRecord(profileId, ["connector_new"]));
    seedLink("connector_new", "ws-default", "user_2");
    manager = true; // a manager can read it, which is exactly why the owner is checked
    route();
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, repairHarness: true, harness: "codex" });
    expect(payload).toMatchObject({ status: "error", repaired: [], failed: [expect.objectContaining({ connectorId: "connector_new" })] });
    expect(requests.some((request) => request.startsWith("PATCH "))).toBe(false);
  });

  test("a pre-release config's Connectors are reused only when they are this person's own", async () => {
    // That shape recorded the connecting user's links in the shared file itself.
    // It no longer parses; its ids are candidates to reuse, never routes, and a
    // teammate's id there is neither reused nor named.
    const { profileId } = await signIn();
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({
      authMode: "oauth", profileId, controlUrl: CONTROL, endpoint: GATEWAY,
      destinations: [
        { connectorId: "connector_mine", workspaceId: "ws-default" },
        { connectorId: "connector_theirs", workspaceId: "ws-scratch" },
      ],
    }));
    expect(loadProjectConfig(project)).toBeUndefined();
    seedLink("connector_mine", "ws-default");
    seedLink("connector_theirs", "ws-scratch", "user_2");
    manager = true;
    route();

    // Unparseable, so nothing records its environment: name it, as the skill does.
    const probe = await runJsonVerb({ projectRoot: project }, { ...baseArgs, probe: true });
    expect(probe.destinations).toEqual([{ connectorId: "connector_mine", workspaceId: "ws-default", workspaceName: "Default Workspace" }]);
    expect(JSON.stringify(probe)).not.toContain("connector_theirs");

    requests = [];
    const payload = await runJsonVerb({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default", "ws-scratch"] });
    expect(payload).toMatchObject({
      status: "connected",
      destinations: [
        { connectorId: "connector_mine", action: "adopted" },
        { connectorId: "connector_ws-scratch", action: "created" },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("connector_theirs");
    expect(requests.some((request) => request.includes("connector_theirs") && !request.startsWith("GET "))).toBe(false);
    expect(loadProjectConfig(project)!.connectorIds).toEqual(["connector_mine", "connector_ws-scratch"]);
  });

  test("an unchanged re-affirmation leaves the shared file byte-identical", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default", "ws-scratch"] });
    const bytes = readFileSync(join(project, ".augenta", "config.json"), "utf8");
    requests = [];
    expect(await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default", "ws-scratch"] }))
      .toMatchObject({ status: "connected" });
    expect(readFileSync(join(project, ".augenta", "config.json"), "utf8")).toBe(bytes);
    expect(requests.filter((request) => !request.startsWith("GET "))).toEqual([]);
  });

  test("a teammate choosing different Workspaces names what the project stops feeding", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default", "ws-scratch"] });
    rmSync(join(project, ".augenta", "state"), { recursive: true, force: true });
    await signIn("user_2");
    const payload = await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    // Dropped from the shared set for everyone; the teammate has no link of their
    // own there to name, and the committer's is never named.
    expect(payload).toMatchObject({
      status: "connected",
      destinations: [{ connectorId: "connector_new_user_2", action: "created" }],
      removed: [{ workspaceId: "ws-scratch", workspaceName: "Scratch", disposition: "left_in_place" }],
    });
    expect((payload.removed as Array<Record<string, unknown>>)[0]).not.toHaveProperty("connectorId");
    expect(loadProjectConfig(project)!.workspaces).toEqual([{ workspaceId: "ws-default", workspaceName: "Default Workspace" }]);
  });

  test("--auto-recall alone needs a readable connection and refuses other verbs", async () => {
    expect(await runJsonVerb({ projectRoot: project }, { json: true, autoRecall: false }))
      .toMatchObject({ status: "error", code: "not_connected" });
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
    for (const extra of [{ probe: true }, { login: true }, { createWorkspace: "x" }, { health: true }, { repairHarness: true, harness: "codex" as const }]) {
      expect(await runJsonVerb({ projectRoot: project }, { json: true, autoRecall: false, ...extra }))
        .toMatchObject({ status: "error", code: "conflicting_verbs" });
    }
  });

  /** A fresh checkout of a committed config — a teammate's clone, or another
   *  clone, worktree or cloud session of the same person: same file, but a
   *  sign-in store of its own and no links of its own. */
  const teammateCheckout = () => {
    rmSync(join(project, ".augenta", "state"), { recursive: true, force: true });
    rmSync(authHome, { recursive: true, force: true });
    authHome = mkdtempSync(join(tmpdir(), "aug-json-auth-b-"));
    process.env.AUGENTA_AUTH_HOME = authHome;
  };
  const mutations = () => requests.filter((request) => !request.startsWith("GET "));

  test("the same person's fresh checkout joins with --adopt and reuses their own link", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    const configBytes = readFileSync(join(project, ".augenta", "config.json"), "utf8");
    teammateCheckout();

    expect(await runJsonVerb({ projectRoot: project }, { json: true, probe: true }))
      .toMatchObject({ status: "need_login", alreadyConnected: true, adopted: false, configTracked: false });
    expect(await runJsonVerb({ projectRoot: project }, { json: true, adopt: true })).toMatchObject({ status: "need_login" });
    expect(captureEnabled(loadProjectConfig(project))).toBe(false);

    await signIn();
    requests = [];
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, adopt: true });
    expect(payload).toMatchObject({
      status: "adopted",
      destinations: [{ connectorId: "connector_new", workspaceId: "ws-default", action: "adopted" }],
      organization: "Example Org",
    });
    // Found by the project's key, not minted again, and not relabelled: every
    // cloud session and worktree joins like this.
    expect(mutations()).toEqual([]);
    expect(readFileSync(join(project, ".augenta", "config.json"), "utf8")).toBe(configBytes);
    expect(captureEnabled(loadProjectConfig(project))).toBe(true);
  });

  for (const asManager of [false, true]) {
    test(`a teammate${asManager ? " who manages the organization" : ""} joins with their own link, never the committer's`, async () => {
      await signIn();
      route();
      await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
      const configBytes = readFileSync(join(project, ".augenta", "config.json"), "utf8");
      const committers = JSON.stringify(links.get("connector_new"));
      teammateCheckout();
      await signIn("user_2"); // same organization, so the same profile id
      // A manager can read and list everyone's links, and ship through them; the
      // plugin must still pick only this person's own.
      manager = asManager;
      requests = [];

      const payload = await runJsonVerb({ projectRoot: project }, { json: true, adopt: true });

      expect(payload).toMatchObject({
        status: "adopted",
        destinations: [{ connectorId: "connector_new_user_2", workspaceId: "ws-default", action: "created" }],
      });
      expect(mutations()).toEqual([`POST ${GATEWAY}/v1/connectors`]);
      expect(links.get("connector_new_user_2")).toMatchObject({ ownerUserId: "user_2", metadata: { projectKey: loadProjectConfig(project)!.projectKey } });
      expect(JSON.stringify(links.get("connector_new"))).toBe(committers);
      expect(readFileSync(join(project, ".augenta", "config.json"), "utf8")).toBe(configBytes);
      expect(readLinks(project)).toMatchObject({ userId: "user_2", links: [{ connectorId: "connector_new_user_2" }] });
      expect(captureEnabled(loadProjectConfig(project))).toBe(true);
    });
  }

  test("duplicate links of one person resolve to the oldest, deterministically", async () => {
    const { profileId } = await signIn();
    writeSharedConfig(project, {
      profileId,
      destinations: [{ connectorId: "unused", workspaceId: "ws-default" }],
      extra: { controlUrl: CONTROL, endpoint: GATEWAY, org: { id: "org_1", name: "Example Org" } },
    });
    const metadata = { projectKey: TEST_PROJECT_KEY };
    seedLink("connector_later", "ws-default", TEST_USER_ID, { metadata, createdAt: "2026-09-02T00:00:00.000Z" });
    seedLink("connector_first", "ws-default", TEST_USER_ID, { metadata, createdAt: "2026-09-01T00:00:00.000Z" });
    seedLink("connector_other_project", "ws-default", TEST_USER_ID, { metadata: { projectKey: "elsewhere" }, createdAt: "2026-08-01T00:00:00.000Z" });
    route();
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, adopt: true });
    expect(payload).toMatchObject({ status: "adopted", destinations: [{ connectorId: "connector_first", action: "adopted" }] });
    expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
  });

  test("joining refuses a sign-in to another organization", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    teammateCheckout();
    await saveDeviceProfile(
      { issuer: ISSUER, clientId: "client_public", gateway: GATEWAY },
      { accessToken: "access-other", refreshToken: "refresh-other", expiresAt: Date.now() + 3_600_000 },
      { userId: "user_2", orgId: "org_2" },
    );
    expect(await runJsonVerb({ projectRoot: project }, { json: true, adopt: true }))
      .toMatchObject({ status: "error", code: "org_mismatch", organization: "Example Org" });
    expect(readLinks(project)).toBeUndefined();
  });

  test("joining needs every recorded Workspace, and creates nothing when one is out of reach", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default", "ws-scratch"] });
    teammateCheckout();
    await signIn("user_2");
    // Not a member of Scratch: the platform would refuse their link into it.
    liveWorkspaces = liveWorkspaces.filter((workspace) => workspace.id !== "ws-scratch");
    requests = [];
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, adopt: true });
    expect(payload).toMatchObject({
      status: "error",
      code: "destinations_unreachable",
      reachable: [{ workspaceId: "ws-default" }],
      unreachable: [{ workspaceId: "ws-scratch", workspaceName: "Scratch" }],
    });
    expect(String(payload.message)).toContain("you may need to be added to that Workspace");
    expect(mutations()).toEqual([]);
    expect(readLinks(project)).toBeUndefined();
    expect(captureEnabled(loadProjectConfig(project))).toBe(false);
  });

  test("joining is all or nothing, and a retry reuses what the failed join made", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default", "ws-scratch"] });
    teammateCheckout();
    await signIn("user_2");
    route({ [`POST ${GATEWAY}/v1/connectors`]: (_query, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { workspaceId: string };
      if (body.workspaceId === "ws-scratch") return new Response("refused", { status: 403 });
      seedLink("connector_new_user_2", body.workspaceId, "user_2", { ...body, createdAt: new Date().toISOString() });
      return Response.json({ connector: links.get("connector_new_user_2") });
    } });
    const payload = await runJsonVerb({ projectRoot: project }, { json: true, adopt: true });
    expect(payload).toMatchObject({ status: "error", code: "join_failed", failed: [{ workspaceId: "ws-scratch" }] });
    expect(readLinks(project)).toBeUndefined();
    expect(captureEnabled(loadProjectConfig(project))).toBe(false);

    route();
    requests = [];
    expect(await runJsonVerb({ projectRoot: project }, { json: true, adopt: true })).toMatchObject({
      status: "adopted",
      destinations: [
        { connectorId: "connector_new_user_2", action: "adopted" },
        { connectorId: "connector_ws-scratch_user_2", action: "created" },
      ],
    });
    expect(mutations()).toEqual([`POST ${GATEWAY}/v1/connectors`]);
  });

  test("a failed lookup of existing links creates nothing", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    teammateCheckout();
    await signIn();
    route({ [`GET ${GATEWAY}/v1/connectors`]: () => new Response("unavailable", { status: 503 }) });
    requests = [];
    expect(await runJsonVerb({ projectRoot: project }, { json: true, adopt: true }))
      .toMatchObject({ status: "error", code: "join_failed", failed: [{ workspaceId: "ws-default" }] });
    expect(mutations()).toEqual([]);
    expect(readLinks(project)).toBeUndefined();
  });

  test("a Workspace added by a pulled change never inherits this checkout's backlog", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    // Records spooled while only the first destination was joined. Connect
    // registered that destination when it linked it, so the outbox has its map.
    const box = new Outbox(project);
    box.append([{ src: "claude-code", sid: "s", proj: project, ts: new Date().toISOString(), seq: 0, kind: "msg", role: "user", text: "before B" }]);
    // A teammate adds a second Workspace and the change is pulled.
    const path = join(project, ".augenta", "config.json");
    const pulled = JSON.parse(readFileSync(path, "utf8"));
    pulled.workspaces.push({ workspaceId: "ws-scratch", workspaceName: "Scratch" });
    writeFileSync(path, JSON.stringify(pulled));
    expect(captureEnabled(loadProjectConfig(project))).toBe(false);

    expect(await runJsonVerb({ projectRoot: project }, { json: true, adopt: true })).toMatchObject({ status: "adopted" });
    const cursor = JSON.parse(readFileSync(box.cursorPath, "utf8")) as { links: Record<string, number> };
    expect(cursor.links["connector_new"]).toBe(0);
    expect(cursor.links["connector_ws-scratch"]).toBeGreaterThan(0);
  });

  test("another person reconnecting here never sees the first person's Connectors, and hears what stays unsent", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    new Outbox(project).append([{ src: "claude-code", sid: "s", proj: project, ts: new Date().toISOString(), seq: 0, kind: "msg", role: "user", text: "the first person's" }]);
    await signIn("user_2"); // a plain member: the first person's link reads as not found
    requests = [];
    const payload = await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    expect(payload).toMatchObject({ status: "connected", destinations: [{ connectorId: "connector_new_user_2" }] });
    expect(payload).not.toHaveProperty("unresolvedConnectorIds");
    expect(JSON.stringify(payload)).not.toContain('"connector_new"');
    expect(payload.unsentFromAnotherSignIn).toBeGreaterThan(0);
    expect(requests).not.toContain(`GET ${GATEWAY}/v1/connectors/connector_new`);
  });

  test("an undetected harness does not relabel, or PATCH, a link that has one", async () => {
    const keys = ["CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_HOME", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CLAUDECODE"];
    const saved = keys.map((key) => process.env[key]);
    try {
      for (const key of keys) delete process.env[key];
      await signIn();
      route();
      await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, harness: "codex", workspaces: ["ws-default"] });
      requests = [];
      expect(await runJsonVerb({ projectRoot: project }, { json: true, adopt: true })).toMatchObject({ status: "adopted" });
      expect(requests.some((request) => request.startsWith("PATCH "))).toBe(false);
      expect(links.get("connector_new")!.harness).toBe("codex");
    } finally {
      keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    }
  });

  test("another person joining on this machine starts at the end of the spool", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    new Outbox(project).append([{ src: "claude-code", sid: "s", proj: project, ts: new Date().toISOString(), seq: 0, kind: "msg", role: "user", text: "the first person's" }]);
    await signIn("user_2"); // same organization, same profile id, another person
    expect(captureEnabled(loadProjectConfig(project))).toBe(false);
    const joined = await runJsonVerb({ projectRoot: project }, { json: true, adopt: true });
    // Reported, not silent: those records could go only through the first person's links.
    expect(joined.status).toBe("adopted");
    expect(typeof joined.unsentFromAnotherSignIn).toBe("number");
    expect(joined.unsentFromAnotherSignIn as number).toBeGreaterThan(0);
    const cursor = JSON.parse(readFileSync(new Outbox(project).cursorPath, "utf8")) as { links: Record<string, number> };
    // Their link never carries the first person's records.
    expect(Object.keys(cursor.links)).toEqual(["connector_new_user_2"]);
    expect(cursor.links["connector_new_user_2"]).toBeGreaterThan(0);
  });

  test("a lapsed sign-in to the project's organization is need_login, not org_mismatch", async () => {
    await signIn(); // org_1, the project's organization
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    teammateCheckout();
    await signIn(); // org_1 again, but its token will be refused
    await saveDeviceProfile(
      { issuer: ISSUER, clientId: "client_public", gateway: GATEWAY },
      { accessToken: "access-other", refreshToken: "refresh-other", expiresAt: Date.now() + 3_600_000 },
      { userId: "user_2", orgId: "org_2" },
    );
    route({
      [`GET ${GATEWAY}/v1/me`]: (_query, init) =>
        new Headers(init?.headers).get("authorization") === "Bearer access-other"
          ? Response.json({ user: { id: "user_2", name: "B", email: "b@example.com" }, org: { id: "org_2", name: "Other Org" } })
          : new Response("revoked", { status: 401 }),
      [`POST ${ISSUER}/oauth2/token`]: () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    expect(await runJsonVerb({ projectRoot: project }, { json: true, adopt: true }))
      .toMatchObject({ status: "need_login", message: expect.stringContaining("needs renewing") });
  });

  test("joining uses the recorded environment and refuses anything riding along", async () => {
    await signIn();
    route();
    await connectToWorkspaces({ projectRoot: project }, { ...baseArgs, workspaces: ["ws-default"] });
    teammateCheckout();
    process.env.AUGENTA_CONTROL_URL = "https://other.example.com";
    requests = [];
    expect(await runJsonVerb({ projectRoot: project }, { json: true, adopt: true }))
      .toMatchObject({ status: "error", code: "environment_mismatch" });
    expect(requests).toEqual([]);
    delete process.env.AUGENTA_CONTROL_URL;
    for (const extra of [{ probe: true }, { workspaces: ["ws-default"] }, { autoRecall: true }, { controlUrl: CONTROL }, { login: true }]) {
      expect(await runJsonVerb({ projectRoot: project }, { json: true, adopt: true, ...extra }))
        .toMatchObject({ status: "error", code: "conflicting_verbs" });
    }
  });

  test("a network that blocks Augenta is named host by host, before anything is asked", async () => {
    // The first request of every verb is discovery; a refused tunnel there used
    // to reach the user as "cannot reach Augenta: Request was cancelled."
    globalThis.fetch = (async (url: string | URL | Request) => {
      requests.push(`GET ${String(url)}`);
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("Request was cancelled.", {
          cause: Object.assign(new Error("Proxy response (403) !== 200 when HTTP Tunneling"), { name: "AbortError", code: "UND_ERR_ABORTED" }),
        }), { code: 0 }),
      });
    }) as unknown as typeof fetch;
    const payload = await runJsonVerb({ projectRoot: project }, { ...baseArgs, probe: true });
    expect(payload).toMatchObject({
      status: "error",
      code: "network_blocked",
      hosts: [{ host: "control.example.com", ok: false, reason: "a proxy refused it (403)" }],
    });
    expect(String(payload.message)).toContain("this network does not let connect reach control.example.com");
    expect(() => statSync(join(project, ".augenta"))).toThrow();
  });

  test("a failure every host answers through is reported as itself, not as a block", async () => {
    let first = true;
    route({
      [`${CONTROL}/.well-known/augenta.json`]: () => {
        if (first) { first = false; throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }
        return Response.json({ issuer: ISSUER, clientId: "client_public", gateway: GATEWAY });
      },
      [`${ISSUER}/.well-known/openid-configuration`]: () => Response.json({ issuer: ISSUER }),
      [`GET ${GATEWAY}/v1/me`]: () => Response.json({ error: "authentication required" }, { status: 401 }),
    });
    expect(await runJsonVerb({ projectRoot: project }, { ...baseArgs, probe: true }))
      .toMatchObject({ status: "error", code: "failed", message: expect.stringContaining("connection was cut") });
  });

  test("a throwaway session outside any checkout is refused before anything is asked or sent", async () => {
    process.env.AUGENTA_EPHEMERAL = "1";
    route();
    for (const extra of [{ probe: true }, { workspaces: ["ws-default"] }, { adopt: true }]) {
      expect(await runJsonVerb({ projectRoot: project }, { ...baseArgs, ...extra }))
        .toMatchObject({ status: "error", code: "ephemeral_project", session: { ephemeral: true, kind: "declared" } });
    }
    expect(requests).toEqual([]);
    expect(() => statSync(join(project, ".augenta"))).toThrow();

    // The same session in a Git checkout keeps its config through the repo.
    execFileSync("git", ["init", "-q"], { cwd: project });
    const payload = await runJsonVerb({ projectRoot: project }, { ...baseArgs, probe: true });
    expect(payload).toMatchObject({ status: "need_login", session: { ephemeral: true } });
  });

  test("an API-key project or no project has nothing to join", async () => {
    route();
    expect(await runJsonVerb({ projectRoot: project }, { json: true, adopt: true })).toMatchObject({ code: "not_connected" });
    writeApiKeyConfig(project, "sk-aug-test.secret");
    expect(await runJsonVerb({ projectRoot: project }, { json: true, adopt: true })).toMatchObject({ code: "oauth_connection_required" });
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
      loadProjectConfig(project)!.connectorIds,
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
    writeOAuthConfig(project, connectionRecord("profile_stale", ["connector_new"]));
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
    writeOAuthConfig(project, connectionRecord("profile_stale", ["connector_new", "connector_ws-scratch"]));
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
      loadProjectConfig(project)!.connectorIds,
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
    const written = loadProjectConfig(project)!.connectorIds!;
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
    writeOAuthConfig(project, connectionRecord("profile_stale", ["connector_new", "connector_ws-scratch"]));
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
    writeOAuthConfig(project, {
      ...connectionRecord("profile_stale", []),
      destinations: [{ connectorId: "connector_new", workspaceId: "ws-default" }, { connectorId: "connector_ghost", workspaceId: "ws-scratch" }],
    });
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
      loadProjectConfig(project)!.connectorIds,
    ).toEqual(["connector_new"]);
  });

  test("an unreadable prior link does not abort the whole reconnect", async () => {
    // currentConnector throws on anything but 403/404; priorLinks must absorb that
    // — an unreadable prior link is exactly when reconnecting has to keep working.
    await signIn();
    writeOAuthConfig(project, connectionRecord("profile_stale", ["connector_boom"]));
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
    writeOAuthConfig(project, connectionRecord("profile_stale", ["connector_new"]));
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
