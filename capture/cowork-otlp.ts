import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Outbox, type SpoolRecord } from "./outbox";
import type { CaptureEvent } from "./event";
import { captureLock } from "./capture-lock";
import { scrub } from "./scrub";
import { sanitizeTelemetryValue } from "./sanitize";
import { AUTO_RECALL_SENTINEL } from "./auto-recall-marker";
import { boundCoworkConfig, CoworkError, coworkTaskBinding, validCoworkId, verifyCoworkRoutes, type CoworkTaskBinding } from "./cowork-task";

export const MAX_COWORK_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_TASK_RECORDS = 10_000;
const MAX_PENDING_BYTES = 1024 * 1024;
const NAMES = new Set(["user_prompt", "assistant_response", "tool_result", "api_request", "api_error", "tool_decision"]);
type Attributes = Record<string, unknown>;
interface OtlpEvent {
  name: string; sessionId: string; promptId: string; sequence: number; timestamp: string;
  attributes: Attributes; raw: string; digest: string;
}
interface TaskState {
  version: 1;
  connection: string;
  seen: Record<string, string>;
  prompts: Record<string, { turn: number; eligible: boolean }>;
  pending: OtlpEvent[];
}
export interface CoworkIngestResult { queued: number; duplicates: number; ignored: number; projects: string[] }

function valueOf(value: any): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (value.intValue !== undefined) {
    const integer = Number(value.intValue);
    return Number.isSafeInteger(integer) ? integer : undefined;
  }
  if (typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) return value.doubleValue;
  if (Array.isArray(value.arrayValue?.values)) return value.arrayValue.values.map(valueOf);
  return undefined;
}

function attributesOf(pairs: any): Attributes {
  if (!Array.isArray(pairs)) return {};
  return Object.fromEntries(pairs.filter(x => x && typeof x.key === "string").map(x => [x.key, valueOf(x.value)]));
}

function parseBatch(payload: unknown): { events: OtlpEvent[]; ignored: number } {
  const resourceLogs = (payload as any)?.resourceLogs;
  if (!Array.isArray(resourceLogs)) throw new CoworkError("invalid_otlp", "Expected an OTLP/HTTP JSON logs request.");
  const events: OtlpEvent[] = [];
  let ignored = 0;
  for (const resourceLog of resourceLogs) {
    const resource = attributesOf(resourceLog?.resource?.attributes);
    const scopes = resourceLog?.scopeLogs;
    if (!Array.isArray(scopes)) continue;
    for (const scope of scopes) {
      if (!Array.isArray(scope?.logRecords)) continue;
      for (const record of scope.logRecords) {
        if (resource["service.name"] !== "cowork") { ignored++; continue; }
        const attributes = attributesOf(record?.attributes);
        const eventName = record?.eventName ?? attributes["event.name"] ?? record?.body?.stringValue;
        const name = typeof eventName === "string" ? eventName.replace(/^(?:claude_code|cowork)\./, "") : "";
        const sessionId = attributes["session.id"];
        const promptId = attributes["prompt.id"];
        const sequence = attributes["event.sequence"];
        const timestamp = attributes["event.timestamp"];
        if (!NAMES.has(name) || !validCoworkId(sessionId) || !validCoworkId(promptId) ||
          !Number.isSafeInteger(sequence) || (sequence as number) < 0 || (sequence as number) >= Number.MAX_SAFE_INTEGER ||
          typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) { ignored++; continue; }
        const raw = JSON.stringify(sanitizeTelemetryValue({ resource: resourceLog.resource, scope: scope.scope, logRecord: record }));
        if (name !== "user_prompt" && raw.includes(AUTO_RECALL_SENTINEL)) { ignored++; continue; }
        const digest = createHash("sha256").update(JSON.stringify([name, sessionId, promptId, sequence, timestamp,
          Object.entries(attributes).sort(), Object.entries(resource).sort()])).digest("hex");
        events.push({ name, sessionId, promptId, sequence: sequence as number, timestamp: new Date(timestamp).toISOString(), attributes, raw, digest });
      }
    }
  }
  return { events, ignored };
}

