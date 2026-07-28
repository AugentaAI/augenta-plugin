import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accessTokenForProfile,
  beginDeviceLogin,
  clearPendingLogin,
  fetchWithProfile,
  markAuthNotice,
  pollDeviceToken,
  profileIdFor,
  readAuthStore,
  readPendingLogin,
  ReLoginRequiredError,
  reusableProfiles,
  saveDeviceProfile,
  savePendingLogin,
  takeAuthNotice,
  type OAuthConfig,
  type PendingDeviceLogin,
} from "./auth";

const realFetch = globalThis.fetch;
let root: string;

const config: OAuthConfig = {
  issuer: "https://login.example.com",
  clientId: "client_public",
  gateway: "https://api.example.com",
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aug-auth-"));
  process.env.AUGENTA_AUTH_HOME = root;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AUGENTA_AUTH_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("global WorkOS profiles", () => {
  test("stores versioned profiles with owner-only directory/file permissions", async () => {
    const saved = await saveDeviceProfile(
      config,
      {
        accessToken: "access-a",
        refreshToken: "refresh-a",
        expiresAt: Date.now() + 60_000,
      },
      { userId: "user_a", orgId: "org_a" },
    );

    expect(saved.profileId).toBe(profileIdFor(config, "org_a"));
    expect(readAuthStore().version).toBe(1);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "auth.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "auth.json"), "utf8")).not.toContain(
      "secretHash",
    );
  });

  test("isolates profiles by issuer, client id, gateway, and WorkOS organization", async () => {
    await saveDeviceProfile(
      config,
      {
        accessToken: "access-a",
        refreshToken: "refresh-a",
        expiresAt: Date.now() + 60_000,
      },
      { userId: "user_a", orgId: "org_a" },
    );
    await saveDeviceProfile(
      { ...config, gateway: "https://staging-api.example.com" },
      {
        accessToken: "access-b",
        refreshToken: "refresh-b",
        expiresAt: Date.now() + 60_000,
      },
      { userId: "user_a", orgId: "org_b" },
    );

    expect(Object.keys(readAuthStore().profiles)).toHaveLength(2);
    expect(reusableProfiles(config).map((item) => item.profile.orgId)).toEqual([
      "org_a",
    ]);
  });

  test("the same organization behind two gateways keeps two profiles", async () => {
    // reusableProfiles() filters on the gateway, so profile IDENTITY must include
    // it too. When it didn't, connecting one project with an --endpoint override
    // and another without collapsed both onto one id: the second login silently
    // overwrote the first's gateway, and the next --endpoint connect re-ran
    // device login against tokens that were still perfectly valid.
    const override = { ...config, gateway: "http://127.0.0.1:8080" };
    const tokens = {
      accessToken: "access-a",
      refreshToken: "refresh-a",
      expiresAt: Date.now() + 60_000,
    };
    const identity = { userId: "user_a", orgId: "org_a" };
    const first = await saveDeviceProfile(override, tokens, identity);
    const second = await saveDeviceProfile(config, tokens, identity);

    expect(first.profileId).not.toBe(second.profileId);
    expect(Object.keys(readAuthStore().profiles)).toHaveLength(2);
    expect(reusableProfiles(override).map((item) => item.profileId)).toEqual([
      first.profileId,
    ]);
    expect(reusableProfiles(config).map((item) => item.profileId)).toEqual([
      second.profileId,
    ]);
  });

  test("serializes concurrent refreshes and atomically persists the rotated refresh token", async () => {
    const { profileId } = await saveDeviceProfile(
      config,
      {
        accessToken: "expired-access",
        refreshToken: "refresh-old",
        expiresAt: Date.now() - 1,
      },
      { userId: "user_a", orgId: "org_a" },
    );
    let refreshes = 0;
    globalThis.fetch = (async (_url, init) => {
      refreshes++;
      expect(String(init?.body)).toContain("refresh_token=refresh-old");
      expect(String(init?.body)).not.toContain("organization_id=");
      return Response.json({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
      });
    }) as typeof fetch;

    const tokens = await Promise.all([
      accessTokenForProfile(profileId),
      accessTokenForProfile(profileId),
    ]);

    expect(tokens).toEqual(["access-new", "access-new"]);
    expect(refreshes).toBe(1);
    const profile = readAuthStore().profiles[profileId]!;
    expect(profile.accessToken).toBe("access-new");
    expect(profile.refreshToken).toBe("refresh-new");
  });

  test("a 401 forces exactly one locked refresh and retries the request once", async () => {
    const { profileId } = await saveDeviceProfile(
      config,
      {
        accessToken: "access-old",
        refreshToken: "refresh-old",
        expiresAt: Date.now() + 3_600_000,
      },
      { userId: "user_a", orgId: "org_a" },
    );
    let apiCalls = 0;
    let refreshes = 0;
    globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith("/oauth2/token")) {
        refreshes++;
        return Response.json({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3600,
        });
      }
      apiCalls++;
      const authorization = new Headers(init?.headers).get("authorization");
      return new Response(null, {
        status: authorization === "Bearer access-new" ? 204 : 401,
      });
    }) as typeof fetch;

    const response = await fetchWithProfile(
      profileId,
      "https://api.example.com/v1/me",
    );

    expect(response.status).toBe(204);
    expect(apiCalls).toBe(2);
    expect(refreshes).toBe(1);
  });
});

