#!/usr/bin/env bun

// scripts/connect.ts
import { execFileSync } from "node:child_process";
import { chmodSync as chmodSync2, existsSync as existsSync5, writeFileSync as writeFileSync4 } from "node:fs";
import { basename, dirname as dirname2, join as join5, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

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

// capture/config.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
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
  return join2(projectRoot, ".augenta", "config.json");
}
function resolveProjectRoot(cwd) {
  if (!cwd)
    return;
  let dir = cwd;
  for (let i = 0;i < 30; i++) {
    if (existsSync2(configPath(dir)))
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

// capture/outbox.ts
import { join as join3 } from "node:path";
import { mkdirSync as mkdirSync2, existsSync as existsSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2, appendFileSync, renameSync, statSync, unlinkSync } from "node:fs";
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
    this.dir = join3(projectRoot, ".augenta", "outbox");
    this.spoolPath = join3(this.dir, "spool.jsonl");
    this.cursorPath = join3(this.dir, "cursor.json");
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
    return join3(this.dir, "dropped.json");
  }
  markDropped() {
    this.ensure();
    const path = this.dropEpisodePath();
    if (existsSync3(path))
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
    return join3(this.dir, "discarded.json");
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
      const parsed = JSON.parse(readFileSync2(path, "utf8"));
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
      raw = JSON.parse(readFileSync2(this.cursorPath, "utf8"));
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
    if (!existsSync3(this.spoolPath))
      return { records: [], endOffset: shipped, hasMore: false };
    const buf = readFileSync2(this.spoolPath);
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
    if (!existsSync3(this.spoolPath))
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

// scripts/connect.ts
var DEFAULT_WAIT_SECONDS = 90;
var PLUGIN_VERSION = "0.6.1";

class AugentaRequestError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "AugentaRequestError";
  }
}
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
    if (flag === "--api-key") {
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
    } else if (flag === "--neurospace") {
      (args.neurospaces ??= []).push(valueFor(flag, i++));
    } else if (flag === "--profile") {
      args.profile = valueFor(flag, i++);
    } else if (flag === "--wait") {
      const value = Number(valueFor(flag, i++));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--wait must be a positive number of seconds");
      }
      args.waitSeconds = value;
    } else if (flag === "--json") {
      args.json = true;
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
    return { projectRoot: resolve(cwd, args.project) };
  const top = gitRevParse(cwd, "--show-toplevel");
  if (!top)
    return { projectRoot: cwd };
  const commonDir = gitRevParse(cwd, "--git-common-dir");
  if (commonDir) {
    const mainRoot = dirname2(resolve(cwd, commonDir));
    if (mainRoot !== top && existsSync5(mainRoot)) {
      return { projectRoot: mainRoot, worktreeRedirect: { from: top, to: mainRoot } };
    }
  }
  return { projectRoot: top };
}
function resolveTargetProject(args, cwd) {
  return resolveProject(args, cwd).projectRoot;
}
function writeApiKeyConfig(projectRoot, apiKey, endpoint2) {
  const dir = ensureAugentaDir(projectRoot);
  const path = join5(dir, "config.json");
  writeFileSync4(path, `${JSON.stringify({
    authMode: "api-key",
    apiKey,
    ...endpoint2 ? { endpoint: endpoint2 } : {}
  }, null, 2)}
`, { mode: 384 });
  chmodSync2(path, 384);
  return path;
}
function writeOAuthConfig(projectRoot, profileId, neurolinkIds, endpoint2) {
  const dir = ensureAugentaDir(projectRoot);
  const path = join5(dir, "config.json");
  writeFileSync4(path, `${JSON.stringify({
    authMode: "oauth",
    profileId,
    neurolinkIds: [...neurolinkIds],
    ...endpoint2 ? { endpoint: endpoint2 } : {}
  }, null, 2)}
`, { mode: 384 });
  chmodSync2(path, 384);
  return path;
}
function detectedHarness(args) {
  return args.harness ?? (process.env.CODEX_SANDBOX || process.env.CODEX_HOME ? "codex" : "claude-code");
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
      const answer = await rl.question(`Selection (comma-separated, e.g. 1,3 — empty to select nothing) [1-${values.length}]: `);
      if (!answer.trim())
        return [];
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
    throw new Error("no valid Neurospace selection was given");
  } finally {
    rl.close();
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
async function listNeurospaces(profileId, gateway) {
  const { neurospaces } = await bearerJson(profileId, `${gateway}/v1/neurospaces`);
  if (neurospaces.length === 0) {
    throw new Error("the authenticated organization has no active Neurospaces");
  }
  return neurospaces;
}
async function selectedNeurospaces(profileId, gateway, preselectedIds = [], available) {
  return chooseMany("Choose every Neurospace this project should feed (each one receives the full record):", [...available ?? await listNeurospaces(profileId, gateway)], (neurospace) => `${neurospace.name} (${neurospace.id})`, { preselected: (neurospace) => preselectedIds.includes(neurospace.id) });
}
async function currentNeurolink(profileId, gateway, id) {
  if (!id)
    return;
  const response = await fetchWithProfile(profileId, `${gateway}/v1/neurolinks/${encodeURIComponent(id)}`);
  if (response.status === 403 || response.status === 404)
    return;
  if (!response.ok) {
    throw new Error(`could not inspect the existing Neurolink (${response.status})`);
  }
  return (await response.json()).neurolink;
}
async function priorLinks(profileId, gateway, ids) {
  const links = [];
  for (const id of ids) {
    const link = await currentNeurolink(profileId, gateway, id).catch(() => {
      return;
    });
    if (link)
      links.push(link);
  }
  return links;
}
async function linkForNeurospace(projectRoot, args, profileId, gateway, neurospace, adoptable) {
  const name = basename(projectRoot);
  const fields = {
    neurospaceId: neurospace.id,
    kind: "agent",
    direction: "inbound",
    name,
    projectName: name,
    harness: detectedHarness(args),
    client: "augenta-plugin",
    description: `Agent activity and project memory from ${name}`,
    metadata: { pluginVersion: PLUGIN_VERSION }
  };
  const existing = adoptable.find((link) => link.kind === "agent" && link.status === "active" && link.neurospaceId === neurospace.id);
  if (existing) {
    const { kind: _kind, neurospaceId: _neurospaceId, ...mutableFields } = fields;
    const neurolink2 = (await bearerJson(profileId, `${gateway}/v1/neurolinks/${encodeURIComponent(existing.id)}`, {
      method: "PATCH",
      headers: {
        ...existing._etag ? { "if-match": existing._etag } : {}
      },
      body: JSON.stringify({ ...mutableFields, _etag: existing._etag })
    })).neurolink;
    return { neurolink: neurolink2, action: "adopted" };
  }
  const neurolink = (await bearerJson(profileId, `${gateway}/v1/neurolinks`, { method: "POST", body: JSON.stringify(fields) })).neurolink;
  return { neurolink, action: "created" };
}
async function resolveOAuth(args) {
  const discovered = await augentaOAuthConfig(args.controlUrl);
  const gateway = (args.endpoint?.trim() || discovered.gateway).replace(/\/+$/, "");
  return { oauth: { ...discovered, gateway }, gateway };
}
function priorConnection(projectRoot) {
  if (!existsSync5(join5(projectRoot, ".augenta", "config.json")))
    return;
  try {
    const existing = loadProjectConfig(projectRoot);
    return existing?.authMode === "oauth" ? { profileId: existing.profileId, neurolinkIds: existing.neurolinkIds } : undefined;
  } catch {
    return;
  }
}
async function establishNeurolinks(projectRoot, args, profileId, gateway, neurospaces, priorNeurolinkIds, available = neurospaces, preresolved) {
  const adoptable = preresolved ?? await priorLinks(profileId, gateway, priorNeurolinkIds);
  const unresolvedNeurolinkIds = priorNeurolinkIds.filter((id) => !adoptable.some((link) => link.id === id));
  const priorNeurospaceIds = adoptable.map((link) => link.neurospaceId);
  const results = [];
  for (const neurospace of neurospaces) {
    try {
      const { neurolink, action } = await linkForNeurospace(projectRoot, args, profileId, gateway, neurospace, adoptable);
      const verified = await bearerJson(profileId, `${gateway}/v1/neurolinks/${encodeURIComponent(neurolink.id)}`);
      if (verified.neurolink.status !== "active" || verified.neurolink.neurospaceId !== neurospace.id) {
        throw new Error("Neurolink verification failed");
      }
      results.push({
        neurospaceId: neurospace.id,
        neurospaceName: neurospace.name,
        neurolinkId: verified.neurolink.id,
        action
      });
    } catch (error) {
      results.push({
        neurospaceId: neurospace.id,
        neurospaceName: neurospace.name,
        message: error instanceof Error ? error.message : String(error),
        ...priorNeurospaceIds.includes(neurospace.id) ? { wasConnected: true } : {}
      });
    }
  }
  const verifiedIds = results.map((result) => result.neurolinkId).filter((id) => Boolean(id));
  const selectedIds = neurospaces.map((neurospace) => neurospace.id);
  const nameFor = (id) => available.find((neurospace) => neurospace.id === id)?.name;
  const removed = adoptable.filter((link) => !selectedIds.includes(link.neurospaceId)).map((link) => {
    const name = nameFor(link.neurospaceId);
    return {
      neurolinkId: link.id,
      neurospaceId: link.neurospaceId,
      ...name ? { neurospaceName: name } : {},
      disposition: "left_in_place"
    };
  });
  if (verifiedIds.length === 0)
    return { results, removed, unresolvedNeurolinkIds };
  const configPath2 = writeOAuthConfig(projectRoot, profileId, verifiedIds, gateway === DEFAULT_GATEWAY ? undefined : gateway);
  try {
    const freshKeys = results.filter((result) => result.action === "created" && result.neurolinkId).map((result) => result.neurolinkId);
    new Outbox(projectRoot).registerDestinations(verifiedIds, { freshKeys });
  } catch {}
  return { results, removed, unresolvedNeurolinkIds, configPath: configPath2 };
}
async function connectProject(projectRoot, args) {
  const { oauth, gateway } = await resolveOAuth(args);
  const prior = priorConnection(projectRoot);
  const selected = await selectOrCreateProfile(oauth, prior?.profileId);
  console.log(`Signed in as ${selected.me.user.name || selected.me.user.email} to ${selected.me.org.name} (${selected.me.org.id}).`);
  const priorIds = prior?.neurolinkIds ?? [];
  const resolvedPrior = await priorLinks(selected.profileId, gateway, priorIds);
  const available = await listNeurospaces(selected.profileId, gateway);
  const environment = environmentLabel(args);
  console.log("Every Neurospace you select receives the FULL record — this project's agent activity, its raw transcript lines (structurally sanitized, but NOT secret-scrubbed), and its project memory, complete, in each.");
  console.log("So anyone with access to ANY Neurospace you select can read this project's captured activity: the audience is the union of all of them.");
  if (environment !== "prod") {
    console.log(`This is the ${environment} environment, not production.`);
  }
  const neurospaces = await selectedNeurospaces(selected.profileId, gateway, resolvedPrior.map((link) => link.neurospaceId), available);
  if (neurospaces.length === 0) {
    if (priorIds.length > 0) {
      const current = resolvedPrior.map((link) => {
        const name = available.find((n) => n.id === link.neurospaceId)?.name;
        return name ?? link.neurospaceId;
      }).join(", ");
      console.log(`Nothing changed. This project still feeds ${current || "its existing destinations"}. To stop capture entirely, delete ${configPath(projectRoot)}.`);
    } else {
      console.log("Nothing connected. No config was written.");
    }
    return;
  }
  const { results, removed, unresolvedNeurolinkIds, configPath: written } = await establishNeurolinks(projectRoot, args, selected.profileId, gateway, neurospaces, priorIds, available, resolvedPrior);
  const live = results.filter((result) => result.neurolinkId);
  const failed = results.filter((result) => !result.neurolinkId);
  if (live.length > 0) {
    console.log(`Wrote ${written} (0600). This project now feeds ${live.map((result) => `${result.neurospaceName} (Neurolink ${result.neurolinkId})`).join(", ")}.`);
    if (live.length > 1) {
      console.log("Each of those receives the full record, so the audience is the union of everyone with access to any of them.");
    }
  } else {
    console.log("No destination could be linked. No config was written.");
  }
  for (const result of failed) {
    console.log(result.wasConnected ? `Could not link ${result.neurospaceName}, which this project WAS feeding: ${result.message}. It has been dropped — re-run connect to restore it.` : `Could not link ${result.neurospaceName}: ${result.message}`);
  }
  if (written) {
    for (const entry of removed) {
      console.log(`No longer sending to ${entry.neurospaceName ?? entry.neurospaceId}. Its Neurolink ${entry.neurolinkId} is left in place and idle — remove it in Augenta if you want it gone.`);
    }
    if (unresolvedNeurolinkIds.length > 0) {
      console.log(`Dropped ${unresolvedNeurolinkIds.join(", ")}: this project listed ${unresolvedNeurolinkIds.length === 1 ? "that Neurolink" : "those Neurolinks"} but ${unresolvedNeurolinkIds.length === 1 ? "it is" : "they are"} no longer readable with this sign-in.`);
    }
  }
}
function environmentLabel(args) {
  const url = (args.controlUrl?.trim() || process.env.AUGENTA_CONTROL_URL || DEFAULT_CONTROL_URL).replace(/\/+$/, "");
  return url === DEFAULT_CONTROL_URL ? "prod" : url;
}
function secondsUntil(timestamp) {
  return Math.max(0, Math.round((timestamp - Date.now()) / 1000));
}
async function neurospaceStep(profileId, gateway, me) {
  const neurospaces = await listNeurospaces(profileId, gateway);
  return {
    status: "need_neurospace",
    profileId,
    signedInAs: {
      name: me.user.name || me.user.email,
      email: me.user.email,
      organization: me.org.name
    },
    neurospaces: neurospaces.map(({ id, name }) => ({ id, name }))
  };
}
async function priorDestinations(profileId, gateway, ids, neurospaces) {
  const destinations = [];
  const unresolvedNeurolinkIds = [];
  for (const id of ids) {
    const link = await currentNeurolink(profileId, gateway, id).catch(() => {
      return;
    });
    if (!link) {
      unresolvedNeurolinkIds.push(id);
      continue;
    }
    const name = neurospaces.find((n) => n.id === link.neurospaceId)?.name;
    destinations.push({
      neurolinkId: link.id,
      neurospaceId: link.neurospaceId,
      ...name ? { neurospaceName: name } : {}
    });
  }
  return { destinations, unresolvedNeurolinkIds };
}
async function probeConnection(resolved, args) {
  const { oauth, gateway } = await resolveOAuth(args);
  const prior = priorConnection(resolved.projectRoot);
  const priorIds = prior?.neurolinkIds ?? [];
  const alreadyConnected = { alreadyConnected: priorIds.length > 0 };
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
  const step = await neurospaceStep(usable[0].profileId, gateway, usable[0].me);
  return {
    ...step,
    ...alreadyConnected,
    ...await priorDestinations(usable[0].profileId, gateway, priorIds, step.neurospaces)
  };
}
async function startLogin(args) {
  const { oauth } = await resolveOAuth(args);
  const pending = await beginDeviceLogin(oauth);
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
  if (pending.issuer !== oauth.issuer || pending.clientId !== oauth.clientId) {
    clearPendingLogin();
    return {
      status: "error",
      code: "no_pending_login",
      message: "the pending sign-in belongs to a different Augenta environment; start a new one with --login"
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
    return neurospaceStep(profileId, gateway, me);
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
async function connectToNeurospaces(resolved, args) {
  const { oauth, gateway } = await resolveOAuth(args);
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
  const available = await listNeurospaces(picked.profileId, gateway);
  const requested = [...new Set(args.neurospaces ?? [])];
  const unknown = requested.filter((id) => !available.some((item) => item.id === id));
  if (unknown.length > 0) {
    return {
      status: "error",
      code: "unknown_neurospace",
      unknown,
      message: `${unknown.join(", ")} ${unknown.length === 1 ? "is not an active Neurospace" : "are not active Neurospaces"} in ${picked.me.org.name}; nothing was created`
    };
  }
  const neurospaces = available.filter((item) => requested.includes(item.id));
  const { results, removed, unresolvedNeurolinkIds, configPath: configPath2 } = await establishNeurolinks(resolved.projectRoot, args, picked.profileId, gateway, neurospaces, prior?.neurolinkIds ?? [], available);
  const destinations = results.filter((result) => result.neurolinkId);
  const failed = results.filter((result) => !result.neurolinkId);
  if (destinations.length === 0) {
    return {
      status: "error",
      code: "no_destination_linked",
      message: `no destination could be linked; no config was written (${failed.map((result) => `${result.neurospaceName}: ${result.message}`).join("; ")})`
    };
  }
  return {
    status: failed.length > 0 ? "partially_connected" : "connected",
    destinations,
    ...failed.length > 0 ? {
      failed: failed.map(({ neurospaceId, neurospaceName, message, wasConnected }) => ({
        neurospaceId,
        neurospaceName,
        message,
        ...wasConnected ? { wasConnected } : {}
      }))
    } : {},
    ...removed.length > 0 ? { removed } : {},
    ...unresolvedNeurolinkIds.length > 0 ? { unresolvedNeurolinkIds } : {},
    organization: picked.me.org.name,
    configPath: configPath2
  };
}
async function runJsonVerb(resolved, args) {
  if (args.apiKey) {
    return {
      status: "error",
      code: "api_key_not_supported",
      message: "--api-key is a human/CI path and is not available in --json mode; run it directly in a terminal"
    };
  }
  if (args.neurospaces?.length)
    return connectToNeurospaces(resolved, args);
  if (args.awaitLogin)
    return awaitLogin(args);
  if (args.login)
    return startLogin(args);
  if (args.probe)
    return probeConnection(resolved, args);
  return {
    status: "error",
    code: "no_verb",
    message: "--json requires one of --probe, --login, --await-login, or --neurospace <id> (repeatable)"
  };
}
async function verifyApiKeyConnection(apiKey, gateway) {
  const response = await fetch(`${gateway.replace(/\/+$/, "")}/v1/neurolinks`, {
    headers: { authorization: `AugentaKey ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Augenta rejected the platform key (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  const neurolinks = (await response.json()).neurolinks ?? [];
  if (neurolinks.length === 0) {
    throw new Error("the platform key is not assigned to a Neurolink");
  }
  if (neurolinks.length > 1) {
    throw new Error(`the platform key is assigned to ${neurolinks.length} Neurolinks; capture requires exactly one`);
  }
  const neurolink = neurolinks[0];
  if (neurolink.status !== "active" || neurolink.direction !== "inbound" && neurolink.direction !== "bidirectional") {
    throw new Error("the platform key requires an active inbound Neurolink");
  }
  return neurolink;
}
async function connectWithApiKey(projectRoot, apiKey, endpoint2) {
  const gateway = (endpoint2?.trim() || DEFAULT_GATEWAY).replace(/\/+$/, "");
  const neurolink = await verifyApiKeyConnection(apiKey, gateway);
  return {
    path: writeApiKeyConfig(projectRoot, apiKey, gateway === DEFAULT_GATEWAY ? undefined : gateway),
    neurolink
  };
}
if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes("--json");
  try {
    const args = parseArgs(argv);
    const resolved = resolveProject(args, process.cwd());
    const projectRoot = resolved.projectRoot;
    if (args.json) {
      const payload = await runJsonVerb(resolved, args);
      console.log(JSON.stringify({
        ...payload,
        environment: environmentLabel(args),
        projectRoot,
        ...resolved.worktreeRedirect ? { worktreeRedirect: resolved.worktreeRedirect } : {}
      }, null, 2));
      if (payload.status === "error")
        process.exitCode = 1;
    } else if (args.apiKey?.trim()) {
      const existed = existsSync5(join5(projectRoot, ".augenta", "config.json"));
      const { path, neurolink } = await connectWithApiKey(projectRoot, args.apiKey.trim(), args.endpoint);
      console.log(`${existed ? "Updated" : "Wrote"} ${path} (0600). Platform-key capture is enabled through Neurolink ${neurolink.id}.`);
      console.log("Off switch: delete .augenta/config.json, or set AUGENTA_CAPTURE_ENABLED=0.");
    } else if (!input.isTTY) {
      throw new Error("signing in needs an interactive terminal; agents should use --json with --probe/--login/--await-login/--neurospace, and --api-key is for autonomous or CI clients.");
    } else {
      await connectProject(projectRoot, args);
    }
  } catch (error) {
    const message = error.message;
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
  verifyApiKeyConnection,
  startLogin,
  runJsonVerb,
  resolveTargetProject,
  resolveProject,
  probeConnection,
  parseArgs,
  connectWithApiKey,
  connectToNeurospaces,
  connectProject,
  awaitLogin,
  PLUGIN_VERSION
};
