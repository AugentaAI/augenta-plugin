/**
 * Project-scoped capture consent and routing.
 *
 * Human projects keep only a global sign-in profile reference and the
 * authoritative Connector ids — one per Neurospace the user selected. Machine
 * projects may instead hold a platform-managed API key. No organization or
 * Neurospace coordinate is accepted from project config.
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
 * 0.7.0 renamed the routing key to `connectorIds` and reads NOTHING else. A
 * config written by an older plugin uses the previous key, so it parses to
 * undefined and prompts a reconnect — the same treatment every other
 * unparseable config gets. There is no read-forward: the id it holds is a
 * routing decision made against a surface that has been renamed end to end,
 * and honouring it silently would be a guess, not a migration.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_GATEWAY =
  "https://apim-aug-platform-prod-utyom2a4bdhti.azure-api.net";

export type AuthMode = "oauth" | "api-key";

export interface ProjectConfig {
  authMode: AuthMode;
  profileId?: string;
  /**
   * Every destination this project feeds, in the order connect wrote them. One
   * entry per selected Neurospace; never empty in a parsed oauth config. Absent
   * in api-key mode, where the key's own assignment is the route.
   */
  connectorIds?: string[];
  apiKey?: string;
  endpoint?: string;
  projectRoot: string;
}

/**
 * Destinations. An ARRAY is the ONLY accepted shape — a scalar is not read, and
 * neither is any other spelling of the key (see the file header).
 *
 * Returns `[]` for anything unusable, which the caller turns into an
 * unparseable config. One bad member poisons the whole list rather than being
 * skipped: a partial destination set would ship to fewer places than the user
 * consented to while looking like a success. Duplicates are dropped — a repeated
 * id would otherwise become two cursor keys double-POSTing the same bytes to the
 * same Neurospace on every drain.
 */
function parseConnectorIds(value: { connectorIds?: unknown }): string[] {
  const raw = Array.isArray(value.connectorIds) ? value.connectorIds : [];
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return [];
    const id = item.trim();
    if (!id) return [];
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
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
      profileId?: unknown;
      connectorIds?: unknown;
      apiKey?: unknown;
      endpoint?: unknown;
    };
    const endpoint =
      typeof value.endpoint === "string" && value.endpoint.trim()
        ? value.endpoint.trim()
        : undefined;
    if (value.authMode === "oauth") {
      const profileId =
        typeof value.profileId === "string" ? value.profileId.trim() : "";
      const connectorIds = parseConnectorIds(value);
      if (!profileId || connectorIds.length === 0) return undefined;
      return {
        authMode: "oauth",
        profileId,
        connectorIds,
        ...(endpoint ? { endpoint } : {}),
        projectRoot,
      };
    }
    if (value.authMode === "api-key") {
      const apiKey =
        typeof value.apiKey === "string" ? value.apiKey.trim() : "";
      if (!apiKey) return undefined;
      return {
        authMode: "api-key",
        apiKey,
        ...(endpoint ? { endpoint } : {}),
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

export function gatewayBase(cfg?: ProjectConfig): string {
  return (process.env.AUGENTA_API_URL || cfg?.endpoint || DEFAULT_GATEWAY).replace(
    /\/+$/,
    "",
  );
}

export function experiencesUrl(cfg?: ProjectConfig): string {
  return (
    process.env.AUGENTA_INGEST_URL ||
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
