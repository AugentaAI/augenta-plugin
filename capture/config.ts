/**
 * Project-scoped capture consent and routing.
 *
 * No organization or Workspace coordinate is accepted as a routing or
 * authorization input. Org and Workspace coordinates record the user's
 * selection for display and consent checking; destinations[].connectorId is
 * the only routing key. Machine projects may hold a platform-managed API key.
 *
 * A browser (oauth) connection is two files. `.augenta/config.json` records the
 * project's decision — its `projectKey` and the `workspaces` it feeds — holds no
 * credential and no Connector, and may be committed. Each checkout's own links,
 * one Connector per recorded Workspace owned by the person who joined, live in
 * `.augenta/state/links.json` (links.ts). The parsed config composes the two:
 * `destinations` exists only when this checkout's links name exactly the
 * recorded Workspaces under the sign-in stored on this machine, so "has
 * destinations" means "joined by the person signed in here" on every path.
 * controlUrl/endpoint/ingestUrl are the file twins of the three env overrides;
 * CLI flags win over env, which wins over config, then the default.
 *
 * `authMode` names the CREDENTIAL KIND, which decides both what else the file
 * must contain and which authorization header the shipper sends.
 *
 * A config this version cannot parse — a pre-0.3.0 `{apiKey}` file from the
 * removed scripts/setup.ts, the pre-0.4.0 `authMode: "workos"` spelling, or a
 * truncated write — is deliberately NOT migrated. Reusing a stale credential or
 * routing would trade a clear reconnect for an unexplained 401, so it parses to
 * undefined and session-start.ts turns that into a one-time reconnect prompt.
 *
 * destinations replaces connectorIds, and for a browser connection `workspaces`
 * plus links.json replace destinations. An OAuth file keyed either older way is
 * unparseable and prompts a reconnect; routing choices are never read forward or
 * migrated (connect may REUSE a listed Connector the user owns, verified live,
 * after they answer the destination question again).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasStoredProfile, storedProfileUserId } from "./auth";
import { readLinks } from "./links";
import { resolveProjectRoot } from "./project";
export { resolveProjectRoot } from "./project";

export const DEFAULT_GATEWAY =
  "https://apim-aug-platform-prod-utyom2a4bdhti.azure-api.net";
export const DEFAULT_CONTROL_URL = "https://augenta.ai";

export type AuthMode = "oauth" | "api-key";

export interface Destination {
  connectorId: string;
  workspaceId: string;
  workspaceName?: string;
}

/** A Workspace a browser project feeds, as recorded in the shared config. */
export interface RecordedWorkspace {
  workspaceId: string;
  workspaceName?: string;
}

/**
 * Whether this checkout's links carry the recorded connection.
 * - `joined`: they name exactly the recorded Workspaces, under this sign-in.
 * - `none`: this checkout has not joined this connection.
 * - `signin`: it joined under a different sign-in than the one stored here —
 *   another organization or environment, or another person in the same one.
 * - `workspaces`: the recorded Workspaces changed since it joined.
 */
export type JoinState = "joined" | "none" | "signin" | "workspaces";

export interface Organization {
  id: string;
  name?: string;
}

export interface ProjectConfig {
  authMode: AuthMode;
  /** When capture began here. For a browser connection, when this checkout joined. */
  captureSince?: string;
  profileId?: string;
  /** A browser project's identity, shared by every checkout of it. Each person's
   *  Connectors carry it, which is how a fresh checkout finds its user's own. */
  projectKey?: string;
  /** The Workspaces a browser project feeds: the shared, recorded decision. */
  workspaces?: RecordedWorkspace[];
  /** How this checkout stands against that decision (browser connections only). */
  join?: JoinState;
  /**
   * Every destination this project feeds, in the order connect wrote them. One
   * entry per selected Workspace; derived from destinations in parsed config.
   * The key's own assignment remains the route in api-key mode. For a browser
   * connection both are present only while `join` is `joined`.
   */
  connectorIds?: string[];
  destinations?: Destination[];
  org?: Organization;
  controlUrl?: string;
  ingestUrl?: string;
  apiKey?: string;
  endpoint?: string;
  discoveredGateway?: string;
  /**
   * Whether the prompt hook asks this project's Workspaces about each prompt.
   * Connect records the user's answer explicitly. Absent means a config written
   * before the question existed, which keeps the behaviour it was connected
   * with (on); only `false` turns it off. The env switches still win.
   */
  autoRecall?: boolean;
  projectRoot: string;
}

