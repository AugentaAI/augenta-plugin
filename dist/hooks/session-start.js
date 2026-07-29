#!/usr/bin/env bun
// @bun

// capture/capture.ts
import { existsSync as existsSync7, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename as basename2, dirname as dirname5, join as join7 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

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
      return { kind: "tool", role: "tool", tool_status: hasToolError(content) ? "error" : "ok" };
    }
    return { kind: "msg", role: "user" };
  }
  if (etype === "system" || etype === "summary") {
    return { kind: "session", role: "system" };
  }
  if (etype === "tool_use")
    return { kind: "tool", role: "assistant", tool_name: firstToolName(content) };
  if (etype === "tool_result") {
    return { kind: "tool", role: "tool", tool_status: hasToolError(content) ? "error" : "ok" };
  }
  if (msgRole === "assistant" || msgRole === "user" || msgRole === "system") {
    return { kind: "msg", role: msgRole };
  }
  return null;
}
function normalizeLine(line, ctx, seq, off, scrub) {
  const cls = classify(line);
  if (!cls)
    return null;
  const rawText = extractText(line.message?.content);
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

// capture/capture-cursor.ts
import { join as join3, dirname } from "node:path";
import { mkdirSync as mkdirSync3, existsSync as existsSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync3, renameSync as renameSync2 } from "node:fs";
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

// capture/turn-cursor.ts
import { join as join4, dirname as dirname2 } from "node:path";
import { mkdirSync as mkdirSync4, existsSync as existsSync4, readFileSync as readFileSync3, writeFileSync as writeFileSync4, renameSync as renameSync3 } from "node:fs";
class TurnState {
  path;
  projectRoot;
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.path = join4(projectRoot, ".augenta", "state", "turn.json");
  }
  readAll() {
    if (!existsSync4(this.path))
      return {};
    try {
      const parsed = JSON.parse(readFileSync3(this.path, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  writeAll(all) {
    ensureAugentaDir(this.projectRoot);
    mkdirSync4(dirname2(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync4(tmp, JSON.stringify(all));
    renameSync3(tmp, this.path);
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

// capture/config.ts
import { existsSync as existsSync5, readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname3, join as join5 } from "node:path";
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
  return join5(projectRoot, ".augenta", "config.json");
}
function resolveProjectRoot(cwd) {
  if (!cwd)
    return;
  let dir = cwd;
  for (let i = 0;i < 30; i++) {
    if (existsSync5(configPath(dir)))
      return dir;
    const parent = dirname3(dir);
    if (parent === dir)
      return;
    dir = parent;
  }
  return;
}
function loadProjectConfig(projectRoot) {
  try {
    const value = JSON.parse(readFileSync4(configPath(projectRoot), "utf8"));
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

// capture/memory.ts
import { createHash } from "node:crypto";
import {
  existsSync as existsSync6,
  lstatSync,
  mkdirSync as mkdirSync5,
  readFileSync as readFileSync5,
  readdirSync,
  renameSync as renameSync4,
  statSync as statSync2,
  writeFileSync as writeFileSync5
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname as dirname4, extname, isAbsolute, join as join6, relative, resolve, sep } from "node:path";
var MAX_DOCUMENT_EXPERIENCE_BYTES = 512 * 1024;
function sameSnapshot(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}
function memoryStatePath(projectRoot) {
  return join6(projectRoot, ".augenta", "state", "memory.json");
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
  const stateDir = join6(ensureAugentaDir(projectRoot), "state");
  const path = join6(stateDir, "memory.json");
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
  const root = join6(dirname4(transcriptPath), "memory");
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
      const path = join6(dir, entry.name);
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
  const root = codexHome ?? process.env.CODEX_HOME ?? join6(homedir(), ".codex");
  const path = join6(root, "memories", "MEMORY.md");
  try {
    if (!existsSync6(path))
      return { complete: false, documents: [] };
    const linkBefore = lstatSync(path);
    const before = statSync2(path);
    if (!before.isFile())
      return { complete: false, documents: [] };
    const text = readFileSync5(path, "utf8");
    const linkAfter = lstatSync(path);
    const after = statSync2(path);
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
    fd = openSync(transcriptPath, "r");
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
      closeSync(fd);
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
  if (supplied && existsSync7(supplied))
    return { transcriptPath: supplied, agentId, agentType };
  if (!sessionTranscript || !agentId)
    return { transcriptPath: undefined };
  const derived = join7(dirname5(sessionTranscript), basename2(sessionTranscript, ".jsonl"), "subagents", `agent-${agentId}.jsonl`);
  return existsSync7(derived) ? { transcriptPath: derived, agentId, agentType } : { transcriptPath: undefined };
}
function runCapture(payload, opts = {}) {
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
  if (!transcriptPath || !existsSync7(transcriptPath))
    return finish(0);
  const state = new CaptureState(projectRoot);
  const cursor = state.get(transcriptPath);
  let readFrom = cursor.offset;
  let rebaselined = false;
  let tailBuf;
  let fd = -1;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    if (cursor.rebaseline || size < cursor.offset) {
      readFrom = size;
      rebaselined = true;
    }
    if (readFrom < size)
      tailBuf = readTail(fd, readFrom, size, fullTail ? Infinity : maxTailBytes);
  } catch {
    return finish(0);
  } finally {
    if (fd >= 0)
      closeSync(fd);
  }
  if (!tailBuf) {
    if (rebaselined) {
      state.set(transcriptPath, {
        offset: readFrom,
        seq: cursor.seq,
        ...cursor.model ? { model: cursor.model } : {}
      });
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
  const { events, raws: rawLines, nextSeq, nextOffset, lastModel } = normalize({
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
  });
  const raws = rawLines.map(({ raw, sid }) => ({ raw, src, sid, proj: project }));
  let finalSeq = nextSeq;
  if (events.length === 0 && raws.length > 0) {
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
    turn = new TurnState(projectRoot).get(transcriptPath);
    for (const e of events)
      e.turn = turn;
    for (const r of raws)
      r.turn = turn;
  } catch {}
  if (events.length + raws.length > 0) {
    const box = new Outbox(projectRoot, { maxSpoolBytes: opts.maxSpoolBytes });
    const ok = box.append([...events, ...raws]);
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
        ...turn !== undefined ? { turn } : {}
      };
      box.forceAppend([marker]);
      finalSeq += 1;
    }
  }
  state.set(transcriptPath, {
    offset: nextOffset,
    seq: finalSeq,
    ...payload.hook_event_name === "PreCompact" ? { rebaseline: true } : {},
    ...lastModel ?? cursor.model ? { model: lastModel ?? cursor.model } : {}
  });
  return finish(events.length);
}
function spawnShipper(projectRoot) {
  try {
    const child = spawn(process.execPath, [join7(dirname5(fileURLToPath2(import.meta.url)), "ship.js"), projectRoot], {
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();
  } catch {}
}
if (isMain(import.meta.url)) {
  try {
    const payload = JSON.parse(await readStdin());
    if (captureEnabled(projectConfig(payload.cwd))) {
      runCapture(payload);
    }
  } catch {}
  process.exit(0);
}

// hooks/session-start.ts
import { homedir as homedir3 } from "os";
import { join as join9 } from "path";
import { mkdirSync as mkdirSync7, readFileSync as readFileSync7, writeFileSync as writeFileSync7, renameSync as renameSync6 } from "fs";

// capture/auth.ts
import {
  chmodSync,
  existsSync as existsSync8,
  mkdirSync as mkdirSync6,
  readFileSync as readFileSync6,
  renameSync as renameSync5,
  statSync as statSync3,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync6
} from "node:fs";
import { createHash as createHash2, randomUUID } from "node:crypto";
import { homedir as homedir2 } from "node:os";
import { join as join8 } from "node:path";
class ReLoginRequiredError extends Error {
  reason;
  constructor(message, reason) {
    super(message);
    this.name = "ReLoginRequiredError";
    this.reason = reason;
  }
}
var authRoot = () => process.env.AUGENTA_AUTH_HOME || join8(homedir2(), ".augenta");
var authPath = () => join8(authRoot(), "auth.json");
var lockPath = () => join8(authRoot(), "auth.lock");
var LOCK_WAIT_MS = 1e4;
var STALE_LOCK_MS = 30000;
var REQUEST_TIMEOUT_MS = 15000;
function ensureAuthRoot() {
  mkdirSync6(authRoot(), { recursive: true, mode: 448 });
  chmodSync(authRoot(), 448);
}
function readAuthStore() {
  try {
    ensureAuthRoot();
    if (existsSync8(authPath()))
      chmodSync(authPath(), 384);
    const parsed = JSON.parse(readFileSync6(authPath(), "utf8"));
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
    writeFileSync6(tmp, `${JSON.stringify(store, null, 2)}
`, {
      mode: 384,
      flag: "wx"
    });
    chmodSync(tmp, 384);
    renameSync5(tmp, path);
    chmodSync(path, 384);
  } finally {
    try {
      if (existsSync8(tmp))
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
      writeFileSync6(lock, String(process.pid), { flag: "wx", mode: 384 });
      break;
    } catch {
      try {
        if (Date.now() - statSync3(lock).mtimeMs > STALE_LOCK_MS)
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
var pendingLoginPath = () => join8(authRoot(), "pending-login.json");
function savePendingLogin(pending) {
  ensureAuthRoot();
  const path = pendingLoginPath();
  writeFileSync6(path, `${JSON.stringify(pending, null, 2)}
`, { mode: 384 });
  chmodSync(path, 384);
}
function readPendingLogin() {
  try {
    const parsed = JSON.parse(readFileSync6(pendingLoginPath(), "utf8"));
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
  const digest = createHash2("sha256").update(coordinates).digest("hex").slice(0, 24);
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
  return join8(projectRoot, ".augenta", `${notice}-required`);
}
function markAuthNotice(projectRoot, notice) {
  try {
    ensureAugentaDir(projectRoot);
    writeFileSync6(noticePath(projectRoot, notice), `${notice}
`, {
      mode: 384
    });
  } catch {}
}
function takeAuthNotice(projectRoot) {
  let found;
  for (const notice of NOTICES) {
    const path = noticePath(projectRoot, notice);
    if (!existsSync8(path))
      continue;
    found ??= notice;
    try {
      unlinkSync2(path);
    } catch {}
  }
  return found;
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
var projectPath = cwd || process.cwd();
var configuredRoot = resolveProjectRoot(projectPath);
var cfg = configuredRoot ? loadProjectConfig(configuredRoot) : undefined;
var staleConfig = Boolean(configuredRoot) && !cfg;
var connectedRoot = cfg ? configuredRoot : undefined;
if (connectedRoot) {
  if (captureEnabled(cfg)) {
    const action = codex ? "$augenta:connect or Connect Augenta" : "/augenta:connect";
    const notices = [];
    const authNotice = takeAuthNotice(connectedRoot);
    if (authNotice) {
      const reason = authNotice === "relogin" ? "a new Augenta sign-in" : "a valid inbound Neurolink";
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
var stateDir = join9(home, ".augenta", "state");
var markerPath = join9(stateDir, "connect-prompted.json");
var legacyMarkerPath = join9(stateDir, "init-prompted.json");
function readMarkers(path) {
  try {
    const parsed = JSON.parse(readFileSync7(path, "utf8"));
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
  mkdirSync7(stateDir, { recursive: true });
  markers[markerKey] = new Date().toISOString();
  const tmp = markerPath + ".tmp";
  writeFileSync7(tmp, JSON.stringify(markers));
  renameSync6(tmp, markerPath);
} catch {
  process.exit(0);
}
var codexContext = staleConfig ? "Augenta's saved connection for this project can no longer be read \u2014 reconnecting." : "Augenta isn't connected for this project yet \u2014 starting connection.";
var claudeContext = staleConfig ? "[Augenta] This project has an .augenta/config.json that this plugin version " + "cannot read \u2014 it predates the current connection format, or the write was " + "truncated \u2014 so capture is silently off. This is the one automatic prompt it " + "will ever get. Run the augenta connect skill now (/augenta:connect) to " + "reconnect it; anything already queued in the outbox ships once it succeeds. " + "Tokens and API keys must never be pasted into the chat." : "[Augenta] This project has not been connected for Augenta capture and this " + "is the one automatic prompt it will ever get. Run the augenta connect skill now " + "(/augenta:connect): it explains what capture does, then drives connect's --json " + "verbs itself so the user only answers one question and, at most, clicks one " + "sign-in link. Tokens and API keys must never be pasted into the chat.";
var additionalContext = codex ? codexContext : claudeContext;
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext,
    initialUserMessage: codex ? "Connect Augenta" : "/augenta:connect"
  }
}));
process.exit(0);
