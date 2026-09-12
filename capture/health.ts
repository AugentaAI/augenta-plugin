/** Local, bounded diagnostics. No payloads, paths, tokens, IDs or error strings. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { captureEnabled, loadProjectConfig } from "./config";
import { ensureAugentaDir } from "./augenta-dir";
import { Outbox } from "./outbox";

const STAGES = ["dispatch", "capture", "delivery"] as const;
type Stage = typeof STAGES[number];
type Outcome = "started" | "captured" | "idle" | "missing_transcript" | "failed" | "accepted" | "rejected" | "retry" | "spool_full";
interface Activity { at: string; outcome: Outcome; count: number; successes: number; lastSuccessAt?: string }
const outcomes = new Set<Outcome>(["started", "captured", "idle", "missing_transcript", "failed", "accepted", "rejected", "retry", "spool_full"]);
function read(projectRoot: string, stage: Stage): Activity | undefined {
  try {
    const s = JSON.parse(readFileSync(join(projectRoot, ".augenta", "state", `health-${stage}.json`), "utf8"));
    if (!Number.isFinite(Date.parse(s.at)) || !outcomes.has(s.outcome) ||
        !Number.isSafeInteger(s.count) || s.count < 0 || !Number.isSafeInteger(s.successes) || s.successes < 0) return;
    return { at: new Date(s.at).toISOString(), outcome: s.outcome, count: s.count, successes: s.successes,
      ...(Number.isFinite(Date.parse(s.lastSuccessAt)) ? { lastSuccessAt: new Date(s.lastSuccessAt).toISOString() } : {}) };
  } catch { return; }
}
export function recordHealth(projectRoot: string, stage: Stage, outcome: Outcome, count = 0): void {
  try {
    const dir = join(ensureAugentaDir(projectRoot), "state");
    mkdirSync(dir, { recursive: true });
    const old = read(projectRoot, stage);
    const at = new Date().toISOString();
    const success = outcome === "captured" || outcome === "accepted";
    const value: Activity = { at, outcome, count,
      successes: Math.min(Number.MAX_SAFE_INTEGER, (old?.successes ?? 0) + (success ? 1 : 0)),
      ...(success ? { lastSuccessAt: at } : old?.lastSuccessAt ? { lastSuccessAt: old.lastSuccessAt } : {}) };
    const file = join(dir, `health-${stage}.json`);
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); renameSync(tmp, file);
  } catch { /* diagnostics never block capture or delivery */ }
}
export function captureHealth(projectRoot: string) {
  const cfg = loadProjectConfig(projectRoot);
  const activity = Object.fromEntries(STAGES.map(stage => [stage, read(projectRoot, stage) ?? null])) as Record<Stage, Activity | null>;
  return { configured: !!cfg, enabled: captureEnabled(cfg),
    configuration: cfg ? "valid" : existsSync(join(projectRoot, ".augenta/config.json")) ? "invalid" : "missing",
    activityScope: "project", hostDispatch: "unverified",
    destinations: cfg?.authMode === "oauth" ? cfg.connectorIds!.length : cfg ? 1 : 0,
    pendingBytes: cfg ? new Outbox(projectRoot).pendingByteCount() : 0,
    ...activity,
    // Local plugin state cannot establish host approval or lake persistence.
    hostApproval: "unknown", ingestion: "unverified",
    nextStep: !cfg ? "connect" : !captureEnabled(cfg) ? "capture_disabled" : !activity.dispatch
      ? "check_host_hook_approval_and_activation" : activity.capture?.outcome === "missing_transcript"
      ? "check_host_transcript_payload" : "complete_a_turn_then_check_activity" };
}
