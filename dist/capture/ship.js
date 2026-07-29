#!/usr/bin/env bun

// runtime/node.ts
import { spawnSync } from "node:child_process";
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
  return Boolean(entry) && fileURLToPath(metaUrl) === entry;
}
function openBrowser(command) {
  spawnSync(command[0], command.slice(1), { stdio: "ignore" });
}

// capture/ship.ts
import { join as join5, dirname as dirname2 } from "node:path";
import { mkdirSync as mkdirSync4, openSync, writeSync, closeSync, unlinkSync as unlinkSync3, statSync as statSync3, appendFileSync as appendFileSync2 } from "node:fs";

// capture/outbox.ts
import { join as join2 } from "node:path";
import { mkdirSync as mkdirSync2, existsSync as existsSync2, readFileSync, writeFileSync as writeFileSync2, appendFileSync, renameSync, statSync, unlinkSync } from "node:fs";

// capture/augenta-dir.ts
import { join } from "node:path";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
function ensureAugentaDir(projectRoot) {
  const dir = join(projectRoot, ".augenta");
  try {
    mkdirSync(dir, { recursive: true, mode: 448 });
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore))
      writeFileSync(ignore, `*
`);
  } catch {}
  return dir;
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
    this.dir = join2(projectRoot, ".augenta", "outbox");
    this.spoolPath = join2(this.dir, "spool.jsonl");
    this.cursorPath = join2(this.dir, "cursor.json");
    this.maxSpoolBytes = opts.maxSpoolBytes ?? MAX_SPOOL_BYTES;
    this.maxDestLagBytes = opts.maxDestLagBytes ?? MAX_DEST_LAG_BYTES;
  }
  ensure() {
    ensureAugentaDir(this.projectRoot);
    mkdirSync2(this.dir, { recursive: true });
  }
  append(records) {
    if (records.length === 0)
      return true;
    this.ensure();
    try {
      if (statSync(this.spoolPath).size >= this.maxSpoolBytes)
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
    this.ensure();
    appendFileSync(this.spoolPath, records.map((r) => JSON.stringify(r)).join(`
`) + `
`);
  }
  dropEpisodePath() {
    return join2(this.dir, "dropped.json");
  }
  markDropped() {
    this.ensure();
    const path = this.dropEpisodePath();
    if (existsSync2(path))
      return false;
    writeFileSync2(path, JSON.stringify({ since: new Date().toISOString() }));
    return true;
  }
  clearDropEpisode() {
    try {
      unlinkSync(this.dropEpisodePath());
    } catch {}
  }
  discardNoticePath() {
    return join2(this.dir, "discarded.json");
  }
  markDiscarded(entries) {
    if (entries.length === 0)
      return;
    this.ensure();
    try {
      writeFileSync2(this.discardNoticePath(), JSON.stringify({ at: new Date().toISOString(), destinations: entries }));
    } catch {}
  }
  takeDiscarded() {
    const path = this.discardNoticePath();
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      unlinkSync(path);
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
      raw = JSON.parse(readFileSync(this.cursorPath, "utf8"));
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
    writeFileSync2(tmp, JSON.stringify(body));
    renameSync(tmp, this.cursorPath);
  }
  shippedOffset(destKey) {
    const { shipped, links } = this.readCursor();
    const stored = destKey === undefined || !links ? shipped : links[destKey] ?? 0;
    return stored > this.spoolEnd() ? 0 : stored;
  }
  spoolEnd() {
    try {
      return statSync(this.spoolPath).size;
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
      return statSync(this.spoolPath).size > this.shippedOffset();
    } catch {
      return false;
    }
  }
  readPending(maxBatch = Infinity, destKey) {
    const shipped = this.shippedOffset(destKey);
    if (!existsSync2(this.spoolPath))
      return { records: [], endOffset: shipped, hasMore: false };
    const buf = readFileSync(this.spoolPath);
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
    if (!existsSync2(this.spoolPath))
      return;
    let size;
    try {
      size = statSync(this.spoolPath).size;
    } catch {
      return;
    }
    if (size > 0 && this.shippedOffset() >= size) {
      const archivePath = this.spoolPath + ".archive";
      try {
        renameSync(this.spoolPath, archivePath);
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
        unlinkSync(archivePath);
      } catch {}
    }
  }
}

