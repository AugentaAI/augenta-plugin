/**
 * Tests for the `/v1` helpers both CLI entrypoints share.
 *
 * These moved out of scripts/connect.ts so scripts/recall.ts could use them — an
 * entrypoint may not import another entrypoint — and connect.test.ts still
 * exercises most of them end to end through the connect flow. What this file
 * adds is the behaviour a caller depends on DIRECTLY: that paging refuses rather
 * than truncates, that an unreadable Connector is distinguishable from a failed
 * request, and that a thrown fetch turns into a sentence.
 *
 * Run: bun test capture/platform.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AugentaRequestError,
  bearerJson,
  currentConnector,
  describeError,
  environmentLabel,
  fetchAllWorkspaces,
  WORKSPACE_LIST_MAX_PAGES,
  WORKSPACE_LIST_PAGE_SIZE,
} from "./platform";
import { saveDeviceProfile } from "./auth";

const GATEWAY = "https://gw.example.com";
const realFetch = globalThis.fetch;

/** Both of these are variables DEBUG.md tells a contributor to export, so the
 *  suite runs from a known state and puts the caller's values back. Restoring —
 *  not deleting — because a test that leaves the environment changed makes every
 *  later test's result depend on the order it ran in. */
const savedEnv: Record<string, string | undefined> = {};
const SANDBOXED = ["AUGENTA_AUTH_HOME", "AUGENTA_CONTROL_URL"] as const;

let authHome: string;
let profileId: string;

beforeEach(async () => {
  authHome = realpathSync(mkdtempSync(join(tmpdir(), "aug-platform-auth-")));
  for (const key of SANDBOXED) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AUGENTA_AUTH_HOME = authHome;
  ({ profileId } = await saveDeviceProfile(
    { issuer: "https://auth.example.com", clientId: "client_public", gateway: GATEWAY },
    { accessToken: "access-live", refreshToken: "refresh-live", expiresAt: Date.now() + 3_600_000 },
    { userId: "user_1", orgId: "org_1" },
  ));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of SANDBOXED) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(authHome, { recursive: true, force: true });
});

describe("environmentLabel", () => {
  test("production is the default, and an override is reported verbatim", () => {
    // beforeEach already cleared the variable, so this is the production default.
    expect(environmentLabel()).toBe("prod");
    expect(environmentLabel("https://augenta.ai")).toBe("prod");
    // A trailing slash is the same environment, not a different one.
    expect(environmentLabel("https://augenta.ai/")).toBe("prod");
    expect(environmentLabel("https://control.example.com")).toBe("https://control.example.com");
  });

  test("the resolved URL is independent of environment variables", () => {
    process.env.AUGENTA_CONTROL_URL = "https://from-env.example.com";
    expect(environmentLabel()).toBe("prod");
    expect(environmentLabel("https://explicit.example.com")).toBe("https://explicit.example.com");
    // Blank is not a selection.
    expect(environmentLabel("   ")).toBe("prod");
  });
});

describe("describeError", () => {
  test("Node's bare 'fetch failed' is unwrapped into something actionable", () => {
    // The entire diagnosis a user gets for being offline, behind a proxy, or
    // pointed at a dead host — the shipped CLIs run on Node, where the cause is
    // one level down in error.cause.
    const cases: Array<[string, RegExp]> = [
      ["ENOTFOUND", /host name did not resolve/],
      ["EAI_AGAIN", /host name did not resolve/],
      ["ECONNREFUSED", /connection was refused/],
      ["CERT_HAS_EXPIRED", /TLS certificate could not be verified/],
      ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", /TLS certificate could not be verified/],
    ];
    for (const [code, expected] of cases) {
      const error = Object.assign(new Error("fetch failed"), { cause: { code } });
      expect(describeError(error), code).toMatch(expected);
      expect(describeError(error)).toStartWith("cannot reach Augenta");
    }
  });

  test("an unrecognized cause still names something, and a plain error passes through", () => {
    expect(
      describeError(Object.assign(new Error("fetch failed"), { cause: { message: "socket hang up" } })),
    ).toBe("cannot reach Augenta: socket hang up");
    expect(describeError(new Error("fetch failed"))).toMatch(/network request failed/);
    expect(describeError(new Error("something specific"))).toBe("something specific");
    expect(describeError("a bare string")).toBe("a bare string");
  });
});

