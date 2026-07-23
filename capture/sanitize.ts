/**
 * Structural telemetry sanitation for harness transcript JSONL.
 *
 * Reasoning signatures and encrypted reasoning payloads are opaque harness
 * artifacts, not useful trajectory signal. Remove them before a transcript
 * can reach either normalized fallback text or the raw telemetry channel.
 * This deliberately operates on every object path: callers chose broad
 * removal over retaining a same-named field in tool/user payloads.
 */

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
export function sanitizeTelemetryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeTelemetryValue);
  if (!value || typeof value !== "object") return value;

  const sanitized: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (isOpaqueKey(key)) continue;
    const sanitizedChild = sanitizeTelemetryValue(child);
    if ((normalized === "thinking" || normalized === "reasoning") && isEmptyReasoningValue(sanitizedChild)) continue;
    sanitized.push([key, sanitizedChild]);
  }
  // Object.fromEntries defines `__proto__` as an ordinary own property. Direct
  // assignment to `{}` would instead mutate the new object's prototype and
  // silently drop that legitimate transcript key during JSON serialization.
  return Object.fromEntries(sanitized);
}

export interface SanitizedTelemetryRecord {
  value: unknown;
  json: string;
}

/** Parse, sanitize, and serialize one JSONL record with a single parse/walk. */
export function sanitizeTelemetryRecord(raw: string): SanitizedTelemetryRecord | undefined {
  try {
    const value = sanitizeTelemetryValue(JSON.parse(raw));
    const json = JSON.stringify(value);
    return json === undefined ? undefined : { value, json };
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
