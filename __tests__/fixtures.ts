/**
 * Shared test fixtures for a browser (oauth) project as connect leaves it: the
 * shared `.augenta/config.json` recording the project's Workspaces, and — for a
 * checkout that has joined — its own links in `.augenta/state/links.json`.
 *
 * The parsed config routes only when the links name exactly the recorded
 * Workspaces under the sign-in stored on this machine, so a test that expects a
 * joined checkout must also store a sign-in for `profileId` whose `userId` is
 * the links' `userId` (TEST_USER_ID unless it says otherwise).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Destination } from "../capture/config";
import { writeLinks } from "../capture/links";

export const TEST_PROJECT_KEY = "project_key_test";
export const TEST_USER_ID = "user_1";

export interface OAuthProjectFixture {
  profileId: string;
  /** Every destination, in order: the recorded Workspaces and, when joined, the links. */
  destinations: readonly Destination[];
  projectKey?: string;
  /** The person the links belong to. */
  userId?: string;
  /** False writes only the shared config: a clone, worktree or cloud checkout that has not joined. */
  joined?: boolean;
  joinedAt?: string;
  /** Any other shared-config keys (endpoint, org, controlUrl, autoRecall, …). */
  extra?: Record<string, unknown>;
}

/** The shared config alone, as a teammate's commit or a fresh checkout carries it. */
export function writeSharedConfig(root: string, fixture: OAuthProjectFixture): void {
  mkdirSync(join(root, ".augenta"), { recursive: true });
  writeFileSync(
    join(root, ".augenta", "config.json"),
    JSON.stringify({
      authMode: "oauth",
      projectKey: fixture.projectKey ?? TEST_PROJECT_KEY,
      profileId: fixture.profileId,
      workspaces: fixture.destinations.map(({ workspaceId, workspaceName }) => ({ workspaceId, workspaceName })),
      ...fixture.extra,
    }),
  );
}

/** This checkout's own links, as connect leaves a joined checkout. */
export function joinCheckout(root: string, fixture: OAuthProjectFixture): void {
  writeLinks(root, {
    profileId: fixture.profileId,
    userId: fixture.userId ?? TEST_USER_ID,
    projectKey: fixture.projectKey ?? TEST_PROJECT_KEY,
    joinedAt: fixture.joinedAt ?? new Date().toISOString(),
    links: fixture.destinations.map(({ workspaceId, connectorId }) => ({ workspaceId, connectorId })),
  });
}

/** A browser project connected and, unless `joined: false`, joined here. */
export function writeOAuthProject(root: string, fixture: OAuthProjectFixture): void {
  writeSharedConfig(root, fixture);
  if (fixture.joined !== false) joinCheckout(root, fixture);
}
