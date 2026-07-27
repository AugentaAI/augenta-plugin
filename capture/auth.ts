/** WorkOS public-client device authorization and owner-only global profiles. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureAugentaDir } from "./augenta-dir";

export interface OAuthConfig {
  issuer: string;
  clientId: string;
  gateway: string;
}

export interface AuthProfile {
  issuer: string;
  clientId: string;
  gateway: string;
  workosUserId: string;
  workosOrgId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  updatedAt: string;
}

export interface AuthStore {
  version: 1;
  profiles: Record<string, AuthProfile>;
}

export interface DeviceTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export class ReLoginRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReLoginRequiredError";
  }
}

const authRoot = () =>
  process.env.AUGENTA_AUTH_HOME || join(homedir(), ".augenta");
const authPath = () => join(authRoot(), "auth.json");
const lockPath = () => join(authRoot(), "auth.lock");
const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
/** Bounds every CONTROL-PLANE call — discovery, device grant, token refresh, and
 *  the `/v1` requests connect makes. Exported so the connect CLI reuses this
 *  budget instead of a second literal. The ingest POST is deliberately separate:
 *  it runs in the detached shipper on a hot path and keeps its own, tighter
 *  budget in ship.ts. Nothing here is unbounded — that is what the "every fetch
 *  passes an AbortSignal" contract test enforces. */
export const REQUEST_TIMEOUT_MS = 15_000;

function ensureAuthRoot(): void {
  mkdirSync(authRoot(), { recursive: true, mode: 0o700 });
  chmodSync(authRoot(), 0o700);
}

export function readAuthStore(): AuthStore {
  try {
    ensureAuthRoot();
    if (existsSync(authPath())) chmodSync(authPath(), 0o600);
    const parsed = JSON.parse(readFileSync(authPath(), "utf8")) as Partial<AuthStore>;
    if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object") {
      return { version: 1, profiles: {} };
    }
    return { version: 1, profiles: parsed.profiles };
  } catch {
    return { version: 1, profiles: {} };
  }
}

function writeAuthStore(store: AuthStore): void {
  ensureAuthRoot();
  const path = authPath();
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // The atomic rename already succeeded or cleanup is best effort.
    }
  }
}

async function withAuthLock<T>(fn: () => Promise<T> | T): Promise<T> {
  ensureAuthRoot();
  const lock = lockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
      } catch {
        // Another process may have released it between stat and unlink.
      }
      if (Date.now() >= deadline) {
        throw new Error("another Augenta login or token refresh is still running");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // The stale-lock recovery path may already have removed it.
    }
  }
}

function endpoint(issuer: string, suffix: string): string {
  return `${issuer.replace(/\/+$/, "")}${suffix}`;
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : undefined;
}

async function refreshTokens(profile: AuthProfile): Promise<TokenResponse> {
  const response = await fetch(endpoint(profile.issuer, "/oauth2/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: form({
      grant_type: "refresh_token",
      refresh_token: profile.refreshToken,
      client_id: profile.clientId,
    }),
  });
  if (response.ok) return (await response.json()) as TokenResponse;
  const code = await errorCode(response);
  if (
    response.status === 400 ||
    response.status === 401 ||
    code === "invalid_grant" ||
    code === "access_denied"
  ) {
    throw new ReLoginRequiredError("WorkOS login expired or was revoked");
  }
  throw new Error(`WorkOS token refresh failed (${response.status})`);
}

/** Public environment discovery; this endpoint exposes no credential. */
export async function augentaOAuthConfig(
  controlUrl = process.env.AUGENTA_CONTROL_URL || "https://augenta.ai",
): Promise<OAuthConfig> {
  const response = await fetch(
    `${controlUrl.replace(/\/+$/, "")}/.well-known/augenta.json`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!response.ok) {
    throw new Error("Augenta WorkOS login is not configured for this environment");
  }
  const value = (await response.json()) as Partial<OAuthConfig>;
  if (!value.issuer || !value.clientId || !value.gateway) {
    throw new Error("Augenta returned incomplete WorkOS login configuration");
  }
  return {
    issuer: value.issuer.replace(/\/+$/, ""),
    clientId: value.clientId,
    gateway: value.gateway.replace(/\/+$/, ""),
  };
}