/**
 * Destinations. An ARRAY is the ONLY accepted shape — a scalar is not read, and
 * neither is any other spelling of the key (see the file header).
 *
 * Returns undefined for anything unusable, which the caller turns into an
 * unparseable config. One bad member poisons the whole list rather than being
 * skipped: a partial destination set would ship to fewer places than the user
 * consented to while looking like a success. Duplicates are dropped — a repeated
 * id would otherwise become two cursor keys double-POSTing the same bytes to the
 * same Workspace on every drain.
 */
function parseDestinations(raw: unknown): Destination[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const destinations: Destination[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return undefined;
    const connectorId = typeof item.connectorId === "string" ? item.connectorId.trim() : "";
    const workspaceId = typeof item.workspaceId === "string" ? item.workspaceId.trim() : "";
    if (!connectorId || !workspaceId) return undefined;
    if (item.workspaceName !== undefined && typeof item.workspaceName !== "string") return undefined;
    if (destinations.some((destination) => destination.connectorId === connectorId)) continue;
    const workspaceName = item.workspaceName?.trim();
    destinations.push({ connectorId, workspaceId, ...(workspaceName ? { workspaceName } : {}) });
  }
  return destinations;
}

/** The recorded Workspaces: a non-empty array, one bad member poisoning it, repeats dropped. */
function parseWorkspaces(raw: unknown): RecordedWorkspace[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const workspaces: RecordedWorkspace[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return undefined;
    const workspaceId = typeof item.workspaceId === "string" ? item.workspaceId.trim() : "";
    if (!workspaceId) return undefined;
    if (item.workspaceName !== undefined && typeof item.workspaceName !== "string") return undefined;
    if (workspaces.some((workspace) => workspace.workspaceId === workspaceId)) continue;
    const workspaceName = item.workspaceName?.trim();
    workspaces.push({ workspaceId, ...(workspaceName ? { workspaceName } : {}) });
  }
  return workspaces;
}

/**
 * This checkout's routes for a browser connection, when its links carry it.
 * Exact, not a superset: a pulled change that removes a Workspace and later
 * restores it must be confirmed again, not silently covered by an old link.
 */
function joinedRoutes(
  projectRoot: string,
  profileId: string,
  projectKey: string,
  workspaces: readonly RecordedWorkspace[],
): { join: JoinState; destinations?: Destination[]; joinedAt?: string } {
  const links = readLinks(projectRoot);
  if (!links || links.projectKey !== projectKey) return { join: "none" };
  if (links.profileId !== profileId || storedProfileUserId(profileId) !== links.userId) return { join: "signin" };
  const destinations: Destination[] = [];
  for (const workspace of workspaces) {
    const link = links.links.find((entry) => entry.workspaceId === workspace.workspaceId);
    if (!link) return { join: "workspaces" };
    destinations.push({ connectorId: link.connectorId, ...workspace });
  }
  if (links.links.length !== workspaces.length) return { join: "workspaces" };
  return { join: "joined", destinations, joinedAt: links.joinedAt };
}

export function configPath(projectRoot: string): string {
  return join(projectRoot, ".augenta", "config.json");
}

