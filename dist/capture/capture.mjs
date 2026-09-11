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

// capture/capture.ts
import { existsSync as existsSync8, openSync as openSync2, fstatSync, readSync, closeSync as closeSync2 } from "node:fs";
import { basename as basename2, dirname as dirname6, join as join10 } from "node:path";

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

// capture/normalize-core.ts
function agentSid(baseSid, agentId) {
  return `${baseSid}/agent-${agentId}`;
}
function tailToEvents(lines, startSeq, startOffset, toEvent, lineSid) {
  const events = [];
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
    const event = toEvent(sanitized.value, seq, lineOff);
    if (event) {
      events.push(event);
      seq += 1;
    }
    raws.push({ raw: sanitized.json, sid: event ? event.sid : lineSid(sanitized.value) });
  }
  return { events, raws, nextSeq: seq, nextOffset: off };
}

// capture/normalize-claude.ts
function extractText(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== "object")
        continue;
      switch (block.type) {
        case "text":
          parts.push(block.text ?? "");
          break;
        case "thinking":
          if (typeof block.thinking === "string" && block.thinking.trim())
            parts.push("[thinking] " + block.thinking);
          break;
        case "tool_use":
          parts.push(`[tool_use:${block.name}] ` + JSON.stringify(block.input ?? {}));
          break;
        case "tool_result": {
          const tr = block.content;
          parts.push(`[tool_result] ${typeof tr === "string" ? tr : JSON.stringify(tr ?? "")}`);
          break;
        }
        default:
          if (typeof block.type === "string")
            parts.push(`[${block.type}]`);
          break;
      }
    }
    return parts.join(`
`);
  }
  if (content === undefined || content === null)
    return "";
  return JSON.stringify(content);
}
function firstToolName(content) {
  if (!Array.isArray(content))
    return;
  for (const block of content) {
    if (block && block.type === "tool_use" && typeof block.name === "string")
      return block.name;
  }
  return;
}
function hasToolError(content) {
  if (!Array.isArray(content))
    return false;
  return content.some((b) => b && b.type === "tool_result" && b.is_error === true);
}
function hasToolUse(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === "tool_use");
}
function hasToolResult(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === "tool_result");
}
function toolStatus(line) {
  if (typeof line.toolDenialKind === "string" && line.toolDenialKind.trim() !== "")
    return "denied";
  return hasToolError(line.message?.content) ? "error" : "ok";
}
function classify(line) {
  const etype = line.type;
  const content = line.message?.content;
  const msgRole = line.message?.role;
  if (etype === "assistant") {
    if (hasToolUse(content)) {
      return { kind: "tool", role: "assistant", tool_name: firstToolName(content) };
    }
    return { kind: "msg", role: "assistant" };
  }
  if (etype === "user") {
    if (hasToolResult(content)) {
      return { kind: "tool", role: "tool", tool_status: toolStatus(line) };
    }
    return { kind: "msg", role: "user" };
  }
  if (etype === "system" || etype === "summary") {
    return { kind: "session", role: "system" };
  }
  if (etype === "tool_use")
    return { kind: "tool", role: "assistant", tool_name: firstToolName(content) };
  if (etype === "tool_result") {
    return { kind: "tool", role: "tool", tool_status: toolStatus(line) };
  }
  if (msgRole === "assistant" || msgRole === "user" || msgRole === "system") {
    return { kind: "msg", role: msgRole };
  }
  return null;
}
function normalizeLine(line, ctx, seq, off, scrub) {
  if (line.isAbortedMidStream === true)
    return null;
  const cls = classify(line);
  if (!cls)
    return null;
  const rawText = extractText(line.message?.content);
  const content = line.message?.content;
  const textOnly = typeof content === "string" || Array.isArray(content) && content.every((block) => block && block.type === "text");
  if (line.isMeta === true && cls.role === "user" && textOnly && rawText.startsWith("Base directory for this skill: "))
    return null;
  if (cls.role === "user" && /^\[Request interrupted by user(?: for tool use)?\]$/.test(rawText.trim()))
    return null;
  const text = scrub(rawText).trim();
  if (!text)
    return null;
  const usage = line.message?.usage;
  const baseSid = line.sessionId || ctx.sessionId;
  return {
    src: ctx.harness ?? "claude-code",
    sid: ctx.agentId ? agentSid(baseSid, ctx.agentId) : baseSid,
    ...ctx.agentId ? { parent_sid: baseSid } : {},
    ...ctx.agentType ? { agent_type: ctx.agentType } : {},
    proj: ctx.project,
    ts: line.timestamp || line.message?.timestamp || new Date().toISOString(),
    seq,
    kind: cls.kind,
    role: cls.role,
    ...cls.tool_name !== undefined ? { tool_name: cls.tool_name } : {},
    ...cls.tool_status !== undefined ? { tool_status: cls.tool_status } : {},
    in_tok: usage?.input_tokens ?? null,
    out_tok: usage?.output_tokens ?? null,
    cache_in_tok: usage?.cache_creation_input_tokens ?? null,
    cache_read_tok: usage?.cache_read_input_tokens ?? null,
    ...line.message?.model ? { model: line.message.model } : {},
    text,
    ref: { path: ctx.transcriptPath, off }
  };
}
function normalizeClaudeTranscript(opts) {
  const { lines, ctx, startSeq, startOffset } = opts;
  const scrub = opts.scrub ?? ((t) => t);
  return tailToEvents(lines, startSeq, startOffset, (sanitized, seq, off) => {
    if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized))
      return null;
    return normalizeLine(sanitized, ctx, seq, off, scrub);
  }, (sanitized) => {
    const base = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized.sessionId || ctx.sessionId : ctx.sessionId;
    return ctx.agentId ? agentSid(base, ctx.agentId) : base;
  });
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
  }, () => codexSessionFromPath(ctx.transcriptPath) || ctx.sessionId);
  return model ? { ...result, lastModel: model } : result;
}
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

