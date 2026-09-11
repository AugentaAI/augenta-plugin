/**
 * Project-scoped capture consent and routing.
 *
 * No organization or Workspace coordinate is accepted as a routing or
 * authorization input. Org and destination coordinates record the user's
 * selection for display and consent checking; destinations[].connectorId is
 * the only routing key. Machine projects may hold a platform-managed API key.
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
 * destinations replaces connectorIds. Older OAuth configs are unparseable and
 * prompt a reconnect; routing choices are never read forward or migrated.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_GATEWAY =
  "https://apim-aug-platform-prod-utyom2a4bdhti.azure-api.net";
export const DEFAULT_CONTROL_URL = "https://augenta.ai";

export type AuthMode = "oauth" | "api-key";

export interface Destination {
  connectorId: string;
  workspaceId: string;
  workspaceName?: string;
}

export interface Organization {
  id: string;
  name?: string;
}

export interface ProjectConfig {
  authMode: AuthMode;
  captureSince?: string;
  profileId?: string;
  /**
   * Every destination this project feeds, in the order connect wrote them. One
   * entry per selected Workspace; derived from destinations in parsed config.
   * The key's own assignment remains the route in api-key mode.
   */
  connectorIds?: string[];
  destinations?: Destination[];
  org?: Organization;
  controlUrl?: string;
  ingestUrl?: string;
  apiKey?: string;
  endpoint?: string;
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

export function configPath(projectRoot: string): string {
  return join(projectRoot, ".augenta", "config.json");
}

export function resolveProjectRoot(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  let dir = cwd;
  for (let i = 0; i < 30; i++) {
    if (existsSync(configPath(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export function loadProjectConfig(
  projectRoot: string,
): ProjectConfig | undefined {
  try {
    const value = JSON.parse(readFileSync(configPath(projectRoot), "utf8")) as {
      authMode?: unknown;
      captureSince?: unknown;
      profileId?: unknown;
      destinations?: unknown;
      apiKey?: unknown;
      endpoint?: unknown;
      controlUrl?: unknown;
      ingestUrl?: unknown;
      org?: { id?: unknown; name?: unknown };
    };
    if (value.captureSince !== undefined && (typeof value.captureSince !== "string" || !Number.isFinite(Date.parse(value.captureSince)))) return undefined;
    const captureSince = typeof value.captureSince === "string" && Number.isFinite(Date.parse(value.captureSince))
      ? new Date(value.captureSince).toISOString() : undefined;
    const settings: Partial<ProjectConfig> = {};
    for (const key of ["endpoint", "controlUrl", "ingestUrl"] as const) {
      const raw = value[key];
      if (raw !== undefined && typeof raw !== "string") return undefined;
      if (typeof raw === "string" && raw.trim()) {
        settings[key] = raw.trim().replace(/\/+$/, "");
      }
    }
    if (value.org !== undefined) {
      if (!value.org || typeof value.org.id !== "string" || !value.org.id.trim()) return undefined;
      if (value.org.name !== undefined && typeof value.org.name !== "string") return undefined;
      settings.org = { id: value.org.id.trim(), ...(value.org.name?.trim() ? { name: value.org.name.trim() } : {}) };
    }
    const destinations = value.destinations === undefined ? undefined : parseDestinations(value.destinations);
    if (value.destinations !== undefined && !destinations) return undefined;
    if (destinations) {
      settings.destinations = destinations;
      settings.connectorIds = destinations.map((destination) => destination.connectorId);
    }
    if (value.authMode === "oauth") {
      const profileId =
        typeof value.profileId === "string" ? value.profileId.trim() : "";
      if (!profileId || !destinations) return undefined;
      return {
        ...settings,
        authMode: "oauth",
        ...(captureSince ? { captureSince } : {}),
        profileId,
        projectRoot,
      };
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

export function captureEnabled(cfg: ProjectConfig | undefined): boolean {
  if (!cfg || captureKilled()) return false;
  return cfg.authMode === "oauth"
    ? Boolean(cfg.profileId) && (cfg.connectorIds?.length ?? 0) > 0
    : Boolean(cfg.apiKey);
}
