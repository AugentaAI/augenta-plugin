/**
 * Connect one project to its Connectors, by Augenta sign-in or a platform key.
 *
 * Two front ends over the same core. A human running this in a terminal gets the
 * interactive prompts. An agent runs the `--json` verbs — `--probe`, `--login`,
 * `--await-login`, `--create-workspace`, `--workspace` — each of which returns
 * one JSON object and exits, so the sign-in link reaches the user in a bounded
 * call instead of after a poll loop nobody can see. No verb accepts or emits a
 * credential: tokens go browser → `~/.augenta/auth.json`, and `--api-key` stays
 * human/CI-only.
 *
 * A signed-in project may feed SEVERAL Workspaces — one inbound Connector each,
 * `--workspace` repeated once per destination. The answer is always the complete
 * destination set, so this file's job is to make the config a faithful record of
 * what the user just confirmed and nothing more: see `establishConnectors` for the
 * subset invariant and `linkForWorkspace` for why links are adopted, never moved.
 * A platform key stays single-destination (`verifyApiKeyConnection`).
 */
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isMain } from "../runtime/node";
// Reported to the platform as Connector metadata. One shared constant rather
// than a literal per call site — see runtime/version.ts for why.
import { PLUGIN_VERSION } from "../runtime/version";
import { ensureAugentaDir } from "../capture/augenta-dir";
import {
  DEFAULT_GATEWAY,
  gatewayBase,
  loadProjectConfig,
} from "../capture/config";
import { Outbox } from "../capture/outbox";
import {
  AugentaRequestError,
  bearerJson,
  currentConnector,
  describeError,
  environmentLabel,
  fetchAllWorkspaces,
  type Connector,
  type Workspace,
} from "../capture/platform";
import { resolveProject, type ResolvedProject } from "../capture/project";
/* Re-exported, not re-implemented. These moved to modules a second entrypoint
   can import (an entrypoint may not import another entrypoint), but they are
   still part of this file's published surface: scripts/dev-e2e.ts and
   scripts/connect.test.ts import them from here. */
export {
  resolveProject,
  resolveTargetProject,
  type ResolvedProject,
} from "../capture/project";
export {
  WORKSPACE_LIST_MAX_PAGES,
  WORKSPACE_LIST_PAGE_SIZE,
} from "../capture/platform";
import {
  augentaOAuthConfig,
  beginDeviceLogin,
  clearPendingLogin,
  deviceLogin,
  pollDeviceToken,
  readPendingLogin,
  ReLoginRequiredError,
  REQUEST_TIMEOUT_MS,
  reusableProfiles,
  savePendingLogin,
  saveDeviceProfile,
  type OAuthConfig,
} from "../capture/auth";

interface Args {
  apiKey?: string;
  project?: string;
  endpoint?: string;
  controlUrl?: string;
  harness?: "claude-code" | "codex";
  json?: boolean;
  /** Check the key ALREADY on disk against the gateway and write nothing. */
  verifyOnly?: boolean;
  probe?: boolean;
  login?: boolean;
  awaitLogin?: boolean;
  waitSeconds?: number;
  /** Every Workspace the project should feed. `--workspace` is repeatable and
   *  the list is the COMPLETE destination set, not an addition. */
  workspaces?: string[];
  /** Create one Workspace, then return the refreshed choice without connecting. */
  createWorkspace?: string;
  profile?: string;
}

/** Default `--await-login` budget. Chosen to fit inside an agent tool call's
 *  usual timeout: overrunning it would lose the whole poll, whereas returning
 *  `login_pending` early costs one cheap re-invocation. */
const DEFAULT_WAIT_SECONDS = 90;

interface MeResponse {
  user: { id: string; name: string; email: string };
  org: { id: string; name: string };
}

/** The Workspace every MEMBER is provisioned with on first sign-in — not one per
 *  organization, which is what this used to say. Only an ordering hint: it is
 *  never auto-selected, and its absence is not an error. */
const DEFAULT_WORKSPACE_NAME = "Default Workspace";

export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  /**
   * A flag is never another flag's value. Without this, `--api-key --project /p`
   * parsed as the key "--project" and went on to write a config with it — the
   * kind of typo that only shows up later as an unexplained 401.
   */
  const valueFor = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--api-key") {
      args.apiKey = valueFor(flag, i++);
    } else if (flag === "--project") {
      args.project = valueFor(flag, i++);
    } else if (flag === "--endpoint") {
      args.endpoint = valueFor(flag, i++);
    } else if (flag === "--control-url") {
      args.controlUrl = valueFor(flag, i++);
    } else if (flag === "--harness") {
      const value = valueFor(flag, i++);
      if (value !== "claude-code" && value !== "codex") {
        throw new Error("--harness must be claude-code or codex");
      }
      args.harness = value;
    } else if (flag === "--workspace") {
      // Repeatable rather than comma-separated: `valueFor` keeps validating each
      // occurrence, so `--workspace --profile p` still fails loudly. Splitting a
      // string would move that check inside the value, where an empty segment or
      // a stray comma becomes a silent mis-selection instead of an error.
      (args.workspaces ??= []).push(valueFor(flag, i++));
    } else if (flag === "--create-workspace") {
      args.createWorkspace = valueFor(flag, i++);
    } else if (flag === "--profile") {
      args.profile = valueFor(flag, i++);
    } else if (flag === "--wait") {
      const value = Number(valueFor(flag, i++));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--wait must be a positive number of seconds");
      }
      args.waitSeconds = value;
    } else if (flag === "--verify-only") {
      args.verifyOnly = true;
    } else if (flag === "--json") {
      args.json = true;
    } else if (flag === "--probe") {
      args.probe = true;
    } else if (flag === "--login") {
      args.login = true;
    } else if (flag === "--await-login") {
      args.awaitLogin = true;
    }
  }
  return args;
}

export function writeApiKeyConfig(
  projectRoot: string,
  apiKey: string,
  endpoint?: string,
): string {
  const dir = ensureAugentaDir(projectRoot);
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        authMode: "api-key",
        apiKey,
        ...(endpoint ? { endpoint } : {}),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
}

/**
 * Write the project's complete destination set, replacing whatever was there.
 *
 * Callers must pass EVERY destination, never an addition: rewriting the whole
 * file is what makes the config a faithful record of the set the user just
 * confirmed, and a read-modify-write torn halfway would silently drop a
 * destination they consented to.
 *
 * Only the plural form is emitted. Writing both spellings would let an older
 * installed plugin read the scalar, ship to that one destination, and go quietly
 * single-destination with nobody told.
 */