// capture/outbox.ts
import { join as join2 } from "node:path";
import { mkdirSync as mkdirSync2, existsSync as existsSync2, readFileSync, writeFileSync as writeFileSync2, appendFileSync, renameSync, statSync, unlinkSync } from "node:fs";

// capture/augenta-dir.ts
import { join } from "node:path";
import { chmodSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
function ensureAugentaDir(projectRoot) {
  const dir = join(projectRoot, ".augenta");
  try {
    mkdirSync(dir, { recursive: true, mode: 448 });
    try {
      chmodSync(dir, 448);
    } catch {}
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
  pendingByteCount(destKey) {
    return Math.max(0, this.spoolEnd() - this.shippedOffset(destKey));
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

// capture/capture-cursor.ts
import { join as join3, dirname } from "node:path";
import { mkdirSync as mkdirSync3, existsSync as existsSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync3, renameSync as renameSync2 } from "node:fs";

// capture/native-turns.ts
function validNativeTurns(value) {
  if (!value || typeof value !== "object")
    return false;
  const s = value;
  return Number.isSafeInteger(s.ordinal) && s.ordinal >= 0 && !!s.ids && typeof s.ids === "object" && !Array.isArray(s.ids) && Object.values(s.ids).every((n) => Number.isSafeInteger(n) && n > 0 && n <= s.ordinal) && (s.active === undefined || typeof s.active === "string" && Object.hasOwn(s.ids, s.active)) && (s.eligible === undefined || typeof s.eligible === "boolean") && (s.captureSince === undefined || typeof s.captureSince === "string");
}
function normalizeNativeTurns(opts, prior, captureSince) {
  const turns = prior ? { ...prior, ids: { ...prior.ids } } : { ids: {}, ordinal: 0 };
  if (turns.captureSince !== captureSince && turns.active)
    turns.eligible = false;
  turns.captureSince = captureSince;
  const events = [];
  const raws = [];
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
    const result = normalizeCodexRollout({
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
  return { events, raws, records, nextSeq, nextOffset, lastModel: model, turns };
}
function timestampOf(raw) {
  try {
    const timestamp = JSON.parse(raw ?? "{}").timestamp;
    if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)))
      return timestamp;
  } catch {}
  return new Date().toISOString();
}

// capture/capture-cursor.ts
var ZERO = { offset: 0, seq: 0 };

class CaptureState {
  path;
  projectRoot;
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.path = join3(projectRoot, ".augenta", "state", "capture.json");
  }
  readAll() {
    if (!existsSync3(this.path))
      return {};
    try {
      const parsed = JSON.parse(readFileSync2(this.path, "utf8"));
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
      offset: c.offset,
      seq: c.seq,
      ...c.rebaseline === true ? { rebaseline: true } : {},
      ...typeof c.model === "string" && c.model ? { model: c.model } : {}
    };
  }
  set(transcriptPath, cursor) {
    ensureAugentaDir(this.projectRoot);
    mkdirSync3(dirname(this.path), { recursive: true });
    const all = this.readAll();
    all[transcriptPath] = cursor;
    const tmp = this.path + ".tmp";
    writeFileSync3(tmp, JSON.stringify(all));
    renameSync2(tmp, this.path);
  }
}

// capture/capture-lock.ts
import { mkdirSync as mkdirSync4, openSync, readFileSync as readFileSync3, closeSync, writeFileSync as writeFileSync4, unlinkSync as unlinkSync2, statSync as statSync2 } from "node:fs";
import { join as join4 } from "node:path";
function captureLock(projectRoot) {
  const dir = join4(ensureAugentaDir(projectRoot), "state");
  mkdirSync4(dir, { recursive: true });
  const path = join4(dir, "capture.lock");
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
        const pid = Number(readFileSync3(path, "utf8"));
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

// capture/health.ts
import { mkdirSync as mkdirSync5, readFileSync as readFileSync5, renameSync as renameSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join6 } from "node:path";
import { randomUUID } from "node:crypto";

// capture/config.ts
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname2, join as join5 } from "node:path";
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
  return join5(projectRoot, ".augenta", "config.json");
}
function resolveProjectRoot(cwd) {
  if (!cwd)
    return;
  let dir = cwd;
  for (let i = 0;i < 30; i++) {
    if (existsSync4(configPath(dir)))
      return dir;
    const parent = dirname2(dir);
    if (parent === dir)
      return;
    dir = parent;
  }
  return;
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

// capture/health.ts
var STAGES = ["dispatch", "capture", "delivery"];
var outcomes = new Set(["started", "captured", "idle", "missing_transcript", "failed", "accepted", "rejected", "retry", "spool_full"]);
function read(projectRoot, stage) {
  try {
    const s = JSON.parse(readFileSync5(join6(projectRoot, ".augenta", "state", `health-${stage}.json`), "utf8"));
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
    const dir = join6(ensureAugentaDir(projectRoot), "state");
    mkdirSync5(dir, { recursive: true });
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
    const file = join6(dir, `health-${stage}.json`);
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync5(tmp, JSON.stringify(value), { mode: 384 });
    renameSync3(tmp, file);
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

// capture/turn-cursor.ts
import { join as join7, dirname as dirname3 } from "node:path";
import { mkdirSync as mkdirSync6, existsSync as existsSync5, readFileSync as readFileSync6, writeFileSync as writeFileSync6, renameSync as renameSync4 } from "node:fs";
class TurnState {
  path;
  projectRoot;
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.path = join7(projectRoot, ".augenta", "state", "turn.json");
  }
  readAll() {
    if (!existsSync5(this.path))
      return {};
    try {
      const parsed = JSON.parse(readFileSync6(this.path, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  writeAll(all) {
    ensureAugentaDir(this.projectRoot);
    mkdirSync6(dirname3(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync6(tmp, JSON.stringify(all));
    renameSync4(tmp, this.path);
  }
  get(transcriptPath) {
    const v = this.readAll()[transcriptPath];
    return typeof v === "number" && v >= 0 ? v : 0;
  }
  bump(transcriptPath) {
    const all = this.readAll();
    const cur = typeof all[transcriptPath] === "number" && all[transcriptPath] >= 0 ? all[transcriptPath] : 0;
    all[transcriptPath] = cur + 1;
    this.writeAll(all);
    return cur + 1;
  }
}

// capture/memory.ts
import { createHash } from "node:crypto";
import {
  existsSync as existsSync6,
  lstatSync,
  mkdirSync as mkdirSync7,
  readFileSync as readFileSync7,
  readdirSync,
  renameSync as renameSync5,
  statSync as statSync3,
  writeFileSync as writeFileSync7
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname as dirname4, extname, isAbsolute, join as join8, relative, resolve, sep } from "node:path";
var MAX_DOCUMENT_EXPERIENCE_BYTES = 512 * 1024;
function sameSnapshot(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}
function memoryStatePath(projectRoot) {
  return join8(projectRoot, ".augenta", "state", "memory.json");
}
function validEntry(value) {
  const e = value;
  return !!e && (e.source === "claude-code" || e.source === "codex") && typeof e.documentId === "string" && typeof e.sourcePath === "string" && typeof e.title === "string" && typeof e.sourceUpdatedAt === "string" && typeof e.revision === "string" && Number.isInteger(e.chunkCount) && e.chunkCount > 0;
}
function readMemoryIndex(projectRoot) {
  try {
    const parsed = JSON.parse(readFileSync7(memoryStatePath(projectRoot), "utf8"));
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
  const stateDir = join8(ensureAugentaDir(projectRoot), "state");
  const path = join8(stateDir, "memory.json");
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
  const root = join8(dirname4(transcriptPath), "memory");
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
      const path = join8(dir, entry.name);
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
        const text = readFileSync7(path, "utf8");
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
  const root = resolve(projectRoot);
  const target = resolve(scope);
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
  const root = codexHome ?? process.env.CODEX_HOME ?? join8(homedir(), ".codex");
  const path = join8(root, "memories", "MEMORY.md");
  try {
    if (!existsSync6(path))
      return { complete: false, documents: [] };
    const linkBefore = lstatSync(path);
    const before = statSync3(path);
    if (!before.isFile())
      return { complete: false, documents: [] };
    const text = readFileSync7(path, "utf8");
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
  return sha256(`${source}\x00${resolve(projectRoot)}\x00${candidate.sourcePath}${discriminator}`);
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

// capture/shipper.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync7 } from "node:fs";
import { dirname as dirname5, join as join9 } from "node:path";
import { fileURLToPath } from "node:url";
function shipperEntry() {
  const self = fileURLToPath(import.meta.url);
  const ext = self.endsWith(".ts") ? ".ts" : ".mjs";
  const here = dirname5(self);
  const sibling = join9(here, `ship${ext}`);
  return existsSync7(sibling) ? sibling : join9(here, "..", "capture", `ship${ext}`);
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

// runtime/node.ts
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve as resolve2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
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
  return canonical(fileURLToPath2(metaUrl)) === canonical(entry);
}
function canonical(path) {
  const absolute = resolve2(path);
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

// capture/capture.ts
var SPOOL_FULL_MARKER = "[augenta: local spool full — capture records are being dropped until the outbox drains]";
var MAX_TAIL_BYTES_PER_FIRE = 8 * 1024 * 1024;
function readTail(fd, offset, size, cap) {
  let length = Math.max(1, Math.min(cap, size - offset));
  for (;; ) {
    const chunk = Buffer.alloc(length);
    const bytesRead = readSync(fd, chunk, 0, length, offset);
    const slice = bytesRead === length ? chunk : chunk.subarray(0, bytesRead);
    if (bytesRead < length || offset + slice.length >= size || slice.includes(10))
      return slice;
    length = Math.min(size - offset, length * 2);
  }
}
function resolveHarness(transcriptPath, firstLine) {
  if (isCodexHarness(transcriptPath))
    return true;
  if (/\.claude\//.test(transcriptPath.replace(/\\/g, "/")))
    return false;
  return sniffHarness(firstLine) === "codex";
}
function resolveMemoryHarness(transcriptPath) {
  if (!transcriptPath)
    return "claude-code";
  if (isCodexHarness(transcriptPath))
    return "codex";
  if (/\.claude\//.test(transcriptPath.replace(/\\/g, "/")))
    return "claude-code";
  let fd = -1;
  try {
    fd = openSync2(transcriptPath, "r");
    const size = fstatSync(fd).size;
    if (size <= 0)
      return "claude-code";
    const firstWindow = readTail(fd, 0, size, 64 * 1024);
    const newline = firstWindow.indexOf(10);
    const firstLine = firstWindow.subarray(0, newline === -1 ? firstWindow.length : newline).toString("utf8");
    return resolveHarness(transcriptPath, firstLine) ? "codex" : "claude-code";
  } catch {
    return "claude-code";
  } finally {
    if (fd >= 0)
      closeSync2(fd);
  }
}
function shouldFlush(payload) {
  const event = payload.hook_event_name;
  if (event === "Stop")
    return !payload.stop_hook_active;
  return event === "SessionEnd" || event === "PreCompact";
}
function readsFullTail(payload) {
  return shouldFlush(payload) || payload.hook_event_name === "SubagentStop";
}
function shouldScanMemory(payload) {
  const event = payload.hook_event_name;
  return shouldFlush(payload) && event !== "PreCompact" && event !== "SessionEnd";
}
function resolveCaptureTarget(payload) {
  const sessionTranscript = payload.transcript_path;
  if (payload.hook_event_name !== "SubagentStop")
    return { transcriptPath: sessionTranscript };
  const agentId = payload.agent_id;
  const agentType = payload.agent_type;
  const supplied = payload.agent_transcript_path;
  if (supplied && existsSync8(supplied))
    return { transcriptPath: supplied, agentId, agentType };
  if (!sessionTranscript || !agentId)
    return { transcriptPath: undefined };
  const derived = join10(dirname6(sessionTranscript), basename2(sessionTranscript, ".jsonl"), "subagents", `agent-${agentId}.jsonl`);
  return existsSync8(derived) ? { transcriptPath: derived, agentId, agentType } : { transcriptPath: undefined };
}
function captureUnderLock(payload, opts = {}) {
  const projectRoot = opts.projectRoot ?? resolveProjectRoot(payload.cwd);
  const { transcriptPath, agentId, agentType } = resolveCaptureTarget(payload);
  const flush = shouldFlush(payload);
  const fullTail = readsFullTail(payload);
  if (!projectRoot)
    return { appended: 0, flushed: false };
  const scrub2 = opts.scrub ?? scrub;
  const maxTailBytes = opts.maxTailBytes ?? MAX_TAIL_BYTES_PER_FIRE;
  let memoryHarness;
  const finish = (appended) => {
    if (shouldScanMemory(payload)) {
      try {
        captureAgentMemory({
          projectRoot,
          harness: memoryHarness ?? resolveMemoryHarness(transcriptPath),
          transcriptPath,
          scrub: scrub2,
          maxSpoolBytes: opts.maxSpoolBytes
        });
      } catch {}
    }
    if (flush && opts.spawnShipper !== false)
      spawnShipper(projectRoot);
    return { appended, flushed: flush };
  };
  if (!transcriptPath || !existsSync8(transcriptPath)) {
    recordHealth(projectRoot, "capture", "missing_transcript");
    return finish(0);
  }
  const state = new CaptureState(projectRoot);
  const cursor = state.get(transcriptPath);
  let readFrom = cursor.offset;
  let rebaselined = false;
  let tailBuf;
  let fd = -1;
  try {
    fd = openSync2(transcriptPath, "r");
    const size = fstatSync(fd).size;
    if (cursor.rebaseline || size < cursor.offset) {
      readFrom = size;
      rebaselined = true;
    }
    if (readFrom < size)
      tailBuf = readTail(fd, readFrom, size, fullTail ? Infinity : maxTailBytes);
  } catch {
    recordHealth(projectRoot, "capture", "failed");
    return finish(0);
  } finally {
    if (fd >= 0)
      closeSync2(fd);
  }
  if (!tailBuf) {
    if (rebaselined) {
      state.set(transcriptPath, {
        offset: readFrom,
        seq: cursor.seq,
        ...cursor.nativeTurns ? { nativeTurns: cursor.nativeTurns } : {},
        ...cursor.model ? { model: cursor.model } : {}
      });
    }
    if (payload.hook_event_name === "PreCompact") {
      state.set(transcriptPath, { ...state.get(transcriptPath), rebaseline: true });
    }
    return finish(0);
  }
  const tail = tailBuf.toString("utf8");
  const completeLines = tail.split(`
`).slice(0, -1);
  if (completeLines.length === 0)
    return finish(0);
  const codex = resolveHarness(transcriptPath, completeLines[0]);
  const src = codex ? "codex" : "claude-code";
  memoryHarness = src;
  const sessionId = payload.session_id || "unknown";
  const project = payload.cwd || process.cwd();
  const normalize = codex ? normalizeCodexRollout : normalizeClaudeTranscript;
  const normalizeOpts = {
    lines: completeLines,
    ctx: {
      sessionId,
      project,
      transcriptPath,
      harness: src,
      ...agentId ? { agentId } : {},
      ...agentType ? { agentType } : {},
      ...cursor.model ? { model: cursor.model } : {}
    },
    startSeq: cursor.seq,
    startOffset: readFrom,
    scrub: scrub2
  };
  const native = codex ? normalizeNativeTurns(normalizeOpts, cursor.nativeTurns, opts.captureSince) : undefined;
  const { events, raws: rawLines, nextSeq, nextOffset, lastModel } = native ?? normalize(normalizeOpts);
  const raws = rawLines.map(({ raw, sid }) => ({ raw, src, sid, proj: project }));
  let finalSeq = nextSeq;
  if (!native && events.length === 0 && raws.length > 0) {
    const linesBySid = new Map;
    for (const r of raws)
      linesBySid.set(r.sid, (linesBySid.get(r.sid) ?? 0) + 1);
    for (const [sid, count] of linesBySid) {
      events.push({
        src,
        sid,
        proj: project,
        ts: new Date().toISOString(),
        seq: finalSeq,
        kind: "session",
        role: "system",
        text: `[augenta: ${count} transcript line(s) with no mappable steps — raw channel attached]`
      });
      finalSeq += 1;
    }
  }
  let turn;
  try {
    turn = native ? events[0]?.turn ?? 0 : new TurnState(projectRoot).get(transcriptPath);
    if (!native) {
      for (const e of events)
        e.turn = turn;
      for (const r of raws)
        r.turn = turn;
    }
  } catch {}
  let accepted = true;
  if (events.length + raws.length > 0) {
    const box = new Outbox(projectRoot, { maxSpoolBytes: opts.maxSpoolBytes });
    const ok = box.append(native?.records ?? [...events, ...raws]);
    accepted = ok;
    if (!ok)
      recordHealth(projectRoot, "capture", "spool_full");
    if (!ok && box.markDropped()) {
      const marker = {
        src,
        sid: events[0]?.sid ?? raws[0]?.sid ?? sessionId,
        proj: project,
        ts: new Date().toISOString(),
        seq: finalSeq,
        kind: "session",
        role: "system",
        text: SPOOL_FULL_MARKER,
        ...turn !== undefined ? { turn } : {},
        ...native ? { turn_source: events[0]?.turn_source ?? "unknown" } : {}
      };
      box.forceAppend([marker]);
      finalSeq += 1;
    }
  }
  state.set(transcriptPath, {
    ...native ? { nativeTurns: native.turns } : {},
    offset: nextOffset,
    seq: finalSeq,
    ...payload.hook_event_name === "PreCompact" ? { rebaseline: true } : {},
    ...lastModel ?? cursor.model ? { model: lastModel ?? cursor.model } : {}
  });
  if (accepted)
    recordHealth(projectRoot, "capture", events.length ? "captured" : "idle", events.length);
  return finish(events.length);
}
function runCapture(payload, opts = {}) {
  const root = opts.projectRoot ?? resolveProjectRoot(payload.cwd);
  if (!root)
    return { appended: 0, flushed: false };
  const release = captureLock(root);
  if (!release) {
    recordHealth(root, "capture", "retry");
    return { appended: 0, flushed: false };
  }
  try {
    return captureUnderLock(payload, opts);
  } finally {
    release();
  }
}
if (isMain(import.meta.url)) {
  try {
    const payload = JSON.parse(await readStdin());
    const cfg = projectConfig(payload.cwd);
    if (cfg && captureEnabled(cfg)) {
      recordHealth(cfg.projectRoot, "dispatch", "started");
      try {
        runCapture(payload, { captureSince: cfg.captureSince });
      } catch {
        recordHealth(cfg.projectRoot, "capture", "failed");
      }
    }
  } catch {}
  process.exit(0);
}
export {
  shouldFlush,
  runCapture,
  resolveCaptureTarget,
  readsFullTail,
  SPOOL_FULL_MARKER,
  MAX_TAIL_BYTES_PER_FIRE
};
