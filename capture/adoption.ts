/**
 * Per-checkout adoption of a project's browser connection.
 *
 * A browser connection's `.augenta/config.json` may be committed
 * (augenta-dir.ts → SHARED_IGNORE), so its presence in a checkout is no longer
 * evidence that the person working there chose to capture: a teammate's clone,
 * an agent's worktree and a fresh cloud checkout all carry the file. Capture from
 * a checkout therefore also needs this marker, which only connect writes: when
 * the user answers the destination question here, or adopts the recorded set
 * with `--adopt`. It lives under `.augenta/state/`, which the shared ignore file
 * never un-ignores, so it never travels with the config.
 *
 * The marker names the exact destinations adopted. A pulled change that ADDS a
 * destination is no longer covered, so capture stops until someone here confirms
 * the new set: what a checkout sends stays a subset of what its user affirmed.
 * Pure builtins; no config import, so capture/config.ts can use it.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAugentaDir } from "./augenta-dir";

export interface Adoption {
  /** The sign-in the destinations were adopted under. */
  profileId: string;
  /** Every destination adopted, by Connector id. */
  connectorIds: string[];
  /** When this checkout joined; Codex turns before it are not eligible. */
  adoptedAt: string;
}

export function adoptionPath(projectRoot: string): string {
  return join(projectRoot, ".augenta", "state", "adopted.json");
}

export function readAdoption(projectRoot: string): Adoption | undefined {
  try {
    const value = JSON.parse(readFileSync(adoptionPath(projectRoot), "utf8")) as Partial<Adoption>;
    if (typeof value.profileId !== "string" || !value.profileId) return undefined;
    if (!Array.isArray(value.connectorIds) ||
        !value.connectorIds.every((id) => typeof id === "string" && id.length > 0)) return undefined;
    if (typeof value.adoptedAt !== "string" || !Number.isFinite(Date.parse(value.adoptedAt))) return undefined;
    return {
      profileId: value.profileId,
      connectorIds: [...value.connectorIds],
      adoptedAt: new Date(value.adoptedAt).toISOString(),
    };
  } catch {
    return undefined;
  }
}

/** Atomic, 0600. Throws: connect must know when adoption did not stick. */
export function writeAdoption(projectRoot: string, adoption: Adoption): void {
  const dir = join(ensureAugentaDir(projectRoot), "state");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "adopted.json");
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(adoption), { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** This checkout adopted this sign-in and every destination the config routes to. */
export function adoptionCovers(
  projectRoot: string,
  profileId: string,
  connectorIds: readonly string[],
): boolean {
  const adoption = readAdoption(projectRoot);
  return Boolean(
    adoption &&
      adoption.profileId === profileId &&
      connectorIds.every((id) => adoption.connectorIds.includes(id)),
  );
}