describe("auth notices handed from the detached shipper to the next SessionStart", () => {
  let project: string;
  beforeEach(() => (project = mkdtempSync(join(tmpdir(), "aug-notice-"))));
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  test("a notice round-trips once and does not repeat", () => {
    markAuthNotice(project, "relogin");
    expect(takeAuthNotice(project)).toBe("relogin");
    expect(takeAuthNotice(project)).toBeUndefined();
  });

  test("marking upholds the .augenta self-gitignore invariant", () => {
    // The dir must never exist without the .gitignore that ignores it — a notice
    // is the one writer that could create it on a project that has no config.
    markAuthNotice(project, "connect");
    expect(readFileSync(join(project, ".augenta", ".gitignore"), "utf8")).toBe("*\n");
  });

  test("reports the most urgent pending notice and clears every one", () => {
    // The shipper writes whichever notice its last status implies, so both can be
    // on disk. Clearing only the reported one strands the other, which resurfaces
    // sessions later as a prompt for a cause that is long gone.
    markAuthNotice(project, "connect");
    markAuthNotice(project, "relogin");
    expect(takeAuthNotice(project)).toBe("relogin");
    expect(takeAuthNotice(project)).toBeUndefined();
  });
});

/**
 * The device grant is split so an agent-driven connect can show the user a link
 * in one bounded call and poll in another. These tests pin the seam: starting
 * must not poll, polling must distinguish "still waiting" from "grant is dead",
 * and the device code must never leave the 0600 pending file.
 */
describe("split device authorization", () => {
  const pending = (over: Partial<PendingDeviceLogin> = {}): PendingDeviceLogin => ({
    deviceCode: "device_secret",
    userCode: "WDJB-MJHT",
    verificationUri: "https://auth.example.com/device?user_code=WDJB-MJHT",
    issuer: config.issuer,
    clientId: config.clientId,
    gateway: config.gateway,
    intervalMs: 1,
    expiresAt: Date.now() + 60_000,
    ...over,
  });

  test("beginDeviceLogin returns the link without polling for a token", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return Response.json({
        device_code: "device_secret",
        user_code: "WDJB-MJHT",
        verification_uri: "https://auth.example.com/device",
        verification_uri_complete:
          "https://auth.example.com/device?user_code=WDJB-MJHT",
        interval: 5,
        expires_in: 600,
      });
    }) as typeof fetch;

    const started = await beginDeviceLogin(config, { openBrowser: false });

    // Exactly one request, and it is NOT the token endpoint: a caller that has to
    // display the URL cannot afford this function to block on authorization.
    expect(calls).toEqual(["https://login.example.com/oauth2/device_authorization"]);
    expect(started.verificationUri).toBe(
      "https://auth.example.com/device?user_code=WDJB-MJHT",
    );
    expect(started.userCode).toBe("WDJB-MJHT");
    expect(started.intervalMs).toBe(5_000);
    expect(started.expiresAt).toBeGreaterThan(Date.now());
  });

  test("prefers the complete URL so the click alone authorizes", async () => {
    globalThis.fetch = (async (_url, _init) =>
      Response.json({
        device_code: "d",
        user_code: "CODE",
        verification_uri: "https://auth.example.com/device",
        expires_in: 600,
      })) as typeof fetch;

    const started = await beginDeviceLogin(config, { openBrowser: false });
    // Absent verification_uri_complete, the bare URL plus the code still works.
    expect(started.verificationUri).toBe("https://auth.example.com/device");
    expect(started.intervalMs).toBe(5_000);
  });

  test("polling returns tokens once the user authorizes", async () => {
    let attempts = 0;
    globalThis.fetch = (async (_url, init) => {
      attempts += 1;
      expect(String((init as RequestInit).body)).toContain("device_code=device_secret");
      if (attempts < 3) {
        return Response.json({ error: "authorization_pending" }, { status: 400 });
      }
      return Response.json({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
      });
    }) as typeof fetch;

    const result = await pollDeviceToken(pending(), { waitMs: 5_000 });

    expect(result.ok).toBe(true);
    expect(result.ok && result.tokens.accessToken).toBe("access-new");
    expect(attempts).toBe(3);
  });

  test("an exhausted wait budget reports pending, not failure", async () => {
    globalThis.fetch = (async (_url, _init) =>
      Response.json({ error: "authorization_pending" }, { status: 400 })) as typeof fetch;

    // The grant is still alive, so the caller must be able to ask again rather
    // than tell the user their link died.
    const result = await pollDeviceToken(pending(), { waitMs: 25 });

    expect(result).toMatchObject({ ok: false, reason: "pending" });
  });

  test("slow_down backs off and reports the raised interval for reuse", async () => {
    let attempts = 0;
    globalThis.fetch = (async (_url, _init) => {
      attempts += 1;
      return Response.json(
        { error: attempts === 1 ? "slow_down" : "authorization_pending" },
        { status: 400 },
      );
    }) as typeof fetch;

    const result = await pollDeviceToken(pending(), { waitMs: 30 });

    // Surfaced so a re-invoking caller persists the back-off instead of resetting
    // to the base interval and hammering the token endpoint.
    expect(result).toMatchObject({ ok: false, reason: "pending" });
    expect(result.ok === false && result.intervalMs).toBeGreaterThan(1);
  });

  test("a declined sign-in is distinguishable from an expired one", async () => {
    globalThis.fetch = (async (_url, _init) =>
      Response.json({ error: "access_denied" }, { status: 400 })) as typeof fetch;
    await expect(pollDeviceToken(pending(), { waitMs: 5_000 })).rejects.toMatchObject({
      name: "ReLoginRequiredError",
      reason: "login_denied",
    });

    globalThis.fetch = (async (_url, _init) =>
      Response.json({ error: "expired_token" }, { status: 400 })) as typeof fetch;
    await expect(pollDeviceToken(pending(), { waitMs: 5_000 })).rejects.toMatchObject({
      reason: "login_expired",
    });
  });

  test("an already-dead grant expires instead of reporting pending", async () => {
    globalThis.fetch = (async (_url, _init) =>
      Response.json({ error: "authorization_pending" }, { status: 400 })) as typeof fetch;

    await expect(
      pollDeviceToken(pending({ expiresAt: Date.now() - 1 }), { waitMs: 5_000 }),
    ).rejects.toBeInstanceOf(ReLoginRequiredError);
  });

  test("a token response without a refresh token is refused", async () => {
    globalThis.fetch = (async (_url, _init) =>
      Response.json({ access_token: "a", expires_in: 3600 })) as typeof fetch;

    // Capture must be able to ship days later; an access token alone is a dead end.
    await expect(pollDeviceToken(pending(), { waitMs: 5_000 })).rejects.toThrow(
      "refreshable credentials",
    );
  });
});