function statePath(root: string, sessionId: string): string {
  return join(root, ".augenta", "state", `cowork-otlp-${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

function readState(root: string, binding: CoworkTaskBinding): TaskState {
  const path = statePath(root, binding.sessionId);
  if (!existsSync(path)) return { version: 1, connection: binding.connection, seen: {}, prompts: {}, pending: [] };
  try {
    if (statSync(path).size > MAX_PENDING_BYTES * 3) throw new Error();
    const value = JSON.parse(readFileSync(path, "utf8"));
    const object = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
    if (value.version !== 1 || value.connection !== binding.connection || !object(value.seen) || !object(value.prompts) ||
      !Array.isArray(value.pending) || Object.keys(value.seen).length > MAX_TASK_RECORDS ||
      Object.entries(value.seen).some(([key, digest]) => !/^\d+$/.test(key) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) ||
      Object.entries(value.prompts).some(([id, prompt]: [string, any]) => !validCoworkId(id) || !Number.isSafeInteger(prompt?.turn) || prompt.turn <= 0 || typeof prompt.eligible !== "boolean") ||
      value.pending.some((event: OtlpEvent) => !event || event.sessionId !== binding.sessionId || !validCoworkId(event.promptId) ||
        !NAMES.has(event.name) || !Number.isSafeInteger(event.sequence) || value.seen[String(event.sequence)] !== event.digest ||
        typeof event.raw !== "string" || !object(event.attributes) || !Number.isFinite(Date.parse(event.timestamp)))) throw new Error();
    return value;
  } catch { throw new CoworkError("damaged_state", "Cowork capture state is damaged; restore it or start a new task. It was not reset or replayed."); }
}

function text(attributes: Attributes, name: string): string | undefined {
  const value = attributes[name];
  return typeof value === "string" && value !== "<REDACTED>" ? value : undefined;
}

function eventToStep(event: OtlpEvent, root: string, turn: number): CaptureEvent {
  const a = event.attributes;
  const base: CaptureEvent = { src: "claude-code", sid: event.sessionId, proj: root, ts: event.timestamp,
    seq: event.sequence, turn, turn_source: "native", kind: "session", role: "system", text: "" };
  if (typeof a.model === "string") base.model = a.model;
  switch (event.name) {
    case "user_prompt": return { ...base, kind: "msg", role: "user", text: scrub(text(a, "prompt") ?? "[augenta: Cowork prompt content unavailable]") };
    case "assistant_response": return { ...base, kind: "msg", role: "assistant", text: scrub(text(a, "response") ?? "[augenta: Cowork response content unavailable]") };
    case "tool_result": return { ...base, kind: "tool", role: "tool", tool_name: text(a, "tool_name"),
      tool_status: a.success === true || a.success === "true" ? "ok" : a.decision_type === "reject" ? "denied" : "error",
      text: scrub([text(a, "tool_input") ?? "[augenta: Cowork tool input unavailable]", text(a, "tool_parameters"),
        text(a, "error"), "[augenta: complete tool-result content is not present in this Cowork event schema]"].filter(Boolean).join("\n")) };
    case "api_error": return { ...base, kind: "error", role: "assistant", text: scrub(text(a, "error") ?? "Cowork API request failed") };
    case "tool_decision": return { ...base, tool_name: text(a, "tool_name"), text: scrub(`Cowork tool decision: ${text(a, "decision") ?? "unknown"} (${text(a, "source") ?? "unknown"})`) };
    default: {
      const count = (key: string) => typeof a[key] === "number" && Number.isSafeInteger(a[key]) && (a[key] as number) >= 0 ? a[key] as number : null;
      return { ...base, role: "assistant", text: "Cowork model request usage", in_tok: count("input_tokens"), out_tok: count("output_tokens"),
        cache_read_tok: count("cache_read_tokens"), cache_in_tok: count("cache_creation_tokens") };
    }
  }
}

/** Run on a customer-controlled relay. Unbound content never enters Augenta's outbox. */
export async function ingestCoworkOtlp(projectRoots: string[], payload: unknown): Promise<CoworkIngestResult> {
  if (Buffer.byteLength(JSON.stringify(payload) ?? "") > MAX_COWORK_BATCH_BYTES) throw new CoworkError("batch_too_large", "Cowork OTLP batch exceeds the relay limit.");
  const parsed = parseBatch(payload);
  const result: CoworkIngestResult = { queued: 0, duplicates: 0, ignored: parsed.ignored, projects: [] };
  const sessions = new Map<string, OtlpEvent[]>();
  for (const event of parsed.events) {
    const group = sessions.get(event.sessionId) ?? [];
    group.push(event); sessions.set(event.sessionId, group);
  }
  for (const [sessionId, incoming] of sessions) {
    const choices = [...new Set(projectRoots)].map(root => ({ root, binding: coworkTaskBinding(root, sessionId) }))
      .filter((x): x is { root: string; binding: CoworkTaskBinding } => !!x.binding);
    if (choices.length !== 1 || choices[0]!.binding.transport !== "otlp") { result.ignored += incoming.length; continue; }
    const { root, binding } = choices[0]!;
    const cfg = boundCoworkConfig(root, binding);
    if (!cfg) { result.ignored += incoming.length; continue; }
    await verifyCoworkRoutes(cfg);
    const release = captureLock(root);
    if (!release) throw new CoworkError("busy", "Project capture is busy; retry this OTLP batch.");
    try {
      if (!boundCoworkConfig(root, binding)) { result.ignored += incoming.length; continue; }
      const box = new Outbox(root);
      const recovered = box.finishPendingAppend();
      if (recovered) { result.queued += recovered / 2; result.projects.push(root); }
      const state = readState(root, binding);
      for (const event of incoming.sort((a, b) => a.sequence - b.sequence)) {
        const key = String(event.sequence);
        if (Object.hasOwn(state.seen, key)) {
          if (state.seen[key] !== event.digest) throw new CoworkError("sequence_conflict", "Cowork reused an event sequence with different content; the conflicting batch was refused.");
          result.duplicates++; continue;
        }
        Object.defineProperty(state.seen, key, { value: event.digest, enumerable: true, writable: true, configurable: true });
        state.pending.push(event);
      }
      if (Object.keys(state.seen).length > MAX_TASK_RECORDS || Buffer.byteLength(JSON.stringify(state.pending)) > MAX_PENDING_BYTES) {
        throw new CoworkError("task_capacity", "This Cowork task reached the relay's local buffer limit; the batch was not committed.");
      }
      for (const event of state.pending) {
        if (event.name !== "user_prompt") continue;
        if (Object.hasOwn(state.prompts, event.promptId) && state.prompts[event.promptId]!.turn !== event.sequence + 1) {
          throw new CoworkError("prompt_conflict", "Cowork reused a prompt ID for a different turn; the batch was refused.");
        }
        Object.defineProperty(state.prompts, event.promptId, { value: { turn: event.sequence + 1,
          eligible: Date.parse(event.timestamp) >= Date.parse(binding.boundAt) && !!text(event.attributes, "prompt") }, enumerable: true, writable: true, configurable: true });
      }
      const records: SpoolRecord[] = [];
      const waiting: OtlpEvent[] = [];
      for (const event of state.pending.sort((a, b) => a.sequence - b.sequence)) {
        const prompt = Object.hasOwn(state.prompts, event.promptId) ? state.prompts[event.promptId] : undefined;
        if (!prompt) { waiting.push(event); continue; }
        if (!prompt.eligible) { result.ignored++; continue; }
        const step = eventToStep(event, root, prompt.turn);
        records.push(step, { raw: event.raw, src: step.src, sid: step.sid, proj: root, turn: prompt.turn });
      }
      state.pending = waiting;
      if (!box.appendWithReceipt(records, statePath(root, sessionId), state)) throw new CoworkError("outbox_full", "The project outbox is full; this OTLP batch was not committed.");
      result.queued += records.length / 2;
      if (records.length && !result.projects.includes(root)) result.projects.push(root);
    } finally { release(); }
  }
  return result;
}
