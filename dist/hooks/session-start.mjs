#!/usr/bin/env node
import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// capture/health.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync6, readFileSync as readFileSync7, renameSync as renameSync4, writeFileSync as writeFileSync6 } from "node:fs";
import { join as join9 } from "node:path";
import { randomUUID as randomUUID4 } from "node:crypto";

// capture/config.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { join as join6 } from "node:path";

// capture/auth.ts
import {
  chmodSync as chmodSync2,
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync2,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// capture/augenta-dir.ts
import { join } from "node:path";
import { chmodSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
var LOCAL_IGNORE = `*
`;
var SHARED_IGNORE = `*
!/.gitignore
!/config.json
`;
function ensureAugentaDir(projectRoot) {
  const dir = join(projectRoot, ".augenta");
  try {
    mkdirSync(dir, { recursive: true, mode: 448 });
    try {
      chmodSync(dir, 448);
    } catch {}
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore))
      writeFileSync(ignore, LOCAL_IGNORE);
  } catch {}
  return dir;
}
function setAugentaIgnore(projectRoot, form) {
  const path = join(ensureAugentaDir(projectRoot), ".gitignore");
  const wanted = form === "shared" ? SHARED_IGNORE : LOCAL_IGNORE;
  try {
    const current = readFileSync(path, "utf8");
    if (current === wanted || current !== LOCAL_IGNORE && current !== SHARED_IGNORE)
      return;
    writeFileSync(path, wanted);
  } catch {}
}

// capture/network.ts
class DiscoveryError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "DiscoveryError";
  }
}
var TLS_CODES = /^(CERT_|UNABLE_TO_|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_)/;
function* causes(error) {
  let current = error;
  for (let depth = 0;current && typeof current === "object" && depth < 8; depth++) {
    yield current;
    current = current.cause;
  }
}
function classifyNetworkError(error) {
  for (const link of causes(error)) {
    if (link instanceof DiscoveryError) {
      return link.status === 404 ? undefined : { kind: "proxy_refused", status: link.status };
    }
    const proxy = /^Proxy response \((\d{3})\)/.exec(String(link.message ?? ""));
    if (proxy)
      return { kind: "proxy_refused", status: Number(proxy[1]) };
    const code = typeof link.code === "string" ? link.code : undefined;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN")
      return { kind: "dns", code };
    if (code === "ECONNREFUSED")
      return { kind: "refused", code };
    if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET")
      return { kind: "reset", code };
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || link.name === "TimeoutError") {
      return { kind: "timeout", ...code ? { code } : {} };
    }
    if (code && TLS_CODES.test(code))
      return { kind: "tls", code };
  }
  return;
}
var PRODUCTION = { control: "https://augenta.ai", issuer: "https://auth.augenta.ai", gateway: "https://api.augenta.ai" };
async function check(fetcher, url, timeoutMs, isAugenta) {
  const host = new URL(url).host;
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json().catch(() => {
      return;
    });
    return isAugenta(response, body) ? { host, ok: true } : { host, ok: false, reason: `answered ${response.status}, not as Augenta does` };
  } catch (error) {
    const failure = classifyNetworkError(error);
    return {
      host,
      ok: false,
      reason: !failure ? "no answer" : failure.kind === "proxy_refused" ? `a proxy refused it (${failure.status})` : failure.kind === "dns" ? "the name did not resolve" : failure.kind === "refused" ? "the connection was refused" : failure.kind === "reset" ? "the connection was cut" : failure.kind === "timeout" ? "no answer in time" : "its TLS certificate was not trusted",
      ...failure ? { kind: failure.kind } : {}
    };
  }
}
async function diagnoseHosts(controlUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3000;
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, { ...init, signal: init.signal }));
  const control = controlUrl.replace(/\/+$/, "");
  let issuer;
  let gateway;
  const discovery = await check(fetcher, `${control}/.well-known/augenta.json`, timeoutMs, (response, body) => {
    const document = body;
    if (!response.ok || typeof document?.issuer !== "string")
      return false;
    issuer = document.issuer;
    gateway = typeof document.gateway === "string" ? document.gateway : undefined;
    return true;
  });
  if (!discovery.ok && control === PRODUCTION.control) {
    issuer = PRODUCTION.issuer;
    gateway = PRODUCTION.gateway;
  }
  if (options.gateway)
    gateway = options.gateway;
  const rest = await Promise.all([
    issuer ? check(fetcher, `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, timeoutMs, (response, body) => response.ok && typeof body?.issuer === "string") : undefined,
    gateway ? check(fetcher, `${gateway.replace(/\/+$/, "")}/v1/me`, timeoutMs, (response, body) => response.status === 401 && typeof body?.error === "string") : undefined
  ]);
  return [discovery, ...rest.filter((item) => Boolean(item))];
}

// capture/url.ts
function urlOrigin(value) {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return;
  }
}
function sameOrigin(a, b) {
  const origin = urlOrigin(a);
  return origin !== undefined && origin === urlOrigin(b);
}
function displayOrigin(value) {
  return urlOrigin(value) ?? "an address that is not a valid Augenta URL";
}

// runtime/node.ts
import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function isMain(metaUrl) {
  const entry = process.argv[1];
  if (!entry)
    return false;
  return canonical(fileURLToPath(metaUrl)) === canonical(entry);
}
function canonical(path) {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}
var SANDBOX_PROXY_CA = "/usr/local/share/ca-certificates/mitm-proxy-ca.crt";
var SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
function nodeHonorsEnvProxy(version) {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major >= 24 || major === 22 && minor >= 21;
}
function readable(path) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
function envProxyReexecEnv(env, nodeVersion, runningUnderBun, isReadable = readable) {
  if (env.AUGENTA_PROXY_REEXEC || runningUnderBun)
    return;
  const proxied = Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
  const useProxy = proxied && !env.NODE_USE_ENV_PROXY && nodeHonorsEnvProxy(nodeVersion);
  const ca = env.NODE_EXTRA_CA_CERTS ? undefined : isReadable(SANDBOX_PROXY_CA) ? SANDBOX_PROXY_CA : (useProxy || env.NODE_USE_ENV_PROXY) && isReadable(SYSTEM_CA_BUNDLE) ? SYSTEM_CA_BUNDLE : undefined;
  if (!useProxy && !ca)
    return;
  return {
    ...env,
    AUGENTA_PROXY_REEXEC: "1",
    ...useProxy ? { NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: env.NODE_NO_WARNINGS ?? "1" } : {},
    ...ca ? { NODE_EXTRA_CA_CERTS: ca } : {}
  };
}
function reexecForEnvProxy() {
  const next = envProxyReexecEnv(process.env, process.versions.node, Boolean(process.versions.bun));
  if (!next)
    return;
  const result = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: next
  });
  if (result.error)
    return;
  process.exit(result.status ?? 1);
}
function urlOpener(platform = process.platform) {
  if (platform === "darwin")
    return ["open"];
  if (platform === "win32")
    return ["rundll32", "url.dll,FileProtocolHandler"];
  return ["xdg-open"];
}
function openBrowser(url) {
  if (!isHttpsUrl(url))
    return;
  const [file, ...args] = urlOpener();
  spawnSync(file, [...args, url], { stdio: "ignore" });
}
function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// capture/auth.ts
class ReLoginRequiredError extends Error {
  reason;
  constructor(message, reason) {
    super(message);
    this.name = "ReLoginRequiredError";
    this.reason = reason;
  }
}
var authRoot = () => process.env.AUGENTA_AUTH_HOME || join2(homedir(), ".augenta");
var authPath = () => join2(authRoot(), "auth.json");
var lockPath = () => join2(authRoot(), "auth.lock");
var LOCK_WAIT_MS = 1e4;
var STALE_LOCK_MS = 30000;
var REQUEST_TIMEOUT_MS = 15000;
function ensureAuthRoot() {
  mkdirSync2(authRoot(), { recursive: true, mode: 448 });
  chmodSync2(authRoot(), 448);
}
function readAuthStore() {
  try {
    ensureAuthRoot();
    if (existsSync2(authPath()))
      chmodSync2(authPath(), 384);
    const parsed = JSON.parse(readFileSync2(authPath(), "utf8"));
    if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object") {
      return { version: 1, profiles: {} };
    }
    return { version: 1, profiles: parsed.profiles };
  } catch {
    return { version: 1, profiles: {} };
  }
}
function writeAuthStore(store) {
  ensureAuthRoot();
  const path = authPath();
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync2(tmp, `${JSON.stringify(store, null, 2)}
`, {
      mode: 384,
      flag: "wx"
    });
    chmodSync2(tmp, 384);
    renameSync(tmp, path);
    chmodSync2(path, 384);
  } finally {
    try {
      if (existsSync2(tmp))
        unlinkSync(tmp);
    } catch {}
  }
}
async function withAuthLock(fn) {
  ensureAuthRoot();
  const lock = lockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      writeFileSync2(lock, String(process.pid), { flag: "wx", mode: 384 });
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS)
          unlinkSync(lock);
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error("another Augenta login or token refresh is still running");
      }
      await new Promise((resolve2) => setTimeout(resolve2, 100));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {}
  }
}
function endpoint(issuer, suffix) {
  return `${issuer.replace(/\/+$/, "")}${suffix}`;
}
function form(values) {
  return new URLSearchParams(values).toString();
}
async function errorCode(response) {
  const body = await response.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : undefined;
}
async function refreshTokens(profile) {
  const response = await fetch(endpoint(profile.issuer, "/oauth2/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: form({
      grant_type: "refresh_token",
      refresh_token: profile.refreshToken,
      client_id: profile.clientId
    })
  });
  if (response.ok)
    return await response.json();
  const code = await errorCode(response);
  if (response.status === 400 || response.status === 401 || code === "invalid_grant" || code === "access_denied") {
    throw new ReLoginRequiredError("the Augenta sign-in expired or was revoked", "login_revoked");
  }
  throw new Error(`Augenta token refresh failed (${response.status})`);
}
async function augentaOAuthConfig(controlUrl) {
  const response = await fetch(`${controlUrl.replace(/\/+$/, "")}/.well-known/augenta.json`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const host = new URL(controlUrl).host;
  if (!response.ok) {
    if (response.status === 404)
      throw new Error("Augenta sign-in is not configured for this environment");
    throw new DiscoveryError(response.status, `${host} answered ${response.status} instead of Augenta's sign-in discovery; a proxy or network allowlist may be answering for it`);
  }
  const value = await response.json().catch(() => {
    throw new DiscoveryError(response.status, `${host} did not answer with Augenta's sign-in discovery; a proxy or captive page may be answering for it`);
  });
  if (!value.issuer || !value.clientId || !value.gateway) {
    throw new Error("Augenta returned incomplete sign-in configuration");
  }
  return {
    issuer: value.issuer.replace(/\/+$/, ""),
    clientId: value.clientId,
    gateway: value.gateway.replace(/\/+$/, "")
  };
}
var pendingLoginPath = () => join2(authRoot(), "pending-login.json");
function savePendingLogin(pending) {
  ensureAuthRoot();
  const path = pendingLoginPath();
  writeFileSync2(path, `${JSON.stringify(pending, null, 2)}
`, { mode: 384 });
  chmodSync2(path, 384);
}
function readPendingLogin() {
  try {
    const parsed = JSON.parse(readFileSync2(pendingLoginPath(), "utf8"));
    if (typeof parsed.deviceCode !== "string" || typeof parsed.clientId !== "string" || typeof parsed.issuer !== "string" || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= Date.now()) {
      return;
    }
    return parsed;
  } catch {
    return;
  }
}
function clearPendingLogin() {
  try {
    unlinkSync(pendingLoginPath());
  } catch {}
}
async function beginDeviceLogin(config, opts = {}) {
  const start = await fetch(endpoint(config.issuer, "/oauth2/device_authorization"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: form({
      client_id: config.clientId,
      scope: "openid profile email offline_access"
    })
  });
  if (!start.ok) {
    throw new Error(`could not start the Augenta sign-in (${start.status})`);
  }
  const device = await start.json();
  const pending = {
    deviceCode: device.device_code,
    userCode: device.user_code,
    verificationUri: device.verification_uri_complete || device.verification_uri,
    issuer: config.issuer,
    clientId: config.clientId,
    gateway: config.gateway,
    intervalMs: Math.max(1, device.interval ?? 5) * 1000,
    expiresAt: Date.now() + device.expires_in * 1000
  };
  if (opts.openBrowser !== false) {
    try {
      openBrowser(pending.verificationUri);
    } catch {}
  }
  return pending;
}
async function pollDeviceToken(pending, opts) {
  const deadline = Math.min(pending.expiresAt, Date.now() + opts.waitMs);
  let intervalMs = pending.intervalMs;
  while (Date.now() < deadline) {
    await new Promise((resolve2) => setTimeout(resolve2, Math.max(1, Math.min(intervalMs, deadline - Date.now()))));
    const response = await fetch(endpoint(pending.issuer, "/oauth2/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, pending.expiresAt - Date.now()))),
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pending.deviceCode,
        client_id: pending.clientId
      })
    });
    if (response.ok) {
      const result = await response.json();
      if (!result.access_token || !result.refresh_token) {
        throw new Error("Augenta sign-in did not return refreshable credentials");
      }
      return {
        ok: true,
        tokens: {
          accessToken: result.access_token,
          refreshToken: result.refresh_token,
          expiresAt: Date.now() + result.expires_in * 1000
        }
      };
    }
    const code = await errorCode(response);
    if (code === "authorization_pending")
      continue;
    if (code === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (code === "access_denied") {
      throw new ReLoginRequiredError("the Augenta sign-in was declined", "login_denied");
    }
    if (code === "expired_token") {
      throw new ReLoginRequiredError("the Augenta sign-in link expired", "login_expired");
    }
    throw new Error(`Augenta sign-in failed (${response.status})`);
  }
  if (Date.now() >= pending.expiresAt) {
    throw new ReLoginRequiredError("the Augenta sign-in link expired", "login_expired");
  }
  return { ok: false, reason: "pending", intervalMs };
}
async function deviceLogin(config) {
  const pending = await beginDeviceLogin(config);
  console.log(`Open ${pending.verificationUri}`);
  console.log(`Augenta verification code: ${pending.userCode}`);
  const result = await pollDeviceToken(pending, {
    waitMs: pending.expiresAt - Date.now()
  });
  if (!result.ok) {
    throw new ReLoginRequiredError("the Augenta sign-in link expired", "login_expired");
  }
  return result.tokens;
}
function profileIdFor(config, orgId) {
  const coordinates = [
    config.issuer.replace(/\/+$/, ""),
    config.clientId,
    config.gateway.replace(/\/+$/, ""),
    orgId
  ].join("\x00");
  const digest = createHash("sha256").update(coordinates).digest("hex").slice(0, 24);
  return `profile_${digest}`;
}
async function saveDeviceProfile(config, tokens, identity) {
  return withAuthLock(() => {
    const store = readAuthStore();
    const profileId = profileIdFor(config, identity.orgId);
    const profile = {
      issuer: config.issuer,
      clientId: config.clientId,
      gateway: config.gateway,
      userId: identity.userId,
      orgId: identity.orgId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      updatedAt: new Date().toISOString()
    };
    store.profiles[profileId] = profile;
    writeAuthStore(store);
    return { profileId, profile };
  });
}
function getAuthProfile(profileId) {
  return readAuthStore().profiles[profileId];
}
function reusableProfiles(config) {
  return Object.entries(readAuthStore().profiles).filter(([, profile]) => profile.issuer.replace(/\/+$/, "") === config.issuer.replace(/\/+$/, "") && profile.clientId === config.clientId && profile.gateway.replace(/\/+$/, "") === config.gateway.replace(/\/+$/, "")).map(([profileId, profile]) => ({ profileId, profile })).sort((a, b) => b.profile.updatedAt.localeCompare(a.profile.updatedAt));
}
async function accessTokenForProfile(profileId, forceRefresh = false, target) {
  return withAuthLock(async () => {
    const store = readAuthStore();
    const profile = store.profiles[profileId];
    if (!profile) {
      throw new ReLoginRequiredError("the Augenta sign-in is missing; run augenta:connect again");
    }
    if (target !== undefined)
      assertSignInTarget(profileId, target, profile.gateway);
    if (!forceRefresh && profile.expiresAt > Date.now() + 60000) {
      return profile.accessToken;
    }
    const rotated = await refreshTokens(profile);
    const updated = {
      ...profile,
      accessToken: rotated.access_token,
      refreshToken: rotated.refresh_token || profile.refreshToken,
      expiresAt: Date.now() + rotated.expires_in * 1000,
      updatedAt: new Date().toISOString()
    };
    store.profiles[profileId] = updated;
    writeAuthStore(store);
    return updated.accessToken;
  });
}
function freshStoredAccessToken(profileId, marginMs = 15000) {
  const profile = storedProfile(profileId);
  if (!profile || typeof profile.accessToken !== "string" || !profile.accessToken)
    return;
  if (typeof profile.expiresAt !== "number" || profile.expiresAt <= Date.now() + marginMs)
    return;
  return profile.accessToken;
}
function storedProfileUpdatedAt(profileId) {
  const updatedAt = storedProfile(profileId)?.updatedAt;
  const ms = typeof updatedAt === "string" ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}