/** Per-platform "open this URL" command. Best effort — the URL and code are
 *  printed either way, so a wrong or missing opener costs nothing. `start`'s
 *  first quoted argument is the window title, hence the empty one. */
export function browserCommand(url: string): string[] {
  if (process.platform === "darwin") return ["open", url];
  if (process.platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

/** Run the WorkOS device grant. No client secret is used or stored. */
export async function deviceLogin(config: OAuthConfig): Promise<DeviceTokens> {
  const start = await fetch(endpoint(config.issuer, "/oauth2/device_authorization"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: form({
      client_id: config.clientId,
      scope: "openid profile email offline_access",
    }),
  });
  if (!start.ok) throw new Error(`could not start WorkOS login (${start.status})`);
  const device = (await start.json()) as {
    device_code: string;
    user_code: string;
    verification_uri_complete?: string;
    verification_uri: string;
    interval?: number;
    expires_in: number;
  };
  const verificationUrl =
    device.verification_uri_complete || device.verification_uri;
  console.log(`Open ${verificationUrl}`);
  console.log(`WorkOS verification code: ${device.user_code}`);
  try {
    Bun.spawnSync({
      cmd: browserCommand(verificationUrl),
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // The printed URL/code remains usable on headless systems.
  }

  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = Math.max(1, device.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const response = await fetch(endpoint(config.issuer, "/oauth2/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())),
      ),
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: config.clientId,
      }),
    });
    if (response.ok) {
      const result = (await response.json()) as TokenResponse;
      if (!result.access_token || !result.refresh_token) {
        throw new Error("WorkOS login did not return refreshable credentials");
      }
      return {
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: Date.now() + result.expires_in * 1000,
      };
    }
    const code = await errorCode(response);
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (code === "access_denied") {
      throw new ReLoginRequiredError("WorkOS login was denied");
    }
    if (code === "expired_token") {
      throw new ReLoginRequiredError("WorkOS device login expired");
    }
    throw new Error(`WorkOS login failed (${response.status})`);
  }
  throw new ReLoginRequiredError("WorkOS device login expired");
}

/**
 * A profile's identity is exactly the set of coordinates {@link reusableProfiles}
 * filters on — issuer, client, gateway, organization. The gateway belongs here
 * even though tokens don't depend on it: leave it out and two logins the filter
 * treats as DISTINCT (same org, `--endpoint` override vs. default) collapse onto
 * one id, so the second silently overwrites the first's stored gateway and the
 * next `--endpoint` connect re-runs device login against still-valid tokens.
 */
export function profileIdFor(config: OAuthConfig, workosOrgId: string): string {
  // NUL-joined so no coordinate can impersonate another by containing the
  // separator.
  const coordinates = [
    config.issuer.replace(/\/+$/, ""),
    config.clientId,
    config.gateway.replace(/\/+$/, ""),
    workosOrgId,
  ].join("\0");
  const digest = createHash("sha256")
    // CodeQL reports js/insufficient-password-hash here. It is a false positive
    // and is handled by a dismissal in the repository's Security tab — this
    // repo uses CodeQL default setup, which takes no config file, and inline
    // `// codeql[...]` markers do NOT suppress code-scanning alerts. If a
    // refactor changes this function's shape, CodeQL mints a NEW alert that the
    // old dismissal does not cover, and the check goes red until it is
    // dismissed again.
    //
    // Why it is a false positive: these are public profile coordinates — an
    // issuer URL, a PUBLIC OAuth client id (deviceLogin uses no client secret),
    // a gateway URL, and an organization id. None is a password, and the digest
    // is a local cache key, not a credential verifier, so a slow KDF would be
    // the wrong tool.
    .update(coordinates)
    .digest("hex")
    .slice(0, 24);
  return `profile_${digest}`;
}

export async function saveDeviceProfile(
  config: OAuthConfig,
  tokens: DeviceTokens,
  identity: { workosUserId: string; workosOrgId: string },
): Promise<{ profileId: string; profile: AuthProfile }> {
  return withAuthLock(() => {
    const store = readAuthStore();
    const profileId = profileIdFor(config, identity.workosOrgId);
    const profile: AuthProfile = {
      issuer: config.issuer,
      clientId: config.clientId,
      gateway: config.gateway,
      workosUserId: identity.workosUserId,
      workosOrgId: identity.workosOrgId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      updatedAt: new Date().toISOString(),
    };
    store.profiles[profileId] = profile;
    writeAuthStore(store);
    return { profileId, profile };
  });
}

export function getAuthProfile(profileId: string): AuthProfile | undefined {
  return readAuthStore().profiles[profileId];
}

export function reusableProfiles(config: OAuthConfig): Array<{
  profileId: string;
  profile: AuthProfile;
}> {
  return Object.entries(readAuthStore().profiles)
    .filter(
      ([, profile]) =>
        profile.issuer.replace(/\/+$/, "") === config.issuer.replace(/\/+$/, "") &&
        profile.clientId === config.clientId &&
        profile.gateway.replace(/\/+$/, "") === config.gateway.replace(/\/+$/, ""),
    )
    .map(([profileId, profile]) => ({ profileId, profile }))
    .sort((a, b) => b.profile.updatedAt.localeCompare(a.profile.updatedAt));
}

/**
 * Return a usable token, serializing refresh and atomically persisting both
 * rotated token halves before another process can read them.
 */
export async function accessTokenForProfile(
  profileId: string,
  forceRefresh = false,
): Promise<string> {
  return withAuthLock(async () => {
    const store = readAuthStore();
    const profile = store.profiles[profileId];
    if (!profile) {
      throw new ReLoginRequiredError(
        "WorkOS login is missing; run augenta:connect again",
      );
    }
    if (!forceRefresh && profile.expiresAt > Date.now() + 60_000) {
      return profile.accessToken;
    }
    const rotated = await refreshTokens(profile);
    const updated: AuthProfile = {
      ...profile,
      accessToken: rotated.access_token,
      refreshToken: rotated.refresh_token || profile.refreshToken,
      expiresAt: Date.now() + rotated.expires_in * 1000,
      updatedAt: new Date().toISOString(),
    };
    store.profiles[profileId] = updated;
    writeAuthStore(store);
    return updated.accessToken;
  });
}

/** One bearer request with exactly one locked refresh/retry on a 401. */
export async function fetchWithProfile(
  profileId: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const send = async (forceRefresh: boolean) => {
    const accessToken = await accessTokenForProfile(profileId, forceRefresh);
    return fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
        authorization: `Bearer ${accessToken}`,
      },
    });
  };
  const first = await send(false);
  return first.status === 401 ? send(true) : first;
}