export function writeOAuthConfig(
  projectRoot: string,
  profileId: string,
  connectorIds: readonly string[],
  endpoint?: string,
): string {
  if (connectorIds.length === 0) {
    throw new Error("an OAuth connection requires at least one Connector");
  }
  const dir = ensureAugentaDir(projectRoot);
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        authMode: "oauth",
        profileId,
        connectorIds: [...connectorIds],
        ...(endpoint ? { endpoint } : {}),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
}

function detectedHarness(args: Args): "claude-code" | "codex" {
  return (
    args.harness ??
    (process.env.CODEX_SANDBOX || process.env.CODEX_HOME
      ? "codex"
      : "claude-code")
  );
}

/**
 * Numbered interactive pick of ONE. A single option is auto-selected — there is
 * nothing to decide. The Workspace choice deliberately does NOT come through
 * here; see {@link chooseMany}.
 */
async function choose<T>(
  prompt: string,
  values: T[],
  label: (value: T) => string,
): Promise<T> {
  if (values.length === 0) throw new Error(`no choices available for ${prompt}`);
  if (values.length === 1) return values[0]!;
  // Checked before printing: a menu nobody can answer is just noise.
  if (!input.isTTY) {
    throw new Error("run augenta:connect in an interactive terminal");
  }
  console.log(prompt);
  values.forEach((value, index) =>
    console.log(`  ${index + 1}. ${label(value)}`),
  );
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Selection [1-${values.length}]: `);
    const selected = values[Number(answer) - 1];
    if (!selected) {
      throw new Error(`invalid selection: ${answer.trim() || "(empty)"}`);
    }
    return selected;
  } finally {
    rl.close();
  }
}

/**
 * The consent gate: numbered MULTI-pick returning the complete selected set.
 *
 * This function has no shortcut, and that is the point of it being separate from
 * {@link choose}. WHICH Workspaces a project feeds is the user's consent
 * decision, so it is asked every time — including when the organization has only
 * one, and including when the project is already connected, where the current set
 * is shown pre-selected and must be re-affirmed rather than kept by default (see
 * skills/connect/SKILL.md, AGENTS.md → Privacy invariants).
 *
 * An EMPTY answer is invalid and RE-ASKS. A completed connection must feed at
 * least one Workspace; a user who changes their mind can cancel the command,
 * while deleting the project config remains the explicit off switch.
 *
 * A malformed answer RE-ASKS rather than throwing. A comma list is easy to
 * fat-finger (`1-3`, `1;3`), and this is the one gate every user has to pass, so
 * unwinding the whole run over a typo would be the wrong trade.
 */
async function chooseMany<T>(
  prompt: string,
  values: T[],
  label: (value: T) => string,
  opts: { preselected?: (value: T) => boolean } = {},
): Promise<T[]> {
  if (values.length === 0) throw new Error(`no choices available for ${prompt}`);
  if (!input.isTTY) {
    throw new Error("run augenta:connect in an interactive terminal");
  }
  console.log(prompt);
  values.forEach((value, index) => {
    const mark = opts.preselected?.(value) ? "x" : " ";
    console.log(`  ${index + 1}. [${mark}] ${label(value)}`);
  });
  const rl = createInterface({ input, output });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const answer = await rl.question(
        `Selection (comma-separated, e.g. 1,3; at least one required) [1-${values.length}]: `,
      );
      if (!answer.trim()) {
        console.log("Choose at least one Workspace, or cancel the command.");
        continue;
      }
      const selected: T[] = [];
      let bad: string | undefined;
      for (const part of answer.split(",")) {
        const value = values[Number(part.trim()) - 1];
        if (!value) {
          bad = part.trim() || "(empty)";
          break;
        }
        if (!selected.includes(value)) selected.push(value);
      }
      if (!bad) return selected;
      console.log(
        `Not a choice: ${bad}. Enter numbers from 1 to ${values.length}, separated by commas.`,
      );
    }
    throw new Error("no valid Workspace selection was given");
  } finally {
    rl.close();
  }
}

async function verifyFreshLogin(
  oauth: OAuthConfig,
  accessToken: string,
): Promise<MeResponse> {
  // Bounded like every other call: this runs the instant the user finishes
  // authorizing in the browser and BEFORE the tokens are persisted, so an
  // unreachable gateway would otherwise hang the terminal and throw the login away.
  const response = await fetch(`${oauth.gateway}/v1/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Augenta rejected the sign-in (${response.status})`);
  }
  const me = (await response.json()) as MeResponse;
  if (!me.user?.id || !me.org?.id) {
    throw new Error("this organization is not provisioned in Augenta");
  }
  return me;
}

/**
 * Stored logins that still work, freshest first. Read-only and starts no sign-in,
 * which is what lets `--probe` report the next step before the user has consented
 * to anything.
 */
async function usableProfiles(
  oauth: OAuthConfig,
  preferredProfileId?: string,
): Promise<Array<{ profileId: string; me: MeResponse }>> {
  const candidates = reusableProfiles(oauth);
  const ordered = preferredProfileId
    ? [
        ...candidates.filter((item) => item.profileId === preferredProfileId),
        ...candidates.filter((item) => item.profileId !== preferredProfileId),
      ]
    : candidates;
  const usable: Array<{
    profileId: string;
    me: MeResponse;
  }> = [];
  for (const candidate of ordered) {
    try {
      const me = await bearerJson<MeResponse>(
        candidate.profileId,
        `${oauth.gateway}/v1/me`,
      );
      usable.push({ profileId: candidate.profileId, me });
    } catch (error) {
      if (
        error instanceof ReLoginRequiredError ||
        (error instanceof AugentaRequestError &&
          (error.status === 401 || error.status === 403))
      ) {
        // Expired/revoked profiles stay isolated; a fresh login remains available.
        continue;
      }
      // A gateway/network failure is not an authentication failure. Do not
      // replace a valid profile or start a redundant device login.
      throw error;
    }
  }
  return usable;
}

/** Persist a completed device grant as a reusable global profile. */
async function saveVerifiedLogin(
  oauth: OAuthConfig,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number },
): Promise<{ profileId: string; me: MeResponse }> {
  const me = await verifyFreshLogin(oauth, tokens.accessToken);
  const saved = await saveDeviceProfile(oauth, tokens, {
    userId: me.user.id,
    orgId: me.org.id,
  });
  return { profileId: saved.profileId, me };
}

async function selectOrCreateProfile(
  oauth: OAuthConfig,
  preferredProfileId?: string,
): Promise<{ profileId: string; me: MeResponse }> {
  const usable = await usableProfiles(oauth, preferredProfileId);
  if (usable.length > 0) {
    return choose(
      "Choose the Augenta organization:",
      usable,
      // Augenta's own org id, not the IdP's: this string is shown to a person.
      (item) => `${item.me.org.name} (${item.me.org.id})`,
    );
  }
  return saveVerifiedLogin(oauth, await deviceLogin(oauth));
}

async function listWorkspaces(
  profileId: string,
  gateway: string,
): Promise<Workspace[]> {
  /* `GET /v1/workspaces` is paged (keyset over id), so the whole list is
     assembled before anything is offered — see `fetchAllWorkspaces`. */
  const workspaces = await fetchAllWorkspaces(profileId, gateway);
  if (workspaces.length === 0) {
    throw new Error("the authenticated organization has no active Workspaces");
  }
  // The platform seeds this Workspace for every organization. Keep it first in
  // both terminal and agent menus even if a backend changes list ordering.
  //
  // Keyed on the NAME, not on an id literal: the provisioned name is the part
  // README/SKILL.md promise to a user, while ids are opaque platform strings
  // this plugin has no contract over — sorting on a guessed id would be a silent
  // no-op in the field and the docs would be untrue.
  const isDefault = (workspace: Workspace) =>
    workspace.name.trim().toLowerCase() === DEFAULT_WORKSPACE_NAME.toLowerCase();
  return [...workspaces].sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)));
}

/** Create an organization Workspace without exposing the stored OAuth token. */
async function createWorkspace(
  profileId: string,
  gateway: string,
  requestedName: string,
): Promise<Workspace> {
  const name = requestedName.trim();
  if (!name) throw new Error("a Workspace name is required");
  const result = await bearerJson<
    { workspace?: Workspace; id?: string; name?: string }
  >(profileId, `${gateway}/v1/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const workspace = result.workspace ?? result;
  if (typeof workspace.id !== "string" || typeof workspace.name !== "string") {
    throw new Error("Augenta created the Workspace but returned an invalid response");
  }
  // The platform response also carries tenancy/audit fields. The agent needs
  // only the same public choice coordinates returned by listWorkspaces.
  return { id: workspace.id, name: workspace.name };
}

