/**
 * Tests for config.ts — project-scoped config resolution and the consent gate.
 *
 * Contract under test: project consent and a Neurolink or platform key travel
 * together in `<project>/.augenta/config.json` (found by walking UP from cwd); no env var
 * and no home-dir file can stand in for it; AUGENTA_INGEST_URL only redirects
 * the destination; AUGENTA_CAPTURE_ENABLED=0|false kills capture everywhere.
 *
 * Run: bun test capture/config.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_GATEWAY,
  resolveProjectRoot,
  loadProjectConfig,
  projectConfig,
  gatewayBase,
  experiencesUrl,
  captureEnabled,
  captureKilled,
  type ProjectConfig,
} from "./config";

const ENV_KEYS = ["AUGENTA_API_URL", "AUGENTA_INGEST_URL", "AUGENTA_CAPTURE_ENABLED"] as const;
let saved: Record<string, string | undefined>;
let project: string;

function writeConfig(root: string, config: unknown): void {
  mkdirSync(join(root, ".augenta"), { recursive: true });
  writeFileSync(join(root, ".augenta", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  project = mkdtempSync(join(tmpdir(), "aug-cfg-"));
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
  test("parses platform-key mode and optional endpoint", () => {
    writeConfig(project, { authMode: "api-key", apiKey: "key-test", endpoint: "https://gw.example.com/" });
    expect(loadProjectConfig(project)).toEqual({
      authMode: "api-key",
      apiKey: "key-test",
      endpoint: "https://gw.example.com/",
      projectRoot: project,
    });
  });

  test("parses oauth mode without organization or Neurospace coordinates", () => {
    writeConfig(project, {
      authMode: "oauth",
      profileId: "profile_1",
      neurolinkIds: ["link_1", "link_2"],
    });
    expect(loadProjectConfig(project)).toEqual({
      authMode: "oauth",
      profileId: "profile_1",
      neurolinkIds: ["link_1", "link_2"],
      projectRoot: project,
    });
  });

  describe("the destination set — widening a field is not migration", () => {
    test("a pre-0.6.0 scalar `neurolinkId` is READ FORWARD as a one-element set", () => {
      // Not a migration: the same id keeps meaning exactly what it meant, no
      // credential is reused and no routing is re-derived, so there is no
      // unexplained 401 for the no-migration policy to prevent. Rejecting it
      // would silently stop capture for every already-connected project.
      writeConfig(project, {
        authMode: "oauth",
        profileId: "profile_1",
        neurolinkId: "link_1",
      });
      expect(loadProjectConfig(project)).toEqual({
        authMode: "oauth",
        profileId: "profile_1",
        neurolinkIds: ["link_1"],
        projectRoot: project,
      });
    });

    test("the plural form wins when both spellings are present", () => {
      writeConfig(project, {
        authMode: "oauth",
        profileId: "profile_1",
        neurolinkId: "link_stale",
        neurolinkIds: ["link_1"],
      });
      expect(loadProjectConfig(project)?.neurolinkIds).toEqual(["link_1"]);
    });

    test("duplicates collapse — one id must never become two cursor keys", () => {
      writeConfig(project, {
        authMode: "oauth",
        profileId: "profile_1",
        neurolinkIds: ["link_1", " link_1 ", "link_2"],
      });
      expect(loadProjectConfig(project)?.neurolinkIds).toEqual(["link_1", "link_2"]);
    });

    test("an empty or partly-invalid set is unparseable, never a partial route", () => {
      // Shipping to a SUBSET of the destinations the user consented to, while
      // reporting success, is the outcome worth failing closed to avoid.
      for (const neurolinkIds of [[], ["link_1", 42], ["link_1", ""], "link_1_not_array"]) {
        writeConfig(project, { authMode: "oauth", profileId: "profile_1", neurolinkIds });
        expect(loadProjectConfig(project)).toBeUndefined();
      }
    });
  });

  test("the pre-0.4.0 `workos` spelling is not accepted", () => {
    // Not migrated on purpose: an unparseable config becomes session-start's
    // one-time reconnect prompt, which is a clear ask instead of a stale routing
    // decision reused behind the user's back.
    writeConfig(project, {
      authMode: "workos",
      profileId: "profile_1",
      neurolinkId: "link_1",
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

describe("captureEnabled — config presence IS consent", () => {
  test("on with a config, off without", () => {
    expect(captureEnabled({ authMode: "api-key", apiKey: "k", projectRoot: "/p" })).toBe(true);
    expect(captureEnabled({ authMode: "oauth", profileId: "profile_1", neurolinkIds: ["link_1"], projectRoot: "/p" })).toBe(true);
    expect(captureEnabled(undefined)).toBe(false);
  });

  test("oauth consent needs at least one destination", () => {
    // No destination means nowhere to ship — capture stays a silent no-op rather
    // than spooling records with no route.
    expect(captureEnabled({ authMode: "oauth", profileId: "profile_1", neurolinkIds: [], projectRoot: "/p" })).toBe(false);
    expect(captureEnabled({ authMode: "oauth", profileId: "profile_1", projectRoot: "/p" })).toBe(false);
  });

  test("AUGENTA_INGEST_URL does NOT grant consent (redirect only)", () => {
    process.env.AUGENTA_INGEST_URL = "http://127.0.0.1:8787";
    expect(captureEnabled(undefined)).toBe(false);
  });

  test("the kill switch beats a valid config", () => {
    for (const v of ["0", "false"]) {
      process.env.AUGENTA_CAPTURE_ENABLED = v;
      expect(captureKilled()).toBe(true);
      expect(captureEnabled({ authMode: "api-key", apiKey: "k", projectRoot: "/p" })).toBe(false);
    }
    // any other value is not the kill switch
    process.env.AUGENTA_CAPTURE_ENABLED = "1";
    expect(captureKilled()).toBe(false);
    expect(captureEnabled({ authMode: "api-key", apiKey: "k", projectRoot: "/p" })).toBe(true);
  });
});
