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

// scripts/recall.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// runtime/node.ts
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
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
function openBrowser(command) {
  const opener = command[0];
  if (!opener)
    return;
  const url = command[command.length - 1];
  if (!url || !isHttpsUrl(url))
    return;
  spawnSync(opener, command.slice(1), { stdio: "ignore" });
}
function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// capture/config.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
var DEFAULT_GATEWAY = "https://apim-aug-platform-prod-utyom2a4bdhti.azure-api.net";
function parseConnectorIds(value) {
  const raw = Array.isArray(value.connectorIds) ? value.connectorIds : [];
  const ids = [];
  for (const item of raw) {
    if (typeof item !== "string")
      return [];
    const id = item.trim();
    if (!id)
      return [];
    if (!ids.includes(id))
      ids.push(id);
  }
  return ids;
}
function configPath(projectRoot) {
  return join(projectRoot, ".augenta", "config.json");
}
function resolveProjectRoot(cwd) {
  if (!cwd)
    return;
  let dir = cwd;
  for (let i = 0;i < 30; i++) {
    if (existsSync(configPath(dir)))
      return dir;
    const parent = dirname(dir);
    if (parent === dir)
      return;
    dir = parent;
  }
  return;
}
function loadProjectConfig(projectRoot) {
  try {
    const value = JSON.parse(readFileSync(configPath(projectRoot), "utf8"));
    const endpoint = typeof value.endpoint === "string" && value.endpoint.trim() ? value.endpoint.trim() : undefined;
    if (value.authMode === "oauth") {
      const profileId = typeof value.profileId === "string" ? value.profileId.trim() : "";
      const connectorIds = parseConnectorIds(value);
      if (!profileId || connectorIds.length === 0)
        return;
      return {
        authMode: "oauth",
        profileId,
        connectorIds,
        ...endpoint ? { endpoint } : {},
        projectRoot
      };
    }
    if (value.authMode === "api-key") {
      const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
      if (!apiKey)
        return;
      return {
        authMode: "api-key",
        apiKey,
        ...endpoint ? { endpoint } : {},
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
function gatewayBase(cfg) {
  return (process.env.AUGENTA_API_URL || cfg?.endpoint || DEFAULT_GATEWAY).replace(/\/+$/, "");
}
function experiencesUrl(cfg) {
  return process.env.AUGENTA_INGEST_URL || `${gatewayBase(cfg)}/v1/experiences`;
}
function captureKilled() {
  const value = process.env.AUGENTA_CAPTURE_ENABLED;
  return value === "0" || value === "false";
}
function captureEnabled(cfg) {
  if (!cfg || captureKilled())
    return false;
  return cfg.authMode === "oauth" ? Boolean(cfg.profileId) && (cfg.connectorIds?.length ?? 0) > 0 : Boolean(cfg.apiKey);
}

// capture/auth.ts
import {
  chmodSync as chmodSync2,
  existsSync as existsSync3,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync2,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join as join3 } from "node:path";

// capture/augenta-dir.ts
import { join as join2 } from "node:path";
import { chmodSync, mkdirSync, existsSync as existsSync2, writeFileSync } from "node:fs";
function ensureAugentaDir(projectRoot) {
  const dir = join2(projectRoot, ".augenta");
  try {
    mkdirSync(dir, { recursive: true, mode: 448 });
    try {
      chmodSync(dir, 448);
    } catch {}
    const ignore = join2(dir, ".gitignore");
    if (!existsSync2(ignore))
      writeFileSync(ignore, `*
`);
  } catch {}
  return dir;
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
var authRoot = () => process.env.AUGENTA_AUTH_HOME || join3(homedir(), ".augenta");
var authPath = () => join3(authRoot(), "auth.json");
var lockPath = () => join3(authRoot(), "auth.lock");
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
    if (existsSync3(authPath()))
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
      if (existsSync3(tmp))
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
var DEFAULT_CONTROL_URL = "https://augenta.ai";
async function augentaOAuthConfig(controlUrl = process.env.AUGENTA_CONTROL_URL || DEFAULT_CONTROL_URL) {
  const response = await fetch(`${controlUrl.replace(/\/+$/, "")}/.well-known/augenta.json`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error("Augenta sign-in is not configured for this environment");
  }
  const value = await response.json();
  if (!value.issuer || !value.clientId || !value.gateway) {
    throw new Error("Augenta returned incomplete sign-in configuration");
  }
  return {
    issuer: value.issuer.replace(/\/+$/, ""),
    clientId: value.clientId,
    gateway: value.gateway.replace(/\/+$/, "")
  };
}
function browserCommand(url) {
  if (process.platform === "darwin")
    return ["open", url];
  if (process.platform === "win32")
    return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}
var pendingLoginPath = () => join3(authRoot(), "pending-login.json");
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
      openBrowser(browserCommand(pending.verificationUri));
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
async function accessTokenForProfile(profileId, forceRefresh = false) {
  return withAuthLock(async () => {
    const store = readAuthStore();
    const profile = store.profiles[profileId];
    if (!profile) {
      throw new ReLoginRequiredError("the Augenta sign-in is missing; run augenta:connect again");
    }
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
async function fetchWithProfile(profileId, url, init = {}) {
  const send = async (forceRefresh) => {
    const accessToken = await accessTokenForProfile(profileId, forceRefresh);
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
  return join3(projectRoot, ".augenta", `${notice}-required`);
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
function takeAuthNotice(projectRoot) {
  let found;
  for (const notice of NOTICES) {
    const path = noticePath(projectRoot, notice);
    if (!existsSync3(path))
      continue;
    found ??= notice;
    try {
      unlinkSync(path);
    } catch {}
  }
  return found;
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
  if (!id)
    return;
  const response = await fetchWithProfile(profileId, `${gateway}/v1/connectors/${encodeURIComponent(id)}`);
  if (response.status === 403 || response.status === 404)
    return;
  if (!response.ok) {
    throw new Error(`could not inspect the existing Connector (${response.status})`);
  }
  return (await response.json()).connector;
}
function environmentLabel(controlUrl) {
  const url = (controlUrl?.trim() || process.env.AUGENTA_CONTROL_URL || DEFAULT_CONTROL_URL).replace(/\/+$/, "");
  return url === DEFAULT_CONTROL_URL ? "prod" : url;
}
function describeError(error) {
  const message = error?.message ?? String(error);
  if (message !== "fetch failed")
    return message;
  const cause = error.cause;
  const code = cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "cannot reach Augenta: the host name did not resolve. Check your network or DNS.";
  }
  if (code === "ECONNREFUSED") {
    return "cannot reach Augenta: the connection was refused. Check the URL, and any proxy or firewall.";
  }
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return "cannot reach Augenta: the TLS certificate could not be verified. Check for a TLS-intercepting proxy.";
  }
  const detail = cause?.message ?? code;
  return detail ? `cannot reach Augenta: ${detail}` : "cannot reach Augenta: the network request failed. Check your connection.";
}

// capture/project.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync4 } from "node:fs";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
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
function resolveProject(args, cwd) {
  if (args.project)
    return { projectRoot: resolve2(cwd, args.project) };
  const top = gitRevParse(cwd, "--show-toplevel");
  if (!top)
    return { projectRoot: cwd };
  const commonDir = gitRevParse(cwd, "--git-common-dir");
  if (commonDir) {
    const mainRoot = dirname2(resolve2(cwd, commonDir));
    if (mainRoot !== top && existsSync4(mainRoot)) {
      return { projectRoot: mainRoot, worktreeRedirect: { from: top, to: mainRoot } };
    }
  }
  return { projectRoot: top };
}
function resolveTargetProject(args, cwd) {
  return resolveProject(args, cwd).projectRoot;
}

// scripts/recall.ts
var DEFAULT_TIMEOUT_SECONDS = 75;
var MAX_QUERY_CHARS = 4096;
function parseArgs(argv) {
  const args = { words: [] };
  const valueFor = (flag, i) => {
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0;i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") {
      args.json = true;
    } else if (flag === "--query") {
      args.query = valueFor(flag, i++);
    } else if (flag === "--workspace") {
      (args.workspaces ??= []).push(valueFor(flag, i++));
    } else if (flag === "--project") {
      args.project = valueFor(flag, i++);
    } else if (flag === "--timeout") {
      const value = Number(valueFor(flag, i++));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--timeout must be a positive number of seconds");
      }
      args.timeoutSeconds = value;
    } else if (flag.startsWith("--")) {
      throw new Error(`unknown flag: ${flag}`);
    } else {
      args.words.push(flag);
    }
  }
  return args;
}
function questionFrom(args) {
  const words = args.words.join(" ").trim();
  const flag = args.query?.trim() ?? "";
  if (flag && words) {
    throw new Error("pass the question with --query or as plain words, not both");
  }
  return flag || words;
}
function errorFields(body, text) {
  const error = body?.error;
  if (error && typeof error === "object") {
    const typed = error;
    return {
      code: typeof typed.code === "string" ? typed.code : undefined,
      message: typeof typed.message === "string" ? typed.message : undefined,
      structured: true
    };
  }
  if (typeof error === "string") {
    const sibling = body.code;
    return {
      code: typeof sibling === "string" ? sibling : undefined,
      message: error,
      structured: true
    };
  }
  const trimmed = text.trim();
  return {
    message: trimmed ? trimmed.slice(0, 400) : undefined,
    structured: false
  };
}
function retryAfterSeconds(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed)
    return;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined;
}
function classifyRecallResponse(parts) {
  const { status, body, text } = parts;
  if (status === 200) {
    const answer = typeof body?.answer === "string" ? body.answer : "";
    if (!answer.trim()) {
      return {
        kind: "failed",
        code: "invalid_response",
        message: "Augenta answered without an answer"
      };
    }
    const scope = body.scope;
    return {
      kind: "answered",
      answer,
      ...typeof scope === "string" ? { scope } : {},
      ...parts.model ? { model: parts.model } : {},
      ...parts.renderer ? { renderer: parts.renderer } : {}
    };
  }
  const { code, message, structured } = errorFields(body, text);
  const say = (fallback) => message ?? fallback;
  if (status === 404) {
    if (code === "empty_scope")
      return { kind: "nothing_remembered" };
    if (!structured) {
      return {
        kind: "failed",
        code: "recall_unavailable",
        message: "recall is not available in this Augenta environment"
      };
    }
    return { kind: "failed", code: code ?? "not_found", message: say("Augenta returned 404") };
  }
  if (status === 401) {
    return {
      kind: "failed",
      code: "need_login",
      message: say("the Augenta sign-in was rejected; sign in again with the connect skill")
    };
  }
  if (status === 403) {
    return {
      kind: "failed",
      code: "not_entitled",
      message: say("this sign-in is not entitled to read that Workspace")
    };
  }
  if (status === 429) {
    return {
      kind: "failed",
      code: "rate_limited",
      message: say("Augenta is rate limiting recall requests"),
      ...retryAfterSeconds(parts.retryAfter) !== undefined ? { retryAfterSeconds: retryAfterSeconds(parts.retryAfter) } : {}
    };
  }
  if (status === 400) {
    return {
      kind: "failed",
      code: code ?? "bad_request",
      message: say("Augenta rejected the recall request")
    };
  }
  if (status >= 500) {
    return {
      kind: "failed",
      code: code ?? "upstream_error",
      message: say(`Augenta returned ${status}`)
    };
  }
  return {
    kind: "failed",
    code: code ?? "unexpected_status",
    message: say(`Augenta returned ${status}`)
  };
}
async function askDestination(ctx, destination) {
  const headers = {
    "content-type": "application/json",
    "idempotency-key": randomUUID2()
  };
  const body = JSON.stringify(destination.workspaceId ? { query: ctx.query, workspace: destination.workspaceId } : { query: ctx.query });
  try {
    const response = ctx.profileId ? await fetchWithProfile(ctx.profileId, ctx.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(ctx.timeoutMs)
    }) : await fetch(ctx.url, {
      method: "POST",
      headers: { ...headers, authorization: `AugentaKey ${ctx.apiKey}` },
      body,
      signal: AbortSignal.timeout(ctx.timeoutMs)
    });
    const text = await response.text().catch(() => "");
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return classifyRecallResponse({
      status: response.status,
      body: parsed,
      text,
      model: response.headers.get("x-augenta-model") ?? undefined,
      renderer: response.headers.get("x-augenta-renderer") ?? undefined,
      retryAfter: response.headers.get("retry-after")
    });
  } catch (error) {
    if (error instanceof ReLoginRequiredError) {
      return { kind: "failed", code: "need_login", message: error.message };
    }
    const name = error?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        kind: "failed",
        code: "recall_timeout",
        message: `Augenta did not answer within ${Math.round(ctx.timeoutMs / 1000)}s`
      };
    }
    return { kind: "failed", code: "network", message: describeError(error) };
  }
}
function aggregateStatus(payload) {
  const { answers, nothingRemembered, failed } = payload;
  const total = answers.length + nothingRemembered.length + failed.length;
  if (total === 0)
    return "error";
  if (answers.length === total)
    return "answered";
  if (nothingRemembered.length === total)
    return "nothing_remembered";
  if (failed.length === total) {
    if (failed.every((f) => f.code === "need_login"))
      return "need_login";
    if (failed.every((f) => f.code === "recall_unavailable"))
      return "recall_unavailable";
    return "error";
  }
  return "partially_answered";
}
function fail(status, code, message, query, environment, startedAt) {
  return {
    status,
    query,
    answers: [],
    nothingRemembered: [],
    failed: [],
    code,
    message,
    environment,
    elapsedMs: Date.now() - startedAt
  };
}
async function resolveDestinations(profileId, gateway, connectorIds) {
  const destinations = [];
  const unresolvedConnectorIds = [];
  const failed = [];
  let needLogin = false;
  const resolved = await Promise.all(connectorIds.map(async (id) => {
    try {
      return { id, link: await currentConnector(profileId, gateway, id) };
    } catch (error) {
      return { id, error };
    }
  }));
  for (const entry of resolved) {
    if ("error" in entry && entry.error !== undefined) {
      if (entry.error instanceof ReLoginRequiredError) {
        needLogin = true;
        continue;
      }
      failed.push({
        connectorId: entry.id,
        code: "network",
        message: describeError(entry.error)
      });
      continue;
    }
    const link = entry.link;
    if (!link) {
      unresolvedConnectorIds.push(entry.id);
      continue;
    }
    destinations.push({ connectorId: link.id, workspaceId: link.workspaceId });
  }
  return { destinations, unresolvedConnectorIds, failed, needLogin };
}
function recallEnvironment(gateway) {
  const label = environmentLabel();
  if (label !== "prod")
    return label;
  return gateway === DEFAULT_GATEWAY ? "prod" : gateway;
}
async function runRecall(resolved, args) {
  const startedAt = Date.now();
  const query = questionFrom(args);
  let environment = recallEnvironment(DEFAULT_GATEWAY);
  if (!query) {
    return fail("error", "query_required", "ask a question: recall takes the text to look up", query, environment, startedAt);
  }
  if (query.length > MAX_QUERY_CHARS) {
    return fail("error", "query_too_long", `the question is ${query.length} characters; Augenta accepts ${MAX_QUERY_CHARS}`, query, environment, startedAt);
  }
  const projectRoot = resolveProjectRoot(resolved.projectRoot);
  if (!projectRoot) {
    return fail("not_connected", "not_connected", "this project is not connected to Augenta; run the connect skill first", query, environment, startedAt);
  }
  const cfg = loadProjectConfig(projectRoot);
  if (!cfg) {
    return fail("not_connected", "unreadable_config", "this project's Augenta config cannot be read; reconnect with the connect skill", query, environment, startedAt);
  }
  const gateway = gatewayBase(cfg);
  environment = recallEnvironment(gateway);
  const answers = [];
  const nothingRemembered = [];
  const failed = [];
  let unresolvedConnectorIds = [];
  let destinations = [];
  let ctx;
  const timeoutMs = (args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const url = `${gateway}/v1/recall`;
  if (cfg.authMode === "oauth") {
    const profileId = cfg.profileId;
    if (!getAuthProfile(profileId)) {
      return fail("need_login", "need_login", "this project's Augenta sign-in is missing; sign in again with the connect skill", query, environment, startedAt);
    }
    const resolution = await resolveDestinations(profileId, gateway, cfg.connectorIds ?? []);
    if (resolution.needLogin) {
      return fail("need_login", "need_login", "this project's Augenta sign-in has expired; sign in again with the connect skill", query, environment, startedAt);
    }
    destinations = resolution.destinations;
    unresolvedConnectorIds = resolution.unresolvedConnectorIds;
    failed.push(...resolution.failed);
    const named = await fetchAllWorkspaces(profileId, gateway).catch(() => []);
    for (const destination of destinations) {
      const name = named.find((workspace) => workspace.id === destination.workspaceId)?.name;
      if (name)
        destination.workspaceName = name;
    }
    if (args.workspaces?.length) {
      const requested = new Set(args.workspaces);
      const unknown = args.workspaces.filter((id) => !destinations.some((destination) => destination.workspaceId === id));
      if (unknown.length > 0) {
        return fail("error", "unknown_workspace", `this project does not feed ${unknown.join(", ")}; recall can only ask the Workspaces it sends to`, query, environment, startedAt);
      }
      destinations = destinations.filter((destination) => destination.workspaceId && requested.has(destination.workspaceId));
    }
    ctx = { url, query, timeoutMs, profileId };
  } else {
    if (args.workspaces?.length) {
      return fail("error", "workspace_not_selectable", "this project uses a platform key, whose Connector fixes the Workspace; --workspace selects nothing", query, environment, startedAt);
    }
    destinations = [{}];
    ctx = { url, query, timeoutMs, apiKey: cfg.apiKey };
  }
  if (destinations.length === 0 && failed.length === 0) {
    return {
      ...fail("error", "no_destination", unresolvedConnectorIds.length > 0 ? `this project lists ${unresolvedConnectorIds.join(", ")}, but ${unresolvedConnectorIds.length === 1 ? "it is" : "they are"} not readable with this sign-in; reconnect` : "this project has no destination to ask; reconnect with the connect skill", query, environment, startedAt),
      ...unresolvedConnectorIds.length > 0 ? { unresolvedConnectorIds } : {}
    };
  }
  const outcomes = await Promise.all(destinations.map(async (destination) => ({
    destination,
    outcome: await askDestination(ctx, destination)
  })));
  for (const { destination, outcome } of outcomes) {
    if (outcome.kind === "answered") {
      const { kind: _answered, ...fields } = outcome;
      answers.push({ ...destination, ...fields });
    } else if (outcome.kind === "nothing_remembered") {
      nothingRemembered.push({ ...destination });
    } else {
      const { kind: _failed, ...fields } = outcome;
      failed.push({ ...destination, ...fields });
    }
  }
  const status = aggregateStatus({ answers, nothingRemembered, failed });
  return {
    status,
    query,
    answers,
    nothingRemembered,
    failed,
    ...unresolvedConnectorIds.length > 0 ? { unresolvedConnectorIds } : {},
    environment,
    elapsedMs: Date.now() - startedAt
  };
}
function printPayload(payload) {
  for (const answer of payload.answers) {
    const label = answer.workspaceName ?? answer.workspaceId ?? "Augenta";
    console.log(`— ${label} —`);
    console.log(answer.answer);
    console.log("");
  }
  for (const entry of payload.nothingRemembered) {
    const label = entry.workspaceName ?? entry.workspaceId ?? "this Workspace";
    console.log(`Nothing remembered yet in ${label}.`);
  }
  for (const entry of payload.failed) {
    const label = entry.workspaceName ?? entry.workspaceId ?? entry.connectorId ?? "Augenta";
    console.error(`Augenta recall: could not ask ${label}: ${entry.message}`);
  }
  if (payload.message && payload.answers.length === 0) {
    console.error(`Augenta recall: ${payload.message}`);
  }
}
if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes("--json");
  try {
    const args = parseArgs(argv);
    const resolved = resolveProject(args, process.cwd());
    const payload = await runRecall(resolved, args);
    const envelope = {
      ...payload,
      projectRoot: resolved.projectRoot,
      ...resolved.worktreeRedirect ? { worktreeRedirect: resolved.worktreeRedirect } : {}
    };
    if (args.json) {
      console.log(JSON.stringify(envelope, null, 2));
    } else {
      printPayload(payload);
    }
    if (payload.status === "error")
      process.exitCode = 1;
  } catch (error) {
    const message = describeError(error);
    if (wantsJson) {
      console.log(JSON.stringify({ status: "error", code: "failed", message }, null, 2));
    } else {
      console.error(`Augenta recall: ${message}`);
    }
    process.exitCode = 1;
  }
}
export {
  runRecall,
  recallEnvironment,
  questionFrom,
  parseArgs,
  classifyRecallResponse,
  aggregateStatus
};