async function askWorkspaceName(): Promise<string> {
  if (!input.isTTY) {
    throw new Error("run augenta:connect in an interactive terminal");
  }
  const rl = createInterface({ input, output });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const name = (await rl.question("New Workspace name: ")).trim();
      if (name) return name;
      console.log("Enter a name for the new Workspace, or cancel the command.");
    }
    throw new Error("no valid Workspace name was given");
  } finally {
    rl.close();
  }
}

/** The two terminal questions this loop asks, injectable so the loop's own rules
 *  — create must be chosen alone, the refreshed set is asked again, a created
 *  Workspace is not pre-selected — are testable without a TTY. */
export interface WorkspacePrompts {
  chooseMany: typeof chooseMany;
  askWorkspaceName: typeof askWorkspaceName;
}

export async function selectedWorkspaces(
  profileId: string,
  gateway: string,
  organizationName: string,
  preselectedIds: readonly string[] = [],
  available?: readonly Workspace[],
  prompts: WorkspacePrompts = { chooseMany, askWorkspaceName },
): Promise<Workspace[]> {
  let choices = [...(available ?? (await listWorkspaces(profileId, gateway)))];
  const preselected = new Set(preselectedIds);
  type WorkspaceChoice =
    | { kind: "workspace"; workspace: Workspace }
    | { kind: "create" };
  while (true) {
    const menu: WorkspaceChoice[] = [
      ...choices.map((workspace) => ({ kind: "workspace" as const, workspace })),
      { kind: "create" },
    ];
    const selected = await prompts.chooseMany(
      "Choose every Workspace this project should feed (each one receives the full record):",
      menu,
      (choice) =>
        choice.kind === "create"
          ? "Create a new Workspace"
          : `${choice.workspace.name} (${choice.workspace.id})`,
      {
        preselected: (choice) =>
          choice.kind === "workspace" && preselected.has(choice.workspace.id),
      },
    );
    if (!selected.some((choice) => choice.kind === "create")) {
      return selected.map((choice) => (choice as { workspace: Workspace }).workspace);
    }
    if (selected.length > 1) {
      console.log(
        "Choose Create a new Workspace by itself; the complete destination list appears again after creation.",
      );
      continue;
    }
    const name = await prompts.askWorkspaceName();
    const created = await createWorkspace(profileId, gateway, name);
    console.log(
      `Created ${created.name} (${created.id}) in ${organizationName}. Choose the complete destination set.`,
    );
    // The refreshed menu shows the new Workspace UNMARKED. `[x]` means "this
    // project already feeds it", and creating a Workspace connects nothing —
    // pre-marking one the project has never fed would be exactly the inferred
    // destination the consent invariant bans (AGENTS.md → Privacy invariants).
    choices = await listWorkspaces(profileId, gateway);
  }
}

/**
 * This project's prior links, resolved. Ids that no longer resolve — deleted, or
 * in an organization the user has lost access to — are simply dropped: an
 * unreadable prior link is precisely when reconnecting has to keep working.
 */
async function priorLinks(
  profileId: string,
  gateway: string,
  ids: readonly string[],
): Promise<Connector[]> {
  const links: Connector[] = [];
  for (const id of ids) {
    // `currentConnector` throws on anything other than 403/404, which would abort
    // the whole reconnect — the opposite of this function's job. Any unreadable
    // prior link is treated as unresolved and reported by the caller.
    const link = await currentConnector(profileId, gateway, id).catch(() => undefined);
    if (link) links.push(link);
  }
  return links;
}

/**
 * The one link that carries this project into `workspace` — adopted when one of
 * this project's prior links ALREADY points there, otherwise created.
 *
 * `workspaceId` is never mutated. The pre-fan-out code retargeted the single
 * link by PATCHing a new `workspaceId` onto it, which under fan-out would (a)
 * steal a link belonging to a destination the user KEPT and (b) relabel the route
 * of history already attached to that link. Adopt-or-create instead makes "one
 * link per (project, Workspace)" a stable identity, so re-running connect with
 * the same answer converges instead of accumulating siblings.
 *
 * Adoption is scoped to ids from THIS project's config, never matched against the
 * organization's live links by `projectName` — folder names are not unique across
 * an org, so that would let one user's `~/code/api` adopt another's Connector,
 * which is a misrouting bug strictly worse than a duplicate.
 */
