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
import { existsSync as existsSync6, mkdirSync as mkdirSync7, readFileSync as readFileSync8, renameSync as renameSync5, writeFileSync as writeFileSync7 } from "node:fs";
import { join as join10 } from "node:path";
import { randomUUID as randomUUID5 } from "node:crypto";

// capture/config.ts
import { readFileSync as readFileSync5 } from "node:fs";
import { join as join7 } from "node:path";

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
import { randomUUID as randomUUID3 } from "node:crypto";
import { mkdirSync as mkdirSync4, readFileSync as readFileSync4, renameSync as renameSync3, rmSync as rmSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join4 } from "node:path";

// capture/documents.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { lstatSync, realpathSync as realpathSync2, readlinkSync, mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync as renameSync2, rmSync, statSync as statSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { basename, dirname, isAbsolute, join as join3, relative, resolve as resolve2, sep } from "node:path";
var MAX_DOCUMENT_EXPERIENCE_BYTES = 512 * 1024;
function sha256(input) {
  return createHash2("sha256").update(input).digest("hex");
}
function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function boundedTitle(title) {
  return [...title].slice(0, 512).join("");
}
function normalizeLogicalPath(path) {
  return path.split(sep).join("/");
}
function sameSnapshot(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function safeBoundary(text, index) {
  if (index > 0 && index < text.length && text.charCodeAt(index - 1) >= 55296 && text.charCodeAt(index - 1) <= 56319 && text.charCodeAt(index) >= 56320 && text.charCodeAt(index) <= 57343)
    return index - 1;
  return index;
}
function chunkText(text, makeRecord) {
  if (!text.length)
    return [""];
  const chunks = [];
  let start = 0;
  const sizingIndex = 999999999;
  while (start < text.length) {
    let lo = start + 1, hi = text.length, best = -1;
    while (lo <= hi) {
      const rawMid = Math.floor((lo + hi) / 2);
      const mid = safeBoundary(text, rawMid);
      if (mid <= start) {
        lo = rawMid + 1;
        continue;
      }
      if (jsonBytes(makeRecord(text.slice(start, mid), sizingIndex, sizingIndex)) < MAX_DOCUMENT_EXPERIENCE_BYTES) {
        best = mid;
        lo = rawMid + 1;
      } else
        hi = rawMid - 1;
    }
    if (best <= start)
      return [];
    chunks.push(text.slice(start, best));
    start = best;
  }
  return chunks;
}
function readDocumentIndex(root, file, valid, maxBytes = Infinity) {
  try {
    const path = join3(root, ".augenta", "state", file);
    if (statSync2(path).size > maxBytes)
      return {};
    const parsed = JSON.parse(readFileSync3(path, "utf8"));
    if (!parsed || parsed.version !== 1 || !parsed.documents || typeof parsed.documents !== "object" || Array.isArray(parsed.documents))
      return {};
    return Object.fromEntries(Object.entries(parsed.documents).filter(([id, value]) => valid(value) && value.documentId === id));
  } catch {
    return {};
  }
}
function writeDocumentIndex(root, file, documents, maxBytes = Infinity) {
  const dir = join3(ensureAugentaDir(root), "state");
  const path = join3(dir, file), tmp = `${path}.${randomUUID2()}.tmp`;
  try {
    const json = JSON.stringify({ version: 1, documents });
    if (Buffer.byteLength(json) > maxBytes)
      return false;
    mkdirSync3(dir, { recursive: true });
    writeFileSync3(tmp, json, { mode: 384 });
    renameSync2(tmp, path);
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {}
  }
}
function documentTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    return;
  return new Date(value).toISOString();
}
var MAX_SYMLINK_HOPS = 40;
function symlinkTarget(path) {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve2(dirname(path), readlinkSync(path)) : undefined;
  } catch {
    return;
  }
}
function physicalPath(path) {
  let existing = resolve2(path);
  const missing = [];
  let hops = 0;
  while (true) {
    try {
      return join3(realpathSync2(existing), ...missing);
    } catch {}
    const target = symlinkTarget(existing);
    if (target !== undefined) {
      if (++hops > MAX_SYMLINK_HOPS)
        return;
      existing = target;
      continue;
    }
    const parent = dirname(existing);
    if (parent === existing)
      return resolve2(path);
    missing.unshift(basename(existing));
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

// capture/links.ts
function linksPath(projectRoot) {
  return join4(projectRoot, ".augenta", "state", "links.json");
}
function legacyAdoptionPath(projectRoot) {
  return join4(projectRoot, ".augenta", "state", "adopted.json");
}
var nonEmpty = (value) => typeof value === "string" && value.length > 0;
function readLinks(projectRoot) {
  try {
    const value = JSON.parse(readFileSync4(linksPath(projectRoot), "utf8"));
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
      ...documentTimestamp(value.attachmentsConsentedAt) ? { attachmentsConsentedAt: documentTimestamp(value.attachmentsConsentedAt) } : {},
      links
    };
  } catch {
    return;
  }
}
function writeLinks(projectRoot, links) {
  const dir = join4(ensureAugentaDir(projectRoot), "state");
  mkdirSync4(dir, { recursive: true });
  const path = join4(dir, "links.json");
  const tmp = `${path}.${randomUUID3()}.tmp`;
  try {
    writeFileSync4(tmp, JSON.stringify({
      version: 1,
      profileId: links.profileId,
      userId: links.userId,
      projectKey: links.projectKey,
      joinedAt: links.joinedAt,
      ...documentTimestamp(links.attachmentsConsentedAt) ? { attachmentsConsentedAt: documentTimestamp(links.attachmentsConsentedAt) } : {},
      links: links.links.map(({ workspaceId, connectorId }) => ({ workspaceId, connectorId }))
    }), { mode: 384 });
    renameSync3(tmp, path);
  } finally {
    rmSync2(tmp, { force: true });
  }
  rmSync2(legacyAdoptionPath(projectRoot), { force: true });
}

// capture/project.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync4, realpathSync as realpathSync3 } from "node:fs";
import { dirname as dirname3, join as join6, resolve as resolve4 } from "node:path";

// capture/environment.ts
import { existsSync as existsSync3 } from "node:fs";
import { dirname as dirname2, join as join5, resolve as resolve3 } from "node:path";
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
  let current = resolve3(dir);
  while (true) {
    if (existsSync3(join5(current, ".git")))
      return true;
    const parent = dirname2(current);
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
    dir = realpathSync3(cwd);
  } catch {
    return;
  }
  while (true) {
    if (existsSync4(join6(dir, ".augenta", "config.json")))
      return dir;
    if (existsSync4(join6(dir, ".git")))
      return;
    const parent = dirname3(dir);
    if (parent === dir)
      return;
    dir = parent;
  }
}
function resolveProject(args, cwd) {
  if (args.project)
    return { projectRoot: resolve4(cwd, args.project) };
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
  return { join: "joined", destinations, joinedAt: links.joinedAt, attachmentsConsentedAt: links.attachmentsConsentedAt };
}
function configPath(projectRoot) {
  return join7(projectRoot, ".augenta", "config.json");
}
function loadProjectConfig(projectRoot) {
  try {
    const value = JSON.parse(readFileSync5(configPath(projectRoot), "utf8"));
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
          captureSince: routes.joinedAt,
          ...routes.attachmentsConsentedAt ? { attachmentsConsentedAt: routes.attachmentsConsentedAt } : {}
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
        ...documentTimestamp(value.attachmentsConsentedAt) ? { attachmentsConsentedAt: documentTimestamp(value.attachmentsConsentedAt) } : {},
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
function attachmentCaptureMode(env = process.env) {
  return ["0", "off", "false"].includes((env.AUGENTA_CAPTURE_ATTACHMENTS ?? "").trim().toLowerCase()) ? "off" : "documents";
}

// capture/outbox.ts
import { basename as basename2, dirname as dirname4, join as join9 } from "node:path";
import { randomUUID as randomUUID4 } from "node:crypto";
import { mkdirSync as mkdirSync6, existsSync as existsSync5, readFileSync as readFileSync7, writeFileSync as writeFileSync6, appendFileSync, renameSync as renameSync4, statSync as statSync4, unlinkSync as unlinkSync3 } from "node:fs";

// capture/capture-lock.ts
import { mkdirSync as mkdirSync5, openSync, readFileSync as readFileSync6, closeSync, writeFileSync as writeFileSync5, unlinkSync as unlinkSync2, statSync as statSync3 } from "node:fs";
import { join as join8 } from "node:path";
function captureLock(projectRoot) {
  const dir = join8(ensureAugentaDir(projectRoot), "state");
  mkdirSync5(dir, { recursive: true });
  const path = join8(dir, "capture.lock");
  const deadline = Date.now() + 750;
  do {
    try {
      const fd = openSync(path, "wx", 384);
      try {
        writeFileSync5(fd, String(process.pid));
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
        const pid = Number(readFileSync6(path, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (e) {
            if (e.code === "ESRCH") {
              unlinkSync2(path);
              continue;
            }
          }
        } else if (Date.now() - statSync3(path).mtimeMs > 30000) {
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
  if (!data || typeof data.documentId !== "string" || data.documentId.length === 0 || typeof data.sourcePath !== "string" || typeof data.title !== "string" || typeof data.capturedAt !== "string" || typeof data.revision !== "string" || data.revision.length === 0 || typeof data.deleted !== "boolean" || typeof data.chunkIndex !== "number" || !Number.isInteger(data.chunkIndex) || data.chunkIndex < 0 || typeof data.chunkCount !== "number" || !Number.isInteger(data.chunkCount) || data.chunkCount <= 0)
    return false;
  if (data.chunkIndex >= data.chunkCount)
    return false;
  const text = typeof data.text === "string" && data.content === undefined && data.encoding === undefined && data.mediaType === undefined;
  if (data.kind === "agent-memory")
    return text && data.format === "text/markdown" && typeof data.sourceUpdatedAt === "string" && e.sid === `memory-${data.documentId}`;
  if (data.kind !== "agent-attachment" || e.sid !== `attachment-${data.documentId}` || !/^[a-f0-9]{64}$/.test(data.documentId) || !/^[a-f0-9]{64}$/.test(data.revision) || !documentTimestamp(data.capturedAt) || data.deleted !== false || !["mention", "prompt", "read"].includes(data.origin))
    return false;
  if (text)
    return data.format === "text/plain" || data.format === "text/markdown";
  return data.text === undefined && data.encoding === "base64" && data.format === "application/pdf" && data.mediaType === "application/pdf" && typeof data.content === "string" && data.content.length > 0 && data.content.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data.content) && data.content.startsWith("JVBERi0") && data.chunkIndex === 0 && data.chunkCount === 1;
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
    this.dir = join9(projectRoot, ".augenta", "outbox");
    this.spoolPath = join9(this.dir, "spool.jsonl");
    this.cursorPath = join9(this.dir, "cursor.json");
    this.maxSpoolBytes = opts.maxSpoolBytes ?? MAX_SPOOL_BYTES;
    this.maxDestLagBytes = opts.maxDestLagBytes ?? MAX_DEST_LAG_BYTES;
  }
  ensure() {
    ensureAugentaDir(this.projectRoot);
    mkdirSync6(this.dir, { recursive: true });
  }
  append(records) {
    if (records.length === 0)
      return true;
    if (existsSync5(this.appendJournalPath()))
      throw new Error("An outbox append needs recovery");
    this.ensure();
    try {
      if (statSync4(this.spoolPath).size >= this.maxSpoolBytes)
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
    return join9(this.dir, "append-transaction.json");
  }
  hasPendingAppend() {
    return existsSync5(this.appendJournalPath());
  }
  publish(path, value) {
    mkdirSync6(dirname4(path), { recursive: true, mode: 448 });
    const temp = `${path}.${randomUUID4()}.tmp`;
    try {
      writeFileSync6(temp, JSON.stringify(value), { mode: 384, flag: "wx" });
      renameSync4(temp, path);
    } finally {
      try {
        unlinkSync3(temp);
      } catch {}
    }
  }
  appendWithReceipt(records, receiptPath, receipt) {
    this.ensure();
    if (dirname4(receiptPath) !== join9(this.projectRoot, ".augenta", "state"))
      throw new Error("Invalid outbox receipt path");
    if (existsSync5(this.appendJournalPath()))
      throw new Error("An outbox append needs recovery");
    if (!records.length) {
      this.publish(receiptPath, receipt);
      return true;
    }
    appendFileSync(this.spoolPath, "");
    const before = statSync4(this.spoolPath);
    if (before.size >= this.maxSpoolBytes)
      return false;
    this.publish(this.appendJournalPath(), {
      version: 1,
      offset: before.size,
      inode: before.ino,
      content: records.map((record) => JSON.stringify(record)).join(`
`) + `
`,
      receiptName: basename2(receiptPath),
      receipt
    });
    this.finishPendingAppend();
    return true;
  }
  finishPendingAppend() {
    const path = this.appendJournalPath();
    if (!existsSync5(path))
      return 0;
    if (statSync4(path).size > MAX_SPOOL_BYTES)
      throw new Error("Invalid outbox append journal");
    const journal = JSON.parse(readFileSync7(path, "utf8"));
    if (journal.version !== 1 || !Number.isSafeInteger(journal.offset) || journal.offset < 0 || typeof journal.content !== "string" || !journal.content.endsWith(`
`) || typeof journal.receiptName !== "string" || !/^[a-zA-Z0-9_-]+\.json$/.test(journal.receiptName))
      throw new Error("Invalid outbox append journal");
    const spool = statSync4(this.spoolPath);
    const content = Buffer.from(journal.content);
    const tail = readFileSync7(this.spoolPath).subarray(journal.offset);
    if (spool.ino !== journal.inode || spool.size < journal.offset || tail.length > content.length || !tail.equals(content.subarray(0, tail.length)))
      throw new Error("Outbox append journal no longer matches its spool");
    if (tail.length < content.length)
      appendFileSync(this.spoolPath, content.subarray(tail.length));
    this.publish(join9(this.projectRoot, ".augenta", "state", journal.receiptName), journal.receipt);
    unlinkSync3(path);
    return journal.content.split(`
`).length - 1;
  }
  dropEpisodePath() {
    return join9(this.dir, "dropped.json");
  }
  markDropped() {
    this.ensure();
    const path = this.dropEpisodePath();
    if (existsSync5(path))
      return false;
    writeFileSync6(path, JSON.stringify({ since: new Date().toISOString() }));
    return true;
  }
  clearDropEpisode() {
    try {
      unlinkSync3(this.dropEpisodePath());
    } catch {}
  }
  discardNoticePath() {
    return join9(this.dir, "discarded.json");
  }
  markDiscarded(entries) {
    if (entries.length === 0)
      return;
    this.ensure();
    try {
      writeFileSync6(this.discardNoticePath(), JSON.stringify({ at: new Date().toISOString(), destinations: entries }));
    } catch {}
  }
  takeDiscarded() {
    const path = this.discardNoticePath();
    try {
      const parsed = JSON.parse(readFileSync7(path, "utf8"));
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
      raw = JSON.parse(readFileSync7(this.cursorPath, "utf8"));
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
    writeFileSync6(tmp, JSON.stringify(body));
    renameSync4(tmp, this.cursorPath);
  }
  shippedOffset(destKey) {
    const { shipped, links } = this.readCursor();
    const stored = destKey === undefined || !links ? shipped : links[destKey] ?? 0;
    return stored > this.spoolEnd() ? 0 : stored;
  }
  spoolEnd() {
    try {
      return statSync4(this.spoolPath).size;
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
      return statSync4(this.spoolPath).size > this.shippedOffset();
    } catch {
      return false;
    }
  }
  pendingByteCount(destKey) {
    return Math.max(0, this.spoolEnd() - this.shippedOffset(destKey));
  }
  readPending(maxBatch = Infinity, destKey, maxBytes = Infinity) {
    const shipped = this.shippedOffset(destKey);
    if (this.hasPendingAppend())
      return { records: [], endOffset: shipped, hasMore: false };
    if (!existsSync5(this.spoolPath))
      return { records: [], endOffset: shipped, hasMore: false };
    const buf = readFileSync7(this.spoolPath);
    const start = Math.min(shipped, buf.length);
    const records = [];
    let off = start;
    let hasMore = false;
    let cursor = start;
    let bytes = 0;
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
          if (isCaptureEvent(parsed) || isRawRecord(parsed) || isDocumentRecord(parsed)) {
            const cost = next - cursor;
            if (records.length && bytes + cost > maxBytes) {
              hasMore = true;
              break;
            }
            records.push(parsed);
            bytes += cost;
          }
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
      size = statSync4(this.spoolPath).size;
    } catch {
      return;
    }
    if (size > 0 && this.shippedOffset() >= size) {
      const archivePath = this.spoolPath + ".archive";
      try {
        renameSync4(this.spoolPath, archivePath);
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
var STAGES = ["dispatch", "capture", "attachments", "delivery"];
var outcomes = new Set(["started", "captured", "idle", "missing_transcript", "failed", "accepted", "rejected", "retry", "spool_full", "too_large", "skipped"]);
function read(projectRoot, stage) {
  try {
    const s = JSON.parse(readFileSync8(join10(projectRoot, ".augenta", "state", `health-${stage}.json`), "utf8"));
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
    const dir = join10(ensureAugentaDir(projectRoot), "state");
    mkdirSync7(dir, { recursive: true });
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
    const file = join10(dir, `health-${stage}.json`);
    const tmp = `${file}.${randomUUID5()}.tmp`;
    writeFileSync7(tmp, JSON.stringify(value), { mode: 384 });
    renameSync5(tmp, file);
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
    configuration: cfg ? "valid" : existsSync6(join10(projectRoot, ".augenta/config.json")) ? "invalid" : "missing",
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

// capture/harness.ts
function detectedHarness(explicit, env = process.env) {
  if (explicit)
    return explicit;
  const codex = Boolean(env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === "Codex Desktop");
  const claude = env.CLAUDECODE === "1";
  if (codex === claude)
    return;
  return codex ? "codex" : "claude-code";
}

// scripts/connect.ts
import { chmodSync as chmodSync3, existsSync as existsSync9, readFileSync as readFileSync11, renameSync as renameSync8, rmSync as rmSync4, writeFileSync as writeFileSync10 } from "node:fs";
import { basename as basename4, join as join13 } from "node:path";
import { randomUUID as randomUUID7 } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// runtime/version.ts
var PLUGIN_VERSION = "0.14.0";

// capture/cowork-task.ts
import { createHash as createHash4, randomUUID as randomUUID6 } from "node:crypto";
import { dirname as dirname6, join as join12 } from "node:path";
import { existsSync as existsSync8, linkSync, mkdirSync as mkdirSync9, readFileSync as readFileSync10, realpathSync as realpathSync5, renameSync as renameSync7, rmSync as rmSync3, statSync as statSync5, writeFileSync as writeFileSync9 } from "node:fs";
import { homedir as homedir2 } from "node:os";

// capture/capture-cursor.ts
import { join as join11, dirname as dirname5 } from "node:path";
import { mkdirSync as mkdirSync8, existsSync as existsSync7, readFileSync as readFileSync9, writeFileSync as writeFileSync8, renameSync as renameSync6 } from "node:fs";

// capture/auto-recall-marker.ts
var AUTO_RECALL_SENTINEL = "[augenta-recall:v1]";
function hasSentinel(value) {
  if (typeof value === "string")
    return value.includes(AUTO_RECALL_SENTINEL);
  if (Array.isArray(value))
    return value.some(hasSentinel);
  return false;
}
function isClaudeAutoRecallRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  const line = value;
  if (line.type !== "attachment")
    return false;
  const attachment = line.attachment;
  if (!attachment || typeof attachment !== "object")
    return false;
  if (typeof attachment.type !== "string" || !attachment.type.startsWith("hook_"))
    return false;
  return hasSentinel(attachment.content) || hasSentinel(attachment.stdout);
}
function isCodexAutoRecallItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  const item = value;
  if (item.type !== "message" || item.role !== "developer")
    return false;
  if (typeof item.content === "string")
    return hasSentinel(item.content);
  if (!Array.isArray(item.content))
    return false;
  return item.content.some((block) => !!block && typeof block === "object" && hasSentinel(block.text));
}
function isCodexAutoRecallRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return false;
  const line = value;
  return line.type === "response_item" && isCodexAutoRecallItem(line.payload);
}
function stripCodexAutoRecallHistory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return;
  const line = value;
  if (line.type !== "compacted" || !line.payload || typeof line.payload !== "object")
    return;
  const payload = line.payload;
  let changed = false;
  const next = { ...payload };
  for (const [key, entry] of Object.entries(payload)) {
    if (!Array.isArray(entry))
      continue;
    const kept = entry.filter((item) => !isCodexAutoRecallItem(item));
    if (kept.length !== entry.length) {
      next[key] = kept;
      changed = true;
    }
  }
  return changed ? { ...line, payload: next } : undefined;
}

// capture/sanitize.ts
import { createHash as createHash3 } from "node:crypto";
var REFERENCE_PREFIX = "[augenta attachment sha256:";
function attachmentHash(reference) {
  if (typeof reference !== "string")
    return;
  return /^\[augenta attachment sha256:([a-f0-9]{64}) \d+B [^\]\r\n]+\]$/.exec(reference)?.[1];
}
function mediaType(value, fallback = "application/octet-stream") {
  return typeof value === "string" && value.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value) ? value.toLowerCase() : fallback;
}
function removePayload(content, mime, payloads) {
  if (attachmentHash(content))
    return content;
  const clean = content.replace(/\s/g, "");
  const valid = clean.length > 0 && clean.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(clean);
  const bytes = valid ? Buffer.from(clean, "base64") : Buffer.from(content, "utf8");
  const hash = createHash3("sha256").update(bytes).digest("hex");
  payloads.set(hash, { hash, content: valid ? bytes.toString("base64") : "", mediaType: mime, bytes: bytes.length, valid });
  return `${REFERENCE_PREFIX}${hash} ${bytes.length}B ${mime}]`;
}
var EMBEDDED_PAYLOAD_HINT = /"(?:base64|blob|data)"\s*:\s*"|;base64,/i;
function sanitizeEmbeddedJson(text, payloads, inheritedMime) {
  if (!/^\s*[{[]/.test(text) || !EMBEDDED_PAYLOAD_HINT.test(text))
    return text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const json = JSON.stringify(sanitize(parsed, payloads, inheritedMime));
  return json === undefined || json === JSON.stringify(parsed) ? text : json;
}
function normalizedKey(key) {
  return key.replace(/[_-]/g, "").toLowerCase();
}
function isOpaqueKey(key) {
  const normalized = normalizedKey(key);
  return normalized === "signature" || normalized === "encryptedcontent";
}
function isEmptyReasoningValue(value) {
  if (value === null || value === undefined)
    return true;
  if (typeof value === "string")
    return value.trim() === "";
  if (Array.isArray(value))
    return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}
function sanitize(value, payloads, inheritedMime) {
  if (typeof value === "string") {
    const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(value);
    if (dataUrl)
      return removePayload(dataUrl[2], mediaType(dataUrl[1]), payloads);
    return sanitizeEmbeddedJson(value, payloads, inheritedMime);
  }
  if (Array.isArray(value))
    return value.map((child) => sanitize(child, payloads, inheritedMime));
  if (!value || typeof value !== "object")
    return value;
  const object = value;
  const mime = mediaType(object.media_type ?? object.mediaType ?? object.mimeType, object.type === "pdf" ? "application/pdf" : inheritedMime);
  const sanitized = [];
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (isOpaqueKey(key))
      continue;
    let sanitizedChild;
    if (typeof child === "string" && (key === "base64" || key === "blob" || key === "data" && ["base64", "image", "audio"].includes(object.type))) {
      sanitizedChild = removePayload(child, mime, payloads);
    } else {
      sanitizedChild = sanitize(child, payloads, mime);
    }
    if ((normalized === "thinking" || normalized === "reasoning") && isEmptyReasoningValue(sanitizedChild))
      continue;
    sanitized.push([key, sanitizedChild]);
  }
  return Object.fromEntries(sanitized);
}
function sanitizeTelemetryValue(value) {
  return sanitize(value, new Map);
}
function sanitizeTelemetryRecord(raw) {
  try {
    const payloads = new Map;
    const value = sanitize(JSON.parse(raw), payloads);
    const json = JSON.stringify(value);
    return json === undefined ? undefined : { value, json, payloads };
  } catch {
    return;
  }
}
function sanitizeTelemetryJsonl(raw) {
  return sanitizeTelemetryRecord(raw)?.json;
}

// capture/normalize-core.ts
function agentSid(baseSid, agentId) {
  return `${baseSid}/agent-${agentId}`;
}
function tailToEvents(lines, startSeq, startOffset, toEvent, lineSid, exclude, extract) {
  const events = [];
  const documents = [];
  const raws = [];
  let seq = startSeq;
  let off = startOffset;
  for (const raw of lines) {
    const lineOff = off;
    off += Buffer.byteLength(raw, "utf8") + 1;
    const trimmed = raw.trim();
    if (!trimmed)
      continue;
    const sanitized = sanitizeTelemetryRecord(raw);
    if (sanitized === undefined)
      continue;
    let value = sanitized.value;
    let json = sanitized.json;
    const excluded = exclude?.(value);
    if (excluded === "drop")
      continue;
    if (excluded !== undefined) {
      value = excluded;
      json = JSON.stringify(excluded);
    }
    documents.push(...extract?.(value, sanitized.payloads) ?? []);
    const event = toEvent(value, seq, lineOff);
    if (event) {
      events.push(event);
      seq += 1;
    }
    raws.push({ raw: json, sid: event ? event.sid : lineSid(value) });
  }
  return { events, documents, raws, nextSeq: seq, nextOffset: off };
}

// capture/normalize-codex.ts
function extractCodexText(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== "object")
        continue;
      if (typeof block.text === "string")
        parts.push(block.text);
      else if (typeof block.type === "string")
        parts.push(`[${block.type}]`);
    }
    return parts.join(`
`);
  }
  if (content === undefined || content === null)
    return "";
  return JSON.stringify(content);
}
function toolStatusFromOutput(output) {
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      if (typeof parsed.metadata?.exit_code === "number" && parsed.metadata.exit_code !== 0)
        return "error";
    } catch {}
  }
  return "ok";
}
function codexSessionFromPath(path) {
  const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path.replace(/\\/g, "/"));
  return m?.[1];
}
function classifyCodex(p) {
  switch (p.type) {
    case "message": {
      const text = extractCodexText(p.content);
      if (p.role === "assistant")
        return { kind: "msg", role: "assistant", text };
      if (p.role === "user")
        return { kind: "msg", role: "user", text };
      return { kind: "session", role: "system", text };
    }
    case "function_call": {
      const args = typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {});
      return { kind: "tool", role: "assistant", tool_name: p.name, text: `[tool_use:${p.name}] ${args}` };
    }
    case "function_call_output": {
      const out = p.output;
      return { kind: "tool", role: "tool", tool_status: "ok", text: `[tool_result] ${typeof out === "string" ? out : JSON.stringify(out ?? "")}` };
    }
    case "reasoning": {
      const summary = extractCodexText(p.summary ?? p.content);
      return { kind: "msg", role: "assistant", text: summary ? "[thinking] " + summary : "" };
    }
    case "custom_tool_call": {
      const input = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {});
      return { kind: "tool", role: "assistant", tool_name: p.name, text: `[tool_use:${p.name}] ${input}` };
    }
    case "custom_tool_call_output": {
      const out = p.output;
      return {
        kind: "tool",
        role: "tool",
        tool_status: toolStatusFromOutput(out),
        text: `[tool_result] ${typeof out === "string" ? out : JSON.stringify(out ?? "")}`
      };
    }
    case "local_shell_call": {
      const args = typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {});
      return { kind: "tool", role: "assistant", tool_name: p.name ?? "shell", text: `[tool_use:${p.name ?? "shell"}] ${args}` };
    }
    case "local_shell_call_output": {
      const out = p.output;
      return { kind: "tool", role: "tool", tool_status: "ok", text: `[tool_result] ${typeof out === "string" ? out : JSON.stringify(out ?? "")}` };
    }
    case "web_search_call":
      return { kind: "tool", role: "assistant", tool_name: "web_search", text: `[tool_use:web_search] ${JSON.stringify(p.action ?? {})}` };
    case "agent_message":
      return { kind: "msg", role: "assistant", text: `[agent_message ${p.author ?? "?"}→${p.recipient ?? "?"}] ${extractCodexText(p.content)}` };
    default: {
      const text = extractCodexText(p.content) || (typeof p.output === "string" ? p.output : "") || JSON.stringify(p);
      return { kind: "session", role: "system", text: `[codex:${p.type}] ${text}` };
    }
  }
}
function stampCodexUsage(target, usage) {
  if (!target || !usage)
    return;
  target.in_tok = usage.input_tokens ?? null;
  target.out_tok = usage.output_tokens ?? null;
  target.cache_read_tok = usage.cached_input_tokens ?? null;
  target.cache_in_tok = usage.cache_write_input_tokens ?? null;
  target.reasoning_tok = usage.reasoning_output_tokens ?? null;
}
function normalizeCodexLine(line, ctx, seq, off, scrub, model) {
  if (line.type !== "response_item" || !line.payload)
    return null;
  const cls = classifyCodex(line.payload);
  if (!cls)
    return null;
  const text = scrub(cls.text).trim();
  if (!text)
    return null;
  return {
    src: ctx.harness ?? "codex",
    sid: codexSessionFromPath(ctx.transcriptPath) || ctx.sessionId,
    proj: ctx.project,
    ts: line.timestamp || new Date().toISOString(),
    seq,
    kind: cls.kind,
    role: cls.role,
    ...cls.tool_name !== undefined ? { tool_name: cls.tool_name } : {},
    ...cls.tool_status !== undefined ? { tool_status: cls.tool_status } : {},
    in_tok: null,
    out_tok: null,
    ...model ? { model } : {},
    text,
    ref: { path: ctx.transcriptPath, off }
  };
}
function normalizeCodexRollout(opts) {
  const { lines, ctx, startSeq, startOffset } = opts;
  const scrub = opts.scrub ?? ((t) => t);
  let model = ctx.model;
  let lastAssistant;
  const result = tailToEvents(lines, startSeq, startOffset, (sanitized, seq, off) => {
    if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized))
      return null;
    const line = sanitized;
    if (line.type === "turn_context") {
      if (typeof line.payload?.model === "string")
        model = line.payload.model;
      return null;
    }
    if (line.type === "event_msg" && line.payload?.type === "token_count") {
      stampCodexUsage(lastAssistant, line.payload.info?.last_token_usage);
      return null;
    }
    const event = normalizeCodexLine(line, ctx, seq, off, scrub, model);
    if (event?.role === "assistant")
      lastAssistant = event;
    return event;
  }, () => codexSessionFromPath(ctx.transcriptPath) || ctx.sessionId, (sanitized) => isCodexAutoRecallRecord(sanitized) ? "drop" : stripCodexAutoRecallHistory(sanitized));
  return model ? { ...result, lastModel: model } : result;
}

