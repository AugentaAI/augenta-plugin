/**
 * Structural telemetry sanitation for harness transcript JSONL.
 *
 * Reasoning signatures, encrypted reasoning and embedded file bytes are opaque
 * harness artifacts, not trajectory text. Remove them before a transcript
 * can reach either normalized fallback text or the raw telemetry channel.
 * This deliberately operates on every object path: callers chose broad
 * removal over retaining a same-named field in tool/user payloads.
 */
import { createHash } from "node:crypto";

export interface RemovedPayload {
  hash: string;
  /** Canonical base64; retained in memory only, never in telemetry. */
  content: string;
  mediaType: string;
  bytes: number;
  valid: boolean;
}

const REFERENCE_PREFIX = "[augenta attachment sha256:";

export function attachmentHash(reference: unknown): string | undefined {
  if (typeof reference !== "string") return undefined;
  return /^\[augenta attachment sha256:([a-f0-9]{64}) \d+B [^\]\r\n]+\]$/.exec(reference)?.[1];
}

function mediaType(value: unknown, fallback = "application/octet-stream"): string {
  return typeof value === "string" && value.length <= 128 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value) ? value.toLowerCase() : fallback;
}

function removePayload(content: string, mime: string, payloads: Map<string, RemovedPayload>): string {
  if (attachmentHash(content)) return content;
  const clean = content.replace(/\s/g, "");
  const valid = clean.length > 0 && clean.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(clean);
  const bytes = valid ? Buffer.from(clean, "base64") : Buffer.from(content, "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  payloads.set(hash, { hash, content: valid ? bytes.toString("base64") : "", mediaType: mime, bytes: bytes.length, valid });
  return `${REFERENCE_PREFIX}${hash} ${bytes.length}B ${mime}]`;
}

function normalizedKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

function isOpaqueKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized === "signature" || normalized === "encryptedcontent";
}

function isEmptyReasoningValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

/** Remove opaque reasoning artifacts and empty thought fields from JSON data. */
function sanitize(value: unknown, payloads: Map<string, RemovedPayload>, inheritedMime?: string): unknown {
  if (typeof value === "string") {
    // Codex UI events put image URLs in arrays, not only named object fields.
    const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(value);
    return dataUrl ? removePayload(dataUrl[2]!, mediaType(dataUrl[1]), payloads) : value;
  }
  if (Array.isArray(value)) return value.map(child => sanitize(child, payloads, inheritedMime));
  if (!value || typeof value !== "object") return value;

  const object = value as Record<string, unknown>;
  const mime = mediaType(object.media_type ?? object.mediaType ?? object.mimeType,
    object.type === "pdf" ? "application/pdf" : inheritedMime);

  const sanitized: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (isOpaqueKey(key)) continue;
    let sanitizedChild: unknown;
    if (typeof child === "string" && (key === "base64" || (key === "data" && ["base64", "image"].includes(object.type as string)))) {
      sanitizedChild = removePayload(child, mime, payloads);
    } else {
      sanitizedChild = sanitize(child, payloads, mime);
    }
    if ((normalized === "thinking" || normalized === "reasoning") && isEmptyReasoningValue(sanitizedChild)) continue;
    sanitized.push([key, sanitizedChild]);
  }
  // Object.fromEntries defines `__proto__` as an ordinary own property. Direct
  // assignment to `{}` would instead mutate the new object's prototype and
  // silently drop that legitimate transcript key during JSON serialization.
  return Object.fromEntries(sanitized);
}

/** Remove opaque reasoning artifacts and embedded binary payloads. */
export function sanitizeTelemetryValue(value: unknown): unknown {
  return sanitize(value, new Map());
}

export interface SanitizedTelemetryRecord {
  value: unknown;
  json: string;
  payloads: Map<string, RemovedPayload>;
}

/** Parse, sanitize, and serialize one JSONL record with a single parse/walk. */
export function sanitizeTelemetryRecord(raw: string): SanitizedTelemetryRecord | undefined {
  try {
    const payloads = new Map<string, RemovedPayload>();
    const value = sanitize(JSON.parse(raw), payloads);
    const json = JSON.stringify(value);
    return json === undefined ? undefined : { value, json, payloads };
  } catch {
    return undefined;
  }
}

/**
 * Parse and sanitize one raw JSONL record for storage/egress. Undefined means
 * the line was not JSON and therefore cannot safely enter the raw channel.
 */
export function sanitizeTelemetryJsonl(raw: string): string | undefined {
  return sanitizeTelemetryRecord(raw)?.json;
}
