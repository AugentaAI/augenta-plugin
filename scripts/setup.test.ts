/**
 * Tests for setup.ts — the network-free project key installer.
 *
 * Contract under test: `--api-key` is required; the config lands at
 * `<project>/.augenta/config.json` with mode 0600 inside the self-gitignored
 * dir; project resolution is --project > git toplevel > cwd; no network is
 * involved (nothing here serves HTTP). The CLI surface is driven as a real
 * subprocess; the pure helpers directly.
 *
 * Run: bun test scripts/setup.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, resolveTargetProject, writeConfig } from "./setup";

const SETUP = join(import.meta.dir, "setup.ts");

let project: string;
beforeEach(() => (project = realpathSync(mkdtempSync(join(tmpdir(), "aug-setup-")))));
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe("parseArgs", () => {
  test("reads --api-key (and the --apiKey alias), --project, --endpoint", () => {
    expect(parseArgs(["--api-key", "k1"])).toEqual({ apiKey: "k1" });
    expect(parseArgs(["--apiKey", "k2"])).toEqual({ apiKey: "k2" });
    expect(parseArgs(["--api-key", "k", "--project", "/p", "--endpoint", "http://x"])).toEqual({
      apiKey: "k",
      project: "/p",
      endpoint: "http://x",
    });
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

describe("writeConfig", () => {
  test("writes config.json 0600 inside the self-gitignored dir", () => {
    const path = writeConfig(project, "sk-test", "http://gw.example.com");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      apiKey: "sk-test",
      endpoint: "http://gw.example.com",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(project, ".augenta", ".gitignore"), "utf8")).toBe("*\n");
  });

  test("omits endpoint when not given", () => {
    const path = writeConfig(project, "sk-test");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ apiKey: "sk-test" });
  });
});

describe("CLI subprocess", () => {
  test("missing --api-key → usage on stderr, exit 1, nothing written", () => {
    const r = spawnSync("bun", [SETUP], { cwd: project, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--api-key");
    expect(() => statSync(join(project, ".augenta", "config.json"))).toThrow();
  });

  test("writes the config for the cwd project and reports the off switches", () => {
    const r = spawnSync("bun", [SETUP, "--api-key", "sk-live"], { cwd: project, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Wrote");
    expect(r.stdout).toContain("AUGENTA_CAPTURE_ENABLED=0");
    const config = JSON.parse(readFileSync(join(project, ".augenta", "config.json"), "utf8"));
    expect(config).toEqual({ apiKey: "sk-live" });
  });

  test("re-running updates in place", () => {
    spawnSync("bun", [SETUP, "--api-key", "old"], { cwd: project, encoding: "utf8" });
    const r = spawnSync("bun", [SETUP, "--api-key", "new"], { cwd: project, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Updated");
    const config = JSON.parse(readFileSync(join(project, ".augenta", "config.json"), "utf8"));
    expect(config.apiKey).toBe("new");
  });
});