// capture/native-turns.ts
function validNativeTurns(value) {
  if (!value || typeof value !== "object")
    return false;
  const s = value;
  return Number.isSafeInteger(s.ordinal) && s.ordinal >= 0 && !!s.ids && typeof s.ids === "object" && !Array.isArray(s.ids) && Object.values(s.ids).every((n) => Number.isSafeInteger(n) && n > 0 && n <= s.ordinal) && (s.active === undefined || typeof s.active === "string" && Object.hasOwn(s.ids, s.active)) && (s.eligible === undefined || typeof s.eligible === "boolean") && (s.captureSince === undefined || typeof s.captureSince === "string");
}
function normalizeNativeTurns(opts, prior, captureSince, normalizeBatch = normalizeCodexRollout) {
  const turns = prior ? { ...prior, ids: { ...prior.ids } } : { ids: {}, ordinal: 0 };
  if (turns.captureSince !== captureSince && turns.active)
    turns.eligible = false;
  turns.captureSince = captureSince;
  const events = [];
  const raws = [];
  const documents = [];
  const records = [];
  let nextSeq = opts.startSeq;
  let nextOffset = opts.startOffset;
  let model = opts.ctx.model;
  let batch = [];
  let batchTurn = 0;
  let batchSource = "unknown";
  let batchEligible = !captureSince;
  const since = captureSince ? Date.parse(captureSince) : undefined;
  const flush = () => {
    if (!batch.length)
      return;
    const result = normalizeBatch({
      ...opts,
      lines: batch,
      startSeq: nextSeq,
      startOffset: nextOffset,
      ctx: { ...opts.ctx, model }
    });
    nextOffset = result.nextOffset;
    model = result.lastModel ?? model;
    if (batchEligible) {
      nextSeq = result.nextSeq;
      const rawRecords = result.raws.map(({ raw, sid }) => ({
        raw,
        sid,
        src: "codex",
        proj: opts.ctx.project,
        turn: batchTurn
      }));
      for (const e of result.events) {
        e.turn = batchTurn;
        e.turn_source = batchSource;
      }
      const covered = new Set(result.events.map((e) => e.sid));
      for (const sid of new Set(result.raws.map((r) => r.sid))) {
        if (covered.has(sid))
          continue;
        result.events.push({
          src: "codex",
          sid,
          proj: opts.ctx.project,
          ts: timestampOf(result.raws[0]?.raw),
          seq: nextSeq++,
          kind: "session",
          role: "system",
          turn: batchTurn,
          turn_source: batchSource,
          text: "[augenta: transcript records with no mappable steps — raw channel attached]"
        });
      }
      events.push(...result.events);
      raws.push(...result.raws);
      documents.push(...result.documents);
      records.push(...result.events, ...rawRecords);
    }
    batch = [];
  };
  for (const line of opts.lines) {
    let x;
    try {
      x = JSON.parse(line);
    } catch {}
    const p = x?.payload;
    const starts = x?.type === "event_msg" && p?.type === "task_started" || x?.type === "turn_context";
    const ends = x?.type === "event_msg" && ["task_complete", "turn_aborted"].includes(p?.type ?? "");
    if (starts && typeof p?.turn_id === "string" && p.turn_id.length > 0 && p.turn_id.length <= 256) {
      if (turns.active !== p.turn_id) {
        flush();
        if (!Object.hasOwn(turns.ids, p.turn_id)) {
          Object.defineProperty(turns.ids, p.turn_id, { value: ++turns.ordinal, enumerable: true, writable: true, configurable: true });
        }
        turns.active = p.turn_id;
        const timestamp = Date.parse(x?.timestamp ?? "");
        turns.eligible = since === undefined || Number.isFinite(timestamp) && timestamp >= since;
      }
    }
    const turn = turns.active ? turns.ids[turns.active] : 0;
    const source = turns.active ? "native" : "unknown";
    const eligible = turns.active ? turns.eligible !== false : since === undefined;
    if (batch.length && (turn !== batchTurn || source !== batchSource || eligible !== batchEligible))
      flush();
    batchTurn = turn;
    batchSource = source;
    batchEligible = eligible;
    batch.push(line);
    if (ends && p?.turn_id === turns.active) {
      flush();
      delete turns.active;
      delete turns.eligible;
    }
  }
  flush();
  return { events, documents, raws, records, nextSeq, nextOffset, lastModel: model, turns };
}
function timestampOf(raw) {
  try {
    const timestamp = JSON.parse(raw ?? "{}").timestamp;
    if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)))
      return timestamp;
  } catch {}
  return new Date().toISOString();
}