export function loadProjectConfig(
  projectRoot: string,
): ProjectConfig | undefined {
  try {
    const value = JSON.parse(readFileSync(configPath(projectRoot), "utf8")) as {
      authMode?: unknown;
      captureSince?: unknown;
      profileId?: unknown;
      projectKey?: unknown;
      workspaces?: unknown;
      destinations?: unknown;
      apiKey?: unknown;
      endpoint?: unknown;
      discoveredGateway?: unknown;
      controlUrl?: unknown;
      ingestUrl?: unknown;
      autoRecall?: unknown;
      org?: { id?: unknown; name?: unknown };
    };
    if (value.captureSince !== undefined && (typeof value.captureSince !== "string" || !Number.isFinite(Date.parse(value.captureSince)))) return undefined;
    const captureSince = typeof value.captureSince === "string" && Number.isFinite(Date.parse(value.captureSince))
      ? new Date(value.captureSince).toISOString() : undefined;
    const settings: Partial<ProjectConfig> = {};
    for (const key of ["endpoint", "controlUrl", "ingestUrl", "discoveredGateway"] as const) {
      const raw = value[key];
      if (raw !== undefined && typeof raw !== "string") return undefined;
      if (typeof raw === "string" && raw.trim()) {
        settings[key] = raw.trim().replace(/\/+$/, "");
      }
    }
    if (value.autoRecall !== undefined && typeof value.autoRecall !== "boolean") return undefined;
    if (typeof value.autoRecall === "boolean") settings.autoRecall = value.autoRecall;
    if (value.org !== undefined) {
      if (!value.org || typeof value.org.id !== "string" || !value.org.id.trim()) return undefined;
      if (value.org.name !== undefined && typeof value.org.name !== "string") return undefined;
      settings.org = { id: value.org.id.trim(), ...(value.org.name?.trim() ? { name: value.org.name.trim() } : {}) };
    }
    if (value.authMode === "oauth") {
      // The pre-release shape, which recorded the connecting user's Connectors in
      // the shared file. Unparseable, so it becomes the reconnect prompt.
      if (value.destinations !== undefined) return undefined;
      const profileId =
        typeof value.profileId === "string" ? value.profileId.trim() : "";
      const projectKey =
        typeof value.projectKey === "string" ? value.projectKey.trim() : "";
      const workspaces = parseWorkspaces(value.workspaces);
      if (!profileId || !projectKey || !workspaces) return undefined;
      const routes = joinedRoutes(projectRoot, profileId, projectKey, workspaces);
      return {
        ...settings,
        authMode: "oauth",
        profileId,
        projectKey,
        workspaces,
        join: routes.join,
        ...(routes.destinations
          ? {
              destinations: routes.destinations,
              connectorIds: routes.destinations.map((destination) => destination.connectorId),
              captureSince: routes.joinedAt,
            }
          : {}),
        projectRoot,
      };
    }
    const destinations = value.destinations === undefined ? undefined : parseDestinations(value.destinations);
    if (value.destinations !== undefined && !destinations) return undefined;
    if (destinations) {
      settings.destinations = destinations;
      settings.connectorIds = destinations.map((destination) => destination.connectorId);
    }
    if (value.authMode === "api-key") {
      const apiKey =
        typeof value.apiKey === "string" ? value.apiKey.trim() : "";
      if (!apiKey || (Array.isArray(value.destinations) && value.destinations.length !== 1)) return undefined;
      return {
        ...settings,
        authMode: "api-key",
        ...(captureSince ? { captureSince } : {}),
        apiKey,
        projectRoot,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function projectConfig(cwd: string | undefined): ProjectConfig | undefined {
  const root = resolveProjectRoot(cwd);
  return root ? loadProjectConfig(root) : undefined;
}

export function controlUrl(cfg?: ProjectConfig, flag?: string): string {
  return (
    flag?.trim() || process.env.AUGENTA_CONTROL_URL?.trim() || cfg?.controlUrl || DEFAULT_CONTROL_URL
  ).replace(/\/+$/, "");
}

export function gatewayBase(cfg?: Pick<ProjectConfig, "endpoint">, flag?: string): string {
  return (flag?.trim() || process.env.AUGENTA_API_URL?.trim() || cfg?.endpoint || DEFAULT_GATEWAY).replace(
    /\/+$/,
    "",
  );
}

export function experiencesUrl(cfg?: ProjectConfig): string {
  return (
    process.env.AUGENTA_INGEST_URL ||
    cfg?.ingestUrl ||
    `${gatewayBase(cfg)}/v1/experiences`
  );
}

export function captureKilled(): boolean {
  const value = process.env.AUGENTA_CAPTURE_ENABLED;
  return value === "0" || value === "false";
}

/**
 * Why capture is or is not running for a readable config.
 *
 * - `killed`: `AUGENTA_CAPTURE_ENABLED=0`.
 * - `signed_out`: this machine has no saved sign-in for the config's profile —
 *   a fresh clone, a cloud session's new home, or a deleted auth file. A revoked
 *   or expired sign-in keeps its profile, so it is NOT this: capture keeps
 *   queueing and the re-login notice is the remedy.
 * - `not_adopted`: a browser connection this checkout has not joined, joined
 *   under another sign-in, or whose Workspaces changed since it did
 *   (capture/links.ts; `cfg.join` says which).
 * - `live`: capture runs.
 *
 * A platform key is its own consent and routing, so an API-key config is live
 * whenever it has its key.
 */
export type CaptureGate = "killed" | "signed_out" | "not_adopted" | "live";

export function captureGate(cfg: ProjectConfig): CaptureGate {
  if (captureKilled()) return "killed";
  if (cfg.authMode !== "oauth") return cfg.apiKey ? "live" : "signed_out";
  if (!cfg.profileId || !hasStoredProfile(cfg.profileId)) return "signed_out";
  if (!cfg.connectorIds?.length) return "not_adopted";
  return "live";
}

export function captureEnabled(cfg: ProjectConfig | undefined): boolean {
  return Boolean(cfg) && captureGate(cfg!) === "live";
}

/**
 * The Codex eligibility boundary for this checkout. For a browser connection it
 * is when this checkout joined, never when the shared config was first written,
 * so a teammate joining a committed config cannot make their own earlier turns
 * eligible; for a platform key, when it was connected.
 */
export function effectiveCaptureSince(cfg: ProjectConfig): string | undefined {
  return cfg.captureSince;
}