async function linkForWorkspace(
  projectRoot: string,
  args: Args,
  profileId: string,
  gateway: string,
  workspace: Workspace,
  adoptable: readonly Connector[],
): Promise<{ connector: Connector; action: "adopted" | "created" }> {
  const name = basename(projectRoot);
  const fields = {
    workspaceId: workspace.id,
    kind: "agent",
    direction: "inbound",
    name,
    projectName: name,
    harness: detectedHarness(args),
    client: "augenta-plugin",
    description: `Agent activity and project memory from ${name}`,
    metadata: { pluginVersion: PLUGIN_VERSION },
  };
  const existing = adoptable.find(
    (link) =>
      link.kind === "agent" &&
      link.status === "active" &&
      link.workspaceId === workspace.id,
  );
  if (existing) {
    // Refresh the mutable metadata only. `kind` is immutable and `workspaceId`
    // already matches by construction, so neither is sent.
    const { kind: _kind, workspaceId: _workspaceId, ...mutableFields } = fields;
    const connector = (
      await bearerJson<{ connector: Connector }>(
        profileId,
        `${gateway}/v1/connectors/${encodeURIComponent(existing.id)}`,
        {
          method: "PATCH",
          headers: {
            ...(existing._etag ? { "if-match": existing._etag } : {}),
          },
          body: JSON.stringify({ ...mutableFields, _etag: existing._etag }),
        },
      )
    ).connector;
    return { connector, action: "adopted" };
  }
  const connector = (
    await bearerJson<{ connector: Connector }>(
      profileId,
      `${gateway}/v1/connectors`,
      { method: "POST", body: JSON.stringify(fields) },
    )
  ).connector;
  return { connector, action: "created" };
}

async function resolveOAuth(
  args: Args,
): Promise<{ oauth: OAuthConfig; gateway: string }> {
  const discovered = await augentaOAuthConfig(args.controlUrl);
  const gateway = (args.endpoint?.trim() || discovered.gateway).replace(/\/+$/, "");
  return { oauth: { ...discovered, gateway }, gateway };
}

/**
 * The prior connection, when there is a readable one. A config too broken to
 * parse is treated as absent rather than fatal: an unreadable config is precisely
 * when reconnecting has to keep working.
 */
function priorConnection(
  projectRoot: string,
): { profileId?: string; connectorIds?: string[] } | undefined {
  if (!existsSync(join(projectRoot, ".augenta", "config.json"))) return undefined;
  try {
    const existing = loadProjectConfig(projectRoot);
    return existing?.authMode === "oauth"
      ? { profileId: existing.profileId, connectorIds: existing.connectorIds }
      : undefined;
  } catch {
    return undefined;
  }
}

/** One destination's outcome. `connectorId` is present iff it verified. */
export interface DestinationResult {
  workspaceId: string;
  workspaceName: string;
  connectorId?: string;
  action?: "created" | "adopted";
  /** Why this destination failed. Never carries a credential. */
  message?: string;
  /**
   * Set when this destination was ALREADY connected and has now been dropped
   * because it failed. Reporting it as merely "could not link" would hide a
   * change of state: the project was shipping there and no longer is.
   */
  wasConnected?: boolean;
}

/** A destination the user dropped from the set. */
export interface RemovedDestination {
  connectorId: string;
  workspaceId: string;
  workspaceName?: string;
  /** The Connector is left alone on the platform — see below. */
  disposition: "left_in_place";
}

/**
 * Link every selected Workspace, verify each, then write the config ONCE.
 *
 * Verification is per destination and NON-FATAL. The single-destination code
 * threw on a failed verify, which under fan-out would let one unreachable
 * Workspace lose the two that worked.
 *
 * The config is written once, at the end, containing only the destinations that
 * verified — never incrementally. That yields the invariant worth stating plainly:
 * **the written destination set is always a SUBSET of the set the user just
 * confirmed.** Shipping to fewer places than authorized never violates consent;
 * the reverse would. So a partial failure is a safe outcome rather than an
 * ambiguous one, and re-running connect retries the rest.
 *
 * Destinations the user dropped are removed from the config — which stops
 * shipping to them immediately, locally, with no network call that could
 * half-fail after the user was told "done" — while their Connectors are LEFT IN
 * PLACE. Disabling or deleting them would be an org-level mutation with blast
 * radius nobody was asked about, would break re-selection (adoption only takes
 * `status: "active"` links, so a disabled one would come back as a sibling), and
 * `status` is outside the mutable field set this code has ever exercised.
 */
async function establishConnectors(
  projectRoot: string,
  args: Args,
  profileId: string,
  gateway: string,
  workspaces: readonly Workspace[],
  priorConnectorIds: readonly string[],
  /** The organization's live Workspaces, so removals can be NAMED rather than
   *  reported as bare ids. */
  available: readonly Workspace[] = workspaces,
  /** Prior links resolved by the caller, to avoid a second round of GETs. */
  preresolved?: readonly Connector[],
): Promise<{
  results: DestinationResult[];
  removed: RemovedDestination[];
  /** Prior destinations that could not be resolved at all. They are dropped from
   *  the config, so they must be reported rather than vanishing. */
  unresolvedConnectorIds: string[];
  configPath?: string;
}> {
  const adoptable = preresolved ?? (await priorLinks(profileId, gateway, priorConnectorIds));
  const unresolvedConnectorIds = priorConnectorIds.filter(
    (id) => !adoptable.some((link) => link.id === id),
  );
  const priorWorkspaceIds = adoptable.map((link) => link.workspaceId);
  const results: DestinationResult[] = [];
  for (const workspace of workspaces) {
    try {
      const { connector, action } = await linkForWorkspace(
        projectRoot,
        args,
        profileId,
        gateway,
        workspace,
        adoptable,
      );
      const verified = await bearerJson<{ connector: Connector }>(
        profileId,
        `${gateway}/v1/connectors/${encodeURIComponent(connector.id)}`,
      );
      if (
        verified.connector.status !== "active" ||
        verified.connector.workspaceId !== workspace.id
      ) {
        throw new Error("Connector verification failed");
      }
      results.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        connectorId: verified.connector.id,
        action,
      });
    } catch (error) {
      results.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        message: error instanceof Error ? error.message : String(error),
        // A destination the project ALREADY fed is being dropped, not merely not
        // added. Same message either way would hide a change of state.
        ...(priorWorkspaceIds.includes(workspace.id) ? { wasConnected: true } : {}),
      });
    }
  }

  const verifiedIds = results
    .map((result) => result.connectorId)
    .filter((id): id is string => Boolean(id));
  // Removed means DESELECTED — its Workspace is not in the set the user just
  // confirmed. A destination they kept but that failed to link is a failure, not a
  // removal, and must never be reported as one.
  const selectedIds = workspaces.map((workspace) => workspace.id);
  const nameFor = (id: string): string | undefined =>
    available.find((workspace) => workspace.id === id)?.name;
  const removed = adoptable
    .filter((link) => !selectedIds.includes(link.workspaceId))
    .map((link) => {
      const name = nameFor(link.workspaceId);
      return {
        connectorId: link.id,
        workspaceId: link.workspaceId,
        ...(name ? { workspaceName: name } : {}),
        disposition: "left_in_place" as const,
      };
    });

  if (verifiedIds.length === 0) return { results, removed, unresolvedConnectorIds };
  const configPath = writeOAuthConfig(
    projectRoot,
    profileId,
    verifiedIds,
    gateway === DEFAULT_GATEWAY ? undefined : gateway,
  );
  // Stamp the outbox's destination map here, while we still know which links were
  // just CREATED. A newly added Workspace must not inherit the pending tail a
  // pre-fan-out cursor accumulated for the destination that earned it, and by the
  // time the shipper runs that distinction is gone (see Outbox.registerDestinations).
  try {
    const freshKeys = results
      .filter((result) => result.action === "created" && result.connectorId)
      .map((result) => result.connectorId!);
    new Outbox(projectRoot).registerDestinations(verifiedIds, { freshKeys });
  } catch {
    /* the shipper reconciles the set on its own; never fail a connect over this */
  }
  return { results, removed, unresolvedConnectorIds, configPath };
}

