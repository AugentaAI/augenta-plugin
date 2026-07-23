/**
 * Project-scoped config — the SINGLE source of truth for whether and where the
 * plugin ships agent activity and project memory. A user supplies ONE thing:
 * `<project>/.augenta/config.json`
 * with their Augenta API key (written by `scripts/setup.ts`).
 *
 *   • projectConfig(cwd)   — walk UP from the hook's cwd to find `.augenta/config.json`;
 *                            undefined when the project has not opted in.
 *   • gatewayBase(cfg)     — hosted API base. AUGENTA_API_URL > cfg.endpoint > {@link DEFAULT_GATEWAY}.
 *   • experiencesUrl(cfg)  — the ONE egress door (`POST …/v1/experiences`); override AUGENTA_INGEST_URL.
 *   • captureEnabled(cfg)  — config presence IS consent: a project captures iff its
 *                            config.json holds an apiKey and the kill switch
 *                            (AUGENTA_CAPTURE_ENABLED=0|false) is not set.
 *
 * Deliberate changes from the home-scoped predecessor:
 *   • NO ~/.augenta/key fallback and NO env-var key — the key lives only in the
 *     project's config.json, so consent and credential are one per-project file.
 *   • AUGENTA_INGEST_URL no longer ENABLES capture — it only redirects the
 *     destination. "No project config → every hook is a silent no-op" holds
 *     unconditionally.
 *
 * Builtins only (node:fs/path), so it runs from the installed plugin location
 * (which has no node_modules), like the rest of `capture/`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * The hosted Augenta gateway — the production front door. The plugin ships pointed
 * at prod so a fresh install + prod key just works; dev testing is the explicit
 * override via AUGENTA_API_URL. Not a secret; the per-project API key is.
 */
export const DEFAULT_GATEWAY = "https://apim-aug-platform-prod-utyom2a4bdhti.azure-api.net";

/** A parsed `<project>/.augenta/config.json`, plus where it was found. */
export interface ProjectConfig {
  /** The one Augenta credential; identity is resolved server-side from it. */
  apiKey: string;
  /** Optional per-project gateway override (beaten by AUGENTA_API_URL). */
  endpoint?: string;
  /** Absolute project root — the directory that contains `.augenta/`. */
  projectRoot: string;
}

/** Path of a project's config file given its root. */
export function configPath(projectRoot: string): string {
  return join(projectRoot, ".augenta", "config.json");
}

/**
 * Walk UP from `cwd` toward the filesystem root looking for `.augenta/config.json`
 * (the same discovery shape git uses for `.git`). Returns the containing project
 * root, or undefined when no ancestor has opted in. Capped so a pathological
 * mount can't loop forever.
 */
export function resolveProjectRoot(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  let dir = cwd;
  for (let i = 0; i < 30; i++) {
    if (existsSync(configPath(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the fs root
    dir = parent;
  }
  return undefined;
}

/**
 * Parse `<root>/.augenta/config.json`. Undefined on a missing file, malformed
 * JSON, or an empty/non-string apiKey — never throws, so a hook can call it on
 * every fire without a try/catch.
 */
export function loadProjectConfig(projectRoot: string): ProjectConfig | undefined {
  try {
    const parsed = JSON.parse(readFileSync(configPath(projectRoot), "utf8")) as {
      apiKey?: unknown;
      endpoint?: unknown;
    };
    const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    if (!apiKey) return undefined;
    const endpoint = typeof parsed.endpoint === "string" && parsed.endpoint.trim() ? parsed.endpoint.trim() : undefined;
    return { apiKey, ...(endpoint ? { endpoint } : {}), projectRoot };
  } catch {
    return undefined;
  }
}

/** Convenience: {@link resolveProjectRoot} + {@link loadProjectConfig} in one call. */
export function projectConfig(cwd: string | undefined): ProjectConfig | undefined {
  const root = resolveProjectRoot(cwd);
  return root ? loadProjectConfig(root) : undefined;
}

/** Hosted API base URL, no trailing slash. AUGENTA_API_URL > cfg.endpoint > default. */
export function gatewayBase(cfg?: ProjectConfig): string {
  return (process.env.AUGENTA_API_URL || cfg?.endpoint || DEFAULT_GATEWAY).replace(/\/+$/, "");
}

/**
 * The one egress door: trajectory and document experiences. Trajectories carry
 * scrubbed steps plus structurally-sanitized raw transcript lines; memory is a separate,
 * scrubbed `type: "doc"` envelope without events. Override with
 * AUGENTA_INGEST_URL (e.g. a local stub) — redirect only; it does NOT enable
 * capture.
 */
export function experiencesUrl(cfg?: ProjectConfig): string {
  return process.env.AUGENTA_INGEST_URL || `${gatewayBase(cfg)}/v1/experiences`;
}

/** True when the env kill switch is thrown (AUGENTA_CAPTURE_ENABLED=0|false). */
export function captureKilled(): boolean {
  const v = process.env.AUGENTA_CAPTURE_ENABLED;
  return v === "0" || v === "false";
}

/**
 * THE consent gate: a project captures iff its own `.augenta/config.json` holds
 * an apiKey and the kill switch is not thrown. Nothing else — no env target, no
 * home-dir flag — can turn capture on for a project that hasn't opted in.
 */
export function captureEnabled(cfg: ProjectConfig | undefined): boolean {
  return Boolean(cfg?.apiKey) && !captureKilled();
}
