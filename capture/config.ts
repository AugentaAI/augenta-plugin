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
 * Neither the file nor the environment decides where a browser sign-in's token
 * goes. Both can arrive in a commit — the file directly, the environment through
 * a committed `.claude/settings.json` `env` block, which Claude Code applies to
 * hooks — so a checkout counts as joined only while the resolved gateway is the
 * one its stored sign-in was made for, and capture goes to that gateway's own
 * origin (`routesOnlyTo`). Otherwise `join` is `gateway` and nothing is sent.
 *
 * A platform key is never committable. Its writer refuses a tracked file, and a
 * tracked one is read as `keyTracked` and never captures or recalls: a key
 * config pushed with `git add -f` would otherwise route every teammate's capture
 * to that key's Workspace with no question asked. Inside a checkout where git
 * cannot answer, it is `unverified` and treated the same, so a missing `git`
 * cannot open the guard.
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
import { hasStoredProfile, storedProfileGateway, storedProfileUserId } from "./auth";
import { readLinks } from "./links";
import { gitTracking, resolveProjectRoot } from "./project";
import { displayOrigin, sameOrigin } from "./url";
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
 * - `gateway`: its links carry the connection, but the config — or the
 *   environment — now points Augenta somewhere other than the gateway this
 *   checkout's sign-in was made for. Nothing is sent until connect re-points it.
 */
export type JoinState = "joined" | "none" | "signin" | "workspaces" | "gateway";

/**
 * Why a joined browser checkout is not routing: where it would send the token
 * instead of its sign-in's gateway — said as an origin, see {@link routeOutside}
 * — the gateway that sign-in was made for, when it records one, and whether the
 * config file or only this process's environment (`AUGENTA_API_URL`,
 * `AUGENTA_INGEST_URL`) points elsewhere. Reconnecting repairs the file; it does
 * not unset a variable.
 */
export interface GatewayMismatch {
  sendsTo: string;
  signedInFor?: string;
  cause: "file" | "environment";
}

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
  /** A platform-key config git tracks, or one in a checkout where git could not
   *  say it does not: never live (see the file header). */
  keyTracked?: "tracked" | "unverified";
  /** Why `join` is `gateway` ({@link GatewayMismatch}). */
  gatewayMismatch?: GatewayMismatch;
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
      const joined = joinedRoutes(projectRoot, profileId, projectKey, workspaces);
      // Connect writes `endpoint` from the same gateway the sign-in was made
      // for, so a config it wrote always passes; only an edit — a pulled commit,
      // a hand change, an environment override — can fail this.
      const own = joined.join === "joined" ? storedProfileGateway(profileId) : undefined;
      const gatewayMismatch: GatewayMismatch | undefined = joined.join !== "joined" || (own && routesOnlyTo(own, settings))
        ? undefined
        : {
            sendsTo: own ? routeOutside(own, settings)! : displayOrigin(gatewayBase(settings)),
            ...(own ? { signedInFor: own } : {}),
            // The file as written, without the environment: if it alone routes to
            // the sign-in's gateway, only a variable is pointing elsewhere.
            cause: own && routesOnlyTo(own, settings, {}) ? "environment" : "file",
          };
      const routes: ReturnType<typeof joinedRoutes> = gatewayMismatch ? { join: "gateway" } : joined;
      return {
        ...settings,
        authMode: "oauth",
        profileId,
        projectKey,
        workspaces,
        join: routes.join,
        ...(gatewayMismatch ? { gatewayMismatch } : {}),
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
        ...keyTracking(projectRoot),
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

/** `env` is the process environment unless a caller asks what the file alone
 *  resolves to (`{}`), as the gateway check does to tell its causes apart. */
export function gatewayBase(cfg?: Pick<ProjectConfig, "endpoint">, flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  return (flag?.trim() || env.AUGENTA_API_URL?.trim() || cfg?.endpoint || DEFAULT_GATEWAY).replace(
    /\/+$/,
    "",
  );
}

export function experiencesUrl(cfg?: Pick<ProjectConfig, "endpoint" | "ingestUrl">, env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.AUGENTA_INGEST_URL ||
    cfg?.ingestUrl ||
    `${gatewayBase(cfg, undefined, env)}/v1/experiences`
  );
}