export async function connectProject(
  projectRoot: string,
  args: Args,
): Promise<void> {
  const { oauth, gateway } = await resolveOAuth(args);
  const prior = priorConnection(projectRoot);
  const selected = await selectOrCreateProfile(oauth, prior?.profileId);
  console.log(
    `Signed in as ${selected.me.user.name || selected.me.user.email} to ${selected.me.org.name} (${selected.me.org.id}).`,
  );
  const priorIds = prior?.connectorIds ?? [];
  const resolvedPrior = await priorLinks(selected.profileId, gateway, priorIds);
  const available = await listWorkspaces(selected.profileId, gateway);
  const environment = environmentLabel(args.controlUrl);

  // BEFORE the answer, not after. This is the disclosure the consent invariant
  // turns on (AGENTS.md → Privacy invariants): a list of Workspace names does not
  // tell anyone how many people can read their transcripts, and a warning that
  // arrives after the selection cannot change it.
  console.log(
    "Every Workspace you select receives the FULL record — this project's agent activity, its raw transcript lines (structurally sanitized, but NOT secret-scrubbed), and its project memory, complete, in each.",
  );
  console.log(
    "So anyone with access to ANY Workspace you select can read this project's captured activity: the audience is the union of all of them.",
  );
  if (environment !== "prod") {
    console.log(`This is the ${environment} environment, not production.`);
  }

  const workspaces = await selectedWorkspaces(
    selected.profileId,
    gateway,
    selected.me.org.name,
    resolvedPrior.map((link) => link.workspaceId),
    available,
  );
  if (workspaces.length === 0) {
    throw new Error("choose at least one Workspace");
  }

  const { results, removed, unresolvedConnectorIds, configPath: written } =
    await establishConnectors(
      projectRoot,
      args,
      selected.profileId,
      gateway,
      workspaces,
      priorIds,
      available,
      resolvedPrior,
    );
  const live = results.filter((result) => result.connectorId);
  const failed = results.filter((result) => !result.connectorId);
  if (live.length > 0) {
    console.log(
      `Wrote ${written} (0600). This project now feeds ${live
        .map((result) => `${result.workspaceName} (Connector ${result.connectorId})`)
        .join(", ")}.`,
    );
    if (live.length > 1) {
      console.log(
        "Each of those receives the full record, so the audience is the union of everyone with access to any of them.",
      );
    }
  } else {
    console.log("No destination could be linked. No config was written.");
  }
  for (const result of failed) {
    console.log(
      result.wasConnected
        ? `Could not link ${result.workspaceName}, which this project WAS feeding: ${result.message}. It has been dropped — re-run connect to restore it.`
        : `Could not link ${result.workspaceName}: ${result.message}`,
    );
  }
  // Only true once a config actually replaced the old one. With nothing written,
  // the previous destinations are all still live.
  if (written) {
    for (const entry of removed) {
      console.log(
        `No longer sending to ${entry.workspaceName ?? entry.workspaceId}. Its Connector ${entry.connectorId} is left in place and idle — remove it in Augenta if you want it gone.`,
      );
    }
    if (unresolvedConnectorIds.length > 0) {
      console.log(
        `Dropped ${unresolvedConnectorIds.join(", ")}: this project listed ${unresolvedConnectorIds.length === 1 ? "that Connector" : "those Connectors"} but ${unresolvedConnectorIds.length === 1 ? "it is" : "they are"} no longer readable with this sign-in.`,
      );
    }
  }
}

/* ---------------------------------------------------------------------------
 * Agent-driven JSON mode.
 *
 * One object out, one exit, per verb. Nothing here prompts, and nothing here
 * emits a credential — no access token, no refresh token, no device code, no
 * platform key. Every payload is safe to paste into a chat transcript, which is
 * exactly what the connect skill does with it.
 * ------------------------------------------------------------------------- */

export interface JsonPayload {
  status: string;
  [key: string]: unknown;
}

function secondsUntil(timestamp: number): number {
  return Math.max(0, Math.round((timestamp - Date.now()) / 1000));
}

/** Signed in and ready to choose a target. Also the terminal state of a
 *  successful `--await-login`, saving the caller a round trip. */
async function workspaceStep(
  profileId: string,
  gateway: string,
  me: MeResponse,
): Promise<JsonPayload> {
  const workspaces = await listWorkspaces(profileId, gateway);
  return {
    status: "need_workspace",
    profileId,
    signedInAs: {
      name: me.user.name || me.user.email,
      email: me.user.email,
      organization: me.org.name,
    },
    // No `canCreateWorkspace` flag: creation is always available to a signed-in
    // organization, so a constant `true` would be a payload field the skill has
    // to read to learn something SKILL.md already states.
    workspaces: workspaces.map(({ id, name }) => ({ id, name })),
  };
}

/**
 * The destinations this project currently feeds, resolved to Workspace names so
 * the caller can pre-select them.
 *
 * Ids that cannot be resolved are reported in `unresolvedConnectorIds` rather
 * than dropped: the project is still SHIPPING to them, so silently omitting one
 * would quietly drop a live destination out of the pre-selection — and, because
 * the answer is the complete set, out of the project's config on the next
 * reconnect. Read-only; `currentConnector` already treats 403/404 as "not
 * visible" instead of an error.
 */
