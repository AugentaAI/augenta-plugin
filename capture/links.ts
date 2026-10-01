/**
 * This checkout's own links into a browser project's recorded Workspaces.
 *
 * A browser connection's `.augenta/config.json` may be committed
 * (augenta-dir.ts → SHARED_IGNORE), and it records only the project's decision:
 * which Workspaces it feeds. It names no Connector, because a Connector belongs
 * to one person — the platform accepts records through it only from its owner
 * or an organization manager — so a committed Connector id would route a
 * teammate's capture through a link that refuses them, or, for a manager,
 * through someone else's link under their own name.
 *
 * Each person therefore joins with their own Connector in every recorded
 * Workspace, and this file records which. Only connect writes it: when the user
 * answers the destination question here, or joins the recorded set with
 * `--adopt`. It lives under `.augenta/state/`, which the shared ignore file never
 * un-ignores, so it never travels with the config. Its presence is also this
 * checkout's consent: config.ts routes only when it names EXACTLY the recorded
 * Workspaces, under the sign-in now stored on this machine, so a pulled change to
 * the Workspaces stops capture until someone here confirms the new set.
 *
 * Pure builtins; no config import, so capture/config.ts can use it.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAugentaDir } from "./augenta-dir";
import { documentTimestamp } from "./documents";

export interface Link {
  workspaceId: string;
  connectorId: string;
}

export interface Links {
  /** The sign-in (issuer, client, gateway, organization) the links were made under. */
  profileId: string;
  /** The person who joined: the owner of every link below. */
  userId: string;
  /** The project these links carry, from the shared config. */
  projectKey: string;
  /** When this checkout joined; Codex turns before it are not eligible. */
  joinedAt: string;
  /** Reconnect/adopt after the document disclosure. Old joins keep attachments off. */
  attachmentsConsentedAt?: string;
  /** One link per recorded Workspace, each a Connector this person owns. */
  links: Link[];
}

export function linksPath(projectRoot: string): string {
  return join(projectRoot, ".augenta", "state", "links.json");
}

/** The pre-0.11.0-release join marker this file replaces; removed when links are written. */
function legacyAdoptionPath(projectRoot: string): string {
  return join(projectRoot, ".augenta", "state", "adopted.json");
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function readLinks(projectRoot: string): Links | undefined {
  try {
    const value = JSON.parse(readFileSync(linksPath(projectRoot), "utf8")) as Partial<Links> & { version?: unknown };
    if (value.version !== 1) return undefined;
    if (!nonEmpty(value.profileId) || !nonEmpty(value.userId) || !nonEmpty(value.projectKey)) return undefined;
    if (!nonEmpty(value.joinedAt) || !Number.isFinite(Date.parse(value.joinedAt))) return undefined;
    if (!Array.isArray(value.links) || value.links.length === 0) return undefined;
    const links: Link[] = [];
    for (const item of value.links as unknown[]) {
      const link = item as Partial<Link> | null;
      if (!link || !nonEmpty(link.workspaceId) || !nonEmpty(link.connectorId)) return undefined;
      // A repeated Workspace or Connector is a damaged file, not two routes: reading
      // it would double-POST the same bytes or leave a Workspace ambiguous.
      if (links.some((seen) => seen.workspaceId === link.workspaceId || seen.connectorId === link.connectorId)) {
        return undefined;
      }
      links.push({ workspaceId: link.workspaceId, connectorId: link.connectorId });
    }
    return {
      profileId: value.profileId,
      userId: value.userId,
      projectKey: value.projectKey,
      joinedAt: new Date(value.joinedAt).toISOString(),
      ...(documentTimestamp(value.attachmentsConsentedAt) ? { attachmentsConsentedAt: documentTimestamp(value.attachmentsConsentedAt) } : {}),
      links,
    };
  } catch {
    return undefined;
  }
}

/** Atomic, 0600. Throws: connect must know when a join did not stick. */
export function writeLinks(projectRoot: string, links: Links): void {
  const dir = join(ensureAugentaDir(projectRoot), "state");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "links.json");
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      tmp,
      JSON.stringify({
        version: 1,
        profileId: links.profileId,
        userId: links.userId,
        projectKey: links.projectKey,
        joinedAt: links.joinedAt,
        ...(documentTimestamp(links.attachmentsConsentedAt) ? { attachmentsConsentedAt: documentTimestamp(links.attachmentsConsentedAt) } : {}),
        links: links.links.map(({ workspaceId, connectorId }) => ({ workspaceId, connectorId })),
      }),
      { mode: 0o600 },
    );
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  rmSync(legacyAdoptionPath(projectRoot), { force: true });
}
