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
  fetchWithProfile,
  markAuthNotice,
  profileIdFor,
  readAuthStore,
  reusableProfiles,
  saveDeviceProfile,
  takeAuthNotice,
  type OAuthConfig,
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
      { workosUserId: "user_a", workosOrgId: "org_a" },
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
      { workosUserId: "user_a", workosOrgId: "org_a" },
    );
    await saveDeviceProfile(
      { ...config, gateway: "https://staging-api.example.com" },
      {
        accessToken: "access-b",
        refreshToken: "refresh-b",
        expiresAt: Date.now() + 60_000,
      },
      { workosUserId: "user_a", workosOrgId: "org_b" },
    );

    expect(Object.keys(readAuthStore().profiles)).toHaveLength(2);
    expect(reusableProfiles(config).map((item) => item.profile.workosOrgId)).toEqual([
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
    const identity = { workosUserId: "user_a", workosOrgId: "org_a" };
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
      { workosUserId: "user_a", workosOrgId: "org_a" },
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
      { workosUserId: "user_a", workosOrgId: "org_a" },
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