async function priorDestinations(
  profileId: string,
  gateway: string,
  ids: readonly string[],
  workspaces: readonly Workspace[],
): Promise<{
  destinations: Array<{ connectorId: string; workspaceId: string; workspaceName?: string }>;
  unresolvedConnectorIds: string[];
}> {
  const destinations: Array<{
    connectorId: string;
    workspaceId: string;
    workspaceName?: string;
  }> = [];
  const unresolvedConnectorIds: string[] = [];
  for (const id of ids) {
    const link = await currentConnector(profileId, gateway, id).catch(() => undefined);
    if (!link) {
      unresolvedConnectorIds.push(id);
      continue;
    }
    const name = workspaces.find((n) => n.id === link.workspaceId)?.name;
    destinations.push({
      connectorId: link.id,
      workspaceId: link.workspaceId,
      ...(name ? { workspaceName: name } : {}),
    });
  }
  return { destinations, unresolvedConnectorIds };
}

/**
 * Read-only "what happens next". Deliberately starts NO authorization: the caller
 * needs to describe the choice and get consent before anything leaves the machine.
 *
 * An existing connection is reported as fields, not a terminal status — the skill
 * must still be able to reconnect a project to verify or change which Workspaces
 * it feeds.
 */
export async function probeConnection(
  resolved: ResolvedProject,
  args: Args,
): Promise<JsonPayload> {
  const { oauth, gateway } = await resolveOAuth(args);
  const prior = priorConnection(resolved.projectRoot);
  const priorIds = prior?.connectorIds ?? [];
  const alreadyConnected = { alreadyConnected: priorIds.length > 0 };
  const usable = await usableProfiles(oauth, prior?.profileId);
  if (usable.length === 0) return { status: "need_login", ...alreadyConnected };
  if (usable.length > 1) {
    return {
      status: "need_profile",
      ...alreadyConnected,
      profiles: usable.map((item) => ({
        profileId: item.profileId,
        organization: item.me.org.name,
        email: item.me.user.email,
      })),
    };
  }
  const step = await workspaceStep(usable[0]!.profileId, gateway, usable[0]!.me);
  return {
    ...step,
    ...alreadyConnected,
    ...(await priorDestinations(
      usable[0]!.profileId,
      gateway,
      priorIds,
      step.workspaces as Workspace[],
    )),
  };
}

/**
 * Start the grant and return the link immediately — or hand back the live one.
 *
 * Calling this twice while a grant is still valid used to mint a second link and
 * overwrite the first, silently invalidating the link the user was in the middle
 * of opening. An agent that re-ran `--login` instead of waiting could do that
 * indefinitely, which is how a non-interactive turn once looped on dead links
 * until it was killed (issue #8).
 *
 * So the verb is idempotent while a grant is live: same link, same code, real
 * remaining time. `readPendingLogin` already treats an EXPIRED grant as absent,
 * so this cannot wedge a later connect onto a dead one — an expired link falls
 * through and mints fresh, which is the one case where a replacement is right.
 *
 * Reuse requires the stored grant to belong to the issuer we just resolved:
 * pointing at a different environment must not hand back a link minted for the
 * previous one.
 */
export async function startLogin(args: Args): Promise<JsonPayload> {
  const { oauth } = await resolveOAuth(args);
  const live = readPendingLogin();
  const pending =
    live && live.issuer === oauth.issuer && live.clientId === oauth.clientId
      ? live
      : await beginDeviceLogin(oauth);
  savePendingLogin(pending);
  return {
    status: "login_started",
    verificationUri: pending.verificationUri,
    userCode: pending.userCode,
    expiresInSeconds: secondsUntil(pending.expiresAt),
  };
}

/**
 * Wait for the user to finish authorizing, bounded by `--wait`. Safe to call
 * repeatedly: `login_pending` means "still valid, ask again", and only a dead
 * grant clears the pending state.
 */