// capture/attachments.ts
import { closeSync as closeSync2, constants as constants2, fstatSync, lstatSync as lstatSync2, openSync as openSync2, readSync, realpathSync as realpathSync4 } from "node:fs";
import { basename as basename3, extname, relative as relative2, resolve as resolve5 } from "node:path";
function validAttachmentContext(value) {
  const x = value;
  return !!x && typeof x.compact === "boolean" && Array.isArray(x.paths) && x.paths.length <= 64 && x.paths.every((p) => typeof p === "string" && p.length <= 4096) && (x.parent === undefined || typeof x.parent === "string" && x.parent.length <= 256) && (x.suppliedAt === undefined || documentTimestamp(x.suppliedAt) !== undefined);
}
var object = (x) => !!x && typeof x === "object" && !Array.isArray(x);
function filePath(value, project) {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\x00") || /^[a-z]+:\/\//i.test(value))
    return;
  return resolve5(project, value);
}
function mentionPaths(content, project) {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join(`
`) : "";
  const paths = [];
  for (const m of text.matchAll(/(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g)) {
    const path = filePath(m[1] ?? m[2] ?? m[3], project);
    if (path && !paths.includes(path))
      paths.push(path);
    if (paths.length === 64)
      break;
  }
  return paths;
}
function removed(value, payloads) {
  const hash = attachmentHash(value);
  return hash ? payloads.get(hash) : undefined;
}
function extractClaudeAttachments(value, payloads, project, prior) {
  let context = prior ? { ...prior, paths: [...prior.paths] } : { compact: false, paths: [] };
  const documents = [];
  if (!object(value))
    return { documents, context };
  const x = value;
  const capturedAt = documentTimestamp(x.timestamp ?? x.message?.timestamp);
  const uuid = typeof x.uuid === "string" && x.uuid.length <= 256 ? x.uuid : undefined;
  if (x.type === "system" && x.subtype === "compact_boundary" || x.isCompactSummary === true || x.type === "attachment" && x.attachment?.type === "compact_file_reference") {
    return { documents, context: { compact: true, paths: [] } };
  }
  if (x.type === "assistant")
    return { documents, context: { compact: false, paths: [] } };
  const content = x.message?.content;
  const toolResult = Array.isArray(content) && content.some((b) => b?.type === "tool_result");
  if (x.type === "user" && x.isMeta !== true && x.isVisibleInTranscriptOnly !== true && !toolResult && !x.toolUseResult) {
    if (x.promptSource === "sdk" || x.promptSource === "cli" || x.turnOrigin === "sdk")
      context.compact = false;
    if (context.compact)
      return { documents, context };
    context = { compact: false, paths: mentionPaths(content, project), parent: uuid, suppliedAt: capturedAt };
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type !== "document" || !object(b.source))
        continue;
      const s = b.source;
      if (s.type === "text" && typeof s.data === "string" && ["text/plain", "text/markdown"].includes(s.media_type)) {
        documents.push({ origin: "prompt", format: s.media_type, capturedAt, text: s.data, title: b.title });
      } else if (s.type === "base64" && s.media_type === "application/pdf") {
        documents.push({ origin: "prompt", format: "application/pdf", capturedAt, payload: removed(s.data, payloads), title: b.title });
      }
    }
    return { documents, context };
  }
  if (context.compact)
    return { documents, context };
  if (x.type === "attachment") {
    if (!uuid || !context.parent || x.parentUuid !== context.parent)
      return { documents, context: { compact: false, paths: [] } };
    context.parent = uuid;
    const a = x.attachment;
    const c = a?.content;
    const path = filePath(c?.file?.filePath, project);
    if (a?.type === "file" && path && context.paths.includes(path)) {
      if (c.type === "text" && typeof c.file.content === "string") {
        documents.push({
          origin: "mention",
          format: /\.md(?:own)?$/i.test(path) ? "text/markdown" : "text/plain",
          filePath: path,
          text: c.file.content,
          capturedAt,
          suppliedAt: context.suppliedAt
        });
      } else if (c.type === "pdf") {
        documents.push({
          origin: "mention",
          format: "application/pdf",
          filePath: path,
          payload: removed(c.file.base64, payloads),
          capturedAt,
          suppliedAt: context.suppliedAt
        });
      }
    }
    return { documents, context };
  }
  const r = x.toolUseResult;
  if (x.type === "user" && toolResult && object(r) && (r.type === "pdf" || r.type === "parts")) {
    const path = filePath(r.file?.filePath, project);
    if (path && (r.type === "pdf" || extname(path).toLowerCase() === ".pdf")) {
      documents.push({
        origin: "read",
        format: "application/pdf",
        filePath: path,
        payload: r.type === "pdf" ? removed(r.file?.base64, payloads) : undefined,
        capturedAt
      });
    }
  }
  return { documents, context };
}
var MAX_ATTACHMENT_INDEX_BYTES = 4 * 1024 * 1024;
var MAX_PDF_BYTES = Math.floor(MAX_DOCUMENT_EXPERIENCE_BYTES * 3 / 4);

class TooLarge extends Error {
}
function pdfContent(bytes) {
  return /^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString("ascii")) && bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from("%%EOF"));
}
function readPdfSnapshot(path, afterRead) {
  const physical = realpathSync4(path);
  const entry = lstatSync2(physical);
  if (!entry.isFile())
    throw new Error("not_regular");
  if (entry.size > MAX_PDF_BYTES)
    throw new TooLarge;
  let fd = -1;
  try {
    fd = openSync2(physical, constants2.O_RDONLY | constants2.O_NOFOLLOW | constants2.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || !sameSnapshot(entry, before))
      throw new Error("changed");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n)
        throw new Error("changed");
      offset += n;
    }
    afterRead?.();
    if (!sameSnapshot(before, fstatSync(fd)) || !sameSnapshot(before, lstatSync2(physical)) || realpathSync4(path) !== physical)
      throw new Error("changed");
    if (!pdfContent(bytes))
      throw new Error("not_pdf");
    return bytes;
  } finally {
    if (fd >= 0)
      closeSync2(fd);
  }
}
function validObservation(x) {
  const v = x;
  return !!v && typeof v.documentId === "string" && /^[a-f0-9]{64}$/.test(v.documentId) && typeof v.revision === "string" && /^[a-f0-9]{64}$/.test(v.revision) && Number.isSafeInteger(v.chunkCount) && v.chunkCount > 0 && typeof v.capturedAt === "string" && documentTimestamp(v.capturedAt) === v.capturedAt && (v.consentedAt === undefined || typeof v.consentedAt === "string" && documentTimestamp(v.consentedAt) === v.consentedAt);
}
function prepareAttachments(projectRoot, harness, candidates, opts) {
  const maxIndexBytes = opts.maxIndexBytes ?? MAX_ATTACHMENT_INDEX_BYTES;
  const result = { records: [], observations: {}, captured: 0, skipped: 0, tooLarge: 0 };
  const consent = documentTimestamp(opts.consentedAt);
  if (!opts.enabled || !consent)
    return result;
  result.observations = readDocumentIndex(projectRoot, "attachments.json", validObservation, maxIndexBytes);
  const root = physicalPath(projectRoot);
  for (const c of candidates) {
    const capturedAt = documentTimestamp(c.capturedAt);
    if (!capturedAt || capturedAt < consent || c.origin === "mention" && (!c.suppliedAt || c.suppliedAt < consent)) {
      result.skipped++;
      continue;
    }
    try {
      let text, bytes;
      if (c.format === "application/pdf") {
        if (c.payload) {
          if (!c.payload.valid)
            throw new Error("invalid_payload");
          if (c.payload.bytes > MAX_PDF_BYTES)
            throw new TooLarge;
          bytes = Buffer.from(c.payload.content, "base64");
          if (!pdfContent(bytes))
            throw new Error("not_pdf");
        } else if (c.filePath)
          bytes = readPdfSnapshot(c.filePath, opts.afterRead);
        else
          throw new Error("missing_payload");
      } else if (typeof c.text === "string")
        text = opts.scrub(c.text);
      else
        throw new Error("missing_text");
      const revision = sha256(bytes ?? text);
      const path = c.filePath && physicalPath(c.filePath);
      const scoped = root && path && isScopedToProject(path, root);
      const sourcePath = scoped ? normalizeLogicalPath(relative2(root, path)) : c.filePath ? basename3(c.filePath) : "supplied-document";
      const key = scoped ? sourcePath : `sha256:${revision}`;
      const documentId = sha256(`attachment\x00${harness}\x00${resolve5(projectRoot)}\x00${key}`);
      const prior = result.observations[documentId];
      if (prior && prior.revision === revision && prior.consentedAt === consent) {
        if (capturedAt > prior.capturedAt)
          result.observations[documentId] = { ...prior, capturedAt };
        continue;
      }
      if (prior && prior.revision !== revision && capturedAt <= prior.capturedAt) {
        result.skipped++;
        continue;
      }
      const metadata = {
        kind: "agent-attachment",
        documentId,
        sourcePath: opts.scrub(sourcePath),
        title: boundedTitle(opts.scrub(typeof c.title === "string" ? c.title : basename3(sourcePath))),
        format: c.format,
        origin: c.origin,
        revision,
        capturedAt,
        deleted: false
      };
      const record = (payload, chunkIndex, chunkCount) => ({
        type: "doc",
        src: harness,
        sid: `attachment-${documentId}`,
        proj: projectRoot,
        data: { ...metadata, ...payload, chunkIndex, chunkCount }
      });
      let records;
      if (bytes) {
        const doc = record({ encoding: "base64", content: bytes.toString("base64"), mediaType: "application/pdf" }, 0, 1);
        if (jsonBytes(doc) >= MAX_DOCUMENT_EXPERIENCE_BYTES)
          throw new TooLarge;
        records = [doc];
      } else {
        const chunks = chunkText(text, (part, i, n) => record({ text: part }, i, n));
        if (!chunks.length)
          throw new TooLarge;
        records = chunks.map((part, i) => record({ text: part }, i, chunks.length));
      }
      result.records.push(...records);
      result.captured++;
      const observedAt = prior && prior.revision === revision && prior.capturedAt > capturedAt ? prior.capturedAt : capturedAt;
      Object.defineProperty(result.observations, documentId, { value: { documentId, revision, chunkCount: records.length, capturedAt: observedAt, consentedAt: consent }, enumerable: true, writable: true, configurable: true });
    } catch (e) {
      if (e instanceof TooLarge)
        result.tooLarge++;
      else
        result.skipped++;
    }
  }
  let size = jsonBytes({ version: 1, documents: result.observations });
  let count = Object.keys(result.observations).length;
  for (const entry of Object.values(result.observations).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.documentId.localeCompare(b.documentId))) {
    if (size <= maxIndexBytes)
      break;
    size -= jsonBytes(entry.documentId) + 1 + jsonBytes(entry) + (count-- > 1 ? 1 : 0);
    delete result.observations[entry.documentId];
  }
  return result;
}
function commitAttachments(root, prepared, maxBytes = MAX_ATTACHMENT_INDEX_BYTES) {
  return writeDocumentIndex(root, "attachments.json", prepared.observations, maxBytes);
}