describe("bearerJson", () => {
  test("a non-2xx carries the status, so callers can branch on it", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 418 })) as unknown as typeof fetch;
    const thrown = await bearerJson(profileId, `${GATEWAY}/v1/thing`).catch((e) => e);
    expect(thrown).toBeInstanceOf(AugentaRequestError);
    expect((thrown as AugentaRequestError).status).toBe(418);
    expect((thrown as Error).message).toContain("nope");
  });
});

describe("currentConnector", () => {
  const respond = (status: number, body?: unknown) => {
    globalThis.fetch = (async () =>
      body === undefined ? new Response("", { status }) : Response.json(body, { status })) as unknown as typeof fetch;
  };

  test("403 and 404 mean 'not visible to this sign-in', not an error", async () => {
    // A link recorded by a previous connect may legitimately be deleted, or in an
    // organization the user has since lost access to.
    for (const status of [403, 404]) {
      respond(status);
      expect(await currentConnector(profileId, GATEWAY, "connector_x")).toBeUndefined();
    }
  });

  test("anything else THROWS, so a blip is never read as a missing Connector", async () => {
    // The distinction the recall fan-out depends on: 'gone' drops a destination,
    // 'could not ask' reports one.
    respond(500);
    await expect(currentConnector(profileId, GATEWAY, "connector_x")).rejects.toThrow(
      "could not inspect the existing Connector (500)",
    );
  });

  test("no id is no request", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await currentConnector(profileId, GATEWAY, undefined)).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe("fetchAllWorkspaces", () => {
  /** A keyset-paged door, like the real one: `nextCursor` only while rows remain. */
  function servePages(total: number) {
    const all = Array.from({ length: total }, (_, i) => ({ id: `ws-${i}`, name: `WS ${i}` }));
    const seen: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      seen.push(parsed.searchParams.get("cursor") ?? "");
      const limit = Number(parsed.searchParams.get("limit"));
      const from = Number(parsed.searchParams.get("cursor") ?? 0);
      const page = all.slice(from, from + limit);
      const next = from + limit < all.length ? String(from + limit) : undefined;
      return Response.json({ workspaces: page, ...(next ? { nextCursor: next } : {}) });
    }) as unknown as typeof fetch;
    return seen;
  }

  test("a normal organization costs one round trip", async () => {
    const seen = servePages(3);
    const workspaces = await fetchAllWorkspaces(profileId, GATEWAY);
    expect(workspaces).toHaveLength(3);
    expect(seen).toEqual([""]);
  });

  test("it follows nextCursor to exhaustion", async () => {
    const seen = servePages(WORKSPACE_LIST_PAGE_SIZE * 2 + 1);
    const workspaces = await fetchAllWorkspaces(profileId, GATEWAY);
    expect(workspaces).toHaveLength(WORKSPACE_LIST_PAGE_SIZE * 2 + 1);
    expect(seen).toHaveLength(3);
    // Every id, in order — a walk that dropped or duplicated a page would be a
    // silently partial consent surface.
    expect(new Set(workspaces.map((w) => w.id)).size).toBe(workspaces.length);
  });

  test("a cursor that does not advance is called out as a stuck server", async () => {
    // Caught at the second page rather than at the ceiling: otherwise it costs
    // ten identical round trips, accumulates the same page ten times, and then
    // blames the organization's size for an API bug.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ workspaces: [{ id: "ws-1", name: "One" }], nextCursor: "stuck" });
    }) as unknown as typeof fetch;
    await expect(fetchAllWorkspaces(profileId, GATEWAY)).rejects.toThrow(
      "the Workspace list did not advance",
    );
    expect(calls).toBe(2);
  });

  test("it REFUSES at the ceiling rather than returning a partial list", async () => {
    // The opposite of what a display surface would do, and deliberate: this list
    // is the consent question, so a silently partial list is silently partial
    // consent. The message names the ceiling that was actually applied.
    let page = 0;
    globalThis.fetch = (async () => {
      page += 1;
      return Response.json({ workspaces: [{ id: `ws-${page}`, name: "x" }], nextCursor: String(page) });
    }) as unknown as typeof fetch;
    await expect(fetchAllWorkspaces(profileId, GATEWAY)).rejects.toThrow(
      `did not finish within ${WORKSPACE_LIST_MAX_PAGES} pages of ${WORKSPACE_LIST_PAGE_SIZE}`,
    );
    expect(page).toBe(WORKSPACE_LIST_MAX_PAGES);
  });

  test("a page with no workspaces array is empty, not a crash", async () => {
    globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
    expect(await fetchAllWorkspaces(profileId, GATEWAY)).toEqual([]);
  });
});