function hasStoredProfile(profileId) {
  return storedProfile(profileId) !== undefined;
}
function storedProfileUserId(profileId) {
  const userId = storedProfile(profileId)?.userId;
  return typeof userId === "string" && userId ? userId : undefined;
}
function storedProfileGateway(profileId) {
  const gateway = storedProfile(profileId)?.gateway;
  return typeof gateway === "string" && gateway.trim() ? gateway.trim().replace(/\/+$/, "") : undefined;
}
function storedProfile(profileId) {
  try {
    const parsed = JSON.parse(readFileSync2(authPath(), "utf8"));
    if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object")
      return;
    return Object.hasOwn(parsed.profiles, profileId) ? parsed.profiles[profileId] : undefined;
  } catch {
    return;
  }
}
function assertSignInTarget(profileId, url, gateway = storedProfileGateway(profileId)) {
  const own = gateway?.trim().replace(/\/+$/, "") || undefined;
  if (!own || !sameOrigin(url, own)) {
    throw new Error(`refusing to send this Augenta sign-in to ${displayOrigin(url)}: it was made for ${own ? displayOrigin(own) : "a gateway this machine does not record"}`);
  }
}
async function fetchWithProfile(profileId, url, init = {}) {
  const send = async (forceRefresh) => {
    const accessToken = await accessTokenForProfile(profileId, forceRefresh, url);
    return fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        ...init.body ? { "content-type": "application/json" } : {},
        ...init.headers || {},
        authorization: `Bearer ${accessToken}`
      }
    });
  };
  const first = await send(false);
  return first.status === 401 ? send(true) : first;
}
var NOTICES = ["relogin", "badkey", "connect"];
function noticePath(projectRoot, notice) {
  return join2(projectRoot, ".augenta", `${notice}-required`);
}
function markAuthNotice(projectRoot, notice) {
  try {
    ensureAugentaDir(projectRoot);
    writeFileSync2(noticePath(projectRoot, notice), `${notice}
`, {
      mode: 384
    });
  } catch {}
}
function authNoticePending(projectRoot, notice, since) {
  try {
    return statSync(noticePath(projectRoot, notice)).mtimeMs >= (since ?? Number.NEGATIVE_INFINITY);
  } catch {
    return false;
  }
}
function takeAuthNotice(projectRoot) {
  let found;
  for (const notice of NOTICES) {
    const path = noticePath(projectRoot, notice);
    if (!existsSync2(path))
      continue;
    found ??= notice;
    try {
      unlinkSync(path);
    } catch {}
  }
  return found;
}

