import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { captureEnabled, gatewayBase, loadProjectConfig, type ProjectConfig } from "./config";
import { accessTokenForProfile, assertSignInTarget, storedProfileUserId } from "./auth";
import { ensureAugentaDir } from "./augenta-dir";
import { captureLock } from "./capture-lock";
import { CaptureState } from "./capture-cursor";

export type CoworkTransport = "native" | "otlp";
export interface CoworkTaskBinding {
  sessionId: string;
  transport: CoworkTransport;
  boundAt: string;
  connection: string;
  transcriptPath?: string;
}

export class CoworkError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function validCoworkId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/.test(value);
}

export function coworkBindingsPath(root: string): string {
  return join(root, ".augenta", "state", "cowork-tasks.json");
}

export function writeCoworkState(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

function readBindings(root: string): CoworkTaskBinding[] {
  try {
    const value = JSON.parse(readFileSync(coworkBindingsPath(root), "utf8"));
    if (value.version !== 1 || !Array.isArray(value.tasks)) return [];
    return value.tasks.filter((x: CoworkTaskBinding) => x && validCoworkId(x.sessionId) &&
      (x.transport === "native" || x.transport === "otlp") && typeof x.connection === "string" &&
      /^[a-f0-9]{64}$/.test(x.connection) && Number.isFinite(Date.parse(x.boundAt)) &&
      (x.transport !== "native" || typeof x.transcriptPath === "string"));
  } catch { return []; }
}

export function coworkTaskBinding(root: string, sessionId: string): CoworkTaskBinding | undefined {
  try {
    const claimed = JSON.parse(readFileSync(taskClaimPath(sessionId), "utf8"));
    if (claimed.version !== 1 || claimed.projectRoot !== realpathSync(root)) return undefined;
    const matches = readBindings(root).filter(x => x.sessionId === sessionId && JSON.stringify(x) === JSON.stringify(claimed.binding));
    return matches.length === 1 ? matches[0] : undefined;
  } catch { return undefined; }
}

function taskClaimPath(sessionId: string): string {
  const base = process.env.AUGENTA_AUTH_HOME || join(homedir(), ".augenta");
  return join(base, "cowork", "tasks", createHash("sha256").update(sessionId).digest("hex") + ".json");
}

/** Atomic per-session claim: a task cannot bind to two projects or transports. */
function claimTask(root: string, binding: CoworkTaskBinding): void {
  const path = taskClaimPath(binding.sessionId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const value = { version: 1, projectRoot: realpathSync(root), binding };
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    try { linkSync(temp, path); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const prior = JSON.parse(readFileSync(path, "utf8"));
      if (prior.projectRoot !== value.projectRoot || prior.binding?.transport !== binding.transport ||
        prior.binding?.connection !== binding.connection || prior.binding?.transcriptPath !== binding.transcriptPath) {
        throw new CoworkError("task_already_bound", "This task is already bound to a project and transport. Start a new task to change either.");
      }
      binding.boundAt = prior.binding.boundAt;
    }
  } finally { rmSync(temp, { force: true }); }
}

/** A binding never survives a different sign-in, join, gateway, or selection. */
export function coworkConnection(cfg: ProjectConfig): string {
  return createHash("sha256").update(JSON.stringify({
    authMode: cfg.authMode, profileId: cfg.profileId,
    userId: cfg.profileId ? storedProfileUserId(cfg.profileId) : undefined,
    projectKey: cfg.projectKey, captureSince: cfg.captureSince,
    gateway: gatewayBase(cfg), ingestUrl: cfg.ingestUrl,
    destinations: cfg.destinations, apiKey: cfg.apiKey,
  })).digest("hex");
}

export function boundCoworkConfig(root: string, binding: CoworkTaskBinding): ProjectConfig | undefined {
  const cfg = loadProjectConfig(root);
  return cfg && captureEnabled(cfg) && coworkConnection(cfg) === binding.connection ? cfg : undefined;
}

/** No source account, organization, or attached path is used as authorization. */
export async function verifyCoworkRoutes(cfg: ProjectConfig): Promise<void> {
  const gateway = gatewayBase(cfg);
  if (cfg.authMode === "oauth") assertSignInTarget(cfg.profileId!, gateway);
  const token = cfg.authMode === "oauth" ? await accessTokenForProfile(cfg.profileId!) : cfg.apiKey;
  const headers = { authorization: cfg.authMode === "oauth" ? `Bearer ${token}` : `AugentaKey ${token}` };
  const get = async (path: string) => {
    let response: Response;
    try { response = await fetch(`${gateway.replace(/\/+$/, "")}${path}`, { headers, signal: AbortSignal.timeout(5_000) }); }
    catch { throw new CoworkError("connector_unavailable", "Cannot verify the project's Connectors; no Cowork content was queued."); }
    if (!response.ok) throw new CoworkError("connector_unavailable", `A selected Connector could not be verified (${response.status}); no Cowork content was queued.`);
    try { return await response.json() as any; }
    catch { throw new CoworkError("connector_unavailable", "The Connector check returned an invalid answer; no Cowork content was queued."); }
  };
  if (cfg.authMode === "api-key") {
    const assigned = (await get("/v1/connectors")).connectors;
    if (!Array.isArray(assigned) || assigned.length !== 1 || assigned[0]?.status !== "active" ||
      !["inbound", "bidirectional"].includes(assigned[0]?.direction) ||
      !validCoworkId(assigned[0]?.id) || !validCoworkId(assigned[0]?.workspaceId) || !validCoworkId(assigned[0]?.orgId) ||
      (cfg.destinations?.length && (cfg.destinations.length !== 1 || cfg.destinations[0]!.connectorId !== assigned[0].id || cfg.destinations[0]!.workspaceId !== assigned[0].workspaceId))) {
      throw new CoworkError("connector_unavailable", "The platform key must have exactly one active inbound Connector with the recorded assignment.");
    }
    return;
  }
  const owner = storedProfileUserId(cfg.profileId!);
  for (const destination of cfg.destinations ?? []) {
    const connector = (await get(`/v1/connectors/${encodeURIComponent(destination.connectorId)}`)).connector;
    if (!connector || connector.id !== destination.connectorId || connector.workspaceId !== destination.workspaceId ||
      connector.ownerUserId !== owner || connector.status !== "active" || !["inbound", "bidirectional"].includes(connector.direction)) {
      throw new CoworkError("connector_unavailable", "Every selected Workspace needs this person's own active inbound Connector; no Cowork content was queued.");
    }
  }
  if (!cfg.destinations?.length) throw new CoworkError("not_joined", "Join the project's complete Workspace set before binding a Cowork task.");
}

export async function bindCoworkTask(root: string, sessionId: string, transport: CoworkTransport,
  options: { transcriptPath?: string; now?: string } = {}): Promise<CoworkTaskBinding> {
  if (!validCoworkId(sessionId)) throw new CoworkError("invalid_task", "Use the confirmed Cowork engine session.id, not an attached folder or display title.");
  if (transport !== "native" && transport !== "otlp") throw new CoworkError("invalid_transport", "Choose native or otlp explicitly.");
  const cfg = loadProjectConfig(root);
  if (!cfg || !captureEnabled(cfg)) throw new CoworkError("not_joined", "Connect and join this project's complete Workspace set here before binding a Cowork task.");
  let transcriptPath: string | undefined;
  if (transport === "native") {
    try {
      transcriptPath = realpathSync(options.transcriptPath!);
      if (!statSync(transcriptPath).isFile()) throw new Error();
    } catch { throw new CoworkError("missing_transcript", "Native capture needs the confirmed transcript on this runtime. If Cowork separates the project and transcript, use a local task or the OTLP relay."); }
  } else if (options.transcriptPath) throw new CoworkError("conflicting_verbs", "An OTLP task does not take a native transcript path.");
  await verifyCoworkRoutes(cfg);
  const release = captureLock(root);
  if (!release) throw new CoworkError("busy", "Project capture is busy; retry the task binding.");
  try {
    const connection = coworkConnection(cfg);
    const latest = loadProjectConfig(root);
    if (!latest || !captureEnabled(latest) || coworkConnection(latest) !== connection) throw new CoworkError("connection_changed", "The project connection changed; bind a new task after joining it again.");
    const prior = coworkTaskBinding(root, sessionId);
    if (prior) {
      if (prior.transport !== transport || prior.connection !== connection || prior.transcriptPath !== transcriptPath) {
        throw new CoworkError("task_already_bound", "This task already has a transport and project connection. Start a new task to change either; capture cannot replay through both transports.");
      }
      return prior;
    }
    const boundAt = options.now ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(boundAt))) throw new CoworkError("invalid_time", "The binding time is invalid.");
    const binding: CoworkTaskBinding = { sessionId, transport, boundAt, connection, ...(transcriptPath ? { transcriptPath } : {}) };
    claimTask(root, binding);
    if (transcriptPath) {
      // Begin at the confirmed binding, without importing earlier task content.
      const cursor = new CaptureState(root);
      const priorCursor = cursor.get(transcriptPath);
      cursor.set(transcriptPath, { ...priorCursor, offset: statSync(transcriptPath).size });
    }
    ensureAugentaDir(root);
    writeCoworkState(coworkBindingsPath(root), { version: 1, tasks: [...readBindings(root).filter(x => x.sessionId !== sessionId), binding] });
    return binding;
  } finally { release(); }
}

/** Ordinary coding sessions retain their existing gate. A bound task is exclusive. */
export function nativeCoworkAllowed(root: string, sessionId?: string, transcriptPath?: string,
  requireBinding = process.env.AUGENTA_COWORK_NATIVE === "1"): boolean {
  if (!sessionId) return !requireBinding;
  const binding = coworkTaskBinding(root, sessionId);
  if (!binding) return !requireBinding && !existsSync(taskClaimPath(sessionId));
  if (binding.transport !== "native" || !boundCoworkConfig(root, binding)) return false;
  try { return realpathSync(transcriptPath!) === binding.transcriptPath; } catch { return false; }
}