export async function awaitLogin(args: Args): Promise<JsonPayload> {
  const { oauth, gateway } = await resolveOAuth(args);
  const pending = readPendingLogin();
  if (!pending) {
    return {
      status: "error",
      code: "no_pending_login",
      message: "no sign-in is in progress; start one with --login",
    };
  }
  if (pending.issuer !== oauth.issuer || pending.clientId !== oauth.clientId) {
    // A grant from another environment can never be redeemed here.
    clearPendingLogin();
    return {
      status: "error",
      code: "no_pending_login",
      message:
        "the pending sign-in belongs to a different Augenta environment; start a new one with --login",
    };
  }
  try {
    const result = await pollDeviceToken(pending, {
      waitMs: (args.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000,
    });
    if (!result.ok) {
      // Persist any slow_down back-off so re-invocation does not reset it.
      savePendingLogin({ ...pending, intervalMs: result.intervalMs });
      return {
        status: "login_pending",
        verificationUri: pending.verificationUri,
        userCode: pending.userCode,
        expiresInSeconds: secondsUntil(pending.expiresAt),
      };
    }
    const { profileId, me } = await saveVerifiedLogin(oauth, result.tokens);
    clearPendingLogin();
    return workspaceStep(profileId, gateway, me);
  } catch (error) {
    if (error instanceof ReLoginRequiredError) {
      clearPendingLogin();
      return {
        status: "error",
        code: error.reason ?? "login_expired",
        message: error.message,
      };
    }
    throw error;
  }
}

/**
 * Create a Workspace as an explicit user-selected action, then return the live
 * list so the consent question can be asked again. Creation alone never connects
 * the project and never writes project config.
 */
export async function createWorkspaceForSelection(
  resolved: ResolvedProject,
  args: Args,
): Promise<JsonPayload> {
  const name = args.createWorkspace?.trim();
  if (!name) {
    return {
      status: "error",
      code: "workspace_name_required",
      message: "a non-empty Workspace name is required",
    };
  }
  const { oauth, gateway } = await resolveOAuth(args);
  const prior = priorConnection(resolved.projectRoot);
  const usable = await usableProfiles(oauth, args.profile ?? prior?.profileId);
  if (usable.length === 0) {
    return {
      status: "error",
      code: "not_signed_in",
      message: "no usable Augenta sign-in; start one with --login",
    };
  }
  if (usable.length > 1 && !args.profile) {
    return {
      status: "error",
      code: "need_profile",
      message:
        "several organizations are signed in; pass --profile <profileId> to choose one",
    };
  }
  const picked = args.profile
    ? usable.find((item) => item.profileId === args.profile)
    : usable[0];
  if (!picked) {
    return {
      status: "error",
      code: "unknown_profile",
      message: `no usable sign-in matches profile ${args.profile}`,
    };
  }
  const createdWorkspace = await createWorkspace(
    picked.profileId,
    gateway,
    name,
  );
  try {
    return {
      ...(await workspaceStep(picked.profileId, gateway, picked.me)),
      createdWorkspace,
    };
  } catch (error) {
    // The POST already succeeded. Reporting a generic error would invite a retry
    // that collides with the Workspace just created, so preserve that fact even
    // when the follow-up list request fails.
    return {
      status: "workspace_created",
      createdWorkspace,
      message: `Created ${createdWorkspace.name}, but could not refresh the Workspace list: ${describeError(error)}. Re-run --probe; do not create it again.`,
    };
  }
}

/**
 * Finish: bind the project to the chosen Workspaces. The answer is the COMPLETE
 * destination set — what the project feeds after this call, and nothing else.
 *
 * Every id must be one the organization actually has. Validation happens for the
 * WHOLE set before anything is created, and one bad id fails all of it: if a
 * single id does not match the live list then the answer does not match what the
 * user saw rendered, so none of it is trustworthy. Failing closed beats quietly
 * misrouting a project's transcripts, or connecting a subset nobody confirmed.
 */
export async function connectToWorkspaces(
  resolved: ResolvedProject,
  args: Args,
): Promise<JsonPayload> {
  const { oauth, gateway } = await resolveOAuth(args);
  const prior = priorConnection(resolved.projectRoot);
  const usable = await usableProfiles(oauth, args.profile ?? prior?.profileId);
  if (usable.length === 0) {
    return {
      status: "error",
      code: "not_signed_in",
      message: "no usable Augenta sign-in; start one with --login",
    };
  }
  if (usable.length > 1 && !args.profile) {
    return {
      status: "error",
      code: "need_profile",
      message:
        "several organizations are signed in; pass --profile <profileId> to choose one",
    };
  }
  const picked = args.profile
    ? usable.find((item) => item.profileId === args.profile)
    : usable[0];
  if (!picked) {
    return {
      status: "error",
      code: "unknown_profile",
      message: `no usable sign-in matches profile ${args.profile}`,
    };
  }
  const requested = [...new Set(args.workspaces ?? [])];
  if (requested.length === 0) {
    return {
      status: "error",
      code: "workspace_required",
      message: "select at least one Workspace; nothing was created or changed",
    };
  }
  const available = await listWorkspaces(picked.profileId, gateway);
  const unknown = requested.filter((id) => !available.some((item) => item.id === id));
  if (unknown.length > 0) {
    return {
      status: "error",
      code: "unknown_workspace",
      unknown,
      message: `${unknown.join(", ")} ${unknown.length === 1 ? "is not an active Workspace" : "are not active Workspaces"} in ${picked.me.org.name}; nothing was created`,
    };
  }
  // Iterate in LIVE-LIST order rather than flag order, so the config is
  // byte-deterministic however the caller happened to order its arguments.
  const workspaces = available.filter((item) => requested.includes(item.id));
  const { results, removed, unresolvedConnectorIds, configPath } = await establishConnectors(
    resolved.projectRoot,
    args,
    picked.profileId,
    gateway,
    workspaces,
    prior?.connectorIds ?? [],
    available,
  );
  const destinations = results.filter((result) => result.connectorId);
  const failed = results.filter((result) => !result.connectorId);
  if (destinations.length === 0) {
    return {
      status: "error",
      code: "no_destination_linked",
      message: `no destination could be linked; no config was written (${failed
        .map((result) => `${result.workspaceName}: ${result.message}`)
        .join("; ")})`,
    };
  }
  return {
    // A distinct status, not `connected` plus a non-empty `failed`: the caller's
    // confirmation wording has to BRANCH, and branching on a status is more
    // reliable than remembering to check whether an array is empty.
    status: failed.length > 0 ? "partially_connected" : "connected",
    destinations,
    ...(failed.length > 0
      ? {
          failed: failed.map(
            ({ workspaceId, workspaceName, message, wasConnected }) => ({
              workspaceId,
              workspaceName,
              message,
              ...(wasConnected ? { wasConnected } : {}),
            }),
          ),
        }
      : {}),
    ...(removed.length > 0 ? { removed } : {}),
    // Prior destinations dropped because they no longer resolve. Reported so the
    // caller can say they are gone instead of them vanishing from the config
    // unmentioned.
    ...(unresolvedConnectorIds.length > 0 ? { unresolvedConnectorIds } : {}),
    organization: picked.me.org.name,
    configPath,
  };
}

export async function runJsonVerb(
  resolved: ResolvedProject,
  args: Args,
): Promise<JsonPayload> {
  // The platform-key path writes a secret given on the command line, so it stays
  // outside JSON mode: an agent must never be the process that handles one.
  if (args.apiKey) {
    return {
      status: "error",
      code: "api_key_not_supported",
      message:
        "--api-key is a human/CI path and is not available in --json mode; run it directly in a terminal",
    };
  }
  // Creation and connection are separate mutations, and the destination question
  // is asked AGAIN over the refreshed list. A caller that sent both either wants
  // a destination set chosen before the new Workspace existed, or expects one
  // call to do both — so refuse rather than silently honour whichever verb this
  // dispatch happens to reach first.
  if (args.createWorkspace !== undefined && args.workspaces?.length) {
    return {
      status: "error",
      code: "conflicting_verbs",
      message:
        "--create-workspace and --workspace are separate steps; create first, then ask for the complete destination set again and pass it with --workspace",
    };
  }
  if (args.createWorkspace !== undefined) {
    return createWorkspaceForSelection(resolved, args);
  }
  if (args.workspaces?.length) return connectToWorkspaces(resolved, args);
  if (args.awaitLogin) return awaitLogin(args);
  if (args.login) return startLogin(args);
  if (args.probe) return probeConnection(resolved, args);
  return {
    status: "error",
    code: "no_verb",
    message:
      "--json requires one of --probe, --login, --await-login, --create-workspace <name>, or --workspace <id> (repeatable)",
  };
}

export async function verifyApiKeyConnection(
  apiKey: string,
  gateway: string,
): Promise<Connector> {
  const response = await fetch(
    `${gateway.replace(/\/+$/, "")}/v1/connectors`,
    {
      headers: { authorization: `AugentaKey ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Augenta rejected the platform key (${response.status})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  const connectors = ((await response.json()) as { connectors?: Connector[] })
    .connectors ?? [];
  if (connectors.length === 0) {
    throw new Error("the platform key is not assigned to a Connector");
  }
  // This ban SURVIVES fan-out, deliberately. A signed-in project fans out because
  // a human affirmed a set of Workspaces; nothing on this path affirms anything —
  // there is no consent gate here, the config format it writes has no field to
  // express a route, and the shipper sends no Connector header in api-key mode.
  // A platform key's server-side assignment IS its routing decision, so with
  // several links visible there is no non-arbitrary pick and the plugin cannot
  // verify which one the door will choose. Fail loudly now rather than let a CI
  // pipeline discover it from where its transcripts landed. Fanning a key out to
  // several Workspaces is a platform feature (assign the key to a link that does
  // it server-side, or issue one key per destination), not a plugin one.
  if (connectors.length > 1) {
    throw new Error(
      `the platform key is assigned to ${connectors.length} Connectors; capture requires exactly one`,
    );
  }
  const connector = connectors[0]!;
  if (
    connector.status !== "active" ||
    (connector.direction !== "inbound" &&
      connector.direction !== "bidirectional")
  ) {
    throw new Error("the platform key requires an active inbound Connector");
  }
  return connector;
}

/**
 * Check the key the project ALREADY has, and write nothing.
 *
 * The reason this exists: the documented way to configure an autonomous client is
 * to write `.augenta/config.json` yourself, which is right — a service configures
 * a file, and the value never becomes an `argv` entry that every local process can
 * read. But it gave up the one thing `--api-key` did well, which is
 * {@link verifyApiKeyConnection}: a key checked against the gateway BEFORE anything
 * depends on it. Without it the first sign a key is wrong is a 401 at shipping
 * time, in a hook, on a machine with nobody watching.
 *
 * So: same check, reading the key from the file instead of the command line. The
 * secret stays where it was put. Refuses an oauth project rather than pretending to
 * verify one — its credential lives in the global auth file, not here, and the
 * connect flow already reports on it.
 */
export async function verifyProjectKey(
  projectRoot: string,
  endpointOverride?: string,
): Promise<{ connector: Connector; gateway: string }> {
  const cfg = loadProjectConfig(projectRoot);
  if (!cfg) {
    throw new Error(
      "no readable .augenta/config.json in this project — nothing to verify",
    );
  }
  if (cfg.authMode !== "api-key") {
    throw new Error(
      `--verify-only checks a platform key, but this project is configured for ${cfg.authMode}`,
    );
  }
  const apiKey = cfg.apiKey?.trim();
  if (!apiKey) {
    // loadProjectConfig already refuses an empty key, so this is unreachable today
    // — asserted rather than `!`-ed because the alternative is sending the literal
    // header `AugentaKey undefined` and reporting whatever the gateway says about it.
    throw new Error("the project config has no platform key to verify");
  }
  /* Resolved through gatewayBase, NOT by re-deriving the precedence here.
     The shipper reaches the door via experiencesUrl -> gatewayBase, which reads
     AUGENTA_API_URL FIRST and only then the config's `endpoint`. Hand-rolling
     `endpoint || DEFAULT` looked equivalent and was not: with AUGENTA_API_URL set —
     which is how a local or dev environment is pointed, and what dev-plugin-e2e.ts
     does — this would have verified a different host than capture actually ships
     to, and a green check against the wrong gateway is worse than no check.

     An explicit --endpoint still wins: that is an operator saying "check this one".
     AUGENTA_INGEST_URL is deliberately not consulted — it overrides the ingest path
     only, and what is being verified here is the key and its Connector on the
     control surface. */
  const gateway = endpointOverride?.trim()
    ? endpointOverride.trim().replace(/\/+$/, "")
    : gatewayBase(cfg);
  return { connector: await verifyApiKeyConnection(apiKey, gateway), gateway };
}

export async function connectWithApiKey(
  projectRoot: string,
  apiKey: string,
  endpoint?: string,
): Promise<{ path: string; connector: Connector }> {
  const gateway = (endpoint?.trim() || DEFAULT_GATEWAY).replace(/\/+$/, "");
  const connector = await verifyApiKeyConnection(apiKey, gateway);
  return {
    path: writeApiKeyConfig(
      projectRoot,
      apiKey,
      gateway === DEFAULT_GATEWAY ? undefined : gateway,
    ),
    connector,
  };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  // Read straight off argv: parseArgs itself can throw, and a caller that asked
  // for JSON must get JSON back even for a bad flag.
  const wantsJson = argv.includes("--json");
  // One failure shape for the whole CLI, argument parsing included — every exit
  // the user can cause reads as `Augenta connect: <what went wrong>`, never a
  // stack trace.
  try {
    const args = parseArgs(argv);
    // The terminal flow offers creation inside its own menu, so this flag has no
    // meaning here. Silently ignoring it would look like a Workspace was created.
    if (args.createWorkspace !== undefined && !args.json) {
      throw new Error(
        "--create-workspace is a --json verb; the interactive flow offers Create a new Workspace in its menu",
      );
    }
    const resolved = resolveProject(args, process.cwd());
    const projectRoot = resolved.projectRoot;
    if (args.json) {
      const payload = await runJsonVerb(resolved, args);
      console.log(
        JSON.stringify(
          {
            ...payload,
            environment: environmentLabel(args.controlUrl),
            projectRoot,
            ...(resolved.worktreeRedirect
              ? { worktreeRedirect: resolved.worktreeRedirect }
              : {}),
          },
          null,
          2,
        ),
      );
      if (payload.status === "error") process.exitCode = 1;
    } else if (args.verifyOnly) {
      if (args.apiKey?.trim()) {
        // Refused rather than resolved either way. --verify-only checks the key the
        // project ALREADY has, so honouring a supplied one would change what the
        // flag means, and ignoring it would print "the platform key is accepted"
        // about a different credential than the one just named on the command line.
        throw new Error(
          "--verify-only checks the key already in .augenta/config.json; drop --api-key, or run --api-key on its own to write and verify a new one",
        );
      }
      const { connector, gateway } = await verifyProjectKey(
        projectRoot,
        args.endpoint,
      );
      console.log(
        `The platform key in .augenta/config.json is accepted by ${gateway} and resolves to Connector ${connector.id} (${connector.status}, ${connector.direction}). Nothing was written.`,
      );
    } else if (args.apiKey?.trim()) {
      const existed = existsSync(join(projectRoot, ".augenta", "config.json"));
      const { path, connector } = await connectWithApiKey(
        projectRoot,
        args.apiKey.trim(),
        args.endpoint,
      );
      console.log(
        `${existed ? "Updated" : "Wrote"} ${path} (0600). Platform-key capture is enabled through Connector ${connector.id}.`,
      );
      console.log(
        "Off switch: delete .augenta/config.json, or set AUGENTA_CAPTURE_ENABLED=0.",
      );
    } else if (!input.isTTY) {
      throw new Error(
        "signing in needs an interactive terminal; agents should use --json with --probe/--login/--await-login/--create-workspace/--workspace, and --api-key is for autonomous or CI clients.",
      );
    } else {
      await connectProject(projectRoot, args);
    }
  } catch (error) {
    const message = describeError(error);
    if (wantsJson) {
      console.log(
        JSON.stringify({ status: "error", code: "failed", message }, null, 2),
      );
    } else {
      console.error(`Augenta connect: ${message}`);
    }
    process.exitCode = 1;
  }
}