// capture/capture-cursor.ts
var ZERO = { offset: 0, seq: 0 };

class CaptureState {
  path;
  projectRoot;
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.path = join11(projectRoot, ".augenta", "state", "capture.json");
  }
  readAll() {
    if (!existsSync7(this.path))
      return {};
    try {
      const parsed = JSON.parse(readFileSync9(this.path, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  get(transcriptPath) {
    const c = this.readAll()[transcriptPath];
    if (!c || !Number.isInteger(c.offset) || c.offset < 0 || !Number.isInteger(c.seq) || c.seq < 0) {
      return { ...ZERO };
    }
    return {
      ...validNativeTurns(c.nativeTurns) ? { nativeTurns: c.nativeTurns } : {},
      ...validAttachmentContext(c.attachmentContext) ? { attachmentContext: c.attachmentContext } : {},
      offset: c.offset,
      seq: c.seq,
      ...c.rebaseline === true ? { rebaseline: true } : {},
      ...typeof c.model === "string" && c.model ? { model: c.model } : {}
    };
  }
  set(transcriptPath, cursor) {
    ensureAugentaDir(this.projectRoot);
    mkdirSync8(dirname5(this.path), { recursive: true });
    const all = this.readAll();
    all[transcriptPath] = cursor;
    const tmp = this.path + ".tmp";
    writeFileSync8(tmp, JSON.stringify(all));
    renameSync6(tmp, this.path);
  }
}

// capture/cowork-task.ts
class CoworkError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function validCoworkId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/.test(value);
}
function coworkBindingsPath(root) {
  return join12(root, ".augenta", "state", "cowork-tasks.json");
}
function writeCoworkState(path, value) {
  mkdirSync9(dirname6(path), { recursive: true, mode: 448 });
  const temp = `${path}.${randomUUID6()}.tmp`;
  try {
    writeFileSync9(temp, JSON.stringify(value), { mode: 384, flag: "wx" });
    renameSync7(temp, path);
  } finally {
    rmSync3(temp, { force: true });
  }
}
function readBindings(root) {
  try {
    const value = JSON.parse(readFileSync10(coworkBindingsPath(root), "utf8"));
    if (value.version !== 1 || !Array.isArray(value.tasks))
      return [];
    return value.tasks.filter((x) => x && validCoworkId(x.sessionId) && (x.transport === "native" || x.transport === "otlp") && typeof x.connection === "string" && /^[a-f0-9]{64}$/.test(x.connection) && Number.isFinite(Date.parse(x.boundAt)) && (x.transport !== "native" || typeof x.transcriptPath === "string"));
  } catch {
    return [];
  }
}
function coworkTaskBinding(root, sessionId) {
  try {
    const claimed = JSON.parse(readFileSync10(taskClaimPath(sessionId), "utf8"));
    if (claimed.version !== 1 || claimed.projectRoot !== realpathSync5(root))
      return;
    const matches = readBindings(root).filter((x) => x.sessionId === sessionId && JSON.stringify(x) === JSON.stringify(claimed.binding));
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return;
  }
}
function taskClaimPath(sessionId) {
  const base = process.env.AUGENTA_AUTH_HOME || join12(homedir2(), ".augenta");
  return join12(base, "cowork", "tasks", createHash4("sha256").update(sessionId).digest("hex") + ".json");
}
function claimTask(root, binding) {
  const path = taskClaimPath(binding.sessionId);
  mkdirSync9(dirname6(path), { recursive: true, mode: 448 });
  const value = { version: 1, projectRoot: realpathSync5(root), binding };
  const temp = `${path}.${randomUUID6()}.tmp`;
  try {
    writeFileSync9(temp, JSON.stringify(value), { mode: 384, flag: "wx" });
    try {
      linkSync(temp, path);
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      const prior = JSON.parse(readFileSync10(path, "utf8"));
      if (prior.projectRoot !== value.projectRoot || prior.binding?.transport !== binding.transport || prior.binding?.connection !== binding.connection || prior.binding?.transcriptPath !== binding.transcriptPath) {
        throw new CoworkError("task_already_bound", "This task is already bound to a project and transport. Start a new task to change either.");
      }
      binding.boundAt = prior.binding.boundAt;
    }
  } finally {
    rmSync3(temp, { force: true });
  }
}
function coworkConnection(cfg) {
  return createHash4("sha256").update(JSON.stringify({
    authMode: cfg.authMode,
    profileId: cfg.profileId,
    userId: cfg.profileId ? storedProfileUserId(cfg.profileId) : undefined,
    projectKey: cfg.projectKey,
    captureSince: cfg.captureSince,
    gateway: gatewayBase(cfg),
    ingestUrl: cfg.ingestUrl,
    destinations: cfg.destinations,
    apiKey: cfg.apiKey
  })).digest("hex");
}
function boundCoworkConfig(root, binding) {
  const cfg = loadProjectConfig(root);
  return cfg && captureEnabled(cfg) && coworkConnection(cfg) === binding.connection ? cfg : undefined;
}
async function verifyCoworkRoutes(cfg) {
  const gateway = gatewayBase(cfg);
  if (cfg.authMode === "oauth")
    assertSignInTarget(cfg.profileId, gateway);
  const token = cfg.authMode === "oauth" ? await accessTokenForProfile(cfg.profileId) : cfg.apiKey;
  const headers = { authorization: cfg.authMode === "oauth" ? `Bearer ${token}` : `AugentaKey ${token}` };
  const get = async (path) => {
    let response;
    try {
      response = await fetch(`${gateway.replace(/\/+$/, "")}${path}`, { headers, signal: AbortSignal.timeout(5000) });
    } catch {
      throw new CoworkError("connector_unavailable", "Cannot verify the project's Connectors; no Cowork content was queued.");
    }
    if (!response.ok)
      throw new CoworkError("connector_unavailable", `A selected Connector could not be verified (${response.status}); no Cowork content was queued.`);
    try {
      return await response.json();
    } catch {
      throw new CoworkError("connector_unavailable", "The Connector check returned an invalid answer; no Cowork content was queued.");
    }
  };
  if (cfg.authMode === "api-key") {
    const assigned = (await get("/v1/connectors")).connectors;
    if (!Array.isArray(assigned) || assigned.length !== 1 || assigned[0]?.status !== "active" || !["inbound", "bidirectional"].includes(assigned[0]?.direction) || !validCoworkId(assigned[0]?.id) || !validCoworkId(assigned[0]?.workspaceId) || !validCoworkId(assigned[0]?.orgId) || cfg.destinations?.length && (cfg.destinations.length !== 1 || cfg.destinations[0].connectorId !== assigned[0].id || cfg.destinations[0].workspaceId !== assigned[0].workspaceId)) {
      throw new CoworkError("connector_unavailable", "The platform key must have exactly one active inbound Connector with the recorded assignment.");
    }
    return;
  }
  const owner = storedProfileUserId(cfg.profileId);
  for (const destination of cfg.destinations ?? []) {
    const connector = (await get(`/v1/connectors/${encodeURIComponent(destination.connectorId)}`)).connector;
    if (!connector || connector.id !== destination.connectorId || connector.workspaceId !== destination.workspaceId || connector.ownerUserId !== owner || connector.status !== "active" || !["inbound", "bidirectional"].includes(connector.direction)) {
      throw new CoworkError("connector_unavailable", "Every selected Workspace needs this person's own active inbound Connector; no Cowork content was queued.");
    }
  }
  if (!cfg.destinations?.length)
    throw new CoworkError("not_joined", "Join the project's complete Workspace set before binding a Cowork task.");
}
async function bindCoworkTask(root, sessionId, transport, options = {}) {
  if (!validCoworkId(sessionId))
    throw new CoworkError("invalid_task", "Use the confirmed Cowork engine session.id, not an attached folder or display title.");
  if (transport !== "native" && transport !== "otlp")
    throw new CoworkError("invalid_transport", "Choose native or otlp explicitly.");
  const cfg = loadProjectConfig(root);
  if (!cfg || !captureEnabled(cfg))
    throw new CoworkError("not_joined", "Connect and join this project's complete Workspace set here before binding a Cowork task.");
  let transcriptPath;
  if (transport === "native") {
    try {
      transcriptPath = realpathSync5(options.transcriptPath);
      if (!statSync5(transcriptPath).isFile())
        throw new Error;
    } catch {
      throw new CoworkError("missing_transcript", "Native capture needs the confirmed transcript on this runtime. If Cowork separates the project and transcript, use a local task or the OTLP relay.");
    }
  } else if (options.transcriptPath)
    throw new CoworkError("conflicting_verbs", "An OTLP task does not take a native transcript path.");
  await verifyCoworkRoutes(cfg);
  const release = captureLock(root);
  if (!release)
    throw new CoworkError("busy", "Project capture is busy; retry the task binding.");
  try {
    const connection = coworkConnection(cfg);
    const latest = loadProjectConfig(root);
    if (!latest || !captureEnabled(latest) || coworkConnection(latest) !== connection)
      throw new CoworkError("connection_changed", "The project connection changed; bind a new task after joining it again.");
    const prior = coworkTaskBinding(root, sessionId);
    if (prior) {
      if (prior.transport !== transport || prior.connection !== connection || prior.transcriptPath !== transcriptPath) {
        throw new CoworkError("task_already_bound", "This task already has a transport and project connection. Start a new task to change either; capture cannot replay through both transports.");
      }
      return prior;
    }
    const boundAt = options.now ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(boundAt)))
      throw new CoworkError("invalid_time", "The binding time is invalid.");
    const binding = { sessionId, transport, boundAt, connection, ...transcriptPath ? { transcriptPath } : {} };
    claimTask(root, binding);
    if (transcriptPath) {
      const cursor = new CaptureState(root);
      const priorCursor = cursor.get(transcriptPath);
      cursor.set(transcriptPath, { ...priorCursor, offset: statSync5(transcriptPath).size });
    }
    ensureAugentaDir(root);
    writeCoworkState(coworkBindingsPath(root), { version: 1, tasks: [...readBindings(root).filter((x) => x.sessionId !== sessionId), binding] });
    return binding;
  } finally {
    release();
  }
}
function nativeCoworkAllowed(root, sessionId, transcriptPath, requireBinding = process.env.AUGENTA_COWORK_NATIVE === "1") {
  if (!sessionId)
    return !requireBinding;
  const binding = coworkTaskBinding(root, sessionId);
  if (!binding)
    return !requireBinding && !existsSync8(taskClaimPath(sessionId));
  if (binding.transport !== "native" || !boundCoworkConfig(root, binding))
    return false;
  try {
    return realpathSync5(transcriptPath) === binding.transcriptPath;
  } catch {
    return false;
  }
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
// scripts/connect.ts
var DEFAULT_WAIT_SECONDS = 90;
var DEFAULT_WORKSPACE_NAME = "Default Workspace";
function parseArgs(argv) {
  const args = {};
  const valueFor = (flag, i) => {
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0;i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--cowork-task") {
      args.coworkTask = valueFor(flag, i++);
    } else if (flag === "--cowork-transport") {
      const value = valueFor(flag, i++);
      if (value !== "native" && value !== "otlp")
        throw new Error("--cowork-transport requires native or otlp");
      args.coworkTransport = value;
    } else if (flag === "--cowork-transcript") {
      args.coworkTranscript = valueFor(flag, i++);
    } else if (flag === "--api-key") {
      args.apiKey = valueFor(flag, i++);
    } else if (flag === "--project") {
      args.project = valueFor(flag, i++);
    } else if (flag === "--endpoint") {
      args.endpoint = valueFor(flag, i++);
    } else if (flag === "--control-url") {
      args.controlUrl = valueFor(flag, i++);
    } else if (flag === "--harness") {
      const value = valueFor(flag, i++);
      if (value !== "claude-code" && value !== "codex") {
        throw new Error("--harness must be claude-code or codex");
      }
      args.harness = value;
    } else if (flag === "--workspace") {
      (args.workspaces ??= []).push(valueFor(flag, i++));
    } else if (flag === "--create-workspace") {
      args.createWorkspace = valueFor(flag, i++);
    } else if (flag === "--profile") {
      args.profile = valueFor(flag, i++);
    } else if (flag === "--wait") {
      const value = Number(valueFor(flag, i++));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--wait must be a positive number of seconds");
      }
      args.waitSeconds = value;
    } else if (flag === "--verify-only") {
      args.verifyOnly = true;
    } else if (flag === "--json") {
      args.json = true;
    } else if (flag === "--health") {
      args.health = true;
    } else if (flag === "--repair-harness") {
      args.repairHarness = true;
    } else if (flag === "--auto-recall") {
      const value = valueFor(flag, i++);
      if (value !== "on" && value !== "off") {
        throw new Error("--auto-recall must be on or off");
      }
      args.autoRecall = value === "on";
    } else if (flag === "--adopt") {
      args.adopt = true;
    } else if (flag === "--probe") {
      args.probe = true;
    } else if (flag === "--login") {
      args.login = true;
    } else if (flag === "--await-login") {
      args.awaitLogin = true;
    }
  }
  return args;
}
function writeApiKeyConfig(projectRoot, apiKey, endpoint2, details = {}) {
  const tracking = gitTracking(projectRoot, ".augenta/config.json");
  if (tracking) {
    throw new Error(tracking === "tracked" ? ".augenta/config.json is tracked by git, and an API-key config would put the key in it; untrack it first (git rm --cached .augenta/config.json)" : "git gave no answer on whether .augenta/config.json is committed, and an API-key config would put the key in it; either git is not on PATH or it refuses this repository (see git's safe.directory for a checkout owned by another user) — `git status` here shows which");
  }
  const dir = ensureAugentaDir(projectRoot);
  setAugentaIgnore(projectRoot, "local");
  const path = join13(dir, "config.json");
  const consentedAt = new Date().toISOString();
  writeFileSync10(path, `${JSON.stringify({
    authMode: "api-key",
    captureSince: consentedAt,
    attachmentsConsentedAt: consentedAt,
    apiKey,
    org: details.org ? { id: details.org.id, name: details.org.name } : undefined,
    destinations: details.destinations?.map(({ connectorId, workspaceId, workspaceName }) => ({ connectorId, workspaceId, workspaceName })),
    controlUrl: details.controlUrl,
    ingestUrl: details.ingestUrl,
    autoRecall: details.autoRecall ?? false,
    ...endpoint2 ? { endpoint: endpoint2 } : {}
  }, null, 2)}
`, { mode: 384 });
  chmodSync3(path, 384);
  return path;
}
function writeOAuthConfig(projectRoot, connection) {
  if (connection.destinations.length === 0) {
    throw new Error("an OAuth connection requires at least one Connector");
  }
  const dir = ensureAugentaDir(projectRoot);
  const path = join13(dir, "config.json");
  const joinedAt = new Date().toISOString();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync10(tmp, `${JSON.stringify({
      authMode: "oauth",
      projectKey: connection.projectKey,
      profileId: connection.profileId,
      controlUrl: connection.controlUrl,
      endpoint: connection.endpoint,
      discoveredGateway: connection.discoveredGateway,
      org: { id: connection.org.id, name: connection.org.name },
      workspaces: connection.destinations.map(({ workspaceId, workspaceName }) => ({ workspaceId, workspaceName })),
      autoRecall: connection.autoRecall ?? false,
      ingestUrl: connection.ingestUrl
    }, null, 2)}
`, { mode: 384 });
    renameSync8(tmp, path);
  } finally {
    rmSync4(tmp, { force: true });
  }
  chmodSync3(path, 384);
  setAugentaIgnore(projectRoot, connection.shared === false ? "local" : "shared");
  writeLinks(projectRoot, {
    profileId: connection.profileId,
    userId: connection.userId,
    projectKey: connection.projectKey,
    joinedAt,
    attachmentsConsentedAt: joinedAt,
    links: connection.destinations.map(({ workspaceId, connectorId }) => ({ workspaceId, connectorId }))
  });
  return path;
}
async function choose(prompt, values, label) {
  if (values.length === 0)
    throw new Error(`no choices available for ${prompt}`);
  if (values.length === 1)
    return values[0];
  if (!input.isTTY) {
    throw new Error("run augenta:connect in an interactive terminal");
  }
  console.log(prompt);
  values.forEach((value, index) => console.log(`  ${index + 1}. ${label(value)}`));
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Selection [1-${values.length}]: `);
    const selected = values[Number(answer) - 1];
    if (!selected) {
      throw new Error(`invalid selection: ${answer.trim() || "(empty)"}`);
    }
    return selected;
  } finally {
    rl.close();
  }
}
async function askAutoRecall(current) {
  if (!input.isTTY) {
    throw new Error("run augenta:connect in an interactive terminal");
  }
  const fallback = current ?? false;
  console.log("Automatic recall looks up what these Workspaces remember about each prompt you submit, and hands any match to your agent. Your agent can still ask with /augenta:recall either way.");
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`Turn on automatic recall for this project? [${fallback ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
    if (!answer)
      return fallback;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
async function chooseMany(prompt, values, label, opts = {}) {
  if (values.length === 0)
    throw new Error(`no choices available for ${prompt}`);
  if (!input.isTTY) {
    throw new Error("run augenta:connect in an interactive terminal");
  }
  console.log(prompt);
  values.forEach((value, index) => {
    const mark = opts.preselected?.(value) ? "x" : " ";
    console.log(`  ${index + 1}. [${mark}] ${label(value)}`);
  });
  const rl = createInterface({ input, output });
  try {
    for (let attempt = 0;attempt < 5; attempt++) {
      const answer = await rl.question(`Selection (comma-separated, e.g. 1,3; at least one required) [1-${values.length}]: `);
      if (!answer.trim()) {
        console.log("Choose at least one Workspace, or cancel the command.");
        continue;
      }
      const selected = [];
      let bad;
      for (const part of answer.split(",")) {
        const value = values[Number(part.trim()) - 1];
        if (!value) {
          bad = part.trim() || "(empty)";
          break;
        }
        if (!selected.includes(value))
          selected.push(value);
      }
      if (!bad)
        return selected;
      console.log(`Not a choice: ${bad}. Enter numbers from 1 to ${values.length}, separated by commas.`);
    }
    throw new Error("no valid Workspace selection was given");
  } finally {
    rl.close();
  }
}
async function verifyFreshLogin(oauth, accessToken) {
  const response = await fetch(`${oauth.gateway}/v1/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Augenta rejected the sign-in (${response.status})`);
  }
  const me = await response.json();
  if (!me.user?.id || !me.org?.id) {
    throw new Error("this organization is not provisioned in Augenta");
  }
  return me;
}
async function usableProfiles(oauth, preferredProfileId) {
  const candidates = reusableProfiles(oauth);
  const ordered = preferredProfileId ? [
    ...candidates.filter((item) => item.profileId === preferredProfileId),
    ...candidates.filter((item) => item.profileId !== preferredProfileId)
  ] : candidates;
  const usable = [];
  for (const candidate of ordered) {
    try {
      const me = await bearerJson(candidate.profileId, `${oauth.gateway}/v1/me`);
      usable.push({ profileId: candidate.profileId, me });
    } catch (error) {
      if (error instanceof ReLoginRequiredError || error instanceof AugentaRequestError && (error.status === 401 || error.status === 403)) {
        continue;
      }
      throw error;
    }
  }
  return usable;
}
async function saveVerifiedLogin(oauth, tokens) {
  const me = await verifyFreshLogin(oauth, tokens.accessToken);
  const saved = await saveDeviceProfile(oauth, tokens, {
    userId: me.user.id,
    orgId: me.org.id
  });
  return { profileId: saved.profileId, me };
}
async function selectOrCreateProfile(oauth, preferredProfileId) {
  const usable = await usableProfiles(oauth, preferredProfileId);
  if (usable.length > 0) {
    return choose("Choose the Augenta organization:", usable, (item) => `${item.me.org.name} (${item.me.org.id})`);
  }
  return saveVerifiedLogin(oauth, await deviceLogin(oauth));
}
async function listWorkspaces(profileId, gateway) {
  const workspaces = await fetchAllWorkspaces(profileId, gateway);
  if (workspaces.length === 0) {
    throw new Error("the authenticated organization has no active Workspaces");
  }
  const isDefault = (workspace) => workspace.name.trim().toLowerCase() === DEFAULT_WORKSPACE_NAME.toLowerCase();
  return [...workspaces].sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)));
}
async function createWorkspace(profileId, gateway, requestedName) {
  const name = requestedName.trim();
  if (!name)
    throw new Error("a Workspace name is required");
  const result = await bearerJson(profileId, `${gateway}/v1/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  const workspace = result.workspace ?? result;
  if (typeof workspace.id !== "string" || typeof workspace.name !== "string") {
    throw new Error("Augenta created the Workspace but returned an invalid response");
  }
  return { id: workspace.id, name: workspace.name };
}
async function askWorkspaceName() {
  if (!input.isTTY) {
    throw new Error("run augenta:connect in an interactive terminal");
  }
  const rl = createInterface({ input, output });
  try {
    for (let attempt = 0;attempt < 5; attempt++) {
      const name = (await rl.question("New Workspace name: ")).trim();
      if (name)
        return name;
      console.log("Enter a name for the new Workspace, or cancel the command.");
    }
    throw new Error("no valid Workspace name was given");
  } finally {
    rl.close();
  }
}
async function selectedWorkspaces(profileId, gateway, organizationName, preselectedIds = [], available, prompts = { chooseMany, askWorkspaceName }) {
  let choices = [...available ?? await listWorkspaces(profileId, gateway)];
  const preselected = new Set(preselectedIds);
  while (true) {
    const menu = [
      ...choices.map((workspace) => ({ kind: "workspace", workspace })),
      { kind: "create" }
    ];
    const selected = await prompts.chooseMany("Choose every Workspace this project should feed (each one receives the full record):", menu, (choice) => choice.kind === "create" ? "Create a new Workspace" : `${choice.workspace.name} (${choice.workspace.id})`, {
      preselected: (choice) => choice.kind === "workspace" && preselected.has(choice.workspace.id)
    });
    if (!selected.some((choice) => choice.kind === "create")) {
      return selected.map((choice) => choice.workspace);
    }
    if (selected.length > 1) {
      console.log("Choose Create a new Workspace by itself; the complete destination list appears again after creation.");
      continue;
    }
    const name = await prompts.askWorkspaceName();
    const created = await createWorkspace(profileId, gateway, name);
    console.log(`Created ${created.name} (${created.id}) in ${organizationName}. Choose the complete destination set.`);
    choices = await listWorkspaces(profileId, gateway);
  }
}
function legacyConnectorIds(projectRoot) {
  try {
    const raw = JSON.parse(readFileSync11(configPath(projectRoot), "utf8"));
    if (raw.authMode !== "oauth" || !Array.isArray(raw.destinations))
      return [];
    const ids = raw.destinations.map((item) => item && typeof item === "object" ? item.connectorId : undefined).filter((id) => typeof id === "string" && id.trim().length > 0).map((id) => id.trim());
    return [...new Set(ids)];
  } catch {
    return [];
  }
}
function priorCandidateIds(projectRoot, signedIn) {
  const links = readLinks(projectRoot);
  const local = links && links.userId === signedIn.userId ? links.links.map((link) => link.connectorId) : [];
  return [...new Set([...local, ...legacyConnectorIds(projectRoot)])];
}
function unsentFromAnotherSignIn(projectRoot, userId) {
  const previous = readLinks(projectRoot);
  if (!previous || previous.userId === userId)
    return 0;
  try {
    return new Outbox(projectRoot).pendingByteCount();
  } catch {
    return 0;
  }
}
async function priorLinks(profileId, gateway, ids, userId) {
  const links = [];
  const unresolved = [];
  for (const id of ids) {
    const link = await currentConnector(profileId, gateway, id).catch(() => {
      return;
    });
    if (!link)
      unresolved.push(id);
    else if (link.ownerUserId === userId)
      links.push(link);
  }
  return { links, unresolved };
}
async function ownProjectLinks(profileId, gateway, owner, workspaceId) {
  const query = new URLSearchParams({ kind: "agent", status: "active", workspaceId });
  const { connectors } = await bearerJson(profileId, `${gateway}/v1/connectors?${query}`);
  return (connectors ?? []).filter((link) => link.kind === "agent" && link.status === "active" && link.workspaceId === workspaceId && link.ownerUserId === owner.userId && link.metadata?.projectKey === owner.projectKey).sort((a, b) => (Date.parse(a.createdAt ?? "") || 0) - (Date.parse(b.createdAt ?? "") || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
async function adoptionCandidates(profileId, gateway, owner, workspaces, prior, lookup) {
  const candidates = new Map;
  for (const workspace of workspaces) {
    const own = prior.filter((link) => link.workspaceId === workspace.id);
    if (!lookup || own.some((link) => link.kind === "agent" && link.status === "active")) {
      candidates.set(workspace.id, own);
      continue;
    }
    try {
      const found = await ownProjectLinks(profileId, gateway, owner, workspace.id);
      candidates.set(workspace.id, [...own, ...found.filter((link) => !own.some((mine) => mine.id === link.id))]);
    } catch (error) {
      candidates.set(workspace.id, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return candidates;
}
function sameMetadata(a, b) {
  const canonical2 = (value) => JSON.stringify(Object.entries(value ?? {}).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0));
  return canonical2(a) === canonical2(b);
}
async function linkForWorkspace(projectRoot, args, profileId, gateway, workspace, adoptable, owner) {
  const name = basename4(projectRoot);
  const fields = {
    workspaceId: workspace.id,
    kind: "agent",
    direction: "inbound",
    name,
    projectName: name,
    harness: detectedHarness(args.harness),
    client: "augenta-plugin",
    description: `Agent activity and project memory from ${name}`,
    metadata: { pluginVersion: PLUGIN_VERSION, projectKey: owner.projectKey }
  };
  const existing = adoptable.find((link) => link.kind === "agent" && link.status === "active" && link.workspaceId === workspace.id && link.ownerUserId === owner.userId);
  if (existing) {
    const metadata = { ...existing.metadata ?? {}, ...fields.metadata };
    if (existing.name === fields.name && existing.projectName === fields.projectName && (fields.harness === undefined || existing.harness === fields.harness) && existing.client === fields.client && existing.description === fields.description && sameMetadata(existing.metadata, metadata)) {
      return { connector: existing, action: "adopted" };
    }
    const { kind: _kind, workspaceId: _workspaceId, ...mutableFields } = fields;
    const connector2 = (await bearerJson(profileId, `${gateway}/v1/connectors/${encodeURIComponent(existing.id)}`, {
      method: "PATCH",
      headers: {
        ...existing._etag ? { "if-match": existing._etag } : {}
      },
      body: JSON.stringify({ ...mutableFields, metadata, _etag: existing._etag })
    })).connector;
    return { connector: connector2, action: "adopted" };
  }
  const connector = (await bearerJson(profileId, `${gateway}/v1/connectors`, { method: "POST", body: JSON.stringify(fields) })).connector;
  return { connector, action: "created" };
}
async function resolveOAuth(args, projectRoot = args.project ?? process.cwd()) {
  const prior = loadProjectConfig(projectRoot);
  const control = controlUrl(prior, args.controlUrl);
  const discovered = await augentaOAuthConfig(control);
  const gateway = gatewayBase({ endpoint: discovered.gateway }, args.endpoint);
  if (gateway !== discovered.gateway) {
    if (!args.endpoint?.trim())
      throw new GatewayOverrideError("gateway_override_unconfirmed", gateway, discovered.gateway);
    if (gitTracking(projectRoot, ".augenta/config.json")) {
      throw new GatewayOverrideError("override_config_tracked", gateway, discovered.gateway);
    }
  }
  const variable = process.env.AUGENTA_API_URL?.trim().replace(/\/+$/, "");
  if (args.endpoint?.trim() && variable && variable !== gateway) {
    throw new GatewayOverrideError("gateway_override_conflict", gateway, discovered.gateway, variable, "AUGENTA_API_URL");
  }
  const ingest = process.env.AUGENTA_INGEST_URL?.trim();
  if (ingest && !sameOrigin(ingest, gateway)) {
    throw new GatewayOverrideError("gateway_override_conflict", gateway, discovered.gateway, ingest, "AUGENTA_INGEST_URL");
  }
  if (args.disclosures && gateway !== discovered.gateway)
    args.disclosures.gatewayOverride = gateway;
  const discoveredGateway = gateway === discovered.gateway ? discovered.gateway : undefined;
  return { oauth: { ...discovered, gateway }, gateway, control, discovered: discovered.gateway, discoveredGateway };
}
function grantMismatch(pending, oauth) {
  if (pending.issuer !== oauth.issuer || pending.clientId !== oauth.clientId)
    return "environment";
  return typeof pending.gateway === "string" && pending.gateway.replace(/\/+$/, "") === oauth.gateway ? undefined : "gateway";
}

class GatewayOverrideError extends Error {
  code;
  constructor(code, gateway, discovered, variable, variableName) {
    super(code === "gateway_override_unconfirmed" ? `AUGENTA_API_URL points connect at ${displayOrigin(gateway)} instead of ${displayOrigin(discovered)}, the gateway this environment's sign-in names, and connect does not sign in or send to a gateway the environment alone chose; nothing was sent. Unset AUGENTA_API_URL (check any committed .claude/settings.json), or pass --endpoint to choose that gateway yourself` : code === "override_config_tracked" ? `this connection would use the gateway ${displayOrigin(gateway)} instead of ${displayOrigin(discovered)}, and git tracks this project's .augenta/config.json (or gave no answer on whether it does), so the override would reach everyone who pulls it and stop their capture; nothing was sent. Connect without --endpoint, or untrack the config first` : `this connection would use the gateway ${displayOrigin(gateway)}, but ${variableName} is set to ${displayOrigin(variable)}, and the variable would win in every hook, so this checkout would never capture; nothing was sent. Unset ${variableName} (check any committed .claude/settings.json), or make it the same gateway`);
    this.code = code;
  }
}
function priorConnection(projectRoot) {
  if (!existsSync9(join13(projectRoot, ".augenta", "config.json")))
    return;
  try {
    const existing = loadProjectConfig(projectRoot);
    return existing?.authMode === "oauth" ? existing : undefined;
  } catch {
    return;
  }
}
async function establishConnectors(projectRoot, args, profileId, gateway, connection, workspaces, priorConnectorIds, available = workspaces, preresolved) {
  const prior = preresolved ?? await priorLinks(profileId, gateway, priorConnectorIds, connection.owner.userId);
  const adoptable = prior.links;
  const unresolvedConnectorIds = prior.unresolved;
  const priorWorkspaceIds = [
    ...new Set([
      ...(connection.recorded ?? []).map((workspace) => workspace.workspaceId),
      ...adoptable.map((link) => link.workspaceId)
    ])
  ];
  const candidates = await adoptionCandidates(profileId, gateway, connection.owner, workspaces, adoptable, connection.knownProject);
  const results = await linkWorkspaces(projectRoot, args, profileId, gateway, connection.owner, workspaces, candidates);
  for (const result of results) {
    if (!result.connectorId && priorWorkspaceIds.includes(result.workspaceId))
      result.wasConnected = true;
  }
  const verifiedIds = results.map((result) => result.connectorId).filter((id) => Boolean(id));
  const selectedIds = workspaces.map((workspace) => workspace.id);
  const nameFor = (id) => available.find((workspace) => workspace.id === id)?.name ?? connection.recorded?.find((workspace) => workspace.workspaceId === id)?.workspaceName;
  const removed2 = priorWorkspaceIds.filter((id) => !selectedIds.includes(id)).map((workspaceId) => {
    const name = nameFor(workspaceId);
    const own = adoptable.find((link) => link.workspaceId === workspaceId);
    return {
      ...own ? { connectorId: own.id } : {},
      workspaceId,
      ...name ? { workspaceName: name } : {},
      disposition: "left_in_place"
    };
  });
  if (verifiedIds.length === 0)
    return { results, removed: removed2, unresolvedConnectorIds };
  const previous = loadProjectConfig(projectRoot);
  const unsent = unsentFromAnotherSignIn(projectRoot, connection.owner.userId);
  const configPath2 = writeOAuthConfig(projectRoot, {
    profileId,
    userId: connection.owner.userId,
    projectKey: connection.owner.projectKey,
    controlUrl: connection.controlUrl,
    org: connection.org,
    discoveredGateway: connection.discoveredGateway,
    shared: connection.shared,
    endpoint: gateway,
    destinations: results.filter((result) => Boolean(result.connectorId)).map(({ connectorId, workspaceId, workspaceName }) => ({ connectorId, workspaceId, workspaceName })),
    autoRecall: args.autoRecall ?? previous?.autoRecall ?? false,
    ingestUrl: previous?.ingestUrl && sameOrigin(previous.ingestUrl, gateway) ? previous.ingestUrl : undefined
  });
  try {
    const freshKeys = results.filter((result) => result.connectorId && (result.action === "created" || !priorConnectorIds.includes(result.connectorId))).map((result) => result.connectorId);
    new Outbox(projectRoot).registerDestinations(verifiedIds, { freshKeys });
  } catch {}
  return { results, removed: removed2, unresolvedConnectorIds, configPath: configPath2, ...unsent > 0 ? { unsentFromAnotherSignIn: unsent } : {} };
}
async function linkWorkspaces(projectRoot, args, profileId, gateway, owner, workspaces, candidates) {
  const results = [];
  for (const workspace of workspaces) {
    try {
      const adoptable = candidates.get(workspace.id) ?? [];
      if (adoptable instanceof Error)
        throw adoptable;
      const { connector, action } = await linkForWorkspace(projectRoot, args, profileId, gateway, workspace, adoptable, owner);
      const verified = await bearerJson(profileId, `${gateway}/v1/connectors/${encodeURIComponent(connector.id)}`);
      if (verified.connector.status !== "active" || verified.connector.workspaceId !== workspace.id || verified.connector.ownerUserId !== owner.userId) {
        throw new Error("Connector verification failed");
      }
      results.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        connectorId: verified.connector.id,
        action
      });
    } catch (error) {
      results.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}
function ephemeralProjectMessage(projectRoot) {
  const session = sessionEnvironment();
  return `this session's machine is discarded when the session ends (${session.signals.join(", ")}), and ` + `${projectRoot} is not inside a Git checkout, so a connection written here could not outlast it; ` + "connect from a local session instead (in Cowork, a local session with the project folder attached)";
}
async function connectProject(projectRoot, args) {
  if (ephemeralProject(projectRoot))
    throw new Error(ephemeralProjectMessage(projectRoot));
  const { oauth, gateway, control, discovered, discoveredGateway } = await resolveOAuth(args, projectRoot);
  const prior = priorConnection(projectRoot);
  const environment = environmentLabel(control);
  if (environment !== "prod") {
    console.log(`This is the ${environment} environment, not production.`);
  }
  if (gateway !== discovered) {
    console.log(`This connection uses the gateway ${displayOrigin(gateway)} instead of ${displayOrigin(discovered)}, the one this environment's sign-in names.`);
  }
  if (prior?.controlUrl && prior.controlUrl !== control) {
    console.log(`This project is moving from ${environmentLabel(prior.controlUrl)} to ${environment}.`);
  }
  const selected = await selectOrCreateProfile(oauth, prior?.profileId);
  console.log(`Signed in as ${selected.me.user.name || selected.me.user.email} to ${selected.me.org.name} (${selected.me.org.id}).`);
  const priorIds = priorCandidateIds(projectRoot, { userId: selected.me.user.id });
  const owner = { userId: selected.me.user.id, projectKey: prior?.projectKey ?? randomUUID7() };
  const resolvedPrior = await priorLinks(selected.profileId, gateway, priorIds, owner.userId);
  const available = await listWorkspaces(selected.profileId, gateway);
  console.log("Every Workspace you select receives the FULL record — this project's agent activity, its raw transcript lines (structurally sanitized, but NOT secret-scrubbed), its project memory, and supplied text documents and PDFs supplied or referenced in supported file-tool records, complete, in each. PDF bytes are NOT secret-scrubbed. Attachments start after this checkout consents; earlier transcript history is not rescanned. Upgrade every installed harness before connecting to enable attachments.");
  console.log("So anyone with access to ANY Workspace you select can read this project's captured activity: the audience is the union of all of them.");
  if (environment !== "prod") {
    console.log(`This is the ${environment} environment, not production.`);
  }
  if (gateway !== discovered) {
    console.log(`This connection uses the gateway ${displayOrigin(gateway)}, not the one this environment's sign-in names.`);
  }
  if (prior && isTrackedByGit(projectRoot, ".augenta/config.json")) {
    console.log("Git tracks this project's .augenta/config.json, so the set you choose changes the Workspaces for everyone who pulls it.");
  }
  const workspaces = await selectedWorkspaces(selected.profileId, gateway, selected.me.org.name, [
    ...(prior?.workspaces ?? []).map((workspace) => workspace.workspaceId),
    ...resolvedPrior.links.map((link) => link.workspaceId)
  ], available);
  if (workspaces.length === 0) {
    throw new Error("choose at least one Workspace");
  }
  const autoRecall = args.autoRecall ?? await askAutoRecall(loadProjectConfig(projectRoot)?.autoRecall);
  const { results, removed: removed2, unresolvedConnectorIds, configPath: written, unsentFromAnotherSignIn: unsent } = await establishConnectors(projectRoot, { ...args, autoRecall }, selected.profileId, gateway, {
    controlUrl: control,
    org: selected.me.org,
    discoveredGateway,
    shared: gateway === discovered,
    owner,
    knownProject: Boolean(prior?.projectKey),
    recorded: prior?.workspaces
  }, workspaces, priorIds, available, resolvedPrior);
  const live = results.filter((result) => result.connectorId);
  const failed = results.filter((result) => !result.connectorId);
  if (live.length > 0) {
    console.log(`Wrote ${written} (0600). This project now feeds ${live.map((result) => `${result.workspaceName} (Connector ${result.connectorId})`).join(", ")}.`);
    if (live.length > 1) {
      console.log("Each of those receives the full record, so the audience is the union of everyone with access to any of them.");
    }
    console.log("Eligible documents observed after this checkout's consent go to every selected Workspace. PDF bytes and raw transcripts are not secret-scrubbed. Images remain placeholders.");
    console.log(`Automatic recall is ${autoRecall ? "on" : "off"} for this project.`);
  } else {
    console.log("No destination could be linked. No config was written.");
  }
  for (const result of failed) {
    console.log(result.wasConnected ? `Could not link ${result.workspaceName}, which this project WAS feeding: ${result.message}. It has been dropped — re-run connect to restore it.` : `Could not link ${result.workspaceName}: ${result.message}`);
  }
  if (written) {
    for (const entry of removed2) {
      console.log(entry.connectorId ? `No longer sending to ${entry.workspaceName ?? entry.workspaceId}. Its Connector ${entry.connectorId} is left in place and idle — remove it in Augenta if you want it gone.` : `No longer sending to ${entry.workspaceName ?? entry.workspaceId}.`);
    }
    if (unresolvedConnectorIds.length > 0) {
      console.log(`Dropped ${unresolvedConnectorIds.join(", ")}: this project listed ${unresolvedConnectorIds.length === 1 ? "that Connector" : "those Connectors"} but ${unresolvedConnectorIds.length === 1 ? "it is" : "they are"} no longer readable with this sign-in.`);
    }
    if (unsent) {
      console.log(`${unsent} bytes of records captured here under another person's sign-in were not sent and will not be: they could go only through that person's own Connectors.`);
    }
  }
}
function secondsUntil(timestamp) {
  return Math.max(0, Math.round((timestamp - Date.now()) / 1000));
}
async function workspaceStep(profileId, gateway, me) {
  const workspaces = await listWorkspaces(profileId, gateway);
  return {
    status: "need_workspace",
    profileId,
    signedInAs: {
      name: me.user.name || me.user.email,
      email: me.user.email,
      organization: me.org.name
    },
    workspaces: workspaces.map(({ id, name }) => ({ id, name }))
  };
}
async function priorDestinations(profileId, gateway, userId, prior, ids, workspaces) {
  const destinations = [];
  const unresolvedConnectorIds = [];
  if (prior?.workspaces) {
    for (const recorded of prior.workspaces) {
      const name = workspaces.find((n) => n.id === recorded.workspaceId)?.name;
      const mine = prior.destinations?.find((destination) => destination.workspaceId === recorded.workspaceId);
      let connectorId;
      if (mine) {
        const link = await currentConnector(profileId, gateway, mine.connectorId).catch(() => {
          return;
        });
        if (link?.ownerUserId === userId)
          connectorId = link.id;
        else
          unresolvedConnectorIds.push(mine.connectorId);
      }
      destinations.push({
        ...connectorId ? { connectorId } : {},
        workspaceId: recorded.workspaceId,
        ...name ? { workspaceName: name } : {}
      });
    }
    return { destinations, unresolvedConnectorIds };
  }
  for (const id of ids) {
    const link = await currentConnector(profileId, gateway, id).catch(() => {
      return;
    });
    if (!link) {
      unresolvedConnectorIds.push(id);
      continue;
    }
    if (link.ownerUserId !== userId)
      continue;
    const name = workspaces.find((n) => n.id === link.workspaceId)?.name;
    destinations.push({
      connectorId: link.id,
      workspaceId: link.workspaceId,
      ...name ? { workspaceName: name } : {}
    });
  }
  return { destinations, unresolvedConnectorIds };
}
async function probeConnection(resolved, args) {
  const cfg = loadProjectConfig(resolved.projectRoot);
  const current = savedConnection(cfg);
  const change = environmentChange(cfg, args);
  const { oauth, gateway } = await resolveOAuth(args, resolved.projectRoot);
  const prior = priorConnection(resolved.projectRoot);
  const alreadyConnected = {
    alreadyConnected: Boolean(cfg),
    ...current ? { current } : {},
    ...change,
    ...cfg ? joinedState(cfg) : {}
  };
  const usable = await usableProfiles(oauth, prior?.profileId);
  if (usable.length === 0)
    return { status: "need_login", ...alreadyConnected };
  if (usable.length > 1) {
    return {
      status: "need_profile",
      ...alreadyConnected,
      profiles: usable.map((item) => ({
        profileId: item.profileId,
        organization: item.me.org.name,
        email: item.me.user.email
      }))
    };
  }
  const step = await workspaceStep(usable[0].profileId, gateway, usable[0].me);
  return {
    ...step,
    ...alreadyConnected,
    ...await priorDestinations(usable[0].profileId, gateway, usable[0].me.user.id, prior, priorCandidateIds(resolved.projectRoot, { userId: usable[0].me.user.id }), step.workspaces)
  };
}
async function startLogin(args) {
  const { oauth } = await resolveOAuth(args);
  const live = readPendingLogin();
  const pending = live && !grantMismatch(live, oauth) ? live : await beginDeviceLogin(oauth);
  savePendingLogin(pending);
  return {
    status: "login_started",
    verificationUri: pending.verificationUri,
    userCode: pending.userCode,
    expiresInSeconds: secondsUntil(pending.expiresAt)
  };
}
async function awaitLogin(args) {
  const { oauth, gateway } = await resolveOAuth(args);
  const pending = readPendingLogin();
  if (!pending) {
    return {
      status: "error",
      code: "no_pending_login",
      message: "no sign-in is in progress; start one with --login"
    };
  }
  const mismatch = grantMismatch(pending, oauth);
  if (mismatch) {
    clearPendingLogin();
    return {
      status: "error",
      code: "no_pending_login",
      message: mismatch === "environment" ? "the pending sign-in belongs to a different Augenta environment; start a new one with --login" : "the pending sign-in was started for a different Augenta gateway, so it was cancelled and nothing was sent; start a new one with --login"
    };
  }
  try {
    const result = await pollDeviceToken(pending, {
      waitMs: (args.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000
    });
    if (!result.ok) {
      savePendingLogin({ ...pending, intervalMs: result.intervalMs });
      return {
        status: "login_pending",
        verificationUri: pending.verificationUri,
        userCode: pending.userCode,
        expiresInSeconds: secondsUntil(pending.expiresAt)
      };
    }
    const { profileId, me } = await saveVerifiedLogin(oauth, result.tokens);
    clearPendingLogin();
    return workspaceStep(profileId, gateway, me);
  } catch (error) {
    if (error instanceof ReLoginRequiredError) {
      clearPendingLogin();
      return {
        status: "error",
        code: error.reason ?? "login_expired",
        message: error.message
      };
    }
    throw error;
  }
}
async function createWorkspaceForSelection(resolved, args) {
  const name = args.createWorkspace?.trim();
  if (!name) {
    return {
      status: "error",
      code: "workspace_name_required",
      message: "a non-empty Workspace name is required"
    };
  }
  const { oauth, gateway } = await resolveOAuth(args, resolved.projectRoot);
  const prior = priorConnection(resolved.projectRoot);
  const usable = await usableProfiles(oauth, args.profile ?? prior?.profileId);
  if (usable.length === 0) {
    return {
      status: "error",
      code: "not_signed_in",
      message: "no usable Augenta sign-in; start one with --login"
    };
  }
  if (usable.length > 1 && !args.profile) {
    return {
      status: "error",
      code: "need_profile",
      message: "several organizations are signed in; pass --profile <profileId> to choose one"
    };
  }
  const picked = args.profile ? usable.find((item) => item.profileId === args.profile) : usable[0];
  if (!picked) {
    return {
      status: "error",
      code: "unknown_profile",
      message: `no usable sign-in matches profile ${args.profile}`
    };
  }
  const createdWorkspace = await createWorkspace(picked.profileId, gateway, name);
  try {
    return {
      ...await workspaceStep(picked.profileId, gateway, picked.me),
      createdWorkspace
    };
  } catch (error) {
    return {
      status: "workspace_created",
      createdWorkspace,
      message: `Created ${createdWorkspace.name}, but could not refresh the Workspace list: ${describeError(error)}. Re-run --probe; do not create it again.`
    };
  }
}
async function connectToWorkspaces(resolved, args) {
  const { oauth, gateway, control, discovered, discoveredGateway } = await resolveOAuth(args, resolved.projectRoot);
  const prior = priorConnection(resolved.projectRoot);
  const usable = await usableProfiles(oauth, args.profile ?? prior?.profileId);
  if (usable.length === 0) {
    return {
      status: "error",
      code: "not_signed_in",
      message: "no usable Augenta sign-in; start one with --login"
    };
  }
  if (usable.length > 1 && !args.profile) {
    return {
      status: "error",
      code: "need_profile",
      message: "several organizations are signed in; pass --profile <profileId> to choose one"
    };
  }
  const picked = args.profile ? usable.find((item) => item.profileId === args.profile) : usable[0];
  if (!picked) {
    return {
      status: "error",
      code: "unknown_profile",
      message: `no usable sign-in matches profile ${args.profile}`
    };
  }
  const requested = [...new Set(args.workspaces ?? [])];
  if (requested.length === 0) {
    return {
      status: "error",
      code: "workspace_required",
      message: "select at least one Workspace; nothing was created or changed"
    };
  }
  const available = await listWorkspaces(picked.profileId, gateway);
  const unknown = requested.filter((id) => !available.some((item) => item.id === id));
  if (unknown.length > 0) {
    return {
      status: "error",
      code: "unknown_workspace",
      unknown,
      message: `${unknown.join(", ")} ${unknown.length === 1 ? "is not an active Workspace" : "are not active Workspaces"} in ${picked.me.org.name}; nothing was created`
    };
  }
  const workspaces = available.filter((item) => requested.includes(item.id));
  const { results, removed: removed2, unresolvedConnectorIds, configPath: configPath2, unsentFromAnotherSignIn: unsent } = await establishConnectors(resolved.projectRoot, args, picked.profileId, gateway, {
    controlUrl: control,
    org: picked.me.org,
    discoveredGateway,
    shared: gateway === discovered,
    owner: { userId: picked.me.user.id, projectKey: prior?.projectKey ?? randomUUID7() },
    knownProject: Boolean(prior?.projectKey),
    recorded: prior?.workspaces
  }, workspaces, priorCandidateIds(resolved.projectRoot, { userId: picked.me.user.id }), available);
  const destinations = results.filter((result) => result.connectorId);
  const failed = results.filter((result) => !result.connectorId);
  if (destinations.length === 0) {
    return {
      status: "error",
      code: "no_destination_linked",
      message: `no destination could be linked; no config was written (${failed.map((result) => `${result.workspaceName}: ${result.message}`).join("; ")})`
    };
  }
  return {
    status: failed.length > 0 ? "partially_connected" : "connected",
    destinations,
    captureHealth: captureHealth(resolved.projectRoot),
    ...failed.length > 0 ? {
      failed: failed.map(({ workspaceId, workspaceName, message, wasConnected }) => ({
        workspaceId,
        workspaceName,
        message,
        ...wasConnected ? { wasConnected } : {}
      }))
    } : {},
    ...removed2.length > 0 ? { removed: removed2 } : {},
    ...unresolvedConnectorIds.length > 0 ? { unresolvedConnectorIds } : {},
    ...unsent ? { unsentFromAnotherSignIn: unsent } : {},
    organization: picked.me.org.name,
    ...environmentChange(prior, args),
    autoRecall: loadProjectConfig(resolved.projectRoot)?.autoRecall ? "on" : "off",
    configPath: configPath2
  };
}
function environmentChange(cfg, args) {
  const next = controlUrl(cfg, args.controlUrl);
  return cfg?.controlUrl && cfg.controlUrl !== next ? { environmentChange: { from: environmentLabel(cfg.controlUrl), to: environmentLabel(next) } } : {};
}
function joinedState(cfg) {
  return {
    adopted: cfg.authMode === "oauth" ? cfg.join === "joined" : true,
    configTracked: isTrackedByGit(cfg.projectRoot, ".augenta/config.json")
  };
}
function autoRecallSetting(cfg) {
  return cfg.autoRecall === undefined ? "on_by_default" : cfg.autoRecall ? "on" : "off";
}
function savedConnection(cfg) {
  if (!cfg)
    return;
  return {
    authMode: cfg.authMode,
    environment: environmentLabel(cfg.controlUrl),
    organization: cfg.org?.name ?? cfg.org?.id,
    destinations: cfg.authMode === "oauth" ? cfg.workspaces ?? [] : cfg.destinations ?? [],
    autoRecall: autoRecallSetting(cfg)
  };
}
function blockedNetworkMessage(hosts) {
  const blocked = hosts.filter((host) => !host.ok);
  const needed = hosts.map((host) => host.host).join(", ");
  return `this network does not let connect reach ${blocked.map((host) => `${host.host} (${host.reason})`).join(", ")}; ` + `connect needs ${needed}. Allow these hosts in this environment's network settings, or ask your administrator to allow them. ` + "In Cowork, the setting is Organization settings → Capabilities → Code execution → Allow network egress " + "(also called Admin settings → Capabilities → Network egress). Start a new task after the setting changes; existing tasks keep their original settings." + (blocked.some((host) => host.kind === "tls") ? " If your network intercepts TLS, ask your administrator to supply its trusted proxy CA for Node." : "");
}
async function runJsonVerb(resolved, args) {
  if ((args.coworkTask || args.coworkTransport || args.coworkTranscript) && !args.project) {
    return { status: "error", code: "project_required", message: "Task binding requires an explicit --project directory; attached paths and the current directory do not choose its route." };
  }
  const cfg = loadProjectConfig(resolved.projectRoot);
  const metadata = {
    environment: environmentLabel(args.repairHarness ? cfg?.controlUrl : controlUrl(cfg, args.controlUrl)),
    ...args.repairHarness ? {} : environmentChange(cfg, args),
    ...args.probe && cfg ? { current: savedConnection(cfg) } : {},
    ...args.probe ? { session: sessionEnvironment() } : {}
  };
  const disclosures = {};
  try {
    return { ...await dispatchJsonVerb(resolved, { ...args, project: resolved.projectRoot, disclosures }), ...metadata, ...disclosures };
  } catch (error) {
    if (error instanceof CoworkError)
      return { status: "error", code: error.code, message: error.message, ...metadata, ...disclosures };
    if (error instanceof GatewayOverrideError) {
      return { status: "error", code: error.code, message: error.message, ...metadata, ...disclosures };
    }
    if (classifyNetworkError(error)) {
      const hosts = await diagnoseHosts(controlUrl(cfg, args.controlUrl), { gateway: disclosures.gatewayOverride });
      const blocked = hosts.filter((host) => !host.ok);
      if (blocked.length > 0) {
        return {
          status: "error",
          code: "network_blocked",
          hosts,
          message: blockedNetworkMessage(hosts),
          ...metadata,
          ...disclosures
        };
      }
    }
    return { status: "error", code: "failed", message: describeError(error), ...metadata, ...disclosures };
  }
}
async function repairHarness(projectRoot, args) {
  if (!args.harness)
    return { status: "error", code: "harness_required", message: "--repair-harness requires an explicit --harness codex or --harness claude-code" };
  const cfg = loadProjectConfig(projectRoot);
  if (cfg?.authMode !== "oauth")
    return { status: "error", code: "oauth_connection_required", message: "repair requires a readable browser-connected project config" };
  const gateway = storedProfileGateway(cfg.profileId);
  if (cfg.gatewayMismatch) {
    const remedy = cfg.gatewayMismatch.cause === "environment" ? "unset AUGENTA_API_URL and AUGENTA_INGEST_URL" : "connect again here to point it back";
    return { status: "error", code: "gateway_mismatch", message: `this project's Augenta requests would go to ${describeGatewayMismatch(cfg.gatewayMismatch)}; nothing was changed. ${remedy[0].toUpperCase()}${remedy.slice(1)}` };
  }
  const owner = cfg.destinations?.length ? storedProfileUserId(cfg.profileId) : undefined;
  if (!owner || !gateway)
    return { status: "error", code: "not_joined", message: "this checkout has not joined its project's connection; join it with connect first" };
  const repaired = [];
  const failed = [];
  for (const destination of cfg.destinations) {
    const connectorId = destination.connectorId;
    try {
      const url = `${gateway}/v1/connectors/${encodeURIComponent(connectorId)}`;
      const { connector } = await bearerJson(cfg.profileId, url);
      if (connector.id !== connectorId || connector.kind !== "agent" || connector.status !== "active" || connector.workspaceId !== destination.workspaceId || connector.ownerUserId !== owner || !connector._etag) {
        throw new Error("Connector must be your active agent in the recorded Workspace with a current revision; nothing changed");
      }
      const { connector: updated } = await bearerJson(cfg.profileId, url, {
        method: "PATCH",
        headers: { "if-match": connector._etag },
        body: JSON.stringify({ harness: args.harness, _etag: connector._etag })
      });
      if (updated.id !== connectorId || updated.kind !== "agent" || updated.status !== "active" || updated.workspaceId !== destination.workspaceId || updated.harness !== args.harness) {
        throw new Error("Repair response did not confirm an active agent with the requested label and route; inspect the Connector before retrying");
      }
      repaired.push(connectorId);
    } catch (error) {
      failed.push({ connectorId, message: describeError(error) });
    }
  }
  return {
    status: failed.length ? "error" : "harness_repaired",
    ...failed.length ? { code: "harness_repair_incomplete", message: "Some Connector labels were not repaired; see repaired and failed" } : {},
    harness: args.harness,
    repaired,
    failed
  };
}
async function adoptProject(resolved, args) {
  const cfg = loadProjectConfig(resolved.projectRoot);
  if (!cfg) {
    return { status: "error", code: "not_connected", message: "this project has no readable connection to join; connect it instead" };
  }
  if (cfg.authMode !== "oauth") {
    return { status: "error", code: "oauth_connection_required", message: "an API-key project has nothing to join: its key is its connection" };
  }
  const recorded = cfg.controlUrl ?? DEFAULT_CONTROL_URL;
  if (controlUrl(cfg) !== recorded) {
    return {
      status: "error",
      code: "environment_mismatch",
      message: `this project's config records the ${environmentLabel(recorded)} environment, but this session is pointed at ${environmentLabel(controlUrl(cfg))}; unset AUGENTA_CONTROL_URL to join it`
    };
  }
  const { oauth, gateway } = await resolveOAuth(args, resolved.projectRoot);
  const organization = cfg.org?.name ?? cfg.org?.id;
  const elsewhere = routeOutside(gateway, cfg);
  if (elsewhere) {
    return {
      status: "error",
      code: "gateway_mismatch",
      organization,
      configTracked: isTrackedByGit(resolved.projectRoot, ".augenta/config.json"),
      message: `this project's config sends Augenta requests to ${elsewhere}, not ${gateway}, the gateway this sign-in uses; nothing was joined, and capture stays off in this checkout. Choose its Workspaces again to point it at ${gateway}`
    };
  }
  const usable = await usableProfiles(oauth, cfg.profileId);
  if (usable.length === 0) {
    return { status: "need_login", message: "sign in to Augenta, then join again", organization };
  }
  const picked = usable.find((item) => item.profileId === cfg.profileId);
  if (!picked && reusableProfiles(oauth).some((item) => item.profileId === cfg.profileId)) {
    return { status: "need_login", message: `the sign-in to ${organization ?? "this project's organization"} needs renewing; sign in again, then join`, organization };
  }
  if (!picked) {
    return {
      status: "error",
      code: "org_mismatch",
      organization,
      signedInTo: [...new Set(usable.map((item) => item.me.org.name))],
      message: `this project was connected in ${organization ?? "another organization"}, and this sign-in is not; sign in to that organization, or choose different Workspaces`
    };
  }
  const owner = { userId: picked.me.user.id, projectKey: cfg.projectKey };
  const available = await listWorkspaces(picked.profileId, gateway);
  const workspaces = [];
  const unreachable = [];
  for (const entry of cfg.workspaces) {
    const live = available.find((workspace) => workspace.id === entry.workspaceId);
    if (live)
      workspaces.push(live);
    else
      unreachable.push({ ...entry });
  }
  if (unreachable.length > 0) {
    return {
      status: "error",
      code: "destinations_unreachable",
      reachable: workspaces.map(({ id, name }) => ({ workspaceId: id, workspaceName: name })),
      unreachable,
      organization,
      message: `this sign-in cannot use ${unreachable.map((item) => item.workspaceName ?? item.workspaceId).join(", ")}; you may need to be added to ${unreachable.length === 1 ? "that Workspace" : "those Workspaces"}. Nothing was created, and capture stays off in this checkout`
    };
  }
  const previous = readLinks(resolved.projectRoot)?.links.map((link) => link.connectorId) ?? [];
  const prior = await priorLinks(picked.profileId, gateway, priorCandidateIds(resolved.projectRoot, { userId: owner.userId }), owner.userId);
  const candidates = await adoptionCandidates(picked.profileId, gateway, owner, workspaces, prior.links, true);
  const unchecked = workspaces.filter((workspace) => candidates.get(workspace.id) instanceof Error);
  if (unchecked.length > 0) {
    return {
      status: "error",
      code: "join_failed",
      failed: unchecked.map((workspace) => ({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        message: describeError(candidates.get(workspace.id))
      })),
      organization,
      message: `could not check this sign-in's existing links into ${unchecked.map((workspace) => workspace.name).join(", ")}; nothing was created, and capture stays off in this checkout`
    };
  }
  const results = await linkWorkspaces(resolved.projectRoot, args, picked.profileId, gateway, owner, workspaces, candidates);
  const failed = results.filter((result) => !result.connectorId);
  if (failed.length > 0) {
    return {
      status: "error",
      code: "join_failed",
      failed: failed.map(({ workspaceId, workspaceName, message }) => ({ workspaceId, workspaceName, message })),
      organization,
      message: `could not link ${failed.map((result) => result.workspaceName).join(", ")}; capture stays off in this checkout. Any link already made is kept and reused when you join again`
    };
  }
  const destinations = results.map(({ connectorId, workspaceId, workspaceName, action }) => ({
    connectorId,
    workspaceId,
    workspaceName,
    action
  }));
  const unsent = unsentFromAnotherSignIn(resolved.projectRoot, owner.userId);
  const consentedAt = new Date().toISOString();
  writeLinks(resolved.projectRoot, {
    profileId: picked.profileId,
    userId: owner.userId,
    projectKey: owner.projectKey,
    joinedAt: consentedAt,
    attachmentsConsentedAt: consentedAt,
    links: destinations.map(({ workspaceId, connectorId }) => ({ workspaceId, connectorId }))
  });
  const ids = destinations.map((destination) => destination.connectorId);
  try {
    new Outbox(resolved.projectRoot).registerDestinations(ids, { freshKeys: ids.filter((id) => !previous.includes(id)) });
  } catch {}
  return {
    status: "adopted",
    destinations,
    ...unsent > 0 ? { unsentFromAnotherSignIn: unsent } : {},
    organization,
    autoRecall: autoRecallSetting(cfg),
    captureHealth: captureHealth(resolved.projectRoot)
  };
}
function setAutoRecall(projectRoot, autoRecall) {
  const cfg = loadProjectConfig(projectRoot);
  if (!cfg) {
    return {
      status: "error",
      code: "not_connected",
      message: "this project has no readable connection; connect it first, then change automatic recall"
    };
  }
  if (cfg.authMode === "oauth" && cfg.join !== "joined") {
    return {
      status: "error",
      code: "not_joined",
      message: "this checkout has not joined its project's connection; join it with connect first, then change automatic recall"
    };
  }
  const path = configPath(projectRoot);
  const raw = JSON.parse(readFileSync11(path, "utf8"));
  raw.autoRecall = autoRecall;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync10(tmp, `${JSON.stringify(raw, null, 2)}
`, { mode: 384 });
    renameSync8(tmp, path);
  } finally {
    rmSync4(tmp, { force: true });
  }
  chmodSync3(path, 384);
  return { status: "auto_recall_updated", autoRecall: autoRecall ? "on" : "off" };
}
async function dispatchJsonVerb(resolved, args) {
  if (args.coworkTask || args.coworkTransport || args.coworkTranscript) {
    if (!args.coworkTask || !args.coworkTransport || args.apiKey || args.endpoint || args.controlUrl || args.profile || args.health || args.repairHarness || args.probe || args.login || args.awaitLogin || args.adopt || args.verifyOnly || args.workspaces !== undefined || args.createWorkspace !== undefined || args.autoRecall !== undefined) {
      return { status: "error", code: "conflicting_verbs", message: "Task binding uses the joined project; pass --cowork-task and --cowork-transport alone with --json, --project and optionally --cowork-transcript for native capture." };
    }
    const task = await bindCoworkTask(resolved.projectRoot, args.coworkTask, args.coworkTransport, { transcriptPath: args.coworkTranscript });
    return { status: "bound", sessionId: task.sessionId, transport: task.transport, boundAt: task.boundAt };
  }
  if (args.repairHarness) {
    if (args.health || args.probe || args.login || args.awaitLogin || args.verifyOnly || args.workspaces !== undefined || args.createWorkspace !== undefined || args.apiKey || args.endpoint || args.controlUrl || args.profile || args.autoRecall !== undefined || args.adopt) {
      return { status: "error", code: "conflicting_verbs", message: "--repair-harness uses the saved project connection; combine it only with --json, --project and --harness" };
    }
    return repairHarness(resolved.projectRoot, args);
  }
  if (args.health && (args.workspaces?.length || args.createWorkspace !== undefined || args.login || args.awaitLogin || args.probe || args.autoRecall !== undefined || args.adopt)) {
    return { status: "error", code: "conflicting_verbs", message: "--health is a local read-only operation; run it by itself with --json" };
  }
  if (args.apiKey) {
    return {
      status: "error",
      code: "api_key_not_supported",
      message: "--api-key is a human/CI path and is not available in --json mode; run it directly in a terminal"
    };
  }
  if (args.createWorkspace !== undefined && args.workspaces?.length) {
    return {
      status: "error",
      code: "conflicting_verbs",
      message: "--create-workspace and --workspace are separate steps; create first, then ask for the complete destination set again and pass it with --workspace"
    };
  }
  if ((args.probe || args.login || args.awaitLogin || args.createWorkspace !== undefined || args.workspaces?.length || args.adopt) && ephemeralProject(resolved.projectRoot)) {
    const session = sessionEnvironment();
    return {
      status: "error",
      code: "ephemeral_project",
      session,
      message: ephemeralProjectMessage(resolved.projectRoot)
    };
  }
  if (args.adopt) {
    if (args.workspaces?.length || args.createWorkspace !== undefined || args.login || args.awaitLogin || args.probe || args.verifyOnly || args.autoRecall !== undefined || args.endpoint || args.controlUrl || args.profile) {
      return {
        status: "error",
        code: "conflicting_verbs",
        message: "--adopt joins the connection this project's config already records; run it alone with --json"
      };
    }
    return adoptProject(resolved, args);
  }
  if (args.autoRecall !== undefined && !args.workspaces?.length) {
    if (args.createWorkspace !== undefined || args.login || args.awaitLogin || args.probe || args.verifyOnly || args.endpoint || args.controlUrl || args.profile) {
      return {
        status: "error",
        code: "conflicting_verbs",
        message: "--auto-recall changes only this project's setting; run it alone with --json, or pass it with --workspace while connecting"
      };
    }
    return setAutoRecall(resolved.projectRoot, args.autoRecall);
  }
  if (args.createWorkspace !== undefined) {
    return createWorkspaceForSelection(resolved, args);
  }
  if (args.workspaces?.length)
    return connectToWorkspaces(resolved, args);
  if (args.awaitLogin)
    return awaitLogin(args);
  if (args.login)
    return startLogin(args);
  if (args.health)
    return { status: "capture_health", ...captureHealth(resolved.projectRoot) };
  if (args.probe)
    return probeConnection(resolved, args);
  return {
    status: "error",
    code: "no_verb",
    message: "--json requires one of --probe, --login, --await-login, --create-workspace <name>, --workspace <id> (repeatable), --adopt, or --auto-recall on|off"
  };
}
async function verifyApiKeyConnection(apiKey, gateway) {
  const response = await fetch(`${gateway.replace(/\/+$/, "")}/v1/connectors`, {
    headers: { authorization: `AugentaKey ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Augenta rejected the platform key (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  const connectors = (await response.json()).connectors ?? [];
  if (!Array.isArray(connectors)) {
    throw new Error("Augenta returned an invalid Connector assignment");
  }
  if (connectors.length === 0) {
    throw new Error("the platform key is not assigned to a Connector");
  }
  if (connectors.length > 1) {
    throw new Error(`the platform key is assigned to ${connectors.length} Connectors; capture requires exactly one`);
  }
  const connector = connectors[0];
  if (!connector || ["id", "orgId", "workspaceId"].some((field) => {
    const value = connector[field];
    return typeof value !== "string" || !value.trim();
  })) {
    throw new Error("the assigned Connector must have non-empty id, orgId, and workspaceId fields");
  }
  if (connector.status !== "active" || connector.direction !== "inbound" && connector.direction !== "bidirectional") {
    throw new Error("the platform key requires an active inbound Connector");
  }
  return connector;
}
async function verifyProjectKey(projectRoot, endpointOverride) {
  const cfg = loadProjectConfig(projectRoot);
  if (!cfg) {
    throw new Error("no readable .augenta/config.json in this project — nothing to verify");
  }
  if (cfg.authMode !== "api-key") {
    throw new Error(`--verify-only checks a platform key, but this project is configured for ${cfg.authMode}`);
  }
  const apiKey = cfg.apiKey?.trim();
  if (!apiKey) {
    throw new Error("the project config has no platform key to verify");
  }
  const gateway = gatewayBase(cfg, endpointOverride);
  return { connector: await verifyApiKeyConnection(apiKey, gateway), gateway };
}
async function connectWithApiKey(projectRoot, apiKey, endpoint2, autoRecall) {
  const prior = loadProjectConfig(projectRoot);
  const gateway = gatewayBase(prior, endpoint2);
  const connector = await verifyApiKeyConnection(apiKey, gateway);
  return {
    path: writeApiKeyConfig(projectRoot, apiKey, gateway === DEFAULT_GATEWAY ? undefined : gateway, {
      org: { id: connector.orgId },
      destinations: [{ connectorId: connector.id, workspaceId: connector.workspaceId }],
      autoRecall: autoRecall ?? prior?.autoRecall ?? false,
      ...prior?.controlUrl ? { controlUrl: prior.controlUrl } : {},
      ...prior?.ingestUrl ? { ingestUrl: prior.ingestUrl } : {}
    }),
    connector
  };
}
if (isMain(import.meta.url)) {
  reexecForEnvProxy();
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes("--json");
  try {
    const args = parseArgs(argv);
    if ((args.coworkTask || args.coworkTransport || args.coworkTranscript) && !args.json)
      throw new Error("Cowork task binding requires --json; it does not start an interactive sign-in.");
    if (args.repairHarness && !args.json)
      throw new Error("--repair-harness requires --json and an explicit --harness");
    if (args.createWorkspace !== undefined && !args.json) {
      throw new Error("--create-workspace is a --json verb; the interactive flow offers Create a new Workspace in its menu");
    }
    const resolved = resolveProject(args, process.cwd());
    const projectRoot = resolved.projectRoot;
    if (args.json) {
      const payload = await runJsonVerb(resolved, args);
      console.log(JSON.stringify({
        ...payload,
        projectRoot
      }, null, 2));
      if (payload.status === "error")
        process.exitCode = 1;
    } else if (args.verifyOnly) {
      if (args.apiKey?.trim()) {
        throw new Error("--verify-only checks the key already in .augenta/config.json; drop --api-key, or run --api-key on its own to write and verify a new one");
      }
      const { connector, gateway } = await verifyProjectKey(projectRoot, args.endpoint);
      console.log(`The platform key in .augenta/config.json is accepted by ${gateway} and resolves to Connector ${connector.id} (${connector.status}, ${connector.direction}). Nothing was written.`);
    } else if (args.apiKey?.trim()) {
      console.log("This checkout will capture supplied text documents and PDFs supplied or referenced in supported file-tool records, including temporary PDFs, after this connection. PDF bytes are not secret-scrubbed and go to the key's assigned Workspace. Upgrade every installed harness before enabling attachments; AUGENTA_CAPTURE_ATTACHMENTS=0 disables new attachment capture.");
      const existed = existsSync9(join13(projectRoot, ".augenta", "config.json"));
      const { path, connector } = await connectWithApiKey(projectRoot, args.apiKey.trim(), args.endpoint, args.autoRecall);
      console.log(`${existed ? "Updated" : "Wrote"} ${path} (0600). Platform-key capture is enabled through Connector ${connector.id}.`);
      console.log("Off switch: delete .augenta/config.json, or set AUGENTA_CAPTURE_ENABLED=0.");
    } else if (!input.isTTY) {
      throw new Error("signing in needs an interactive terminal; agents should use --json with --probe/--login/--await-login/--create-workspace/--workspace, and --api-key is for autonomous or CI clients.");
    } else {
      await connectProject(projectRoot, args);
    }
  } catch (error) {
    const message = describeError(error);
    if (wantsJson) {
      console.log(JSON.stringify({ status: "error", code: "failed", message }, null, 2));
    } else {
      console.error(`Augenta connect: ${message}`);
    }
    process.exitCode = 1;
  }
}
export {
  writeOAuthConfig,
  writeApiKeyConfig,
  verifyProjectKey,
  verifyApiKeyConnection,
  startLogin,
  selectedWorkspaces,
  runJsonVerb,
  resolveTargetProject,
  resolveProject,
  probeConnection,
  parseArgs,
  createWorkspaceForSelection,
  connectWithApiKey,
  connectToWorkspaces,
  connectProject,
  blockedNetworkMessage,
  awaitLogin,
  WORKSPACE_LIST_PAGE_SIZE,
  WORKSPACE_LIST_MAX_PAGES
};