type Notice = "relogin" | "connect";

/** Most to least urgent — also the order {@link takeAuthNotice} reports in. */
const NOTICES = ["relogin", "connect"] as const;

function noticePath(projectRoot: string, notice: Notice): string {
  return join(projectRoot, ".augenta", `${notice}-required`);
}

export function markAuthNotice(projectRoot: string, notice: Notice): void {
  try {
    // Upholds the `.augenta/` invariant: the dir never exists without the
    // .gitignore that ignores it (see ensureAugentaDir).
    ensureAugentaDir(projectRoot);
    writeFileSync(noticePath(projectRoot, notice), `${notice}\n`, {
      mode: 0o600,
    });
  } catch {
    // The spool remains durable even if a notice marker cannot be written.
  }
}

/**
 * Report the most urgent pending notice and clear ALL of them. Clearing only the
 * one reported would strand the others: the shipper writes whichever notice its
 * last status implies, so a `connect` left behind a since-fixed `relogin` would
 * resurface as a stale prompt sessions later, long after the cause was gone.
 */
export function takeAuthNotice(projectRoot: string): Notice | undefined {
  let found: Notice | undefined;
  for (const notice of NOTICES) {
    const path = noticePath(projectRoot, notice);
    if (!existsSync(path)) continue;
    found ??= notice;
    try {
      unlinkSync(path);
    } catch {
      // Show the notice even if marker cleanup raced.
    }
  }
  return found;
}