// capture/links.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync as renameSync2, rmSync, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
function linksPath(projectRoot) {
  return join3(projectRoot, ".augenta", "state", "links.json");
}
function legacyAdoptionPath(projectRoot) {
  return join3(projectRoot, ".augenta", "state", "adopted.json");
}
var nonEmpty = (value) => typeof value === "string" && value.length > 0;
function readLinks(projectRoot) {
  try {
    const value = JSON.parse(readFileSync3(linksPath(projectRoot), "utf8"));
    if (value.version !== 1)
      return;
    if (!nonEmpty(value.profileId) || !nonEmpty(value.userId) || !nonEmpty(value.projectKey))
      return;
    if (!nonEmpty(value.joinedAt) || !Number.isFinite(Date.parse(value.joinedAt)))
      return;
    if (!Array.isArray(value.links) || value.links.length === 0)
      return;
    const links = [];
    for (const item of value.links) {
      const link = item;
      if (!link || !nonEmpty(link.workspaceId) || !nonEmpty(link.connectorId))
        return;
      if (links.some((seen) => seen.workspaceId === link.workspaceId || seen.connectorId === link.connectorId)) {
        return;
      }
      links.push({ workspaceId: link.workspaceId, connectorId: link.connectorId });
    }
    return {
      profileId: value.profileId,
      userId: value.userId,
      projectKey: value.projectKey,
      joinedAt: new Date(value.joinedAt).toISOString(),
      links
    };
  } catch {
    return;
  }
}
function writeLinks(projectRoot, links) {
  const dir = join3(ensureAugentaDir(projectRoot), "state");
  mkdirSync3(dir, { recursive: true });
  const path = join3(dir, "links.json");
  const tmp = `${path}.${randomUUID2()}.tmp`;
  try {
    writeFileSync3(tmp, JSON.stringify({
      version: 1,
      profileId: links.profileId,
      userId: links.userId,
      projectKey: links.projectKey,
      joinedAt: links.joinedAt,
      links: links.links.map(({ workspaceId, connectorId }) => ({ workspaceId, connectorId }))
    }), { mode: 384 });
    renameSync2(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  rmSync(legacyAdoptionPath(projectRoot), { force: true });
}

// capture/project.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync4, realpathSync as realpathSync2 } from "node:fs";
import { dirname as dirname2, join as join5, resolve as resolve3 } from "node:path";

// capture/environment.ts
import { existsSync as existsSync3 } from "node:fs";
import { dirname, join as join4, resolve as resolve2 } from "node:path";
function sessionEnvironment(env = process.env) {
  const declared = env.AUGENTA_EPHEMERAL?.trim().toLowerCase();
  if (declared === "0" || declared === "false")
    return { ephemeral: false, signals: ["AUGENTA_EPHEMERAL=0"] };
  const signals = [];
  let kind;
  if (env.CLAUDE_CODE_REMOTE === "true") {
    signals.push("CLAUDE_CODE_REMOTE");
    kind ??= "claude-cloud";
  }
  if (env.CODEX_HOME?.trim().replace(/\/+$/, "") === "/opt/codex") {
    signals.push("CODEX_HOME=/opt/codex (heuristic)");
    kind ??= "codex-cloud";
  }
  if (declared === "1" || declared === "true") {
    signals.push("AUGENTA_EPHEMERAL=1");
    kind ??= "declared";
  }
  return { ephemeral: signals.length > 0, ...kind ? { kind } : {}, signals };
}
function insideGitCheckout(dir) {
  let current = resolve2(dir);
  while (true) {
    if (existsSync3(join4(current, ".git")))
      return true;
    const parent = dirname(current);
    if (parent === current)
      return false;
    current = parent;
  }
}
function ephemeralProject(projectRoot, env = process.env) {
  return sessionEnvironment(env).ephemeral && !insideGitCheckout(projectRoot);
}

// capture/project.ts
function gitRevParse(cwd, arg) {
  try {
    const value = execFileSync("git", ["rev-parse", arg], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"]
    }).toString().trim();
    return value || undefined;
  } catch {
    return;
  }
}
function isTrackedByGit(projectRoot, relativePath) {
  return gitTracks(projectRoot, relativePath) === true;
}
function gitTracking(projectRoot, relativePath) {
  const tracked = gitTracks(projectRoot, relativePath);
  if (tracked === true)
    return "tracked";
  return tracked === undefined && insideGitCheckout(projectRoot) ? "unverified" : undefined;
}
function gitTracks(projectRoot, relativePath) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
      cwd: projectRoot,
      stdio: "ignore"
    });
    return true;
  } catch (error) {
    return error.status === 1 ? false : undefined;
  }
}
function resolveProjectRoot(cwd) {
  if (!cwd)
    return;
  let dir;
  try {
    dir = realpathSync2(cwd);
  } catch {
    return;
  }
  while (true) {
    if (existsSync4(join5(dir, ".augenta", "config.json")))
      return dir;
    if (existsSync4(join5(dir, ".git")))
      return;
    const parent = dirname2(dir);
    if (parent === dir)
      return;
    dir = parent;
  }
}
function resolveProject(args, cwd) {
  if (args.project)
    return { projectRoot: resolve3(cwd, args.project) };
  const configured = resolveProjectRoot(cwd);
  if (configured)
    return { projectRoot: configured };
  const top = gitRevParse(cwd, "--show-toplevel");
  if (!top)
    return { projectRoot: cwd };
  return { projectRoot: top };
}
function resolveTargetProject(args, cwd) {
  return resolveProject(args, cwd).projectRoot;
}

// capture/config.ts
var DEFAULT_GATEWAY = "https://apim-aug-platform-prod-utyom2a4bdhti.azure-api.net";
var DEFAULT_CONTROL_URL = "https://augenta.ai";
function parseDestinations(raw) {
  if (!Array.isArray(raw) || raw.length === 0)
    return;
  const destinations = [];
  for (const item of raw) {
    if (!item || typeof item !== "object")
      return;
    const connectorId = typeof item.connectorId === "string" ? item.connectorId.trim() : "";
    const workspaceId = typeof item.workspaceId === "string" ? item.workspaceId.trim() : "";
    if (!connectorId || !workspaceId)
      return;
    if (item.workspaceName !== undefined && typeof item.workspaceName !== "string")
      return;
    if (destinations.some((destination) => destination.connectorId === connectorId))
      continue;
    const workspaceName = item.workspaceName?.trim();
    destinations.push({ connectorId, workspaceId, ...workspaceName ? { workspaceName } : {} });
  }
  return destinations;
}
function parseWorkspaces(raw) {
  if (!Array.isArray(raw) || raw.length === 0)
    return;
  const workspaces = [];
  for (const item of raw) {
    if (!item || typeof item !== "object")
      return;
    const workspaceId = typeof item.workspaceId === "string" ? item.workspaceId.trim() : "";
    if (!workspaceId)
      return;
    if (item.workspaceName !== undefined && typeof item.workspaceName !== "string")
      return;
    if (workspaces.some((workspace) => workspace.workspaceId === workspaceId))
      continue;
    const workspaceName = item.workspaceName?.trim();
    workspaces.push({ workspaceId, ...workspaceName ? { workspaceName } : {} });
  }
  return workspaces;
}
function joinedRoutes(projectRoot, profileId, projectKey, workspaces) {
  const links = readLinks(projectRoot);
  if (!links || links.projectKey !== projectKey)
    return { join: "none" };
  if (links.profileId !== profileId || storedProfileUserId(profileId) !== links.userId)
    return { join: "signin" };
  const destinations = [];
  for (const workspace of workspaces) {
    const link = links.links.find((entry) => entry.workspaceId === workspace.workspaceId);
    if (!link)
      return { join: "workspaces" };
    destinations.push({ connectorId: link.connectorId, ...workspace });
  }
  if (links.links.length !== workspaces.length)
    return { join: "workspaces" };
  return { join: "joined", destinations, joinedAt: links.joinedAt };
}
function configPath(projectRoot) {
  return join6(projectRoot, ".augenta", "config.json");
}
function loadProjectConfig(projectRoot) {
  try {
    const value = JSON.parse(readFileSync4(configPath(projectRoot), "utf8"));
    if (value.captureSince !== undefined && (typeof value.captureSince !== "string" || !Number.isFinite(Date.parse(value.captureSince))))
      return;
    const captureSince = typeof value.captureSince === "string" && Number.isFinite(Date.parse(value.captureSince)) ? new Date(value.captureSince).toISOString() : undefined;
    const settings = {};
    for (const key of ["endpoint", "controlUrl", "ingestUrl", "discoveredGateway"]) {
      const raw = value[key];
      if (raw !== undefined && typeof raw !== "string")
        return;
      if (typeof raw === "string" && raw.trim()) {
        settings[key] = raw.trim().replace(/\/+$/, "");
      }
    }
    if (value.autoRecall !== undefined && typeof value.autoRecall !== "boolean")
      return;
    if (typeof value.autoRecall === "boolean")
      settings.autoRecall = value.autoRecall;
    if (value.org !== undefined) {
      if (!value.org || typeof value.org.id !== "string" || !value.org.id.trim())
        return;
      if (value.org.name !== undefined && typeof value.org.name !== "string")
        return;
      settings.org = { id: value.org.id.trim(), ...value.org.name?.trim() ? { name: value.org.name.trim() } : {} };
    }
    if (value.authMode === "oauth") {
      if (value.destinations !== undefined)
        return;
      const profileId = typeof value.profileId === "string" ? value.profileId.trim() : "";
      const projectKey = typeof value.projectKey === "string" ? value.projectKey.trim() : "";
      const workspaces = parseWorkspaces(value.workspaces);
      if (!profileId || !projectKey || !workspaces)
        return;
      const joined = joinedRoutes(projectRoot, profileId, projectKey, workspaces);
      const own = joined.join === "joined" ? storedProfileGateway(profileId) : undefined;
      const gatewayMismatch = joined.join !== "joined" || own && routesOnlyTo(own, settings) ? undefined : {
        sendsTo: own ? routeOutside(own, settings) : displayOrigin(gatewayBase(settings)),
        ...own ? { signedInFor: own } : {},
        cause: own && routesOnlyTo(own, settings, {}) ? "environment" : "file"
      };
      const routes = gatewayMismatch ? { join: "gateway" } : joined;
      return {
        ...settings,
        authMode: "oauth",
        profileId,
        projectKey,
        workspaces,
        join: routes.join,
        ...gatewayMismatch ? { gatewayMismatch } : {},
        ...routes.destinations ? {
          destinations: routes.destinations,
          connectorIds: routes.destinations.map((destination) => destination.connectorId),
          captureSince: routes.joinedAt
        } : {},
        projectRoot
      };
    }
    const destinations = value.destinations === undefined ? undefined : parseDestinations(value.destinations);
    if (value.destinations !== undefined && !destinations)
      return;
    if (destinations) {
      settings.destinations = destinations;
      settings.connectorIds = destinations.map((destination) => destination.connectorId);
    }
    if (value.authMode === "api-key") {
      const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
      if (!apiKey || Array.isArray(value.destinations) && value.destinations.length !== 1)
        return;
      return {
        ...settings,
        authMode: "api-key",
        ...captureSince ? { captureSince } : {},
        apiKey,
        ...keyTracking(projectRoot),
        projectRoot
      };
    }
    return;
  } catch {
    return;
  }
}
function projectConfig(cwd) {
  const root = resolveProjectRoot(cwd);
  return root ? loadProjectConfig(root) : undefined;
}
function controlUrl(cfg, flag) {
  return (flag?.trim() || process.env.AUGENTA_CONTROL_URL?.trim() || cfg?.controlUrl || DEFAULT_CONTROL_URL).replace(/\/+$/, "");
}
function gatewayBase(cfg, flag, env = process.env) {
  return (flag?.trim() || env.AUGENTA_API_URL?.trim() || cfg?.endpoint || DEFAULT_GATEWAY).replace(/\/+$/, "");
}
function experiencesUrl(cfg, env = process.env) {
  return env.AUGENTA_INGEST_URL || cfg?.ingestUrl || `${gatewayBase(cfg, undefined, env)}/v1/experiences`;
}
function routesOnlyTo(gateway, cfg, env = process.env) {
  return gatewayBase(cfg, undefined, env) === gateway.replace(/\/+$/, "") && sameOrigin(experiencesUrl(cfg, env), gateway);
}
function routeOutside(gateway, cfg) {
  if (routesOnlyTo(gateway, cfg))
    return;
  const base = gatewayBase(cfg);
  const elsewhere = base !== gateway.replace(/\/+$/, "") ? base : experiencesUrl(cfg);
  return sameOrigin(elsewhere, gateway) ? `another path on ${displayOrigin(gateway)}` : displayOrigin(elsewhere);
}
function describeGatewayMismatch(mismatch) {
  return mismatch.signedInFor ? `${mismatch.sendsTo}, not ${displayOrigin(mismatch.signedInFor)}, the gateway this checkout's sign-in was made for` : `${mismatch.sendsTo}, which this checkout's sign-in does not record as its gateway`;
}
function keyTracking(projectRoot) {
  const keyTracked = gitTracking(projectRoot, ".augenta/config.json");
  return keyTracked ? { keyTracked } : {};
}
function captureKilled() {
  const value = process.env.AUGENTA_CAPTURE_ENABLED;
  return value === "0" || value === "false";
}
function captureGate(cfg) {
  if (captureKilled())
    return "killed";
  if (cfg.authMode !== "oauth")
    return !cfg.apiKey ? "signed_out" : cfg.keyTracked ? "key_tracked" : "live";
  if (!cfg.profileId || !hasStoredProfile(cfg.profileId))
    return "signed_out";
  if (!cfg.connectorIds?.length)
    return "not_adopted";
  return "live";
}
function captureEnabled(cfg) {
  return Boolean(cfg) && captureGate(cfg) === "live";
}
function effectiveCaptureSince(cfg) {
  return cfg.captureSince;
}

