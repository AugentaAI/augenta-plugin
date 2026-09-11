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
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync as renameSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join4 } from "node:path";
import { randomUUID } from "node:crypto";

// capture/config.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
    if (value.captureSince !== undefined && (typeof value.captureSince !== "string" || !Number.isFinite(Date.parse(value.captureSince))))
      return;
    const captureSince = typeof value.captureSince === "string" && Number.isFinite(Date.parse(value.captureSince)) ? new Date(value.captureSince).toISOString() : undefined;
    const settings = {};
    for (const key of ["endpoint", "controlUrl", "ingestUrl"]) {
      const raw = value[key];
      if (raw !== undefined && typeof raw !== "string")
        return;
      if (typeof raw === "string" && raw.trim()) {
        settings[key] = raw.trim().replace(/\/+$/, "");
      }
    }
    if (value.org !== undefined) {
      if (!value.org || typeof value.org.id !== "string" || !value.org.id.trim())
        return;
      if (value.org.name !== undefined && typeof value.org.name !== "string")
        return;
      settings.org = { id: value.org.id.trim(), ...value.org.name?.trim() ? { name: value.org.name.trim() } : {} };
    }
    const destinations = value.destinations === undefined ? undefined : parseDestinations(value.destinations);
    if (value.destinations !== undefined && !destinations)
      return;
    if (destinations) {
      settings.destinations = destinations;
      settings.connectorIds = destinations.map((destination) => destination.connectorId);
    }
    if (value.authMode === "oauth") {
      const profileId = typeof value.profileId === "string" ? value.profileId.trim() : "";
      if (!profileId || !destinations)
        return;
      return {
        ...settings,
        authMode: "oauth",
        ...captureSince ? { captureSince } : {},
        profileId,
        projectRoot
      };
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
function gatewayBase(cfg, flag) {
  return (flag?.trim() || process.env.AUGENTA_API_URL?.trim() || cfg?.endpoint || DEFAULT_GATEWAY).replace(/\/+$/, "");
}
function experiencesUrl(cfg) {
  return process.env.AUGENTA_INGEST_URL || cfg?.ingestUrl || `${gatewayBase(cfg)}/v1/experiences`;
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
  pendingByteCount(destKey) {
    return Math.max(0, this.spoolEnd() - this.shippedOffset(destKey));
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

// capture/health.ts
var STAGES = ["dispatch", "capture", "delivery"];
var outcomes = new Set(["started", "captured", "idle", "missing_transcript", "failed", "accepted", "rejected", "retry", "spool_full"]);
function read(projectRoot, stage) {
  try {
    const s = JSON.parse(readFileSync3(join4(projectRoot, ".augenta", "state", `health-${stage}.json`), "utf8"));
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
    const dir = join4(ensureAugentaDir(projectRoot), "state");
    mkdirSync3(dir, { recursive: true });
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
    const file = join4(dir, `health-${stage}.json`);
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync3(tmp, JSON.stringify(value), { mode: 384 });
    renameSync2(tmp, file);
  } catch {}
}
function captureHealth(projectRoot) {
  const cfg = loadProjectConfig(projectRoot);
  const activity = Object.fromEntries(STAGES.map((stage) => [stage, read(projectRoot, stage) ?? null]));
  return {
    configured: !!cfg,
    enabled: captureEnabled(cfg),
    destinations: cfg?.authMode === "oauth" ? cfg.connectorIds.length : cfg ? 1 : 0,
    pendingBytes: cfg ? new Outbox(projectRoot).pendingByteCount() : 0,
    ...activity,
    hostApproval: "unknown",
    ingestion: "unverified",
    nextStep: !cfg ? "connect" : !captureEnabled(cfg) ? "capture_disabled" : !activity.dispatch ? "check_host_hook_approval_and_activation" : "complete_a_turn_then_check_activity"
  };
}

// hooks/session-start.ts
import { homedir as homedir3 } from "node:os";
import { join as join8 } from "node:path";
import { mkdirSync as mkdirSync6, readFileSync as readFileSync6, writeFileSync as writeFileSync6, renameSync as renameSync5 } from "node:fs";

// hooks/harness.ts
function isCodexHarness(transcriptPath) {
  if (!transcriptPath)
    return false;
  const p = transcriptPath.replace(/\\/g, "/");
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

// capture/auth.ts
import {
  chmodSync as chmodSync2,
  existsSync as existsSync4,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync4,
  renameSync as renameSync3,
  statSync as statSync2,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync4
} from "node:fs";
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import { homedir } from "node:os";
import { join as join5 } from "node:path";

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

// capture/auth.ts
class ReLoginRequiredError extends Error {
  reason;
  constructor(message, reason) {
    super(message);
    this.name = "ReLoginRequiredError";
    this.reason = reason;
  }
}
var authRoot = () => process.env.AUGENTA_AUTH_HOME || join5(homedir(), ".augenta");
var authPath = () => join5(authRoot(), "auth.json");
var lockPath = () => join5(authRoot(), "auth.lock");
var LOCK_WAIT_MS = 1e4;
var STALE_LOCK_MS = 30000;
var REQUEST_TIMEOUT_MS = 15000;
function ensureAuthRoot() {
  mkdirSync4(authRoot(), { recursive: true, mode: 448 });
  chmodSync2(authRoot(), 448);
}
function readAuthStore() {
  try {
    ensureAuthRoot();
    if (existsSync4(authPath()))
      chmodSync2(authPath(), 384);
    const parsed = JSON.parse(readFileSync4(authPath(), "utf8"));
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
  const tmp = `${path}.${process.pid}.${randomUUID2()}.tmp`;
  try {
    writeFileSync4(tmp, `${JSON.stringify(store, null, 2)}
`, {
      mode: 384,
      flag: "wx"
    });
    chmodSync2(tmp, 384);
    renameSync3(tmp, path);
    chmodSync2(path, 384);
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
      writeFileSync4(lock, String(process.pid), { flag: "wx", mode: 384 });
      break;
    } catch {
      try {
        if (Date.now() - statSync2(lock).mtimeMs > STALE_LOCK_MS)
          unlinkSync2(lock);
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
async function augentaOAuthConfig(controlUrl2) {
  const response = await fetch(`${controlUrl2.replace(/\/+$/, "")}/.well-known/augenta.json`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
var pendingLoginPath = () => join5(authRoot(), "pending-login.json");
function savePendingLogin(pending) {
  ensureAuthRoot();
  const path = pendingLoginPath();
  writeFileSync4(path, `${JSON.stringify(pending, null, 2)}
`, { mode: 384 });
  chmodSync2(path, 384);
}
function readPendingLogin() {
  try {
    const parsed = JSON.parse(readFileSync4(pendingLoginPath(), "utf8"));
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
  return join5(projectRoot, ".augenta", `${notice}-required`);
}
function markAuthNotice(projectRoot, notice) {
  try {
    ensureAugentaDir(projectRoot);
    writeFileSync4(noticePath(projectRoot, notice), `${notice}
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
function environmentLabel(controlUrl2) {
  const url = (controlUrl2?.trim() || DEFAULT_CONTROL_URL).replace(/\/+$/, "");
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

// capture/shipper.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync5 } from "node:fs";
import { dirname as dirname2, join as join6 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function shipperEntry() {
  const self = fileURLToPath2(import.meta.url);
  const ext = self.endsWith(".ts") ? ".ts" : ".mjs";
  const here = dirname2(self);
  const sibling = join6(here, `ship${ext}`);
  return existsSync5(sibling) ? sibling : join6(here, "..", "capture", `ship${ext}`);
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
  } catch {
    recordHealth(projectRoot, "delivery", "failed");
  }
}

// capture/memory.ts
import { createHash as createHash2 } from "node:crypto";
import {
  existsSync as existsSync6,
  lstatSync,
  mkdirSync as mkdirSync5,
  readFileSync as readFileSync5,
  readdirSync,
  renameSync as renameSync4,
  statSync as statSync3,
  writeFileSync as writeFileSync5
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename, dirname as dirname3, extname, isAbsolute, join as join7, relative, resolve as resolve2, sep } from "node:path";

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
  return join7(projectRoot, ".augenta", "state", "memory.json");
}
function validEntry(value) {
  const e = value;
  return !!e && (e.source === "claude-code" || e.source === "codex") && typeof e.documentId === "string" && typeof e.sourcePath === "string" && typeof e.title === "string" && typeof e.sourceUpdatedAt === "string" && typeof e.revision === "string" && Number.isInteger(e.chunkCount) && e.chunkCount > 0;
}
function readMemoryIndex(projectRoot) {
  try {
    const parsed = JSON.parse(readFileSync5(memoryStatePath(projectRoot), "utf8"));
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
  const stateDir = join7(ensureAugentaDir(projectRoot), "state");
  const path = join7(stateDir, "memory.json");
  const tmp = path + ".tmp";
  try {
    mkdirSync5(stateDir, { recursive: true });
    writeFileSync5(tmp, JSON.stringify(index));
    renameSync4(tmp, path);
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
  const root = join7(dirname3(transcriptPath), "memory");
  try {
    if (!existsSync6(root) || !lstatSync(root).isDirectory())
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
      const path = join7(dir, entry.name);
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
        const text = readFileSync5(path, "utf8");
        const after = lstatSync(path);
        if (!after.isFile() || !sameSnapshot(before, after)) {
          complete = false;
          continue;
        }
        const sourcePath = normalizeLogicalPath(relative(root, path));
        documents.push({
          sourcePath,
          title: markdownTitle(text, basename(entry.name, extname(entry.name))),
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
function isScopedToProject(scope, projectRoot) {
  if (!isAbsolute(scope))
    return false;
  const root = resolve2(projectRoot);
  const target = resolve2(scope);
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
    if (!isScopedToProject(scope, projectRoot))
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
function scanCodexMemory(projectRoot, codexHome) {
  const root = codexHome ?? process.env.CODEX_HOME ?? join7(homedir2(), ".codex");
  const path = join7(root, "memories", "MEMORY.md");
  try {
    if (!existsSync6(path))
      return { complete: false, documents: [] };
    const linkBefore = lstatSync(path);
    const before = statSync3(path);
    if (!before.isFile())
      return { complete: false, documents: [] };
    const text = readFileSync5(path, "utf8");
    const linkAfter = lstatSync(path);
    const after = statSync3(path);
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
  return sha256(`${source}\x00${resolve2(projectRoot)}\x00${candidate.sourcePath}${discriminator}`);
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
  const scan = opts.harness === "codex" ? scanCodexMemory(opts.projectRoot, opts.codexHome) : scanClaudeMemory(opts.transcriptPath);
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
      const names = cfg?.destinations?.map((destination) => destination.workspaceName || destination.workspaceId).join(", ");
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
  }
  process.exit(0);
}
var home = process.env.AUGENTA_HOME ?? homedir3();
var stateDir = join8(home, ".augenta", "state");
var markerPath = join8(stateDir, "connect-prompted.json");
var legacyMarkerPath = join8(stateDir, "init-prompted.json");
function readMarkers(path) {
  try {
    const parsed = JSON.parse(readFileSync6(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
var markerKey = staleConfig ? `reconnect:${projectPath}` : projectPath;
var markers = readMarkers(markerPath);
if (markers[markerKey])
  process.exit(0);
if (!staleConfig && readMarkers(legacyMarkerPath)[projectPath])
  process.exit(0);
try {
  mkdirSync6(stateDir, { recursive: true });
  markers[markerKey] = new Date().toISOString();
  const tmp = markerPath + ".tmp";
  writeFileSync6(tmp, JSON.stringify(markers));
  renameSync5(tmp, markerPath);
} catch {
  process.exit(0);
}
var codexContext = staleConfig ? `Augenta's saved connection for this project can no longer be read, so capture is off. Run ${connectAction} to reconnect it.` : `Augenta isn't connected for this project yet. Run ${connectAction} to connect it.`;
var claudeContext = staleConfig ? "[Augenta] This project has an .augenta/config.json that this plugin version " + "cannot read — it predates the current connection format, or the write was " + "truncated — so capture is silently off. This is the one automatic prompt it " + "will ever get. Run the augenta connect skill now (/augenta:connect) to " + "reconnect it; anything already queued in the outbox ships once it succeeds. " + "Tokens and API keys must never be pasted into the chat." : "[Augenta] This project has not been connected for Augenta capture and this " + "is the one automatic prompt it will ever get. Run the augenta connect skill now " + "(/augenta:connect): it explains what capture does, then drives connect's --json " + "verbs itself so the user only answers one question and, at most, clicks one " + "sign-in link. Tokens and API keys must never be pasted into the chat.";
var additionalContext = codex ? codexContext : claudeContext;
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext,
    ...codex ? {} : { initialUserMessage: "/augenta:connect" }
  }
}));
process.exit(0);
