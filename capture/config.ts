/**
 * Project-scoped capture consent and routing.
 *
 * Human projects keep only a global WorkOS profile reference and authoritative
 * Neurolink id. Machine projects may instead hold a platform-managed API key.
 * No organization or Neurospace coordinate is accepted from project config.
 *
 * A pre-0.3.0 `{apiKey}` config (no `authMode`, written by the removed
 * scripts/setup.ts) is deliberately NOT auto-migrated: the wire contract changed
 * from `Bearer` + subscription-key to `AugentaKey`, so silently reusing the old
 * credential would trade a clear reconnect for an unexplained 401. It parses to
 * undefined, and session-start.ts turns that into a one-time reconnect prompt.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_GATEWAY =
  "https://apim-aug-platform-prod-utyom2a4bdhti.azure-api.net";

export interface ProjectConfig {
  authMode: "workos" | "api-key";
  profileId?: string;
  neurolinkId?: string;
  apiKey?: string;
  endpoint?: string;
  projectRoot: string;
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
      neurolinkId?: unknown;
      apiKey?: unknown;
      endpoint?: unknown;
    };
    const endpoint =
      typeof value.endpoint === "string" && value.endpoint.trim()
        ? value.endpoint.trim()
        : undefined;
    if (value.authMode === "workos") {
      const profileId =
        typeof value.profileId === "string" ? value.profileId.trim() : "";
      const neurolinkId =
        typeof value.neurolinkId === "string" ? value.neurolinkId.trim() : "";
      if (!profileId || !neurolinkId) return undefined;
      return {
        authMode: "workos",
        profileId,
        neurolinkId,
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
  return cfg.authMode === "workos"
    ? Boolean(cfg.profileId && cfg.neurolinkId)
    : Boolean(cfg.apiKey);
}