// capture/outbox.ts
import { basename, dirname as dirname3, join as join8 } from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";
import { mkdirSync as mkdirSync5, existsSync as existsSync5, readFileSync as readFileSync6, writeFileSync as writeFileSync5, appendFileSync, renameSync as renameSync3, statSync as statSync3, unlinkSync as unlinkSync3 } from "node:fs";

// capture/capture-lock.ts
import { mkdirSync as mkdirSync4, openSync, readFileSync as readFileSync5, closeSync, writeFileSync as writeFileSync4, unlinkSync as unlinkSync2, statSync as statSync2 } from "node:fs";
import { join as join7 } from "node:path";
function captureLock(projectRoot) {
  const dir = join7(ensureAugentaDir(projectRoot), "state");
  mkdirSync4(dir, { recursive: true });
  const path = join7(dir, "capture.lock");
  const deadline = Date.now() + 750;
  do {
    try {
      const fd = openSync(path, "wx", 384);
      try {
        writeFileSync4(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync2(path);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST")
        return;
      try {
        const pid = Number(readFileSync5(path, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (e) {
            if (e.code === "ESRCH") {
              unlinkSync2(path);
              continue;
            }
          }
        } else if (Date.now() - statSync2(path).mtimeMs > 30000) {
          unlinkSync2(path);
          continue;
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  } while (Date.now() < deadline);
  return;
}

// capture/outbox.ts
var NEWLINE = 10;
var MAX_SPOOL_BYTES = 50 * 1024 * 1024;
var MAX_DEST_LAG_BYTES = 16 * 1024 * 1024;
var LAG_STRIKES = 3;
function isCaptureEvent(o) {
  const e = o;
  return !!e && typeof e.sid === "string" && typeof e.text === "string" && Number.isInteger(e.seq);
}
function isRawRecord(o) {
  const e = o;
  return !!e && typeof e.raw === "string" && typeof e.sid === "string";
}
function isDocumentRecord(o) {
  const e = o;
  if (!e || e.type !== "doc" || e.src !== "claude-code" && e.src !== "codex" || typeof e.sid !== "string" || typeof e.proj !== "string" || e.proj.length === 0)
    return false;
  const data = e.data;
  if (!data || data.kind !== "agent-memory" || typeof data.documentId !== "string" || data.documentId.length === 0 || typeof data.sourcePath !== "string" || typeof data.title !== "string" || data.format !== "text/markdown" || typeof data.text !== "string" || typeof data.sourceUpdatedAt !== "string" || typeof data.capturedAt !== "string" || typeof data.revision !== "string" || data.revision.length === 0 || typeof data.deleted !== "boolean" || typeof data.chunkIndex !== "number" || !Number.isInteger(data.chunkIndex) || data.chunkIndex < 0 || typeof data.chunkCount !== "number" || !Number.isInteger(data.chunkCount) || data.chunkCount <= 0)
    return false;
  return data.chunkIndex < data.chunkCount && e.sid === `memory-${data.documentId}`;
}

class Outbox {
  dir;
  spoolPath;
  cursorPath;
  projectRoot;
  maxSpoolBytes;
  maxDestLagBytes;
  constructor(projectRoot, opts = {}) {
    this.projectRoot = projectRoot;
    this.dir = join8(projectRoot, ".augenta", "outbox");
    this.spoolPath = join8(this.dir, "spool.jsonl");
    this.cursorPath = join8(this.dir, "cursor.json");
    this.maxSpoolBytes = opts.maxSpoolBytes ?? MAX_SPOOL_BYTES;
    this.maxDestLagBytes = opts.maxDestLagBytes ?? MAX_DEST_LAG_BYTES;
  }
  ensure() {
    ensureAugentaDir(this.projectRoot);
    mkdirSync5(this.dir, { recursive: true });
  }
  append(records) {
    if (records.length === 0)
      return true;
    if (existsSync5(this.appendJournalPath()))
      return false;
    this.ensure();
    try {
      if (statSync3(this.spoolPath).size >= this.maxSpoolBytes)
        return false;
    } catch {}
    appendFileSync(this.spoolPath, records.map((r) => JSON.stringify(r)).join(`
`) + `
`);
    return true;
  }
  forceAppend(records) {
    if (records.length === 0)
      return;
    if (existsSync5(this.appendJournalPath()))
      throw new Error("An outbox append needs recovery");
    this.ensure();
    appendFileSync(this.spoolPath, records.map((r) => JSON.stringify(r)).join(`
`) + `
`);
  }
  appendJournalPath() {
    return join8(this.dir, "append-transaction.json");
  }
  hasPendingAppend() {
    return existsSync5(this.appendJournalPath());
  }
  publish(path, value) {
    mkdirSync5(dirname3(path), { recursive: true, mode: 448 });
    const temp = `${path}.${randomUUID3()}.tmp`;
    try {
      writeFileSync5(temp, JSON.stringify(value), { mode: 384, flag: "wx" });
      renameSync3(temp, path);
    } finally {
      try {
        unlinkSync3(temp);
      } catch {}
    }
  }
  appendWithReceipt(records, receiptPath, receipt) {
    this.ensure();
    if (dirname3(receiptPath) !== join8(this.projectRoot, ".augenta", "state"))
      throw new Error("Invalid outbox receipt path");
    if (existsSync5(this.appendJournalPath()))
      throw new Error("An outbox append needs recovery");
    if (!records.length) {
      this.publish(receiptPath, receipt);
      return true;
    }
    appendFileSync(this.spoolPath, "");
    const before = statSync3(this.spoolPath);
    if (before.size >= this.maxSpoolBytes)
      return false;
    this.publish(this.appendJournalPath(), {
      version: 1,
      offset: before.size,
      inode: before.ino,
      content: records.map((record) => JSON.stringify(record)).join(`
`) + `
`,
      receiptName: basename(receiptPath),
      receipt
    });
    this.finishPendingAppend();
    return true;
  }
  finishPendingAppend() {
    const path = this.appendJournalPath();
    if (!existsSync5(path))
      return 0;
    if (statSync3(path).size > MAX_SPOOL_BYTES)
      throw new Error("Invalid outbox append journal");
    const journal = JSON.parse(readFileSync6(path, "utf8"));
    if (journal.version !== 1 || !Number.isSafeInteger(journal.offset) || journal.offset < 0 || typeof journal.content !== "string" || !journal.content.endsWith(`
`) || typeof journal.receiptName !== "string" || !/^[a-zA-Z0-9_-]+\.json$/.test(journal.receiptName))
      throw new Error("Invalid outbox append journal");
    const spool = statSync3(this.spoolPath);
    const content = Buffer.from(journal.content);
    const tail = readFileSync6(this.spoolPath).subarray(journal.offset);
    if (spool.ino !== journal.inode || spool.size < journal.offset || tail.length > content.length || !tail.equals(content.subarray(0, tail.length)))
      throw new Error("Outbox append journal no longer matches its spool");
    if (tail.length < content.length)
      appendFileSync(this.spoolPath, content.subarray(tail.length));
    this.publish(join8(this.projectRoot, ".augenta", "state", journal.receiptName), journal.receipt);
    unlinkSync3(path);
    return journal.content.split(`
`).length - 1;
  }
  dropEpisodePath() {
    return join8(this.dir, "dropped.json");
  }
  markDropped() {
    this.ensure();
    const path = this.dropEpisodePath();
    if (existsSync5(path))
      return false;
    writeFileSync5(path, JSON.stringify({ since: new Date().toISOString() }));
    return true;
  }
  clearDropEpisode() {
    try {
      unlinkSync3(this.dropEpisodePath());
    } catch {}
  }
  discardNoticePath() {
    return join8(this.dir, "discarded.json");
  }
  markDiscarded(entries) {
    if (entries.length === 0)
      return;
    this.ensure();
    try {
      writeFileSync5(this.discardNoticePath(), JSON.stringify({ at: new Date().toISOString(), destinations: entries }));
    } catch {}
  }
  takeDiscarded() {
    const path = this.discardNoticePath();
    try {
      const parsed = JSON.parse(readFileSync6(path, "utf8"));
      unlinkSync3(path);
      if (!Array.isArray(parsed.destinations) || parsed.destinations.length === 0) {
        return;
      }
      return parsed.destinations;
    } catch {
      return;
    }
  }
  static offset(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  static strikes(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return {};
    const parsed = {};
    for (const [key, count] of Object.entries(value)) {
      const n = Outbox.offset(count);
      if (!key || n === undefined)
        return {};
      parsed[key] = n;
    }
    return parsed;
  }
  readCursor() {
    let raw;
    try {
      raw = JSON.parse(readFileSync6(this.cursorPath, "utf8"));
    } catch {
      return { shipped: 0, lagStrikes: {} };
    }
    const shipped = Outbox.offset(raw.shipped) ?? 0;
    const lagStrikes = Outbox.strikes(raw.lagStrikes);
    const links = raw.links;
    if (!links || typeof links !== "object" || Array.isArray(links)) {
      return { shipped, lagStrikes };
    }
    const parsed = {};
    for (const [key, value] of Object.entries(links)) {
      const off = Outbox.offset(value);
      if (!key || off === undefined)
        return { shipped, lagStrikes };
      parsed[key] = off;
    }
    if (Object.keys(parsed).length === 0)
      return { shipped, lagStrikes };
    return { shipped, links: parsed, lagStrikes };
  }
  writeCursor(links, scalar, lagStrikes = {}) {
    this.ensure();
    const strikes = Object.keys(lagStrikes).length > 0 ? { lagStrikes } : {};
    const body = links ? { shipped: Math.min(...Object.values(links)), links, ...strikes } : { shipped: scalar ?? 0 };
    const tmp = this.cursorPath + ".tmp";
    writeFileSync5(tmp, JSON.stringify(body));
    renameSync3(tmp, this.cursorPath);
  }
  shippedOffset(destKey) {
    const { shipped, links } = this.readCursor();
    const stored = destKey === undefined || !links ? shipped : links[destKey] ?? 0;
    return stored > this.spoolEnd() ? 0 : stored;
  }
  spoolEnd() {
    try {
      return statSync3(this.spoolPath).size;
    } catch {
      return 0;
    }
  }
  registerDestinations(keys, opts = {}) {
    const wanted = [...new Set(keys)];
    if (wanted.length === 0)
      return;
    const { shipped, links, lagStrikes } = this.readCursor();
    const spoolEnd = this.spoolEnd();
    const inheritsScalar = (key) => shipped === 0 || (opts.freshKeys !== undefined ? !opts.freshKeys.includes(key) : wanted.length === 1);
    const next = {};
    for (const key of wanted) {
      next[key] = links?.[key] ?? (links ? spoolEnd : inheritsScalar(key) ? shipped : spoolEnd);
    }
    const unchanged = links !== undefined && Object.keys(links).length === wanted.length && wanted.every((key) => links[key] === next[key]);
    if (unchanged)
      return;
    const strikes = {};
    for (const key of wanted)
      if (lagStrikes[key])
        strikes[key] = lagStrikes[key];
    this.writeCursor(next, undefined, strikes);
  }
  enforceLag(progressed = []) {
    const { links, lagStrikes } = this.readCursor();
    if (!links || Object.keys(links).length < 2)
      return [];
    if (progressed.length === 0)
      return [];
    const leader = Math.max(...Object.values(links));
    const swept = [];
    const next = { ...links };
    const strikes = {};
    for (const [destKey, from] of Object.entries(links)) {
      if (progressed.includes(destKey))
        continue;
      if (leader - from <= this.maxDestLagBytes)
        continue;
      const count = (lagStrikes[destKey] ?? 0) + 1;
      if (count < LAG_STRIKES) {
        strikes[destKey] = count;
        continue;
      }
      const to = leader - this.maxDestLagBytes;
      if (to <= from)
        continue;
      next[destKey] = to;
      swept.push({ destKey, from, to });
    }
    const strikesChanged = Object.keys(strikes).length !== Object.keys(lagStrikes).length || Object.entries(strikes).some(([key, count]) => lagStrikes[key] !== count);
    if (swept.length > 0 || strikesChanged)
      this.writeCursor(next, undefined, strikes);
    return swept;
  }
  hasPendingBytes() {
    try {
      return statSync3(this.spoolPath).size > this.shippedOffset();
    } catch {
      return false;
    }
  }
  pendingByteCount(destKey) {
    return Math.max(0, this.spoolEnd() - this.shippedOffset(destKey));
  }
  readPending(maxBatch = Infinity, destKey) {
    const shipped = this.shippedOffset(destKey);
    if (this.hasPendingAppend())
      return { records: [], endOffset: shipped, hasMore: false };
    if (!existsSync5(this.spoolPath))
      return { records: [], endOffset: shipped, hasMore: false };
    const buf = readFileSync6(this.spoolPath);
    const start = Math.min(shipped, buf.length);
    const records = [];
    let off = start;
    let hasMore = false;
    let cursor = start;
    while (cursor < buf.length) {
      const nl = buf.indexOf(NEWLINE, cursor);
      const lineEnd = nl === -1 ? buf.length : nl;
      const next = nl === -1 ? buf.length : nl + 1;
      const text = buf.subarray(cursor, lineEnd).toString("utf8").trim();
      if (text) {
        if (records.length >= maxBatch) {
          hasMore = true;
          break;
        }
        try {
          const parsed = JSON.parse(text);
          if (isCaptureEvent(parsed) || isRawRecord(parsed) || isDocumentRecord(parsed))
            records.push(parsed);
        } catch {}
      }
      off = next;
      cursor = next;
    }
    return { records, endOffset: off, hasMore };
  }
  advance(endOffset, destKey) {
    if (destKey === undefined) {
      this.writeCursor(undefined, endOffset);
      return;
    }
    const { shipped, links, lagStrikes } = this.readCursor();
    const merged = { ...links ?? {} };
    merged[destKey] = Math.max(merged[destKey] ?? (links ? 0 : shipped), endOffset);
    this.writeCursor(merged, undefined, lagStrikes);
  }
  pendingCount(destKey) {
    return this.readPending(Infinity, destKey).records.length;
  }
  compact() {
    if (!existsSync5(this.spoolPath))
      return;
    const release = captureLock(this.projectRoot);
    if (!release)
      return;
    try {
      if (!this.hasPendingAppend())
        this.compactUnderLock();
    } finally {
      release();
    }
  }
  compactUnderLock() {
    let size;
    try {
      size = statSync3(this.spoolPath).size;
    } catch {
      return;
    }
    if (size > 0 && this.shippedOffset() >= size) {
      const archivePath = this.spoolPath + ".archive";
      try {
        renameSync3(this.spoolPath, archivePath);
      } catch {
        return;
      }
      const { links, lagStrikes } = this.readCursor();
      if (links) {
        this.writeCursor(Object.fromEntries(Object.keys(links).map((key) => [key, 0])), undefined, lagStrikes);
      } else {
        this.advance(0);
      }
      try {
        unlinkSync3(archivePath);
      } catch {}
    }
  }
}

// capture/health.ts
var STAGES = ["dispatch", "capture", "delivery"];
var outcomes = new Set(["started", "captured", "idle", "missing_transcript", "failed", "accepted", "rejected", "retry", "spool_full"]);
function read(projectRoot, stage) {
  try {
    const s = JSON.parse(readFileSync7(join9(projectRoot, ".augenta", "state", `health-${stage}.json`), "utf8"));
    if (!Number.isFinite(Date.parse(s.at)) || !outcomes.has(s.outcome) || !Number.isSafeInteger(s.count) || s.count < 0 || !Number.isSafeInteger(s.successes) || s.successes < 0)
      return;
    return {
      at: new Date(s.at).toISOString(),
      outcome: s.outcome,
      count: s.count,
      successes: s.successes,
      ...Number.isFinite(Date.parse(s.lastSuccessAt)) ? { lastSuccessAt: new Date(s.lastSuccessAt).toISOString() } : {}
    };
  } catch {
    return;
  }
}
function recordHealth(projectRoot, stage, outcome, count = 0) {
  try {
    const dir = join9(ensureAugentaDir(projectRoot), "state");
    mkdirSync6(dir, { recursive: true });
    const old = read(projectRoot, stage);
    const at = new Date().toISOString();
    const success = outcome === "captured" || outcome === "accepted";
    const value = {
      at,
      outcome,
      count,
      successes: Math.min(Number.MAX_SAFE_INTEGER, (old?.successes ?? 0) + (success ? 1 : 0)),
      ...success ? { lastSuccessAt: at } : old?.lastSuccessAt ? { lastSuccessAt: old.lastSuccessAt } : {}
    };
    const file = join9(dir, `health-${stage}.json`);
    const tmp = `${file}.${randomUUID4()}.tmp`;
    writeFileSync6(tmp, JSON.stringify(value), { mode: 384 });
    renameSync4(tmp, file);
  } catch {}
}
function captureHealth(projectRoot) {
  const cfg = loadProjectConfig(projectRoot);
  const activity = Object.fromEntries(STAGES.map((stage) => [stage, read(projectRoot, stage) ?? null]));
  const gate = cfg ? captureGate(cfg) : undefined;
  return {
    configured: !!cfg,
    enabled: gate === "live",
    ...gate ? { gate } : {},
    configuration: cfg ? "valid" : existsSync6(join9(projectRoot, ".augenta/config.json")) ? "invalid" : "missing",
    activityScope: "project",
    hostDispatch: "unverified",
    destinations: cfg?.authMode === "oauth" ? cfg.connectorIds?.length ?? 0 : cfg && !cfg.keyTracked ? 1 : 0,
    pendingBytes: cfg ? new Outbox(projectRoot).pendingByteCount() : 0,
    ...activity,
    hostApproval: "unknown",
    ingestion: "unverified",
    nextStep: !cfg ? "connect" : gate === "killed" ? "capture_disabled" : gate === "signed_out" ? "sign_in" : cfg.gatewayMismatch ? cfg.gatewayMismatch.cause === "environment" ? "unset_gateway_override" : "review_config_gateway" : gate === "not_adopted" ? "adopt" : gate === "key_tracked" ? cfg.keyTracked === "tracked" ? "untrack_config" : "make_git_available" : !activity.dispatch ? "check_host_hook_approval_and_activation" : activity.capture?.outcome === "missing_transcript" ? "check_host_transcript_payload" : "complete_a_turn_then_check_activity"
  };
}

// hooks/session-start.ts
import { homedir as homedir3 } from "node:os";
import { join as join12 } from "node:path";
import { createHash as createHash3 } from "node:crypto";
import { mkdirSync as mkdirSync8, readFileSync as readFileSync9, writeFileSync as writeFileSync8, renameSync as renameSync6 } from "node:fs";

// hooks/harness.ts
function isCodexHarness(transcriptPath) {
  if (!transcriptPath)
    return false;
  const p = transcriptPath.replace(/\\/g, "/");
  if (/\/\.claude\/projects\//.test(p))
    return false;
  const configuredHome = process.env.CODEX_HOME?.replace(/\\/g, "/").replace(/\/+$/, "");
  return /\/\.codex\//.test(p) || /\/rollout-[^/]*\.jsonl$/i.test(p) || Boolean(configuredHome && (p === configuredHome || p.startsWith(configuredHome + "/")));
}
function sniffHarness(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object")
    return;
  const o = parsed;
  const hasMessage = typeof o.message === "object" && o.message !== null;
  const hasPayload = typeof o.payload === "object" && o.payload !== null;
  if (typeof o.type === "string" && hasPayload && !hasMessage)
    return "codex";
  if (typeof o.type === "string" && ["user", "assistant", "system", "summary"].includes(o.type) || hasMessage) {
    return "claude-code";
  }
  return;
}

// capture/platform.ts
class AugentaRequestError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "AugentaRequestError";
  }
}
async function bearerJson(profileId, url, init = {}) {
  const response = await fetchWithProfile(profileId, url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AugentaRequestError(response.status, `Augenta request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return await response.json();
}
var WORKSPACE_LIST_PAGE_SIZE = 200;
var WORKSPACE_LIST_MAX_PAGES = 10;
async function fetchAllWorkspaces(profileId, gateway) {
  const workspaces = [];
  let cursor;
  for (let page = 0;page < WORKSPACE_LIST_MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(WORKSPACE_LIST_PAGE_SIZE) });
    if (cursor)
      query.set("cursor", cursor);
    const body = await bearerJson(profileId, `${gateway}/v1/workspaces?${query.toString()}`);
    workspaces.push(...body.workspaces ?? []);
    if (!body.nextCursor)
      return workspaces;
    if (body.nextCursor === cursor) {
      throw new Error("the Workspace list did not advance — the API returned the same page cursor twice");
    }
    cursor = body.nextCursor;
  }
  throw new Error(`the Workspace list did not finish within ${WORKSPACE_LIST_MAX_PAGES} pages of ` + `${WORKSPACE_LIST_PAGE_SIZE} — refusing to offer a partial list of destinations`);
}
async function currentConnector(profileId, gateway, id) {
  return inspectConnector((url, init) => fetchWithProfile(profileId, url, init), gateway, id);
}
async function inspectConnector(fetcher, gateway, id, signal) {
  if (!id)
    return;
  const response = await fetcher(`${gateway}/v1/connectors/${encodeURIComponent(id)}`, signal ? { signal } : {});
  if (response.status === 403 || response.status === 404)
    return;
  if (!response.ok) {
    throw new AugentaRequestError(response.status, `could not inspect the existing Connector (${response.status})`);
  }
  return (await response.json()).connector;
}
function environmentLabel(controlUrl2) {
  const url = (controlUrl2?.trim() || DEFAULT_CONTROL_URL).replace(/\/+$/, "");
  return url === DEFAULT_CONTROL_URL ? "prod" : url;
}
function describeError(error) {
  const message = error?.message ?? String(error);
  if (error instanceof DiscoveryError)
    return message;
  const failure = classifyNetworkError(error);
  switch (failure?.kind) {
    case "proxy_refused":
      return `cannot reach Augenta: a proxy refused the connection (${failure.status}). This network's allowlist may block Augenta's hosts.`;
    case "dns":
      return "cannot reach Augenta: the host name did not resolve. Check your network or DNS.";
    case "refused":
      return "cannot reach Augenta: the connection was refused. Check the URL, and any proxy or firewall.";
    case "reset":
      return "cannot reach Augenta: the connection was cut. Check any proxy or firewall.";
    case "timeout":
      return "cannot reach Augenta: no answer in time. Check your network, and any proxy or firewall.";
    case "tls":
      return "cannot reach Augenta: the TLS certificate could not be verified. Check for a TLS-intercepting proxy.";
  }
  if (message !== "fetch failed")
    return message;
  const cause = error.cause;
  const detail = cause?.message ?? cause?.code;
  return detail ? `cannot reach Augenta: ${detail}` : "cannot reach Augenta: the network request failed. Check your connection.";
}

// capture/shipper.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync7 } from "node:fs";
import { dirname as dirname4, join as join10 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function shipperEntry() {
  const self = fileURLToPath2(import.meta.url);
  const ext = self.endsWith(".ts") ? ".ts" : ".mjs";
  const here = dirname4(self);
  const sibling = join10(here, `ship${ext}`);
  return existsSync7(sibling) ? sibling : join10(here, "..", "capture", `ship${ext}`);
}
function spawnShipper(projectRoot) {
  try {
    const child = spawn(process.execPath, [shipperEntry(), projectRoot], {
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.once("error", () => recordHealth(projectRoot, "delivery", "failed"));
    child.unref();
    return child;
  } catch {
    recordHealth(projectRoot, "delivery", "failed");
    return;
  }
}

// capture/memory.ts
import { createHash as createHash2 } from "node:crypto";
import {
  existsSync as existsSync8,
  lstatSync,
  mkdirSync as mkdirSync7,
  readFileSync as readFileSync8,
  readdirSync,
  readlinkSync,
  realpathSync as realpathSync3,
  renameSync as renameSync5,
  statSync as statSync4,
  writeFileSync as writeFileSync7
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename as basename2, dirname as dirname5, extname, isAbsolute, join as join11, relative, resolve as resolve4, sep } from "node:path";

// capture/scrub.ts
var MASK = (label) => `[redacted:${label}]`;
var TOKEN_GUARD = "(?<!page[_-]?)(?<!continuation[_-]?)(?<!cursor[_-]?)(?<!sync[_-]?)(?<!csrf[_-]?)(?<!xsrf[_-]?)(?<!anti[_-]?forgery[_-]?)";
var SECRET_KEY_NAMES = `api[_-]?key|secret|${TOKEN_GUARD}token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|(?<!o)auth`;
var SCRUB_RULES = [
  {
    label: "private-key",
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    replace: MASK("private-key")
  },
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    replace: MASK("jwt")
  },
  { label: "token", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: MASK("token") },
  { label: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: MASK("github-token") },
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: MASK("slack-token") },
  { label: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: MASK("google-key") },
  { label: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: MASK("aws-key") },
  {
    label: "bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
    replace: "Bearer " + MASK("bearer")
  },
  {
    label: "url-credential",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]{1,200})@/gi,
    replace: (_m, prefix) => `${prefix}:${MASK("url-credential")}@`
  },
  {
    label: "assignment",
    pattern: new RegExp(`((?:${SECRET_KEY_NAMES})["']?\\s*[:=]\\s*)(["']?)([^"'\\s,;]{6,200})\\2`, "gi"),
    replace: (_m, head, quote) => `${head}${quote}${MASK("assignment")}${quote}`
  }
];
function scrub(text) {
  if (!text)
    return text;
  let out = text;
  for (const rule of SCRUB_RULES) {
    out = out.replace(rule.pattern, rule.replace);
  }
  return out;
}

// capture/memory.ts
var MAX_DOCUMENT_EXPERIENCE_BYTES = 512 * 1024;
function sameSnapshot(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
function sha256(input) {
  return createHash2("sha256").update(input).digest("hex");
}
function memoryStatePath(projectRoot) {
  return join11(projectRoot, ".augenta", "state", "memory.json");
}
function validEntry(value) {
  const e = value;
  return !!e && (e.source === "claude-code" || e.source === "codex") && typeof e.documentId === "string" && typeof e.sourcePath === "string" && typeof e.title === "string" && typeof e.sourceUpdatedAt === "string" && typeof e.revision === "string" && Number.isInteger(e.chunkCount) && e.chunkCount > 0;
}
function readMemoryIndex(projectRoot) {
  try {
    const parsed = JSON.parse(readFileSync8(memoryStatePath(projectRoot), "utf8"));
    const rawDocuments = parsed.documents;
    if (!parsed || parsed.version !== 1 || !rawDocuments || typeof rawDocuments !== "object") {
      return { version: 1, documents: {} };
    }
    const documents = {};
    for (const [id, entry] of Object.entries(rawDocuments)) {
      if (validEntry(entry) && entry.documentId === id)
        documents[id] = entry;
    }
    return { version: 1, documents };
  } catch {
    return { version: 1, documents: {} };
  }
}
function writeMemoryIndex(projectRoot, index) {
  const stateDir = join11(ensureAugentaDir(projectRoot), "state");
  const path = join11(stateDir, "memory.json");
  const tmp = path + ".tmp";
  try {
    mkdirSync7(stateDir, { recursive: true });
    writeFileSync7(tmp, JSON.stringify(index));
    renameSync5(tmp, path);
    return true;
  } catch {
    return false;
  }
}
function boundedTitle(title) {
  return [...title].slice(0, 512).join("");
}
function markdownTitle(text, fallback) {
  const heading = markdownH1s(text)[0]?.title;
  return boundedTitle(heading || fallback);
}
function normalizeLogicalPath(path) {
  return path.split(sep).join("/");
}
function scanClaudeMemory(transcriptPath) {
  if (!transcriptPath)
    return { complete: false, documents: [] };
  const root = join11(dirname5(transcriptPath), "memory");
  try {
    if (!existsSync8(root) || !lstatSync(root).isDirectory())
      return { complete: false, documents: [] };
  } catch {
    return { complete: false, documents: [] };
  }
  const documents = [];
  let complete = true;
  const walk = (dir) => {
    let directoryBefore;
    let entries;
    try {
      directoryBefore = lstatSync(dir);
      if (!directoryBefore.isDirectory()) {
        complete = false;
        return;
      }
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    } catch {
      complete = false;
      return;
    }
    for (const entry of entries) {
      const path = join11(dir, entry.name);
      if (entry.isSymbolicLink())
        continue;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md")
        continue;
      try {
        const before = lstatSync(path);
        if (!before.isFile()) {
          complete = false;
          continue;
        }
        const text = readFileSync8(path, "utf8");
        const after = lstatSync(path);
        if (!after.isFile() || !sameSnapshot(before, after)) {
          complete = false;
          continue;
        }
        const sourcePath = normalizeLogicalPath(relative(root, path));
        documents.push({
          sourcePath,
          title: markdownTitle(text, basename2(entry.name, extname(entry.name))),
          text,
          sourceUpdatedAt: after.mtime.toISOString()
        });
      } catch {
        complete = false;
      }
    }
    try {
      const directoryAfter = lstatSync(dir);
      if (!directoryAfter.isDirectory() || !sameSnapshot(directoryBefore, directoryAfter))
        complete = false;
    } catch {
      complete = false;
    }
  };
  walk(root);
  return { complete, documents };
}
var MAX_SYMLINK_HOPS = 40;
function symlinkTarget(path) {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve4(dirname5(path), readlinkSync(path)) : undefined;
  } catch {
    return;
  }
}
function physicalPath(path) {
  let existing = resolve4(path);
  const missing = [];
  let hops = 0;
  while (true) {
    try {
      return join11(realpathSync3(existing), ...missing);
    } catch {}
    const target = symlinkTarget(existing);
    if (target !== undefined) {
      if (++hops > MAX_SYMLINK_HOPS)
        return;
      existing = target;
      continue;
    }
    const parent = dirname5(existing);
    if (parent === existing)
      return resolve4(path);
    missing.unshift(basename2(existing));
    existing = parent;
  }
}
function isScopedToProject(scope, root) {
  if (!isAbsolute(scope))
    return false;
  const target = physicalPath(scope);
  if (target === undefined)
    return false;
  const rel = relative(root, target);
  return rel === "" || !rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel);
}
function markdownH1s(text) {
  const headings = [];
  let offset = 0;
  let fence;
  for (const rawLine of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (rawLine.length === 0)
      continue;
    const line = (rawLine.endsWith(`
`) ? rawLine.slice(0, -1) : rawLine).replace(/\r$/, "");
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const closing = new RegExp(`^ {0,3}\\${fence.marker}{${fence.length},}\\s*$`);
      if (closing.test(line))
        fence = undefined;
    } else if (fenceMatch) {
      const run = fenceMatch[1];
      fence = { marker: run[0], length: run.length };
    } else {
      const heading = /^ {0,3}#(?!#)\s+(.+?)\s*$/.exec(line);
      if (heading) {
        const title = heading[1].replace(/\s+#+\s*$/, "").trim();
        headings.push({ start: offset, contentStart: offset + rawLine.length, title });
      }
    }
    offset += rawLine.length;
  }
  return headings;
}
function parseCodexTaskGroups(text, projectRoot) {
  const headings = markdownH1s(text);
  const documents = [];
  const root = physicalPath(projectRoot);
  if (root === undefined)
    return documents;
  for (let i = 0;i < headings.length; i++) {
    const heading = headings[i];
    const taskGroup = /^Task Group:\s*(.+?)\s*$/.exec(heading.title);
    if (!taskGroup)
      continue;
    const end = headings[i + 1]?.start ?? text.length;
    const block = text.slice(heading.start, end);
    const header = taskGroup[1].trim();
    const firstBodyLine = text.slice(heading.contentStart, end).split(/\r?\n/).find((line) => line.trim().length > 0);
    const scopeMatch = firstBodyLine ? /^ {0,3}applies_to:\s*cwd=(.+?)\s*$/.exec(firstBodyLine) : null;
    if (!scopeMatch)
      continue;
    const scope = scopeMatch[1].trim().replace(/^['"]|['"]$/g, "");
    if (!isScopedToProject(scope, root))
      continue;
    const identity = sha256(`${header}\x00${scope}`).slice(0, 24);
    documents.push({
      sourcePath: `MEMORY.md#task-group-${identity}`,
      title: boundedTitle(`Task Group: ${header}`),
      text: block,
      sourceUpdatedAt: "",
      taskGroup: { header, scope }
    });
  }
  return documents;
}
function codexHomeFromRollout(transcriptPath) {
  if (!transcriptPath)
    return;
  const match = /^(.+)[\\/]sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]rollout-[^\\/]*\.jsonl$/i.exec(transcriptPath);
  return match?.[1];
}
function scanCodexMemory(projectRoot, codexHome, transcriptPath) {
  const root = codexHome ?? process.env.CODEX_HOME ?? codexHomeFromRollout(transcriptPath) ?? join11(homedir2(), ".codex");
  const path = join11(root, "memories", "MEMORY.md");
  try {
    if (!existsSync8(path))
      return { complete: false, documents: [] };
    const linkBefore = lstatSync(path);
    const before = statSync4(path);
    if (!before.isFile())
      return { complete: false, documents: [] };
    const text = readFileSync8(path, "utf8");
    const linkAfter = lstatSync(path);
    const after = statSync4(path);
    if (!after.isFile() || !sameSnapshot(linkBefore, linkAfter) || !sameSnapshot(before, after))
      return { complete: false, documents: [] };
    const sourceUpdatedAt = after.mtime.toISOString();
    return {
      complete: true,
      documents: parseCodexTaskGroups(text, projectRoot).map((doc) => ({ ...doc, sourceUpdatedAt }))
    };
  } catch {
    return { complete: false, documents: [] };
  }
}
function documentId(source, projectRoot, candidate) {
  const taskGroup = candidate.taskGroup;
  const discriminator = taskGroup ? `\x00${taskGroup.header}\x00${taskGroup.scope}` : "";
  return sha256(`${source}\x00${resolve4(projectRoot)}\x00${candidate.sourcePath}${discriminator}`);
}
function revision(text, deleted) {
  return sha256(`${deleted ? "deleted" : "live"}\x00${text}`);
}
function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function safeBoundary(text, index) {
  if (index > 0 && index < text.length) {
    const previous = text.charCodeAt(index - 1);
    const next = text.charCodeAt(index);
    if (previous >= 55296 && previous <= 56319 && next >= 56320 && next <= 57343)
      return index - 1;
  }
  return index;
}
function chunkText(text, makeRecord) {
  if (text.length === 0)
    return [""];
  const chunks = [];
  let start = 0;
  const sizingIndex = 999999999;
  while (start < text.length) {
    let lo = start + 1;
    let hi = text.length;
    let best = -1;
    while (lo <= hi) {
      const rawMid = Math.floor((lo + hi) / 2);
      const mid = safeBoundary(text, rawMid);
      if (mid <= start) {
        lo = rawMid + 1;
        continue;
      }
      const chunk = text.slice(start, mid);
      if (jsonBytes(makeRecord(chunk, sizingIndex, sizingIndex)) < MAX_DOCUMENT_EXPERIENCE_BYTES) {
        best = mid;
        lo = rawMid + 1;
      } else {
        hi = rawMid - 1;
      }
    }
    if (best <= start) {
      return [];
    }
    chunks.push(text.slice(start, best));
    start = best;
  }
  return chunks;
}
function makeLiveRecords(source, projectRoot, candidate, scrubbedText, documentRevision, capturedAt) {
  const id = documentId(source, projectRoot, candidate);
  const base = {
    kind: "agent-memory",
    documentId: id,
    sourcePath: candidate.sourcePath,
    title: candidate.title,
    format: "text/markdown",
    sourceUpdatedAt: candidate.sourceUpdatedAt,
    capturedAt,
    revision: documentRevision,
    deleted: false
  };
  const makeRecord = (text, chunkIndex, chunkCount) => ({
    src: source,
    sid: `memory-${id}`,
    proj: projectRoot,
    type: "doc",
    data: { ...base, text, chunkIndex, chunkCount }
  });
  const chunks = chunkText(scrubbedText, makeRecord);
  return chunks.map((text, chunkIndex) => makeRecord(text, chunkIndex, chunks.length));
}
function makeTombstone(source, projectRoot, previous, capturedAt) {
  const documentRevision = revision("", true);
  return {
    src: source,
    sid: `memory-${previous.documentId}`,
    proj: projectRoot,
    type: "doc",
    data: {
      kind: "agent-memory",
      documentId: previous.documentId,
      sourcePath: previous.sourcePath,
      title: previous.title,
      format: "text/markdown",
      text: "",
      sourceUpdatedAt: previous.sourceUpdatedAt,
      capturedAt,
      revision: documentRevision,
      deleted: true,
      chunkIndex: 0,
      chunkCount: 1
    }
  };
}
function captureAgentMemory(opts) {
  const scan = opts.harness === "codex" ? scanCodexMemory(opts.projectRoot, opts.codexHome, opts.transcriptPath) : scanClaudeMemory(opts.transcriptPath);
  const empty = { spooled: 0, changed: 0, tombstones: 0, complete: scan.complete };
  if (scan.documents.length === 0 && !scan.complete)
    return empty;
  const scrub2 = opts.scrub ?? scrub;
  const capturedAt = (opts.now ?? (() => new Date))().toISOString();
  const current = new Map;
  try {
    for (const candidate of scan.documents) {
      const text = scrub2(candidate.text);
      const id = documentId(opts.harness, opts.projectRoot, candidate);
      const documentRevision = revision(text, false);
      const scrubbedCandidate = { ...candidate, title: boundedTitle(scrub2(candidate.title)) };
      current.set(id, {
        candidate: scrubbedCandidate,
        revision: documentRevision,
        records: makeLiveRecords(opts.harness, opts.projectRoot, scrubbedCandidate, text, documentRevision, capturedAt)
      });
    }
  } catch {
    return empty;
  }
  const oldIndex = readMemoryIndex(opts.projectRoot);
  const nextIndex = { version: 1, documents: { ...oldIndex.documents } };
  const records = [];
  let changed = 0;
  let tombstones = 0;
  for (const [id, live] of current) {
    const prior = oldIndex.documents[id];
    if (prior?.revision === live.revision && prior.chunkCount === live.records.length && prior.title === live.candidate.title)
      continue;
    if (live.records.length === 0)
      return empty;
    records.push(...live.records);
    changed += 1;
    nextIndex.documents[id] = {
      source: opts.harness,
      documentId: id,
      sourcePath: live.candidate.sourcePath,
      title: live.candidate.title,
      sourceUpdatedAt: live.candidate.sourceUpdatedAt,
      revision: live.revision,
      chunkCount: live.records.length
    };
  }
  if (scan.complete) {
    for (const [id, prior] of Object.entries(oldIndex.documents)) {
      if (prior.source !== opts.harness || current.has(id))
        continue;
      records.push(makeTombstone(opts.harness, opts.projectRoot, prior, capturedAt));
      delete nextIndex.documents[id];
      tombstones += 1;
    }
  }
  if (records.length === 0)
    return empty;
  const outbox = opts.outbox ?? new Outbox(opts.projectRoot, { maxSpoolBytes: opts.maxSpoolBytes });
  let accepted = false;
  try {
    accepted = outbox.append(records);
  } catch {
    return empty;
  }
  if (!accepted || !writeMemoryIndex(opts.projectRoot, nextIndex))
    return empty;
  return { spooled: records.length, changed, tombstones, complete: scan.complete };
}

// hooks/session-start.ts
var transcriptPath;
var cwd;
try {
  const payload = JSON.parse(await readStdin());
  if (typeof payload.transcript_path === "string")
    transcriptPath = payload.transcript_path;
  if (typeof payload.cwd === "string")
    cwd = payload.cwd;
} catch {}
var codex = isCodexHarness(transcriptPath);
var connectAction = codex ? "$augenta:connect or Connect Augenta" : "/augenta:connect";
var projectPath = cwd || process.cwd();
var home = process.env.AUGENTA_HOME ?? homedir3();
var stateDir = join12(home, ".augenta", "state");
var markerPath = join12(stateDir, "connect-prompted.json");
var legacyMarkerPath = join12(stateDir, "init-prompted.json");
function readMarkers(path) {
  try {
    const parsed = JSON.parse(readFileSync9(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function firstTime(key) {
  const markers = readMarkers(markerPath);
  if (markers[key])
    return false;
  try {
    mkdirSync8(stateDir, { recursive: true });
    markers[key] = new Date().toISOString();
    const tmp = markerPath + ".tmp";
    writeFileSync8(tmp, JSON.stringify(markers));
    renameSync6(tmp, markerPath);
  } catch {
    return false;
  }
  return true;
}
function staleConfigDigest() {
  let bytes = "";
  try {
    bytes = readFileSync9(configPath(configuredRoot));
  } catch {}
  return createHash3("sha256").update(bytes).digest("hex").slice(0, 16);
}
var configuredRoot = resolveProjectRoot(projectPath);
var cfg = configuredRoot ? loadProjectConfig(configuredRoot) : undefined;
var staleConfig = Boolean(configuredRoot) && !cfg;
var connectedRoot = cfg ? configuredRoot : undefined;
if (connectedRoot) {
  if (captureEnabled(cfg)) {
    recordHealth(connectedRoot, "dispatch", "started");
    const action = connectAction;
    const notices = [];
    const environment = environmentLabel(controlUrl(cfg));
    if (environment !== "prod") {
      const names = (cfg?.workspaces ?? cfg?.destinations)?.map((workspace) => workspace.workspaceName || workspace.workspaceId).join(", ");
      notices.push(`Augenta: this project is connected to the ${environment} environment, not production${names ? `, feeding ${names}` : ""}.`);
    }
    const authNotice = takeAuthNotice(connectedRoot);
    if (authNotice === "badkey") {
      notices.push("Augenta has queued capture: the platform key in .augenta/config.json was refused (401). " + "Check that the key is complete and current, and that its Connector is still enabled; " + "capture resumes on its own once a request is accepted. " + `Do not run ${action} to fix this — it starts a browser sign-in and would replace this project's key config.`);
    } else if (authNotice) {
      const reason = authNotice === "relogin" ? "a new Augenta sign-in" : "a valid inbound Connector";
      notices.push(`Augenta has queued capture waiting for ${reason}. Run ${action}; queued records will resume shipping after reconnecting.`);
    }
    const discarded = new Outbox(connectedRoot).takeDiscarded();
    if (discarded?.length) {
      const detail = discarded.map((d) => `${d.destKey} (spool bytes ${d.from}..${d.to})`).join(", ");
      notices.push(`Augenta DISCARDED unshipped records for ${discarded.length === 1 ? "a destination" : "destinations"} that fell too far behind its peers: ${detail}. Those records are gone and will not be retried. Capture to the other destinations is unaffected. If that destination should still receive this project, run ${action} to verify it, or remove it from the project's destinations.`);
    }
    if (notices.length > 0) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: notices.join(" ") } }));
    }
    try {
      captureAgentMemory({
        projectRoot: connectedRoot,
        harness: codex ? "codex" : "claude-code",
        transcriptPath
      });
    } catch {}
    if (new Outbox(connectedRoot).hasPendingBytes())
      spawnShipper(connectedRoot);
  } else {
    const gate = captureGate(cfg);
    if (gate === "key_tracked") {
      const tracked = cfg.keyTracked === "tracked";
      if (firstTime(`key-${cfg.keyTracked}:${connectedRoot}`)) {
        const fact = tracked ? "this project's .augenta/config.json holds a platform key and git tracks it, so Augenta capture and recall are off in this checkout: " + "a committed key would send everyone's capture to that key's Workspace." : "this project's .augenta/config.json holds a platform key, and git gave no answer here on whether the repository tracks it, " + "so Augenta capture and recall are off in this checkout: a committed key would send everyone's capture to that key's Workspace.";
        const remedy = tracked ? {
          codex: "If the key is yours, untrack the file with git rm --cached .augenta/config.json; if it is not, remove it.",
          claude: "If the key is theirs, the fix is `git rm --cached .augenta/config.json`; if they do not recognize it, it should be removed."
        } : {
          codex: "Either git is not on the coding app's PATH, or git refuses this repository (for a checkout owned by another user, see git's safe.directory). Fix whichever it is, then start a new session.",
          claude: "Either `git` is not on the PATH the coding app gives hooks, or git refuses this repository — usually a checkout " + "owned by another user, which `git config --global --add safe.directory <path>` allows. Running `git status` there shows which. " + "Fixing it and starting a new session turns capture back on."
        };
        const additionalContext = codex ? `Augenta: ${fact} ${remedy.codex}` : `[Augenta] ${fact[0].toUpperCase()}${fact.slice(1)} Tell the user. ${remedy.claude} Do not run the ` + "connect skill to fix this, and never ask for the key in the chat.";
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
      }
    } else if (gate === "signed_out" || gate === "not_adopted") {
      const mismatch = cfg.gatewayMismatch;
      const elsewhere = mismatch?.sendsTo;
      const identity = createHash3("sha256").update([
        cfg.profileId ?? "",
        cfg.projectKey ?? "",
        ...(cfg.workspaces ?? []).map((workspace) => workspace.workspaceId).sort(),
        cfg.profileId && storedProfileUserId(cfg.profileId) || "",
        ...elsewhere ? [`gateway:${elsewhere}`] : []
      ].join("\x00")).digest("hex").slice(0, 16);
      if (firstTime(`join:${connectedRoot}:${identity}`)) {
        const names = (cfg.workspaces ?? cfg.destinations ?? []).map((workspace) => workspace.workspaceName || workspace.workspaceId).join(", ");
        const environment = environmentLabel(controlUrl(cfg));
        const where = [cfg.org?.name, environment === "prod" ? undefined : `the ${environment} environment`].filter(Boolean).join(", ");
        const reason = gate === "signed_out" ? "this machine is not signed in to Augenta for it" : mismatch ? `it now points Augenta at ${describeGatewayMismatch(mismatch)}` : cfg.join === "signin" ? "this checkout joined it under a different sign-in" : cfg.join === "workspaces" ? "its Workspaces changed since this checkout joined" : "this checkout has not joined it";
        const additionalContext = mismatch?.cause === "environment" ? codex ? `Augenta: capture and recall are off in this checkout because ${reason}. AUGENTA_API_URL or AUGENTA_INGEST_URL in the environment that started this app is doing that; nothing was sent there. If you did not set it, look for it in a committed .claude/settings.json. Unsetting it turns capture back on; reconnecting does not.` : `[Augenta] Capture and recall are off in this checkout because ${reason}. Nothing was sent there. It is ` + "AUGENTA_API_URL or AUGENTA_INGEST_URL in the environment that started this app, not the project's config. Tell " + "the user. If they did not set it, suggest looking for it in a committed .claude/settings.json (an `env` block) " + "and its history. Unsetting it turns capture back on; running connect does not, and connect refuses a gateway " + "only the environment chose." : elsewhere ? codex ? `Augenta: capture and recall are off in this checkout because ${reason}. If nobody on your team changed that, check the history of .augenta/config.json first; running ${connectAction} and choosing the Workspaces points it back.` : `[Augenta] Capture and recall are off in this checkout because ${reason}. Nothing was sent there. Tell the ` + "user. If nobody on their team made that change, suggest checking `git log -p .augenta/config.json` before " + "anything else. Running the augenta connect skill (/augenta:connect) and choosing the Workspaces points the " + "project back at the environment's own address. Do not start it without their go-ahead." : codex ? `Augenta: this project is set up to send capture to ${names}${where ? ` (${where})` : ""}, but capture is off in this checkout because ${reason}. Run ${connectAction} to join it.` : `[Augenta] This project's .augenta/config.json sends Augenta capture to ${names}${where ? ` (${where})` : ""}, ` + `but capture is off in this checkout because ${reason}. Tell the user, and offer to run the augenta ` + "connect skill (/augenta:connect): it signs in if needed and asks them to confirm those Workspaces " + "before capture starts. Do not start a sign-in without their go-ahead. Tokens and API keys must " + "never be pasted into the chat.";
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
      }
    }
  }
  process.exit(0);
}
var markerKey = staleConfig ? `reconnect:${projectPath}:${staleConfigDigest()}` : projectPath;
if (!staleConfig && readMarkers(legacyMarkerPath)[projectPath])
  process.exit(0);
if (ephemeralProject(projectPath))
  process.exit(0);
if (!firstTime(markerKey))
  process.exit(0);
var codexContext = staleConfig ? `Augenta's saved connection for this project can no longer be read, so capture is off. Run ${connectAction} to reconnect it.` : `Augenta isn't connected for this project yet. Run ${connectAction} to connect it.`;
var claudeContext = staleConfig ? "[Augenta] This project has an .augenta/config.json that this plugin version " + "cannot read — it predates the current connection format, or the write was " + "truncated — so capture is silently off. This is the one automatic prompt it " + "will ever get. Run the augenta connect skill now (/augenta:connect) to " + "reconnect it; anything already queued in the outbox ships once it succeeds. " + "Tokens and API keys must never be pasted into the chat." : "[Augenta] This project has not been connected for Augenta capture and this " + "is the one automatic prompt it will ever get. Run the augenta connect skill now " + "(/augenta:connect): it explains what capture does, then drives connect's --json " + "verbs itself so the user only answers one question and, at most, clicks one " + "sign-in link. Tokens and API keys must never be pasted into the chat.";
var additionalContext = codex ? codexContext : claudeContext;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
process.exit(0);