describe("pending sign-in state", () => {
  test("round-trips at 0600 and keeps the device code out of everything else", async () => {
    await saveDeviceProfile(
      config,
      {
        accessToken: "access-a",
        refreshToken: "refresh-a",
        expiresAt: Date.now() + 60_000,
      },
      { userId: "user_a", orgId: "org_a" },
    );
    const started: PendingDeviceLogin = {
      deviceCode: "device_secret",
      userCode: "WDJB-MJHT",
      verificationUri: "https://auth.example.com/device",
      issuer: config.issuer,
      clientId: config.clientId,
      gateway: config.gateway,
      intervalMs: 5_000,
      expiresAt: Date.now() + 600_000,
    };
    savePendingLogin(started);

    expect(statSync(join(root, "pending-login.json")).mode & 0o777).toBe(0o600);
    expect(readPendingLogin()).toEqual(started);
    // The pending file is the ONLY place the device code exists on disk.
    expect(readFileSync(join(root, "auth.json"), "utf8")).not.toContain(
      "device_secret",
    );
  });

  test("an expired pending sign-in reads as absent", () => {
    savePendingLogin({
      deviceCode: "stale",
      userCode: "OLD",
      verificationUri: "https://auth.example.com/device",
      issuer: config.issuer,
      clientId: config.clientId,
      gateway: config.gateway,
      intervalMs: 5_000,
      expiresAt: Date.now() - 1,
    });

    // Otherwise a login the user walked away from wedges every later connect into
    // polling a dead grant instead of starting a fresh one.
    expect(readPendingLogin()).toBeUndefined();
  });

  test("clearing is idempotent and survives nothing pending", () => {
    clearPendingLogin();
    expect(readPendingLogin()).toBeUndefined();
    savePendingLogin({
      deviceCode: "d",
      userCode: "C",
      verificationUri: "https://auth.example.com/device",
      issuer: config.issuer,
      clientId: config.clientId,
      gateway: config.gateway,
      intervalMs: 5_000,
      expiresAt: Date.now() + 600_000,
    });
    clearPendingLogin();
    expect(readPendingLogin()).toBeUndefined();
  });
});
