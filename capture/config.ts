/**
 * Project-scoped capture consent and routing.
 *
 * Human projects keep only a global sign-in profile reference and the
 * authoritative Neurolink ids — one per Neurospace the user selected. Machine
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
 * WIDENING a field's shape without changing its meaning is not migration. A
 * pre-0.6.0 scalar `neurolinkId` names a live link and ships successfully today,
 * so it is read forward as the one-element `neurolinkIds` set: same id, same
 * meaning, no credential reused and no routing decision re-derived, therefore no
 * 401 for the policy to prevent. Rejecting it would instead hand a silent
 * capture outage plus a single reconnect prompt to every already-connected
 * project, for a change they never asked for. The write path emits only the
 * plural form.
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
  neurolinkIds?: string[];
  apiKey?: string;
  endpoint?: string;
  projectRoot: string;
}

/**
 * Destinations, newest format first. An ARRAY is the current format; a bare
 * string is the pre-0.6.0 spelling of the SAME routing decision and is read
 * forward as one element (see the file header).
 *
 * Returns `[]` for anything unusable, which the caller turns into an
 * unparseable config. One bad member poisons the whole list rather than being
 * skipped: a partial destination set would ship to fewer places than the user
 * consented to while looking like a success. Duplicates are dropped — a repeated
 * id would otherwise become two cursor keys double-POSTing the same bytes to the
 * same Neurospace on every drain.
 */
function parseNeurolinkIds(value: {
  neurolinkIds?: unknown;
  neurolinkId?: unknown;
}): string[] {
  const raw = Array.isArray(value.neurolinkIds)
    ? value.neurolinkIds
    : typeof value.neurolinkId === "string"
      ? [value.neurolinkId]
      : [];
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
      neurolinkIds?: unknown;
      neurolinkId?: unknown;
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
      const neurolinkIds = parseNeurolinkIds(value);
      if (!profileId || neurolinkIds.length === 0) return undefined;
      return {
        authMode: "oauth",
        profileId,
        neurolinkIds,
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
    ? Boolean(cfg.profileId) && (cfg.neurolinkIds?.length ?? 0) > 0
    : Boolean(cfg.apiKey);
}