// capture/config.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { dirname, join as join3 } from "node:path";
var DEFAULT_GATEWAY = "https://apim-aug-platform-prod-utyom2a4bdhti.azure-api.net";
function parseNeurolinkIds(value) {
  const raw = Array.isArray(value.neurolinkIds) ? value.neurolinkIds : typeof value.neurolinkId === "string" ? [value.neurolinkId] : [];
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
  return join3(projectRoot, ".augenta", "config.json");
}
function resolveProjectRoot(cwd) {
  if (!cwd)
    return;
  let dir = cwd;
  for (let i = 0;i < 30; i++) {
    if (existsSync3(configPath(dir)))
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
    const value = JSON.parse(readFileSync2(configPath(projectRoot), "utf8"));
    const endpoint = typeof value.endpoint === "string" && value.endpoint.trim() ? value.endpoint.trim() : undefined;
    if (value.authMode === "oauth") {
      const profileId = typeof value.profileId === "string" ? value.profileId.trim() : "";
      const neurolinkIds = parseNeurolinkIds(value);
      if (!profileId || neurolinkIds.length === 0)
        return;
      return {
        authMode: "oauth",
        profileId,
        neurolinkIds,
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
  return cfg.authMode === "oauth" ? Boolean(cfg.profileId) && (cfg.neurolinkIds?.length ?? 0) > 0 : Boolean(cfg.apiKey);
}

// capture/auth.ts
import {
  chmodSync,
  existsSync as existsSync4,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync3,
  renameSync as renameSync2,
  statSync as statSync2,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync3
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join as join4 } from "node:path";
class ReLoginRequiredError extends Error {
  reason;
  constructor(message, reason) {
    super(message);
    this.name = "ReLoginRequiredError";
    this.reason = reason;
  }
}
var authRoot = () => process.env.AUGENTA_AUTH_HOME || join4(homedir(), ".augenta");
var authPath = () => join4(authRoot(), "auth.json");
var lockPath = () => join4(authRoot(), "auth.lock");
var LOCK_WAIT_MS = 1e4;
var STALE_LOCK_MS = 30000;
var REQUEST_TIMEOUT_MS = 15000;
function ensureAuthRoot() {
  mkdirSync3(authRoot(), { recursive: true, mode: 448 });
  chmodSync(authRoot(), 448);
}
function readAuthStore() {
  try {
    ensureAuthRoot();
    if (existsSync4(authPath()))
      chmodSync(authPath(), 384);
    const parsed = JSON.parse(readFileSync3(authPath(), "utf8"));
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
    writeFileSync3(tmp, `${JSON.stringify(store, null, 2)}
`, {
      mode: 384,
      flag: "wx"
    });
    chmodSync(tmp, 384);
    renameSync2(tmp, path);
    chmodSync(path, 384);
  } finally {
    try {
      if (existsSync4(tmp))
        unlinkSync2(tmp);
    } catch {}
  }
}
async function withAuthLock(fn) {
  ensureAuthRoot();
  const lock = lockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      writeFileSync3(lock, String(process.pid), { flag: "wx", mode: 384 });
      break;
    } catch {
      try {
        if (Date.now() - statSync2(lock).mtimeMs > STALE_LOCK_MS)
          unlinkSync2(lock);
      } catch {}
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
      unlinkSync2(lock);
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
var pendingLoginPath = () => join4(authRoot(), "pending-login.json");
function savePendingLogin(pending) {
  ensureAuthRoot();
  const path = pendingLoginPath();
  writeFileSync3(path, `${JSON.stringify(pending, null, 2)}
`, { mode: 384 });
  chmodSync(path, 384);
}
function readPendingLogin() {
  try {
    const parsed = JSON.parse(readFileSync3(pendingLoginPath(), "utf8"));
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
    unlinkSync2(pendingLoginPath());
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
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(intervalMs, deadline - Date.now()))));
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
var NOTICES = ["relogin", "connect"];
function noticePath(projectRoot, notice) {
  return join4(projectRoot, ".augenta", `${notice}-required`);
}
function markAuthNotice(projectRoot, notice) {
  try {
    ensureAugentaDir(projectRoot);
    writeFileSync3(noticePath(projectRoot, notice), `${notice}
`, {
      mode: 384
    });
  } catch {}
}
function takeAuthNotice(projectRoot) {
  let found;
  for (const notice of NOTICES) {
    const path = noticePath(projectRoot, notice);
    if (!existsSync4(path))
      continue;
    found ??= notice;
    try {
      unlinkSync2(path);
    } catch {}
  }
  return found;
}

// capture/sanitize.ts
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
function sanitizeTelemetryValue(value) {
  if (Array.isArray(value))
    return value.map(sanitizeTelemetryValue);
  if (!value || typeof value !== "object")
    return value;
  const sanitized = [];
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (isOpaqueKey(key))
      continue;
    const sanitizedChild = sanitizeTelemetryValue(child);
    if ((normalized === "thinking" || normalized === "reasoning") && isEmptyReasoningValue(sanitizedChild))
      continue;
    sanitized.push([key, sanitizedChild]);
  }
  return Object.fromEntries(sanitized);
}
function sanitizeTelemetryRecord(raw) {
  try {
    const value = sanitizeTelemetryValue(JSON.parse(raw));
    const json = JSON.stringify(value);
    return json === undefined ? undefined : { value, json };
  } catch {
    return;
  }
}
function sanitizeTelemetryJsonl(raw) {
  return sanitizeTelemetryRecord(raw)?.json;
}

// capture/ship.ts
var MAX_EXPERIENCE_BYTES = 512 * 1024;
var MAX_BODY_BYTES = 1024 * 1024;
function jsonBytes(x) {
  return Buffer.byteLength(JSON.stringify(x), "utf8");
}
var TRUNCATION_MARKER = " …[augenta: step text truncated — exceeded the single-envelope wire cap]";
function truncateEventText(e, budget) {
  let lo = 0;
  let hi = e.text.length;
  let best = { ...e, text: TRUNCATION_MARKER.trimStart() };
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    const candidate = { ...e, text: e.text.slice(0, mid) + TRUNCATION_MARKER };
    if (jsonBytes(candidate) <= budget) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
function groupIntoExperiences(records) {
  const groups = new Map;
  const experiences = [];
  for (const r of records) {
    if (isDocumentRecord(r)) {
      experiences.push(r);
      continue;
    }
    const turn = typeof r.turn === "number" && r.turn >= 0 ? r.turn : 0;
    const key = `${r.src} ${r.sid} ${r.proj} ${turn}`;
    let g = groups.get(key);
    if (!g) {
      g = { src: r.src, sid: r.sid, proj: r.proj, type: "trajectory", events: [] };
      groups.set(key, g);
      experiences.push(g);
    }
    if (isRawRecord(r)) {
      const raw = sanitizeTelemetryJsonl(r.raw);
      if (raw !== undefined)
        (g.data ??= []).push(raw);
    } else
      g.events.push(r);
  }
  return experiences.filter((experience) => experience.type === "doc" || experience.events.length > 0);
}
function rawDropMarker(kept, total) {
  return `[augenta: ${total - kept} of ${total} raw line(s) dropped — envelope exceeded the single-envelope wire cap]`;
}
function boundRawData(eventsOnly, data) {
  if (!data || data.length === 0)
    return eventsOnly;
  const base = jsonBytes({ ...eventsOnly, data: [] });
  const markerCost = jsonBytes(rawDropMarker(0, data.length)) + 1;
  const budget = MAX_EXPERIENCE_BYTES - base - markerCost;
  if (budget < 0)
    return eventsOnly;
  const kept = [];
  let bytes = 0;
  for (const line of data) {
    const cost = jsonBytes(line) + 1;
    if (bytes + cost > budget)
      break;
    kept.push(line);
    bytes += cost;
  }
  if (kept.length === data.length)
    return { ...eventsOnly, data: kept };
  return { ...eventsOnly, data: [...kept, rawDropMarker(kept.length, data.length)] };
}
var DOCUMENT_TRUNCATION_MARKER = " …[augenta: document text truncated — exceeded the single-envelope wire cap]";
function boundDocumentExperience(exp) {
  if (jsonBytes(exp) <= MAX_EXPERIENCE_BYTES)
    return [exp];
  let lo = 0;
  let hi = exp.data.text.length;
  let best;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    const end = mid > 0 && mid < exp.data.text.length && /[\uD800-\uDBFF]/.test(exp.data.text[mid - 1]) && /[\uDC00-\uDFFF]/.test(exp.data.text[mid]) ? mid - 1 : mid;
    const candidate = {
      ...exp,
      data: { ...exp.data, text: exp.data.text.slice(0, end) + DOCUMENT_TRUNCATION_MARKER }
    };
    if (jsonBytes(candidate) <= MAX_EXPERIENCE_BYTES) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best ? [best] : [];
}
function boundExperienceSize(exp) {
  if (exp.type === "doc")
    return boundDocumentExperience(exp);
  if (jsonBytes(exp) <= MAX_EXPERIENCE_BYTES)
    return [exp];
  const { data, ...eventsOnly } = exp;
  if (jsonBytes(eventsOnly) <= MAX_EXPERIENCE_BYTES)
    return [boundRawData(eventsOnly, data)];
  const base = jsonBytes({ ...eventsOnly, events: [] });
  const out = [];
  let chunk = [];
  let chunkBytes = base;
  for (const step of eventsOnly.events) {
    let bounded = step;
    let cost = jsonBytes(bounded) + 1;
    if (base + cost > MAX_EXPERIENCE_BYTES) {
      bounded = truncateEventText(step, MAX_EXPERIENCE_BYTES - base - 1);
      cost = jsonBytes(bounded) + 1;
    }
    if (chunk.length > 0 && chunkBytes + cost > MAX_EXPERIENCE_BYTES) {
      out.push({ ...eventsOnly, events: chunk });
      chunk = [];
      chunkBytes = base;
    }
    chunk.push(bounded);
    chunkBytes += cost;
  }
  if (chunk.length > 0)
    out.push({ ...eventsOnly, events: chunk });
  return out;
}
function packBodies(experiences) {
  const wrapper = jsonBytes({ experiences: [] });
  const bodies = [];
  let cur = [];
  let bytes = wrapper;
  for (const x of experiences) {
    const cost = jsonBytes(x) + 1;
    if (cur.length > 0 && bytes + cost > MAX_BODY_BYTES) {
      bodies.push(cur);
      cur = [];
      bytes = wrapper;
    }
    cur.push(x);
    bytes += cost;
  }
  if (cur.length > 0)
    bodies.push(cur);
  return bodies;
}
var MAX_ERR_TEXT_CHARS = 2048;
async function postExperiences(url, token, experiences, neurolinkId, authMode = "api-key") {
  if (authMode === "oauth" && !neurolinkId) {
    throw new Error("shipping with an Augenta sign-in requires a Neurolink id");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...token ? authMode === "oauth" ? {
        authorization: `Bearer ${token}`,
        ...neurolinkId ? { "x-augenta-neurolink-id": neurolinkId } : {}
      } : { authorization: `AugentaKey ${token}` } : {}
    },
    body: JSON.stringify({ experiences }),
    signal: AbortSignal.timeout(1e4)
  });
  if (res.status >= 200 && res.status < 300)
    return { status: res.status };
  const errText = await res.text().catch(() => "");
  return { status: res.status, errText: errText.slice(0, MAX_ERR_TEXT_CHARS) };
}
var PERMANENT_STATUSES = new Set([400, 413, 422]);
var MAX_REJECTED_BYTES = 10 * 1024 * 1024;
function rejectedPath(projectRoot) {
  return join5(projectRoot, ".augenta", "outbox", "rejected.jsonl");
}
function appendRejected(projectRoot, entries) {
  if (entries.length === 0)
    return;
  const path = rejectedPath(projectRoot);
  mkdirSync4(dirname2(path), { recursive: true });
  try {
    if (statSync3(path).size >= MAX_REJECTED_BYTES)
      return;
  } catch {}
  appendFileSync2(path, entries.map((e) => JSON.stringify(e)).join(`
`) + `
`);
}
function shippingNotice(authMode, status) {
  if (authMode === "oauth" && status === 401)
    return "relogin";
  if (status === 403 || status === 404 || authMode === "api-key" && status === 401) {
    return "connect";
  }
  return;
}
async function drain(opts) {
  const box = new Outbox(opts.projectRoot);
  const maxBatch = opts.maxBatch ?? 200;
  const maxBatches = opts.maxBatches ?? 50;
  let shipped = 0;
  let batches = 0;
  let lastStatus = 0;
  for (let i = 0;i < maxBatches; i++) {
    const pending = box.readPending(maxBatch, opts.neurolinkId);
    if (pending.records.length === 0)
      break;
    const experiences = groupIntoExperiences(pending.records).flatMap(boundExperienceSize);
    if (experiences.length === 0) {
      box.advance(pending.endOffset, opts.neurolinkId);
      shipped += pending.records.length;
      if (!pending.hasMore)
        break;
      continue;
    }
    let sliceOk = true;
    const quarantineBatch = [];
    try {
      for (const body of packBodies(experiences)) {
        const res = await postExperiences(opts.url, opts.token, body, opts.neurolinkId, opts.authMode);
        lastStatus = res.status;
        if (lastStatus >= 200 && lastStatus < 300) {
          batches += 1;
          continue;
        }
        if (PERMANENT_STATUSES.has(lastStatus)) {
          quarantineBatch.push({
            ts: new Date().toISOString(),
            status: lastStatus,
            ...res.errText ? { error: res.errText } : {},
            ...opts.neurolinkId ? { destination: opts.neurolinkId } : {},
            experiences: body
          });
          continue;
        }
        sliceOk = false;
        break;
      }
    } catch {
      lastStatus = 0;
      break;
    }
    if (!sliceOk)
      break;
    if (quarantineBatch.length > 0)
      appendRejected(opts.projectRoot, quarantineBatch);
    box.advance(pending.endOffset, opts.neurolinkId);
    shipped += pending.records.length;
    if (!pending.hasMore)
      break;
  }
  if (shipped > 0) {
    box.compact();
    if (!box.hasPendingBytes())
      box.clearDropEpisode();
  }
  return { shipped, batches, lastStatus };
}
function fanOutNotice(authMode, statuses) {
  let connect = false;
  for (const status of statuses) {
    const notice = shippingNotice(authMode, status);
    if (notice === "relogin")
      return "relogin";
    if (notice === "connect")
      connect = true;
  }
  return connect ? "connect" : undefined;
}
async function drainAll(opts) {
  const box = new Outbox(opts.projectRoot, {
    ...opts.maxDestLagBytes !== undefined ? { maxDestLagBytes: opts.maxDestLagBytes } : {}
  });
  const keys = [...new Set(opts.neurolinkIds)];
  const byDestination = new Map;
  if (keys.length === 0)
    return { byDestination, derelict: [] };
  const named = keys.filter((key) => Boolean(key));
  if (named.length > 0 && named.length !== keys.length) {
    throw new Error("drainAll: neurolinkIds must be either all Neurolink ids or exactly [undefined]");
  }
  if (named.length === keys.length)
    box.registerDestinations(named);
  const maxBatches = Math.max(1, Math.floor(50 / keys.length));
  let token = await opts.token();
  let refreshed = false;
  for (const key of keys) {
    const drainOne = (bearer) => drain({
      url: opts.url,
      token: bearer,
      ...key ? { neurolinkId: key } : {},
      authMode: opts.authMode,
      projectRoot: opts.projectRoot,
      ...opts.maxBatch !== undefined ? { maxBatch: opts.maxBatch } : {},
      maxBatches
    });
    try {
      let result = await drainOne(token);
      if (opts.authMode === "oauth" && result.lastStatus === 401 && !refreshed) {
        refreshed = true;
        token = await opts.token(true);
        result = await drainOne(token);
      }
      byDestination.set(key ?? "", result);
    } catch (error) {
      byDestination.set(key ?? "", { shipped: 0, batches: 0, lastStatus: 0 });
      if (error instanceof ReLoginRequiredError)
        markAuthNotice(opts.projectRoot, "relogin");
    }
  }
  const progressed = [...byDestination].filter(([, result]) => result.shipped > 0).map(([key]) => key);
  const derelict = box.enforceLag(progressed);
  if (derelict.length > 0) {
    appendRejected(opts.projectRoot, derelict.map(({ destKey, from, to }) => ({
      ts: new Date().toISOString(),
      status: 0,
      destination: destKey,
      reason: "destination_lag",
      error: `discarded unshipped spool bytes ${from}..${to} — this destination fell more than the per-destination lag cap behind its peers`,
      experiences: []
    })));
    box.markDiscarded(derelict);
  }
  box.compact();
  if (!box.hasPendingBytes())
    box.clearDropEpisode();
  return { byDestination, derelict };
}
var STALE_LOCK_MS2 = 60000;
function lockPath2(projectRoot) {
  return join5(projectRoot, ".augenta", "outbox", ".lock");
}
function acquireLock(projectRoot) {
  const lock = lockPath2(projectRoot);
  mkdirSync4(dirname2(lock), { recursive: true });
  try {
    const fd = openSync(lock, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    try {
      if (Date.now() - statSync3(lock).mtimeMs > STALE_LOCK_MS2) {
        unlinkSync3(lock);
        return acquireLock(projectRoot);
      }
    } catch {}
    return false;
  }
}
function releaseLock(projectRoot) {
  try {
    unlinkSync3(lockPath2(projectRoot));
  } catch {}
}
if (isMain(import.meta.url)) {
  const projectRoot = process.argv[2];
  const cfg = projectRoot ? loadProjectConfig(projectRoot) : undefined;
  if (cfg && captureEnabled(cfg) && acquireLock(cfg.projectRoot)) {
    try {
      const result = await drainAll({
        projectRoot: cfg.projectRoot,
        url: experiencesUrl(cfg),
        authMode: cfg.authMode,
        neurolinkIds: cfg.authMode === "oauth" ? cfg.neurolinkIds : [undefined],
        token: (refresh) => cfg.authMode === "oauth" ? accessTokenForProfile(cfg.profileId, refresh) : Promise.resolve(cfg.apiKey)
      });
      const notice = fanOutNotice(cfg.authMode, [...result.byDestination.values()].map((r) => r.lastStatus));
      if (notice)
        markAuthNotice(cfg.projectRoot, notice);
    } catch (error) {
      if (error instanceof ReLoginRequiredError) {
        markAuthNotice(cfg.projectRoot, "relogin");
      }
    } finally {
      releaseLock(cfg.projectRoot);
    }
  }
  process.exit(0);
}
export {
  shippingNotice,
  releaseLock,
  postExperiences,
  packBodies,
  groupIntoExperiences,
  fanOutNotice,
  drainAll,
  drain,
  boundRawData,
  boundExperienceSize,
  acquireLock,
  TRUNCATION_MARKER,
  MAX_REJECTED_BYTES,
  MAX_EXPERIENCE_BYTES,
  MAX_BODY_BYTES,
  DOCUMENT_TRUNCATION_MARKER
};
