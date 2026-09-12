/**
 * The Augenta `/v1` control-surface calls more than one entrypoint needs.
 *
 * `scripts/connect.ts` owns the connection flow and `scripts/recall.ts` asks a
 * connected project's Workspaces what they remember; both have to list
 * Workspaces, name their
 * environment, and turn a thrown fetch into a sentence. An entrypoint may not
 * import another entrypoint — bundling inlines the imported file's `isMain`
 * block into the importer, where it is TRUE and the wrong body runs first (see
 * AGENTS.md → "The runtime boundary") — so the shared half lives here.
 *
 * Nothing in this file prompts, prints, or writes. It is the request layer only:
 * callers decide what a failure means, which is what lets connect treat an
 * unreadable Connector as a missing prior destination. Recall checks that each
 * selected link is active and still matches its recorded Workspace before its
 * request door separately authorizes the Workspace.
 */
import { fetchWithProfile } from "./auth";
import { DEFAULT_CONTROL_URL } from "./config";

export interface Workspace {
  id: string;
  name: string;
}

export interface Connector {
  id: string;
  kind: string;
  direction: "inbound" | "outbound" | "bidirectional";
  status: "active" | "disabled";
  workspaceId: string;
  orgId: string;
  _etag?: string;
  harness?: string;
}

export class AugentaRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AugentaRequestError";
  }
}

export async function bearerJson<T>(
  profileId: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchWithProfile(profileId, url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AugentaRequestError(
      response.status,
      `Augenta request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await response.json()) as T;
}

/** The page {@link fetchAllWorkspaces} asks for. 200 is the largest `?limit` the
 *  API will honour (it clamps), so a normal organization costs one round trip. */
export const WORKSPACE_LIST_PAGE_SIZE = 200;
/**
 * How many pages the walk will follow before refusing.
 *
 * It THROWS at the ceiling rather than returning what it has, which is the
 * opposite of what a display surface would do — and deliberate. This list is the
 * consent question: the user picks their destinations from it, and a silently
 * partial list is a silently partial consent surface. Refusing is the honest
 * failure, and 10 pages is far past where a person is choosing anyway.
 *
 * Exported so the tests can assert the refusal names the ceiling that was
 * actually applied, rather than restating the product of two constants.
 */
export const WORKSPACE_LIST_MAX_PAGES = 10;

/**
 * Every Workspace the caller reaches, following `nextCursor` to exhaustion.
 *
 * Its own function so the terminating branch can simply RETURN and the throw
 * after the loop is unconditional — no "did we finish?" flag to leave false by
 * accident, and no path that can throw over a complete list.
 */
export async function fetchAllWorkspaces(
  profileId: string,
  gateway: string,
): Promise<Workspace[]> {
  const workspaces: Workspace[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < WORKSPACE_LIST_MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(WORKSPACE_LIST_PAGE_SIZE) });
    if (cursor) query.set("cursor", cursor);
    const body = await bearerJson<{ workspaces: Workspace[]; nextCursor?: string }>(
      profileId,
      `${gateway}/v1/workspaces?${query.toString()}`,
    );
    workspaces.push(...(body.workspaces ?? []));
    if (!body.nextCursor) return workspaces;
    /* A cursor identical to the one just sent is a stuck server, not a long list.
       Caught here rather than at the ceiling because otherwise it costs ten
       identical round trips, accumulates the same page ten times, and then blames
       the organization's size for what is an API bug. */
    if (body.nextCursor === cursor) {
      throw new Error(
        "the Workspace list did not advance — the API returned the same page cursor twice",
      );
    }
    cursor = body.nextCursor;
  }
  /* Deliberately says what was OBSERVED and not why. "More than N Workspaces" is
     one explanation; a broken cursor is another, and this code cannot tell them
     apart — so naming the first would send an operator to look at an organization
     that may have four Workspaces in it. */
  throw new Error(
    `the Workspace list did not finish within ${WORKSPACE_LIST_MAX_PAGES} pages of ` +
      `${WORKSPACE_LIST_PAGE_SIZE} — refusing to offer a partial list of destinations`,
  );
}

/**
 * One Connector as the platform currently sees it, or `undefined` when the
 * caller cannot see it at all.
 *
 * 403/404 is "not visible to this sign-in", which is a legitimate state for a
 * link recorded by a previous connect — deleted, or in an organization the user
 * has since lost access to. Anything else THROWS, so a network failure or a 500
 * is never mistaken for a missing Connector: the two mean opposite things to a
 * caller deciding whether to drop a destination.
 */
export async function currentConnector(
  profileId: string,
  gateway: string,
  id: string | undefined,
): Promise<Connector | undefined> {
  if (!id) return undefined;
  const response = await fetchWithProfile(
    profileId,
    `${gateway}/v1/connectors/${encodeURIComponent(id)}`,
  );
  if (response.status === 403 || response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`could not inspect the existing Connector (${response.status})`);
  }
  return ((await response.json()) as { connector: Connector }).connector;
}

/**
 * `prod` or the literal non-production control URL, so a caller can say which
 * environment a project is about to feed — or which one just answered a
 * question — instead of connecting dev by accident.
 *
 * Takes the resolved URL from config's controlUrl helper; this function never
 * reads environment variables itself.
 */
export function environmentLabel(controlUrl?: string): string {
  const url = (
    controlUrl?.trim() ||
    DEFAULT_CONTROL_URL
  ).replace(/\/+$/, "");
  return url === DEFAULT_CONTROL_URL ? "prod" : url;
}

/**
 * One readable sentence for any thrown failure.
 *
 * Node's fetch reports every connection-level failure as the bare string
 * "fetch failed", putting the actual cause (DNS, refused, TLS, timeout) one level
 * down in `error.cause`. Since the shipped CLIs run on Node, that string would be
 * the ENTIRE diagnosis a user or agent gets for being offline, behind a proxy, or
 * pointed at a dead control URL. Unwrap the cause so the message names something
 * actionable.
 */
export function describeError(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  if (message !== "fetch failed") return message;
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "cannot reach Augenta: the host name did not resolve. Check your network or DNS.";
  }
  if (code === "ECONNREFUSED") {
    return "cannot reach Augenta: the connection was refused. Check the URL, and any proxy or firewall.";
  }
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return "cannot reach Augenta: the TLS certificate could not be verified. Check for a TLS-intercepting proxy.";
  }
  const detail = cause?.message ?? code;
  return detail
    ? `cannot reach Augenta: ${detail}`
    : "cannot reach Augenta: the network request failed. Check your connection.";
}
