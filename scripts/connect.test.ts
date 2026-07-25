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
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectWithApiKey,
  parseArgs,
  resolveTargetProject,
  writeApiKeyConfig,
  writeWorkosConfig,
} from "./connect";

const CONNECT = join(import.meta.dir, "connect.ts");
const realFetch = globalThis.fetch;

let project: string;
beforeEach(() => (project = realpathSync(mkdtempSync(join(tmpdir(), "aug-connect-")))));
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(project, { recursive: true, force: true });
});

describe("parseArgs", () => {
  test("reads --api-key, --project, --endpoint without legacy aliases", () => {
    expect(parseArgs(["--api-key", "k1"])).toEqual({ apiKey: "k1" });
    expect(parseArgs(["--apiKey", "k2"])).toEqual({});
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

  test("WorkOS config contains only the profile, Neurolink, and endpoint override", () => {
    const path = writeWorkosConfig(
      project,
      "profile_123",
      "neurolink_456",
      "https://dev.example.com",
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      authMode: "workos",
      profileId: "profile_123",
      neurolinkId: "neurolink_456",
      endpoint: "https://dev.example.com",
    });
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
  test("verifies the assigned inbound Neurolink before writing config", async () => {
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("https://gw.example.com/v1/neurolinks");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "AugentaKey key_live.secret",
      );
      return Response.json({
        neurolinks: [
          {
            id: "neurolink_123",
            kind: "agent",
            direction: "inbound",
            status: "active",
            neurospaceId: "ns-core",
          },
        ],
      });
    }) as typeof fetch;

    const result = await connectWithApiKey(
      project,
      "key_live.secret",
      "https://gw.example.com/",
    );

    expect(result.neurolink.id).toBe("neurolink_123");
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual({
      authMode: "api-key",
      apiKey: "key_live.secret",
      endpoint: "https://gw.example.com",
    });
  });

  test("does not enable capture for a disabled or outbound assignment", async () => {
    globalThis.fetch = (async (_url, _init) =>
      Response.json({
        neurolinks: [
          {
            id: "neurolink_out",
            kind: "service",
            direction: "outbound",
            status: "active",
            neurospaceId: "ns-core",
          },
        ],
      })) as typeof fetch;

    await expect(
      connectWithApiKey(project, "key_live.secret", "https://gw.example.com"),
    ).rejects.toThrow("active inbound Neurolink");
    expect(() =>
      statSync(join(project, ".augenta", "config.json")),
    ).toThrow();
  });
});
