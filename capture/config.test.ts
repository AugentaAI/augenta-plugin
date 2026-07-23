/**
 * Tests for config.ts — project-scoped config resolution and the consent gate.
 *
 * Contract under test: the key/consent travel together in
 * `<project>/.augenta/config.json` (found by walking UP from cwd); no env var
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
    writeConfig(project, { apiKey: "k" });
    expect(resolveProjectRoot(project)).toBe(project);
  });

  test("walks up from a nested subdirectory to the project root", () => {
    writeConfig(project, { apiKey: "k" });
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
  test("parses apiKey and optional endpoint, and records the root", () => {
    writeConfig(project, { apiKey: "sk-test", endpoint: "https://gw.example.com/" });
    expect(loadProjectConfig(project)).toEqual({
      apiKey: "sk-test",
      endpoint: "https://gw.example.com/",
      projectRoot: project,
    });
  });

  test("undefined on missing file, malformed JSON, or empty/non-string apiKey", () => {
    expect(loadProjectConfig(project)).toBeUndefined();
    writeConfig(project, "not json {");
    expect(loadProjectConfig(project)).toBeUndefined();
    writeConfig(project, { apiKey: "   " });
    expect(loadProjectConfig(project)).toBeUndefined();
    writeConfig(project, { apiKey: 42 });
    expect(loadProjectConfig(project)).toBeUndefined();
  });

  test("projectConfig = resolve + load in one call", () => {
    writeConfig(project, { apiKey: "k" });
    const deep = join(project, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(projectConfig(deep)?.apiKey).toBe("k");
    expect(projectConfig(undefined)).toBeUndefined();
  });
});

describe("URL resolution", () => {
  const cfg = (endpoint?: string): ProjectConfig => ({
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
    expect(captureEnabled({ apiKey: "k", projectRoot: "/p" })).toBe(true);
    expect(captureEnabled(undefined)).toBe(false);
  });

  test("AUGENTA_INGEST_URL does NOT grant consent (redirect only)", () => {
    process.env.AUGENTA_INGEST_URL = "http://127.0.0.1:8787";
    expect(captureEnabled(undefined)).toBe(false);
  });

  test("the kill switch beats a valid config", () => {
    for (const v of ["0", "false"]) {
      process.env.AUGENTA_CAPTURE_ENABLED = v;
      expect(captureKilled()).toBe(true);
      expect(captureEnabled({ apiKey: "k", projectRoot: "/p" })).toBe(false);
    }
    // any other value is not the kill switch
    process.env.AUGENTA_CAPTURE_ENABLED = "1";
    expect(captureKilled()).toBe(false);
    expect(captureEnabled({ apiKey: "k", projectRoot: "/p" })).toBe(true);
  });
});