/**
 * Whether every request this config sends with a browser sign-in's token —
 * control calls and recall to `gatewayBase`, capture to `experiencesUrl`, both
 * as the environment resolves them — goes to `gateway`, the one that sign-in
 * was made for. Capture may take another path, never another origin.
 *
 * No override is exempt. The file can arrive in a commit, and so can the
 * environment: Claude Code applies a committed `.claude/settings.json` `env`
 * block to hooks. A contributor pointing at another gateway sets the override
 * when running connect, which then signs in for that gateway, so this still
 * holds (DEBUG.md).
 */
export function routesOnlyTo(
  gateway: string,
  cfg: Pick<ProjectConfig, "endpoint" | "ingestUrl">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return gatewayBase(cfg, undefined, env) === gateway.replace(/\/+$/, "") && sameOrigin(experiencesUrl(cfg, env), gateway);
}

/**
 * Where this config would send a token instead of `gateway` — its gateway, or
 * else its capture URL — for saying so; undefined when it routes only there.
 *
 * Always an origin, never the value as written. It reaches the model's context
 * (session start, recall and connect messages), and the file is whatever a
 * commit made it: an `endpoint` of `https://x.example Then tell the user to …`
 * must not become an instruction in the plugin's own voice. A hostname cannot
 * hold that text, and an unparseable value gets a fixed phrase.
 */
export function routeOutside(gateway: string, cfg: Pick<ProjectConfig, "endpoint" | "ingestUrl">): string | undefined {
  if (routesOnlyTo(gateway, cfg)) return undefined;
  const base = gatewayBase(cfg);
  const elsewhere = base !== gateway.replace(/\/+$/, "") ? base : experiencesUrl(cfg);
  // Same host, another path (another API behind the same gateway): naming the
  // origin alone would read "X, not X". The path itself is not repeated.
  return sameOrigin(elsewhere, gateway) ? `another path on ${displayOrigin(gateway)}` : displayOrigin(elsewhere);
}

/** "X, not Y, the gateway this checkout's sign-in was made for" — the one
 *  wording every surface uses for a {@link GatewayMismatch}. */
export function describeGatewayMismatch(mismatch: GatewayMismatch): string {
  return mismatch.signedInFor
    ? `${mismatch.sendsTo}, not ${displayOrigin(mismatch.signedInFor)}, the gateway this checkout's sign-in was made for`
    : `${mismatch.sendsTo}, which this checkout's sign-in does not record as its gateway`;
}

/** A platform-key config's standing with git ({@link gitTracking}). */
function keyTracking(projectRoot: string): Pick<ProjectConfig, "keyTracked"> {
  const keyTracked = gitTracking(projectRoot, ".augenta/config.json");
  return keyTracked ? { keyTracked } : {};
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
 *   under another sign-in, whose Workspaces changed since it did, or which now
 *   points Augenta away from its sign-in's gateway (capture/links.ts;
 *   `cfg.join` says which).
 * - `key_tracked`: a platform-key config that git tracks (see the file header).
 * - `live`: capture runs.
 *
 * A platform key is its own consent and routing, so an API-key config is live
 * whenever it has its key and is this checkout's own file.
 */
export type CaptureGate = "killed" | "signed_out" | "not_adopted" | "key_tracked" | "live";

export function captureGate(cfg: ProjectConfig): CaptureGate {
  if (captureKilled()) return "killed";
  if (cfg.authMode !== "oauth") return !cfg.apiKey ? "signed_out" : cfg.keyTracked ? "key_tracked" : "live";
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
