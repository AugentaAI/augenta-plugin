/**
 * Tests for config.ts — project-scoped config resolution and the consent gate.
 *
 * Contract under test: project consent and a Connector or platform key travel
 * together in `<project>/.augenta/config.json` (found by walking UP from cwd); no env var
 * and no home-dir file can stand in for it; AUGENTA_INGEST_URL only redirects
 * the destination; AUGENTA_CAPTURE_ENABLED=0|false kills capture everywhere.
 *
 * Run: bun test capture/config.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_GATEWAY,
  DEFAULT_CONTROL_URL,
  controlUrl,
  resolveProjectRoot,
  loadProjectConfig,
  projectConfig,
  gatewayBase,
  experiencesUrl,
  captureEnabled,
  captureGate,
  captureKilled,
  effectiveCaptureSince,
  type ProjectConfig,
} from "./config";
import { writeAdoption } from "./adoption";

const ENV_KEYS = ["AUGENTA_CONTROL_URL", "AUGENTA_API_URL", "AUGENTA_INGEST_URL", "AUGENTA_CAPTURE_ENABLED", "AUGENTA_AUTH_HOME"] as const;
let saved: Record<string, string | undefined>;
let project: string;

function writeConfig(root: string, config: unknown): void {
  mkdirSync(join(root, ".augenta"), { recursive: true });
  writeFileSync(join(root, ".augenta", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // Physical path: the project lookup realpaths, and macOS tmpdir() is under the
  // /var → /private/var symlink, so a logical fixture never compares equal there.
  project = realpathSync(mkdtempSync(join(tmpdir(), "aug-cfg-")));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  rmSync(project, { recursive: true, force: true });
});

describe("resolveProjectRoot", () => {
  test("finds .augenta/config.json in the cwd itself", () => {
    writeConfig(project, { authMode: "api-key", apiKey: "k" });
    expect(resolveProjectRoot(project)).toBe(project);
  });

  test("walks up from a nested subdirectory to the project root", () => {
    writeConfig(project, { authMode: "api-key", apiKey: "k" });
    const deep = join(project, "src", "utils", "nested");
    mkdirSync(deep, { recursive: true });
    expect(resolveProjectRoot(deep)).toBe(project);
  });

  test("undefined when no ancestor has a config (and for undefined cwd)", () => {
    expect(resolveProjectRoot(join(project, "nowhere"))).toBeUndefined();
    expect(resolveProjectRoot(undefined)).toBeUndefined();
  });
});

describe("loadProjectConfig", () => {
  test("api-key configs accept optional coordinates but exactly one destination", () => {
    writeConfig(project, { authMode: "api-key", apiKey: "key" });
    expect(loadProjectConfig(project)).toEqual({ authMode: "api-key", apiKey: "key", projectRoot: project });
    const destination = { connectorId: "connector_one", workspaceId: "ws-one", workspaceName: " One " };
    writeConfig(project, { authMode: "api-key", apiKey: "key", org: { id: " org_one ", name: " Example " }, destinations: [destination] });
    expect(loadProjectConfig(project)).toMatchObject({ org: { id: "org_one", name: "Example" }, destinations: [{ ...destination, workspaceName: "One" }] });
    for (const destinations of [[], [destination, destination], [null]]) {
      writeConfig(project, { authMode: "api-key", apiKey: "key", destinations });
      expect(loadProjectConfig(project)).toBeUndefined();
    }
  });

  test("all URL settings use flag, env, file, then default precedence", () => {
    writeConfig(project, {
      authMode: "api-key", apiKey: "key",
      controlUrl: " https://control.example.com/// ",
      endpoint: " https://gateway.example.com/// ",
      ingestUrl: " https://ingest.example.com/v1/experiences/ ",
    });
    const cfg = loadProjectConfig(project)!;
    expect(controlUrl(cfg)).toBe("https://control.example.com");
    expect(gatewayBase(cfg)).toBe("https://gateway.example.com");
    expect(experiencesUrl(cfg)).toBe("https://ingest.example.com/v1/experiences");
    process.env.AUGENTA_CONTROL_URL = "https://env-control.example.com/";
    process.env.AUGENTA_API_URL = "https://env-gateway.example.com/";
    process.env.AUGENTA_INGEST_URL = "https://env-ingest.example.com/experiences";
    expect(controlUrl(cfg)).toBe("https://env-control.example.com");
    expect(gatewayBase(cfg)).toBe("https://env-gateway.example.com");
    expect(experiencesUrl(cfg)).toBe("https://env-ingest.example.com/experiences");
    expect(controlUrl(cfg, " https://flag-control.example.com/ ")).toBe("https://flag-control.example.com");
    expect(gatewayBase(cfg, " https://flag-gateway.example.com/ ")).toBe("https://flag-gateway.example.com");
    for (const key of ENV_KEYS) delete process.env[key];
    expect(controlUrl()).toBe(DEFAULT_CONTROL_URL);
    expect(gatewayBase()).toBe(DEFAULT_GATEWAY);
    expect(experiencesUrl()).toBe(`${DEFAULT_GATEWAY}/v1/experiences`);
  });

  test("autoRecall is an optional boolean; absent stays absent, anything else is unparseable", () => {
    const base = { authMode: "api-key", apiKey: "k" };
    writeConfig(project, { ...base, autoRecall: false });
    expect(loadProjectConfig(project)?.autoRecall).toBe(false);
    writeConfig(project, { ...base, autoRecall: true });
    expect(loadProjectConfig(project)?.autoRecall).toBe(true);
    // Absent is a config written before connect asked; it must not read as off.
    writeConfig(project, base);
    expect(loadProjectConfig(project)?.autoRecall).toBeUndefined();
    writeConfig(project, { ...base, autoRecall: "off" });
    expect(loadProjectConfig(project)).toBeUndefined();
  });

  test("parses platform-key mode and optional endpoint", () => {
    writeConfig(project, { authMode: "api-key", apiKey: "key-test", endpoint: "https://gw.example.com/" });
    expect(loadProjectConfig(project)).toEqual({
      authMode: "api-key",
      apiKey: "key-test",
      endpoint: "https://gw.example.com",
      projectRoot: project,
    });
  });

  test("parses recorded destinations and derives Connector ids", () => {
    writeConfig(project, {
      authMode: "oauth",
      profileId: "profile_1",
      destinations: [{ connectorId: "link_1", workspaceId: "ws-one" }, { connectorId: "link_2", workspaceId: "ws-two" }],
    });
    expect(loadProjectConfig(project)).toEqual({
      authMode: "oauth",
      profileId: "profile_1",
      connectorIds: ["link_1", "link_2"],
      destinations: [{ connectorId: "link_1", workspaceId: "ws-one" }, { connectorId: "link_2", workspaceId: "ws-two" }],
      projectRoot: project,
    });
  });

  describe("the destination set — destinations[].connectorId routes", () => {
    test("normalizes the discovery marker without using it as a routing override", () => {
      writeConfig(project, { authMode: "api-key", apiKey: "key-test", endpoint: "https://chosen.example.com", discoveredGateway: " https://discovered.example.com/// " });
      const config = loadProjectConfig(project);
      expect(config?.discoveredGateway).toBe("https://discovered.example.com");
      expect(gatewayBase(config)).toBe("https://chosen.example.com");
      writeConfig(project, { authMode: "api-key", apiKey: "key-test", discoveredGateway: 42 });
      expect(loadProjectConfig(project)).toBeUndefined();
    });
    test("connectorIds-only configs require a reconnect", () => {
      writeConfig(project, { authMode: "oauth", profileId: "profile_1", connectorIds: ["link_1"] });
      expect(loadProjectConfig(project)).toBeUndefined();
    });
    test("a scalar `connectorId` is NOT read forward", () => {
      // 0.7.0 renamed the routing surface end to end. Honouring a scalar would
      // be guessing at a routing decision made against the old surface, so it
      // falls through to the ordinary unparseable-config reconnect prompt.
      writeConfig(project, {
        authMode: "oauth",
        profileId: "profile_1",
        connectorId: "link_1",
      });
      expect(loadProjectConfig(project)).toBeUndefined();
    });

    test("a config keyed by any other spelling is unparseable", () => {
      // A pre-0.7.0 project lands here: it has a routing key, just not this
      // one. Reconnecting is the ask; silently capturing nothing is not.
      writeConfig(project, {
        authMode: "oauth",
        profileId: "profile_1",
        someOtherRoutingKey: ["link_1"],
      });
      expect(loadProjectConfig(project)).toBeUndefined();
    });

    test("duplicates collapse — one id must never become two cursor keys", () => {
      writeConfig(project, {
        authMode: "oauth",
        profileId: "profile_1",
        destinations: ["link_1", " link_1 ", "link_2"].map((connectorId) => ({ connectorId, workspaceId: " ws-one " })),
      });
      expect(loadProjectConfig(project)?.connectorIds).toEqual(["link_1", "link_2"]);
    });

    test("an empty or partly-invalid set is unparseable, never a partial route", () => {
      // Shipping to a SUBSET of the destinations the user consented to, while
      // reporting success, is the outcome worth failing closed to avoid.
      const valid = { connectorId: "link_1", workspaceId: "ws-one" };
      for (const destinations of [[], [valid, 42], [valid, { connectorId: "link_2", workspaceId: "" }], [valid, null], [valid, { workspaceId: "ws-two" }], [valid, { ...valid, workspaceName: 42 }], "not_array"]) {
        writeConfig(project, { authMode: "oauth", profileId: "profile_1", destinations });
        expect(loadProjectConfig(project)).toBeUndefined();
      }
    });
  });

  test("the pre-0.4.0 `workos` spelling is not accepted", () => {
    // Not migrated on purpose: an unparseable config becomes session-start's
    // one-time reconnect prompt, which is a clear ask instead of a stale routing
    // decision reused behind the user's back.
    // Routing is otherwise VALID here, so the rejection isolates `authMode`.
    writeConfig(project, {
      authMode: "workos",
      profileId: "profile_1",
      destinations: [{ connectorId: "link_1", workspaceId: "ws-one" }],
    });
    expect(loadProjectConfig(project)).toBeUndefined();
  });

  test("undefined on missing, malformed, legacy, or incomplete config", () => {
    expect(loadProjectConfig(project)).toBeUndefined();
    writeConfig(project, "not json {");
    expect(loadProjectConfig(project)).toBeUndefined();
    writeConfig(project, { authMode: "api-key", apiKey: "   " });
    expect(loadProjectConfig(project)).toBeUndefined();
    writeConfig(project, { authMode: "api-key", apiKey: 42 });
    expect(loadProjectConfig(project)).toBeUndefined();
    writeConfig(project, { apiKey: "legacy" });
    expect(loadProjectConfig(project)).toBeUndefined();
    writeConfig(project, { authMode: "oauth", profileId: "profile_1" });
    expect(loadProjectConfig(project)).toBeUndefined();
  });

  test("projectConfig = resolve + load in one call", () => {
    writeConfig(project, { authMode: "api-key", apiKey: "k" });
    const deep = join(project, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(projectConfig(deep)?.apiKey).toBe("k");
    expect(projectConfig(undefined)).toBeUndefined();
  });
});

describe("URL resolution", () => {
  const cfg = (endpoint?: string): ProjectConfig => ({
    authMode: "api-key",
    apiKey: "k",
    projectRoot: "/p",
    ...(endpoint ? { endpoint } : {}),
  });

  test("defaults to the hosted gateway's /v1/experiences", () => {
    expect(gatewayBase()).toBe(DEFAULT_GATEWAY);
    expect(experiencesUrl()).toBe(`${DEFAULT_GATEWAY}/v1/experiences`);
  });

  test("cfg.endpoint overrides the default (trailing slashes stripped)", () => {
    expect(gatewayBase(cfg("https://gw.example.com///"))).toBe("https://gw.example.com");
    expect(experiencesUrl(cfg("https://gw.example.com/"))).toBe("https://gw.example.com/v1/experiences");
  });

  test("AUGENTA_API_URL beats cfg.endpoint", () => {
    process.env.AUGENTA_API_URL = "https://env.example.com";
    expect(gatewayBase(cfg("https://gw.example.com"))).toBe("https://env.example.com");
  });

  test("AUGENTA_INGEST_URL replaces the experiences URL wholesale", () => {
    process.env.AUGENTA_INGEST_URL = "http://127.0.0.1:8787";
    expect(experiencesUrl(cfg("https://gw.example.com"))).toBe("http://127.0.0.1:8787");
  });
});

describe("captureEnabled — a readable config, a sign-in here, and a joined checkout", () => {
  // A browser config may now be committed, so the file alone is not this
  // checkout's consent: capture also needs this machine's sign-in for the
  // config's profile and this checkout's adoption of its destinations.
  let authHome: string;
  const PROFILE = "profile_1";
  const oauth = (connectorIds: string[] = ["link_1"]) =>
    ({ authMode: "oauth" as const, profileId: PROFILE, connectorIds, projectRoot: project });
  const signIn = (updatedAt = new Date().toISOString(), expiresAt = Date.now() + 3_600_000) => {
    mkdirSync(authHome, { recursive: true });
    writeFileSync(join(authHome, "auth.json"), JSON.stringify({
      version: 1,
      profiles: { [PROFILE]: { accessToken: "a", refreshToken: "r", expiresAt, updatedAt } },
    }));
  };
  const join_ = (connectorIds: string[], adoptedAt = new Date().toISOString()) =>
    writeAdoption(project, { profileId: PROFILE, connectorIds, adoptedAt });
  beforeEach(() => {
    authHome = realpathSync(mkdtempSync(join(tmpdir(), "aug-cfg-auth-")));
    process.env.AUGENTA_AUTH_HOME = authHome;
  });
  afterEach(() => {
    rmSync(authHome, { recursive: true, force: true });
  });

  test("an API-key config is its own consent; no config is none", () => {
    expect(captureEnabled({ authMode: "api-key", apiKey: "k", projectRoot: project })).toBe(true);
    expect(captureEnabled(undefined)).toBe(false);
  });

  test("a browser config with no sign-in here is signed_out, and does not capture", () => {
    join_(["link_1"]);
    expect(captureGate(oauth())).toBe("signed_out");
    expect(captureEnabled(oauth())).toBe(false);
  });

  test("signed in but not joined is not_adopted; joined is live", () => {
    signIn();
    expect(captureGate(oauth())).toBe("not_adopted");
    join_(["link_1"]);
    expect(captureGate(oauth())).toBe("live");
    expect(captureEnabled(oauth())).toBe(true);
  });

  test("a pulled change that ADDS a destination stops capture; dropping one does not", () => {
    signIn();
    join_(["link_1", "link_2"]);
    expect(captureGate(oauth(["link_1"]))).toBe("live");
    expect(captureGate(oauth(["link_1", "link_2", "link_3"]))).toBe("not_adopted");
  });

  test("joining under another sign-in does not cover this config", () => {
    signIn();
    writeAdoption(project, { profileId: "profile_other", connectorIds: ["link_1"], adoptedAt: new Date().toISOString() });
    expect(captureGate(oauth())).toBe("not_adopted");
  });

  test("an expired sign-in keeps its profile, so capture keeps queueing", () => {
    signIn(new Date(0).toISOString(), Date.now() - 60_000);
    join_(["link_1"]);
    expect(captureGate(oauth())).toBe("live");
  });

  test("the Codex boundary is the later of connecting and joining", () => {
    const connected = "2026-09-01T00:00:00.000Z";
    const cfg = { ...oauth(), captureSince: connected };
    expect(effectiveCaptureSince(cfg)).toBe(connected);
    join_(["link_1"], "2026-09-20T00:00:00.000Z");
    expect(effectiveCaptureSince(cfg)).toBe("2026-09-20T00:00:00.000Z");
    join_(["link_1"], "2026-08-01T00:00:00.000Z");
    expect(effectiveCaptureSince(cfg)).toBe(connected);
    expect(effectiveCaptureSince({ authMode: "api-key", apiKey: "k", captureSince: connected, projectRoot: project })).toBe(connected);
  });

  test("oauth consent needs at least one destination", () => {
    // No destination means nowhere to ship — capture stays a silent no-op rather
    // than spooling records with no route.
    signIn();
    expect(captureEnabled({ authMode: "oauth", profileId: PROFILE, connectorIds: [], projectRoot: project })).toBe(false);
    expect(captureEnabled({ authMode: "oauth", profileId: PROFILE, projectRoot: project })).toBe(false);
  });

  test("AUGENTA_INGEST_URL does NOT grant consent (redirect only)", () => {
    process.env.AUGENTA_INGEST_URL = "http://127.0.0.1:8787";
    expect(captureEnabled(undefined)).toBe(false);
  });

  test("the kill switch beats a valid config", () => {
    for (const v of ["0", "false"]) {
      process.env.AUGENTA_CAPTURE_ENABLED = v;
      expect(captureKilled()).toBe(true);
      expect(captureEnabled({ authMode: "api-key", apiKey: "k", projectRoot: project })).toBe(false);
      expect(captureGate({ authMode: "api-key", apiKey: "k", projectRoot: project })).toBe("killed");
    }
    // any other value is not the kill switch
    process.env.AUGENTA_CAPTURE_ENABLED = "1";
    expect(captureKilled()).toBe(false);
    expect(captureEnabled({ authMode: "api-key", apiKey: "k", projectRoot: project })).toBe(true);
  });
});
