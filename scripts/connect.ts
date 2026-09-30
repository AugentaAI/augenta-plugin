/**
 * Connect one project to its Connectors, by Augenta sign-in or a platform key.
 *
 * Two front ends over the same core. A human running this in a terminal gets the
 * interactive prompts. An agent runs the `--json` verbs — `--probe`, `--login`,
 * `--await-login`, `--create-workspace`, `--workspace`, `--auto-recall` — each of which returns
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
import { captureHealth } from "../capture/health";
import { detectedHarness } from "../capture/harness";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isMain, reexecForEnvProxy } from "../runtime/node";
// Reported to the platform as Connector metadata. One shared constant rather
// than a literal per call site — see runtime/version.ts for why.
import { PLUGIN_VERSION } from "../runtime/version";
import { ensureAugentaDir, setAugentaIgnore } from "../capture/augenta-dir";
import { readLinks, writeLinks } from "../capture/links";
import { displayOrigin, sameOrigin } from "../capture/url";
import { ephemeralProject, sessionEnvironment } from "../capture/environment";
import { blockedNetworkMessage, classifyNetworkError, diagnoseHosts } from "../capture/network";
import {
  DEFAULT_CONTROL_URL,
  DEFAULT_GATEWAY,
  configPath,
  controlUrl,
  describeGatewayMismatch,
  gatewayBase,
  loadProjectConfig,
  routeOutside,
  type Destination,
  type Organization,
  type ProjectConfig,
  type RecordedWorkspace,
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
import { gitTracking, isTrackedByGit, resolveProject, type ResolvedProject } from "../capture/project";
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
  storedProfileGateway,
  storedProfileUserId,
  type OAuthConfig,
} from "../capture/auth";

interface Args {
  apiKey?: string;
  project?: string;
  endpoint?: string;
  /** Internal, never parsed from the command line: where resolveOAuth records
   *  what this one verb must disclose. runJsonVerb makes a fresh one per call,
   *  so verbs in flight together never share it. */
  disclosures?: Disclosures;
  controlUrl?: string;
  harness?: "claude-code" | "codex";
  json?: boolean;
  /** Check the key ALREADY on disk against the gateway and write nothing. */
  verifyOnly?: boolean;
  probe?: boolean;
  health?: boolean;
  /** Correct only the selected Connectors' metadata; never rewrite consent. */
  repairHarness?: boolean;
  /** The project's automatic-recall answer. With `--workspace` it is part of
   *  the one config write; alone it changes only that setting. */
  autoRecall?: boolean;
  /** Join this checkout to the destinations its config already records. */
  adopt?: boolean;
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
    } else if (flag === "--health") {
      args.health = true;
    } else if (flag === "--repair-harness") {
      args.repairHarness = true;
    } else if (flag === "--auto-recall") {
      const value = valueFor(flag, i++);
      if (value !== "on" && value !== "off") {
        throw new Error("--auto-recall must be on or off");
      }
      args.autoRecall = value === "on";
    } else if (flag === "--adopt") {
      args.adopt = true;
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
  details: Pick<ProjectConfig, "org" | "destinations" | "controlUrl" | "ingestUrl" | "autoRecall"> = {},
): string {
  // The key goes into this file, so it must never be one git already tracks.
  // Refused before anything is written, rather than written and then warned about.
  // Fails closed where git cannot answer: capture would refuse that config anyway.
  const tracking = gitTracking(projectRoot, ".augenta/config.json");
  if (tracking) {
    throw new Error(
      tracking === "tracked"
        ? ".augenta/config.json is tracked by git, and an API-key config would put the key in it; untrack it first (git rm --cached .augenta/config.json)"
        : "git gave no answer on whether .augenta/config.json is committed, and an API-key config would put the key in it; either git is not on PATH or it refuses this repository (see git's safe.directory for a checkout owned by another user) — `git status` here shows which",
    );
  }
  const dir = ensureAugentaDir(projectRoot);
  setAugentaIgnore(projectRoot, "local");
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        authMode: "api-key",
        captureSince: new Date().toISOString(),
        apiKey,
        org: details.org ? { id: details.org.id, name: details.org.name } : undefined,
        destinations: details.destinations?.map(({ connectorId, workspaceId, workspaceName }) => ({ connectorId, workspaceId, workspaceName })),
        controlUrl: details.controlUrl,
        ingestUrl: details.ingestUrl,
        // Always written, like the OAuth config: this path asks nobody, so an
        // absent key would hand a config written by this release the
        // "connected before the question existed" reading and turn automatic
        // recall on without an answer. `false` is the question's default, and
        // a caller carrying a prior answer forward passes it here.
        autoRecall: details.autoRecall ?? false,
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
 * Write the project's complete destination set, replacing whatever was there:
 * the shared config's recorded Workspaces, then this checkout's own links.
 *
 * Callers must pass EVERY destination, never an addition: rewriting the whole
 * file is what makes the config a faithful record of the set the user just
 * confirmed, and a read-modify-write torn halfway would silently drop a
 * destination they consented to.
 *
 * The shared file names no Connector and carries no timestamp, so it may be
 * committed and stays byte-identical across a re-affirmation that changes
 * nothing. The links go in second: a crash between the two leaves this checkout
 * unjoined (capture off), never routing to a set nobody confirmed.
 */
export function writeOAuthConfig(
  projectRoot: string,
  connection: {
    profileId: string;
    /** The signed-in person, who owns every Connector in `destinations`. */
    userId: string;
    projectKey: string;
    controlUrl: string;
    endpoint: string;
    discoveredGateway?: string;
    org: Organization;
    destinations: readonly Destination[];
    ingestUrl?: string;
    /** Always written explicitly; `false` when the caller has no answer, which
     *  is the question's default. */
    autoRecall?: boolean;
    /** False for a connection made with a gateway override: its `endpoint` is
     *  this person's own choice, and committing it would stop capture for every
     *  teammate, whose sign-ins were made for discovery's gateway. */
    shared?: boolean;
  },
): string {
  if (connection.destinations.length === 0) {
    throw new Error("an OAuth connection requires at least one Connector");
  }
  const dir = ensureAugentaDir(projectRoot);
  const path = join(dir, "config.json");
  const joinedAt = new Date().toISOString();
  // Atomic: the config may be a committed file other checkouts pull, and a torn
  // write would hand every one of them an unparseable config.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(
      tmp,
      `${JSON.stringify(
        {
          authMode: "oauth",
          projectKey: connection.projectKey,
          profileId: connection.profileId,
          controlUrl: connection.controlUrl,
          endpoint: connection.endpoint,
          discoveredGateway: connection.discoveredGateway,
          org: { id: connection.org.id, name: connection.org.name },
          workspaces: connection.destinations.map(({ workspaceId, workspaceName }) => ({ workspaceId, workspaceName })),
          autoRecall: connection.autoRecall ?? false,
          ingestUrl: connection.ingestUrl,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  chmodSync(path, 0o600);
  // A browser connection holds no credential, so its config may be committed
  // and shared; each checkout still joins through connect, with its own links.
  // The user who just answered the destination question here has joined. One
  // made with a gateway override stays local (see `shared`).
  setAugentaIgnore(projectRoot, connection.shared === false ? "local" : "shared");
  writeLinks(projectRoot, {
    profileId: connection.profileId,
    userId: connection.userId,
    projectKey: connection.projectKey,
    joinedAt,
    links: connection.destinations.map(({ workspaceId, connectorId }) => ({ workspaceId, connectorId })),
  });
  return path;
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
 * The automatic-recall question. An empty answer keeps the project's current
 * explicit choice, and otherwise means off, which is the question's default.
 */
async function askAutoRecall(current: boolean | undefined): Promise<boolean> {
  if (!input.isTTY) {
    throw new Error("run augenta:connect in an interactive terminal");
  }
  const fallback = current ?? false;
  console.log(
    "Automatic recall looks up what these Workspaces remember about each prompt you submit, and hands any match to your agent. Your agent can still ask with /augenta:recall either way.",
  );
  const rl = createInterface({ input, output });
  try {
    const answer = (
      await rl.question(`Turn on automatic recall for this project? [${fallback ? "Y/n" : "y/N"}]: `)
    ).trim().toLowerCase();
    if (!answer) return fallback;
    return answer === "y" || answer === "yes";
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

/** Who a link must belong to, and which project it carries. */
export interface LinkOwner {
  /** The signed-in person (`/v1/me` user id). */
  userId: string;
  /** The project's shared identity, carried in each of its Connectors' metadata. */
  projectKey: string;
}

/**
 * Connector ids a pre-release browser config listed in the shared file itself
 * (`destinations[].connectorId`). That shape no longer parses, so these are
 * never routes: only candidates to REUSE, verified live and owned by the person
 * signed in, after they answer the destination question again. Reusing keeps
 * history attached to a link on its route instead of minting a sibling.
 */
function legacyConnectorIds(projectRoot: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(configPath(projectRoot), "utf8")) as {
      authMode?: unknown;
      destinations?: unknown;
    };
    if (raw.authMode !== "oauth" || !Array.isArray(raw.destinations)) return [];
    const ids = raw.destinations
      .map((item) => (item && typeof item === "object" ? (item as { connectorId?: unknown }).connectorId : undefined))
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/**
 * This checkout's prior links first, then a pre-release config's. Local links
 * count only when the person signed in now made them: after someone else signed
 * in on this machine they are that person's, and even resolving them would name
 * their Connectors in this person's output.
 */
function priorCandidateIds(projectRoot: string, signedIn: { userId: string }): string[] {
  const links = readLinks(projectRoot);
  // The person, not the profile: someone who moved this project to another
  // organization or environment still owns their old links, and still hears
  // which of them no longer resolve.
  const local = links && links.userId === signedIn.userId
    ? links.links.map((link) => link.connectorId)
    : [];
  return [...new Set([...local, ...legacyConnectorIds(projectRoot)])];
}

/**
 * Bytes queued here under another person's links, which joining as this person
 * leaves unsent for good: they could go only through that person's links, under
 * their sign-in, and never through this person's. Reported, not silent.
 */
function unsentFromAnotherSignIn(projectRoot: string, userId: string): number {
  const previous = readLinks(projectRoot);
  if (!previous || previous.userId === userId) return 0;
  try {
    return new Outbox(projectRoot).pendingByteCount();
  } catch {
    return 0;
  }
}

/**
 * This checkout's prior links, resolved, keeping only the signed-in person's
 * own. Ids that no longer resolve — deleted, or in an organization the user has
 * lost access to — are reported as unresolved: an unreadable prior link is
 * precisely when reconnecting has to keep working. A link that resolves but
 * belongs to someone else (an organization manager can read everyone's) is
 * dropped SILENTLY, never reported, so no output ever names a teammate's
 * Connector.
 */
async function priorLinks(
  profileId: string,
  gateway: string,
  ids: readonly string[],
  userId: string,
): Promise<{ links: Connector[]; unresolved: string[] }> {
  const links: Connector[] = [];
  const unresolved: string[] = [];
  for (const id of ids) {
    // `currentConnector` throws on anything other than 403/404, which would abort
    // the whole reconnect — the opposite of this function's job. Any unreadable
    // prior link is treated as unresolved and reported by the caller.
    const link = await currentConnector(profileId, gateway, id).catch(() => undefined);
    if (!link) unresolved.push(id);
    else if (link.ownerUserId === userId) links.push(link);
  }
  return { links, unresolved };
}

/**
 * The signed-in person's existing links for this project in `workspaceId`,
 * oldest first — how a fresh clone, worktree or cloud checkout finds the
 * Connector its user already has instead of minting another every session.
 *
 * Matched on the project's `projectKey` AND the owner, never on a folder name:
 * folder names are not unique across an organization, and a manager's listing
 * includes everyone's links. Throws on any failure, so a caller never mistakes
 * "could not look" for "has none" and creates a duplicate.
 */
async function ownProjectLinks(
  profileId: string,
  gateway: string,
  owner: LinkOwner,
  workspaceId: string,
): Promise<Connector[]> {
  const query = new URLSearchParams({ kind: "agent", status: "active", workspaceId });
  const { connectors } = await bearerJson<{ connectors?: Connector[] }>(
    profileId,
    `${gateway}/v1/connectors?${query}`,
  );
  return (connectors ?? [])
    .filter(
      (link) =>
        link.kind === "agent" &&
        link.status === "active" &&
        link.workspaceId === workspaceId &&
        link.ownerUserId === owner.userId &&
        link.metadata?.projectKey === owner.projectKey,
    )
    .sort(
      (a, b) =>
        (Date.parse(a.createdAt ?? "") || 0) - (Date.parse(b.createdAt ?? "") || 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/**
 * Every selected Workspace's adoption candidates, resolved BEFORE anything is
 * created: this checkout's own prior links in it, then — when the project
 * already had a key another checkout may have linked under — the user's other
 * links for this project there. A Workspace whose lookup failed maps to its
 * error rather than to "none", so it can fail without creating a duplicate.
 */
async function adoptionCandidates(
  profileId: string,
  gateway: string,
  owner: LinkOwner,
  workspaces: readonly Workspace[],
  prior: readonly Connector[],
  lookup: boolean,
): Promise<Map<string, Connector[] | Error>> {
  const candidates = new Map<string, Connector[] | Error>();
  for (const workspace of workspaces) {
    const own = prior.filter((link) => link.workspaceId === workspace.id);
    if (!lookup || own.some((link) => link.kind === "agent" && link.status === "active")) {
      candidates.set(workspace.id, own);
      continue;
    }
    try {
      const found = await ownProjectLinks(profileId, gateway, owner, workspace.id);
      candidates.set(workspace.id, [...own, ...found.filter((link) => !own.some((mine) => mine.id === link.id))]);
    } catch (error) {
      candidates.set(workspace.id, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return candidates;
}

/** Key-order-insensitive comparison of two small JSON objects. */
function sameMetadata(a: Record<string, unknown> | undefined, b: Record<string, unknown>): boolean {
  const canonical = (value: Record<string, unknown> | undefined) =>
    JSON.stringify(Object.entries(value ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return canonical(a) === canonical(b);
}

/**
 * The one link that carries this project into `workspace` for the signed-in
 * person — adopted when one of their links for it ALREADY points there,
 * otherwise created.
 *
 * `workspaceId` is never mutated. The pre-fan-out code retargeted the single
 * link by PATCHing a new `workspaceId` onto it, which under fan-out would (a)
 * steal a link belonging to a destination the user KEPT and (b) relabel the route
 * of history already attached to that link. Adopt-or-create instead makes "one
 * link per (person, project, Workspace)" a stable identity, so re-running connect
 * with the same answer converges instead of accumulating siblings.
 *
 * Only a link the person OWNS is ever adopted. The platform accepts records
 * through a link only from its owner or an organization manager, so a manager
 * could otherwise adopt a teammate's link and relabel it under their own name.
 */
async function linkForWorkspace(
  projectRoot: string,
  args: Args,
  profileId: string,
  gateway: string,
  workspace: Workspace,
  adoptable: readonly Connector[],
  owner: LinkOwner,
): Promise<{ connector: Connector; action: "adopted" | "created" }> {
  const name = basename(projectRoot);
  const fields = {
    workspaceId: workspace.id,
    kind: "agent",
    direction: "inbound",
    name,
    projectName: name,
    harness: detectedHarness(args.harness),
    client: "augenta-plugin",
    description: `Agent activity and project memory from ${name}`,
    metadata: { pluginVersion: PLUGIN_VERSION, projectKey: owner.projectKey } as Record<string, unknown>,
  };
  const existing = adoptable.find(
    (link) =>
      link.kind === "agent" &&
      link.status === "active" &&
      link.workspaceId === workspace.id &&
      link.ownerUserId === owner.userId,
  );
  if (existing) {
    // The platform replaces `metadata` whole, so keep whatever else it holds.
    const metadata = { ...(existing.metadata ?? {}), ...fields.metadata };
    // Unchanged is left alone: every cloud session and worktree joins afresh, and
    // a PATCH each time would churn the link's revision for nothing.
    if (
      existing.name === fields.name &&
      existing.projectName === fields.projectName &&
      // An undetected harness sends nothing, so it matches whatever label is there.
      (fields.harness === undefined || existing.harness === fields.harness) &&
      existing.client === fields.client &&
      existing.description === fields.description &&
      sameMetadata(existing.metadata, metadata)
    ) {
      return { connector: existing, action: "adopted" };
    }
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
          body: JSON.stringify({ ...mutableFields, metadata, _etag: existing._etag }),
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

/**
 * The environment and gateway this run connects with. The gateway is the one the
 * environment's discovery names, unless this run's own `--endpoint` says
 * otherwise — never the config file's `endpoint`, and never `AUGENTA_API_URL`
 * alone. Both can arrive in a commit, and whoever wrote them would choose where
 * this person signs in to and sends their token. Another gateway is stated before
 * any sign-in ({@link Disclosures}). `discovered` is what discovery named;
 * `discoveredGateway` marks a gateway that IS discovery's, whatever chose it —
 * the production label (recallEnvironment) is its only reader.
 */
async function resolveOAuth(
  args: Args,
  projectRoot = args.project ?? process.cwd(),
): Promise<{ oauth: OAuthConfig; gateway: string; control: string; discovered: string; discoveredGateway?: string }> {
  const prior = loadProjectConfig(projectRoot);
  const control = controlUrl(prior, args.controlUrl);
  const discovered = await augentaOAuthConfig(control);
  const gateway = gatewayBase({ endpoint: discovered.gateway }, args.endpoint);
  if (gateway !== discovered.gateway) {
    // The variable alone never picks where a browser sign-in goes. It can come
    // from a committed .claude/settings.json, and signing in sends the new token
    // to this gateway at once (verifyFreshLogin) — before any question could
    // name it — then binds the sign-in to it, which the capture check trusts
    // from then on. Only this run's own --endpoint, which no commit can set,
    // chooses another gateway, and it is stated before anything is sent.
    if (!args.endpoint?.trim()) throw new GatewayOverrideError("gateway_override_unconfirmed", gateway, discovered.gateway);
    // A connection made this way keeps its config out of git (writeOAuthConfig);
    // one git already tracks would carry the override to every teammate, whose
    // sign-ins were made for discovery's gateway, and stop their capture.
    // Fails closed: where git cannot answer inside a checkout, the file may be
    // committed, and the check is only as good as its worst answer.
    if (gitTracking(projectRoot, ".augenta/config.json")) {
      throw new GatewayOverrideError("override_config_tracked", gateway, discovered.gateway);
    }
  }
  // A variable left set to another gateway wins over the file in every hook
  // (gatewayBase), so the checkout this run connects would never route.
  const variable = process.env.AUGENTA_API_URL?.trim().replace(/\/+$/, "");
  if (args.endpoint?.trim() && variable && variable !== gateway) {
    throw new GatewayOverrideError("gateway_override_conflict", gateway, discovered.gateway, variable, "AUGENTA_API_URL");
  }
  // The same never-routes outcome through the other variable. AUGENTA_INGEST_URL
  // never chooses the gateway, so unlike the one above this is refused with or
  // without --endpoint: it wins over the file's `ingestUrl` in every hook, and
  // routesOnlyTo requires the capture URL to stay on the gateway's own origin —
  // the same rule connect already applies to a hand-set `ingestUrl`. A platform
  // key, which is how a local fixture receiver is pointed at, never comes here.
  const ingest = process.env.AUGENTA_INGEST_URL?.trim();
  if (ingest && !sameOrigin(ingest, gateway)) {
    throw new GatewayOverrideError("gateway_override_conflict", gateway, discovered.gateway, ingest, "AUGENTA_INGEST_URL");
  }
  // Recorded only now, past every refusal: `gatewayOverride` means this run IS
  // signing in for and sending to that gateway, which a refused one is not (its
  // message names it instead).
  if (args.disclosures && gateway !== discovered.gateway) args.disclosures.gatewayOverride = gateway;
  // Marked whenever the gateway is discovery's, however it was chosen: an
  // unmarked production gateway reads as "not production" (recallEnvironment).
  const discoveredGateway = gateway === discovered.gateway ? discovered.gateway : undefined;
  return { oauth: { ...discovered, gateway }, gateway, control, discovered: discovered.gateway, discoveredGateway };
}

/**
 * What a verb must tell the user before any sign-in that discovery alone
 * reveals: the gateway this run uses instead of discovery's. Filled by
 * resolveOAuth and spread into the verb's payload, whatever it returns.
 */
interface Disclosures {
  gatewayOverride?: string;
}

/** What differs between a pending device grant and this run — its
 *  environment (issuer or client) or its gateway — or undefined when it was
 *  started for exactly this one. A grant is redeemed by the verb that finishes
 *  it, which sends the new token to the gateway at once: the gateway named when
 *  the sign-in began must be the one it goes to. The one rule; callers word it. */
function grantMismatch(
  pending: { issuer: string; clientId: string; gateway?: string },
  oauth: OAuthConfig,
): "environment" | "gateway" | undefined {
  if (pending.issuer !== oauth.issuer || pending.clientId !== oauth.clientId) return "environment";
  return typeof pending.gateway === "string" && pending.gateway.replace(/\/+$/, "") === oauth.gateway ? undefined : "gateway";
}

/** A gateway override connect will not act on; nothing was sent to it. */
class GatewayOverrideError extends Error {
  constructor(
    readonly code: "gateway_override_unconfirmed" | "override_config_tracked" | "gateway_override_conflict",
    gateway: string,
    discovered: string,
    variable?: string,
    variableName?: "AUGENTA_API_URL" | "AUGENTA_INGEST_URL",
  ) {
    super(
      code === "gateway_override_unconfirmed"
        ? `AUGENTA_API_URL points connect at ${displayOrigin(gateway)} instead of ${displayOrigin(discovered)}, the gateway this environment's sign-in names, and connect does not sign in or send to a gateway the environment alone chose; nothing was sent. Unset AUGENTA_API_URL (check any committed .claude/settings.json), or pass --endpoint to choose that gateway yourself`
        : code === "override_config_tracked"
          ? `this connection would use the gateway ${displayOrigin(gateway)} instead of ${displayOrigin(discovered)}, and git tracks this project's .augenta/config.json (or gave no answer on whether it does), so the override would reach everyone who pulls it and stop their capture; nothing was sent. Connect without --endpoint, or untrack the config first`
          : `this connection would use the gateway ${displayOrigin(gateway)}, but ${variableName} is set to ${displayOrigin(variable!)}, and the variable would win in every hook, so this checkout would never capture; nothing was sent. Unset ${variableName} (check any committed .claude/settings.json), or make it the same gateway`,
    );
  }
}

/**
 * The prior connection, when there is a readable one. A config too broken to
 * parse is treated as absent rather than fatal: an unreadable config is precisely
 * when reconnecting has to keep working.
 */
function priorConnection(
  projectRoot: string,
): ProjectConfig | undefined {
  if (!existsSync(join(projectRoot, ".augenta", "config.json"))) return undefined;
  try {
    const existing = loadProjectConfig(projectRoot);
    return existing?.authMode === "oauth"
      ? existing
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
  /** This person's own link to it, when they had one. A Workspace recorded in a
   *  shared config they never joined has none of theirs to name. */
  connectorId?: string;
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
  connection: {
    controlUrl: string;
    org: Organization;
    discoveredGateway?: string;
    /** Whether `gateway` is the one discovery names, so the config may be shared. */
    shared: boolean;
    owner: LinkOwner;
    /** Whether `owner.projectKey` predates this run, so other checkouts may hold
     *  links under it worth finding. A key minted now has none anywhere. */
    knownProject: boolean;
    /** The Workspaces the shared config records before this answer. */
    recorded?: readonly RecordedWorkspace[];
  },
  workspaces: readonly Workspace[],
  priorConnectorIds: readonly string[],
  /** The organization's live Workspaces, so removals can be NAMED rather than
   *  reported as bare ids. */
  available: readonly Workspace[] = workspaces,
  /** Prior links resolved by the caller, to avoid a second round of GETs. */
  preresolved?: { links: Connector[]; unresolved: string[] },
): Promise<{
  results: DestinationResult[];
  removed: RemovedDestination[];
  /** Prior destinations that could not be resolved at all. They are dropped from
   *  the config, so they must be reported rather than vanishing. */
  unresolvedConnectorIds: string[];
  configPath?: string;
  /** Queued bytes another person's links here will now never send. */
  unsentFromAnotherSignIn?: number;
}> {
  const prior = preresolved ?? (await priorLinks(profileId, gateway, priorConnectorIds, connection.owner.userId));
  const adoptable = prior.links;
  const unresolvedConnectorIds = prior.unresolved;
  // What the project fed before this answer: the recorded set, plus any
  // Workspace this person still had a link into.
  const priorWorkspaceIds = [
    ...new Set([
      ...(connection.recorded ?? []).map((workspace) => workspace.workspaceId),
      ...adoptable.map((link) => link.workspaceId),
    ]),
  ];
  const candidates = await adoptionCandidates(
    profileId,
    gateway,
    connection.owner,
    workspaces,
    adoptable,
    connection.knownProject,
  );
  const results = await linkWorkspaces(projectRoot, args, profileId, gateway, connection.owner, workspaces, candidates);
  for (const result of results) {
    // A destination the project ALREADY fed is being dropped, not merely not
    // added. Same message either way would hide a change of state.
    if (!result.connectorId && priorWorkspaceIds.includes(result.workspaceId)) result.wasConnected = true;
  }

  const verifiedIds = results
    .map((result) => result.connectorId)
    .filter((id): id is string => Boolean(id));
  // Removed means DESELECTED — its Workspace is not in the set the user just
  // confirmed. A destination they kept but that failed to link is a failure, not a
  // removal, and must never be reported as one.
  const selectedIds = workspaces.map((workspace) => workspace.id);
  const nameFor = (id: string): string | undefined =>
    available.find((workspace) => workspace.id === id)?.name ??
    connection.recorded?.find((workspace) => workspace.workspaceId === id)?.workspaceName;
  const removed = priorWorkspaceIds
    .filter((id) => !selectedIds.includes(id))
    .map((workspaceId) => {
      const name = nameFor(workspaceId);
      const own = adoptable.find((link) => link.workspaceId === workspaceId);
      return {
        ...(own ? { connectorId: own.id } : {}),
        workspaceId,
        ...(name ? { workspaceName: name } : {}),
        disposition: "left_in_place" as const,
      };
    });

  if (verifiedIds.length === 0) return { results, removed, unresolvedConnectorIds };
  const previous = loadProjectConfig(projectRoot);
  const unsent = unsentFromAnotherSignIn(projectRoot, connection.owner.userId);
  const configPath = writeOAuthConfig(projectRoot, {
    profileId,
    userId: connection.owner.userId,
    projectKey: connection.owner.projectKey,
    controlUrl: connection.controlUrl,
    org: connection.org,
    discoveredGateway: connection.discoveredGateway,
    shared: connection.shared,
    endpoint: gateway,
    destinations: results
      .filter((result): result is DestinationResult & { connectorId: string } => Boolean(result.connectorId))
      .map(({ connectorId, workspaceId, workspaceName }) => ({ connectorId, workspaceId, workspaceName })),
    // The answer given now, else the project's previous explicit answer. A
    // config that never recorded one gets the question's default, off.
    autoRecall: args.autoRecall ?? previous?.autoRecall ?? false,
    // A hand-set capture path is kept only on this gateway's own origin: the
    // previous file may be a pulled commit, and capture carries the token.
    // Compared as written: the environment's own override is not what is kept.
    ingestUrl: previous?.ingestUrl && sameOrigin(previous.ingestUrl, gateway) ? previous.ingestUrl : undefined,
  });
  // Stamp the outbox's destination map here, while we still know which links
  // are new to this checkout. A newly added Workspace must not inherit the
  // pending tail a pre-fan-out cursor accumulated for the destination that earned
  // it, and by the time the shipper runs that distinction is gone (see
  // Outbox.registerDestinations).
  try {
    const freshKeys = results
      .filter((result) => result.connectorId && (result.action === "created" || !priorConnectorIds.includes(result.connectorId)))
      .map((result) => result.connectorId!);
    new Outbox(projectRoot).registerDestinations(verifiedIds, { freshKeys });
  } catch {
    /* the shipper reconciles the set on its own; never fail a connect over this */
  }
  return { results, removed, unresolvedConnectorIds, configPath, ...(unsent > 0 ? { unsentFromAnotherSignIn: unsent } : {}) };
}

/**
 * Adopt or create, then verify, the person's own link in each Workspace. Writes
 * nothing locally; per-destination and NON-FATAL, so the caller decides whether
 * a subset is acceptable (connect) or nothing is (joining).
 */
async function linkWorkspaces(
  projectRoot: string,
  args: Args,
  profileId: string,
  gateway: string,
  owner: LinkOwner,
  workspaces: readonly Workspace[],
  candidates: Map<string, Connector[] | Error>,
): Promise<DestinationResult[]> {
  const results: DestinationResult[] = [];
  for (const workspace of workspaces) {
    try {
      const adoptable = candidates.get(workspace.id) ?? [];
      if (adoptable instanceof Error) throw adoptable;
      const { connector, action } = await linkForWorkspace(
        projectRoot,
        args,
        profileId,
        gateway,
        workspace,
        adoptable,
        owner,
      );
      const verified = await bearerJson<{ connector: Connector }>(
        profileId,
        `${gateway}/v1/connectors/${encodeURIComponent(connector.id)}`,
      );
      if (
        verified.connector.status !== "active" ||
        verified.connector.workspaceId !== workspace.id ||
        verified.connector.ownerUserId !== owner.userId
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
      });
    }
  }
  return results;
}

function ephemeralProjectMessage(projectRoot: string): string {
  const session = sessionEnvironment();
  return `this session's machine is discarded when the session ends (${session.signals.join(", ")}), and ` +
    `${projectRoot} is not inside a Git checkout, so a connection written here could not outlast it; ` +
    "connect from a local session instead (in Cowork, a local session with the project folder attached)";
}

export async function connectProject(
  projectRoot: string,
  args: Args,
): Promise<void> {
  if (ephemeralProject(projectRoot)) throw new Error(ephemeralProjectMessage(projectRoot));
  const { oauth, gateway, control, discovered, discoveredGateway } = await resolveOAuth(args, projectRoot);
  const prior = priorConnection(projectRoot);
  const environment = environmentLabel(control);
  // BEFORE the sign-in, not only before the answer: signing in sends the new
  // token to this environment's gateway at once, and the sign-in page belongs
  // to its issuer. A non-production environment or a gateway override is said
  // while declining still sends nothing.
  if (environment !== "prod") {
    console.log(`This is the ${environment} environment, not production.`);
  }
  if (gateway !== discovered) {
    console.log(`This connection uses the gateway ${displayOrigin(gateway)} instead of ${displayOrigin(discovered)}, the one this environment's sign-in names.`);
  }
  if (prior?.controlUrl && prior.controlUrl !== control) {
    console.log(`This project is moving from ${environmentLabel(prior.controlUrl)} to ${environment}.`);
  }
  const selected = await selectOrCreateProfile(oauth, prior?.profileId);
  console.log(
    `Signed in as ${selected.me.user.name || selected.me.user.email} to ${selected.me.org.name} (${selected.me.org.id}).`,
  );
  const priorIds = priorCandidateIds(projectRoot, { userId: selected.me.user.id });
  const owner: LinkOwner = { userId: selected.me.user.id, projectKey: prior?.projectKey ?? randomUUID() };
  const resolvedPrior = await priorLinks(selected.profileId, gateway, priorIds, owner.userId);
  const available = await listWorkspaces(selected.profileId, gateway);

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
  // Said again beside the destination question, which is the answer they bear on.
  if (environment !== "prod") {
    console.log(`This is the ${environment} environment, not production.`);
  }
  if (gateway !== discovered) {
    console.log(`This connection uses the gateway ${displayOrigin(gateway)}, not the one this environment's sign-in names.`);
  }
  if (prior && isTrackedByGit(projectRoot, ".augenta/config.json")) {
    console.log(
      "Git tracks this project's .augenta/config.json, so the set you choose changes the Workspaces for everyone who pulls it.",
    );
  }

  // Pre-selected: the Workspaces the project records, and any this person still
  // links into. The answer must still re-affirm them.
  const workspaces = await selectedWorkspaces(
    selected.profileId,
    gateway,
    selected.me.org.name,
    [
      ...(prior?.workspaces ?? []).map((workspace) => workspace.workspaceId),
      ...resolvedPrior.links.map((link) => link.workspaceId),
    ],
    available,
  );
  if (workspaces.length === 0) {
    throw new Error("choose at least one Workspace");
  }
  const autoRecall = args.autoRecall ?? (await askAutoRecall(loadProjectConfig(projectRoot)?.autoRecall));

  const { results, removed, unresolvedConnectorIds, configPath: written, unsentFromAnotherSignIn: unsent } =
    await establishConnectors(
      projectRoot,
      { ...args, autoRecall },
      selected.profileId,
      gateway,
      {
        controlUrl: control,
        org: selected.me.org,
        discoveredGateway,
        shared: gateway === discovered,
        owner,
        knownProject: Boolean(prior?.projectKey),
        recorded: prior?.workspaces,
      },
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
    console.log(`Automatic recall is ${autoRecall ? "on" : "off"} for this project.`);
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
        entry.connectorId
          ? `No longer sending to ${entry.workspaceName ?? entry.workspaceId}. Its Connector ${entry.connectorId} is left in place and idle — remove it in Augenta if you want it gone.`
          : `No longer sending to ${entry.workspaceName ?? entry.workspaceId}.`,
      );
    }
    if (unresolvedConnectorIds.length > 0) {
      console.log(
        `Dropped ${unresolvedConnectorIds.join(", ")}: this project listed ${unresolvedConnectorIds.length === 1 ? "that Connector" : "those Connectors"} but ${unresolvedConnectorIds.length === 1 ? "it is" : "they are"} no longer readable with this sign-in.`,
      );
    }
    if (unsent) {
      console.log(
        `${unsent} bytes of records captured here under another person's sign-in were not sent and will not be: they could go only through that person's own Connectors.`,
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
 * For a browser config these are the Workspaces it RECORDS, whether or not this
 * checkout has joined: that is the set the answer re-affirms. This person's own
 * link into each is named when they have one here, and checked live.
 *
 * Ids that cannot be resolved are reported in `unresolvedConnectorIds` rather
 * than dropped: the project is still SHIPPING to them, so silently omitting one
 * would quietly drop a live destination out of the pre-selection — and, because
 * the answer is the complete set, out of the project's config on the next
 * reconnect. Read-only; `currentConnector` already treats 403/404 as "not
 * visible" instead of an error. A link that resolves to someone else's is
 * skipped without being named.
 */
async function priorDestinations(
  profileId: string,
  gateway: string,
  userId: string,
  prior: ProjectConfig | undefined,
  ids: readonly string[],
  workspaces: readonly Workspace[],
): Promise<{
  destinations: Array<{ connectorId?: string; workspaceId: string; workspaceName?: string }>;
  unresolvedConnectorIds: string[];
}> {
  const destinations: Array<{
    connectorId?: string;
    workspaceId: string;
    workspaceName?: string;
  }> = [];
  const unresolvedConnectorIds: string[] = [];
  if (prior?.workspaces) {
    for (const recorded of prior.workspaces) {
      const name = workspaces.find((n) => n.id === recorded.workspaceId)?.name;
      const mine = prior.destinations?.find((destination) => destination.workspaceId === recorded.workspaceId);
      let connectorId: string | undefined;
      if (mine) {
        const link = await currentConnector(profileId, gateway, mine.connectorId).catch(() => undefined);
        if (link?.ownerUserId === userId) connectorId = link.id;
        else unresolvedConnectorIds.push(mine.connectorId);
      }
      destinations.push({
        ...(connectorId ? { connectorId } : {}),
        workspaceId: recorded.workspaceId,
        ...(name ? { workspaceName: name } : {}),
      });
    }
    return { destinations, unresolvedConnectorIds };
  }
  for (const id of ids) {
    const link = await currentConnector(profileId, gateway, id).catch(() => undefined);
    if (!link) {
      unresolvedConnectorIds.push(id);
      continue;
    }
    if (link.ownerUserId !== userId) continue;
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
  const cfg = loadProjectConfig(resolved.projectRoot);
  const current = savedConnection(cfg);
  const change = environmentChange(cfg, args);
  const { oauth, gateway } = await resolveOAuth(args, resolved.projectRoot);
  const prior = priorConnection(resolved.projectRoot);
  const alreadyConnected = {
    alreadyConnected: Boolean(cfg),
    ...(current ? { current } : {}),
    ...change,
    ...(cfg ? joinedState(cfg) : {}),
  };
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
      usable[0]!.me.user.id,
      prior,
      priorCandidateIds(resolved.projectRoot, { userId: usable[0]!.me.user.id }),
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
  const pending = live && !grantMismatch(live, oauth) ? live : await beginDeviceLogin(oauth);
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
  const mismatch = grantMismatch(pending, oauth);
  if (mismatch) {
    // A grant from another environment can never be redeemed here, and one
    // started for another gateway must not be: redeeming it sends the new token
    // to this run's gateway, which is not the one named when it began.
    clearPendingLogin();
    return {
      status: "error",
      code: "no_pending_login",
      message: mismatch === "environment"
        ? "the pending sign-in belongs to a different Augenta environment; start a new one with --login"
        : "the pending sign-in was started for a different Augenta gateway, so it was cancelled and nothing was sent; start a new one with --login",
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
  const { oauth, gateway } = await resolveOAuth(args, resolved.projectRoot);
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
  const { oauth, gateway, control, discovered, discoveredGateway } = await resolveOAuth(args, resolved.projectRoot);
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
  const { results, removed, unresolvedConnectorIds, configPath, unsentFromAnotherSignIn: unsent } = await establishConnectors(
    resolved.projectRoot,
    args,
    picked.profileId,
    gateway,
    {
      controlUrl: control,
      org: picked.me.org,
      discoveredGateway,
      shared: gateway === discovered,
      owner: { userId: picked.me.user.id, projectKey: prior?.projectKey ?? randomUUID() },
      knownProject: Boolean(prior?.projectKey),
      recorded: prior?.workspaces,
    },
    workspaces,
    priorCandidateIds(resolved.projectRoot, { userId: picked.me.user.id }),
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
    captureHealth: captureHealth(resolved.projectRoot),
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
    ...(unsent ? { unsentFromAnotherSignIn: unsent } : {}),
    organization: picked.me.org.name,
    ...environmentChange(prior, args),
    autoRecall: loadProjectConfig(resolved.projectRoot)?.autoRecall ? "on" : "off",
    configPath,
  };
}

function environmentChange(cfg: ProjectConfig | undefined, args: Args): { environmentChange?: { from: string; to: string } } {
  const next = controlUrl(cfg, args.controlUrl);
  return cfg?.controlUrl && cfg.controlUrl !== next
    ? { environmentChange: { from: environmentLabel(cfg.controlUrl), to: environmentLabel(next) } }
    : {};
}

/**
 * Whether THIS checkout has joined its config's connection, and whether the
 * config is a file git tracks (so changing destinations changes them for everyone
 * who pulls). An API-key config is its own connection and never needs joining.
 */
function joinedState(cfg: ProjectConfig): { adopted: boolean; configTracked: boolean } {
  return {
    adopted: cfg.authMode === "oauth" ? cfg.join === "joined" : true,
    configTracked: isTrackedByGit(cfg.projectRoot, ".augenta/config.json"),
  };
}

/** How the project answered the automatic-recall question. `on_by_default` is a
 *  config written before connect asked: it still runs, but nobody chose it. */
function autoRecallSetting(cfg: ProjectConfig): "on" | "off" | "on_by_default" {
  return cfg.autoRecall === undefined ? "on_by_default" : cfg.autoRecall ? "on" : "off";
}

function savedConnection(cfg: ProjectConfig | undefined) {
  if (!cfg) return undefined;
  return {
    authMode: cfg.authMode,
    environment: environmentLabel(cfg.controlUrl),
    organization: cfg.org?.name ?? cfg.org?.id,
    // A browser config's recorded Workspaces, whether or not this checkout has
    // joined: the full-record and union-audience disclosure names these.
    destinations: cfg.authMode === "oauth" ? cfg.workspaces ?? [] : cfg.destinations ?? [],
    autoRecall: autoRecallSetting(cfg),
  };
}

export async function runJsonVerb(
  resolved: ResolvedProject,
  args: Args,
): Promise<JsonPayload> {
  const cfg = loadProjectConfig(resolved.projectRoot);
  const metadata = {
    environment: environmentLabel(args.repairHarness ? cfg?.controlUrl : controlUrl(cfg, args.controlUrl)),
    ...(args.repairHarness ? {} : environmentChange(cfg, args)),
    ...(args.probe && cfg ? { current: savedConnection(cfg) } : {}),
    // Always on a probe: a sign-in made in a throwaway session lasts only as
    // long as that session, and the user should hear it before signing in.
    ...(args.probe ? { session: sessionEnvironment() } : {}),
  };
  // Stated before any sign-in, like a non-production environment: this run
  // signs in for, and sends to, that gateway instead of discovery's. Known only
  // once discovery answered, so it is read after the verb — on every payload,
  // a failure's included, since a failure is when the user most needs to know
  // which gateway was being reached.
  const disclosures: Disclosures = {};
  try {
    return { ...(await dispatchJsonVerb(resolved, { ...args, project: resolved.projectRoot, disclosures })), ...metadata, ...disclosures };
  } catch (error) {
    if (error instanceof GatewayOverrideError) {
      return { status: "error", code: error.code, message: error.message, ...metadata, ...disclosures };
    }
    // A failure that could be the network refusing Augenta is checked host by
    // host before it is reported, so the answer names what to allow instead of
    // "Request was cancelled.". Only a confirmed block is reported as
    // one; if every host answers as Augenta does, the original failure stands.
    // Under an override the gateway checked is the one this run was reaching.
    if (classifyNetworkError(error)) {
      const hosts = await diagnoseHosts(controlUrl(cfg, args.controlUrl), { gateway: disclosures.gatewayOverride });
      const blocked = hosts.filter((host) => !host.ok);
      if (blocked.length > 0) {
        return {
          status: "error",
          code: "network_blocked",
          hosts,
          message: blockedNetworkMessage(hosts),
          ...metadata,
          ...disclosures,
        };
      }
    }
    return { status: "error", code: "failed", message: describeError(error), ...metadata, ...disclosures };
  }
}

/** The config selects the exact repair set. This verb neither reconnects nor
 * rewrites config/cursors, and refuses environment/profile overrides. */
async function repairHarness(projectRoot: string, args: Args): Promise<JsonPayload> {
  if (!args.harness) return { status: "error", code: "harness_required", message: "--repair-harness requires an explicit --harness codex or --harness claude-code" };
  const cfg = loadProjectConfig(projectRoot);
  if (cfg?.authMode !== "oauth") return { status: "error", code: "oauth_connection_required", message: "repair requires a readable browser-connected project config" };
  // The sign-in's own gateway: neither the file nor an ambient override chooses
  // where this token goes. A checkout counts as joined only while both resolve
  // to it, so one that points elsewhere is refused rather than repaired.
  const gateway = storedProfileGateway(cfg.profileId!);
  if (cfg.gatewayMismatch) {
    const remedy = cfg.gatewayMismatch.cause === "environment" ? "unset AUGENTA_API_URL and AUGENTA_INGEST_URL" : "connect again here to point it back";
    return { status: "error", code: "gateway_mismatch", message: `this project's Augenta requests would go to ${describeGatewayMismatch(cfg.gatewayMismatch)}; nothing was changed. ${remedy[0]!.toUpperCase()}${remedy.slice(1)}` };
  }
  // Only this person's own links, which exist only once this checkout joined.
  const owner = cfg.destinations?.length ? storedProfileUserId(cfg.profileId!) : undefined;
  if (!owner || !gateway) return { status: "error", code: "not_joined", message: "this checkout has not joined its project's connection; join it with connect first" };
  const repaired: string[] = [];
  const failed: Array<{ connectorId: string; message: string }> = [];
  for (const destination of cfg.destinations!) {
    const connectorId = destination.connectorId;
    try {
      const url = `${gateway}/v1/connectors/${encodeURIComponent(connectorId)}`;
      const { connector } = await bearerJson<{ connector: Connector }>(cfg.profileId!, url);
      if (connector.id !== connectorId || connector.kind !== "agent" || connector.status !== "active" ||
          connector.workspaceId !== destination.workspaceId || connector.ownerUserId !== owner || !connector._etag) {
        throw new Error("Connector must be your active agent in the recorded Workspace with a current revision; nothing changed");
      }
      const { connector: updated }: { connector: Connector } = await bearerJson<{ connector: Connector }>(cfg.profileId!, url, {
        method: "PATCH", headers: { "if-match": connector._etag },
        body: JSON.stringify({ harness: args.harness, _etag: connector._etag }),
      });
      if (updated.id !== connectorId || updated.kind !== "agent" || updated.status !== "active" ||
          updated.workspaceId !== destination.workspaceId || updated.harness !== args.harness) {
        throw new Error("Repair response did not confirm an active agent with the requested label and route; inspect the Connector before retrying");
      }
      repaired.push(connectorId);
    } catch (error) { failed.push({ connectorId, message: describeError(error) }); }
  }
  return { status: failed.length ? "error" : "harness_repaired",
    ...(failed.length ? { code: "harness_repair_incomplete", message: "Some Connector labels were not repaired; see repaired and failed" } : {}),
    harness: args.harness, repaired, failed };
}

/**
 * Join this checkout to the connection its config already records, without
 * choosing destinations again: a teammate's clone of a committed config, an
 * agent's worktree, a fresh cloud checkout. The caller has shown the recorded
 * Workspaces and the user chose to use them; this links the user's OWN
 * Connector in each and records them for this checkout (capture/links.ts).
 *
 * Refused unless the sign-in is the one the config was connected under — same
 * environment, same organization — and the user can access every recorded
 * Workspace. All or nothing: the config routes to every destination, so joining
 * a subset would ship to fewer places than the project records while looking
 * joined. Access is checked, and every existing link looked up, before anything
 * is created; a link created before a later one failed is kept, idle, and found
 * again by the next join. The shared config itself never changes here.
 */
async function adoptProject(resolved: ResolvedProject, args: Args): Promise<JsonPayload> {
  const cfg = loadProjectConfig(resolved.projectRoot);
  if (!cfg) {
    return { status: "error", code: "not_connected", message: "this project has no readable connection to join; connect it instead" };
  }
  if (cfg.authMode !== "oauth") {
    return { status: "error", code: "oauth_connection_required", message: "an API-key project has nothing to join: its key is its connection" };
  }
  const recorded = cfg.controlUrl ?? DEFAULT_CONTROL_URL;
  if (controlUrl(cfg) !== recorded) {
    return {
      status: "error",
      code: "environment_mismatch",
      message: `this project's config records the ${environmentLabel(recorded)} environment, but this session is pointed at ${environmentLabel(controlUrl(cfg))}; unset AUGENTA_CONTROL_URL to join it`,
    };
  }
  const { oauth, gateway } = await resolveOAuth(args, resolved.projectRoot);
  const organization = cfg.org?.name ?? cfg.org?.id;
  // Before any sign-in or link: a config that sends elsewhere than the gateway
  // this sign-in uses would never route once joined, and joining is the answer
  // that starts capture, so it must not be given to a file that points away.
  // Choosing the Workspaces again rewrites the config with this gateway.
  const elsewhere = routeOutside(gateway, cfg);
  if (elsewhere) {
    return {
      status: "error",
      code: "gateway_mismatch",
      organization,
      configTracked: isTrackedByGit(resolved.projectRoot, ".augenta/config.json"),
      message: `this project's config sends Augenta requests to ${elsewhere}, not ${gateway}, the gateway this sign-in uses; nothing was joined, and capture stays off in this checkout. Choose its Workspaces again to point it at ${gateway}`,
    };
  }
  const usable = await usableProfiles(oauth, cfg.profileId);
  if (usable.length === 0) {
    return { status: "need_login", message: "sign in to Augenta, then join again", organization };
  }
  const picked = usable.find((item) => item.profileId === cfg.profileId);
  // The right organization's sign-in is saved but no longer works (expired or
  // revoked): that needs a new sign-in, not a different organization.
  if (!picked && reusableProfiles(oauth).some((item) => item.profileId === cfg.profileId)) {
    return { status: "need_login", message: `the sign-in to ${organization ?? "this project's organization"} needs renewing; sign in again, then join`, organization };
  }
  if (!picked) {
    return {
      status: "error",
      code: "org_mismatch",
      organization,
      signedInTo: [...new Set(usable.map((item) => item.me.org.name))],
      message: `this project was connected in ${organization ?? "another organization"}, and this sign-in is not; sign in to that organization, or choose different Workspaces`,
    };
  }
  const owner: LinkOwner = { userId: picked.me.user.id, projectKey: cfg.projectKey! };
  // Access first: a Workspace this person cannot use would refuse their link, so
  // say so before creating a link in any of the others.
  const available = await listWorkspaces(picked.profileId, gateway);
  const workspaces: Workspace[] = [];
  const unreachable: RecordedWorkspace[] = [];
  for (const entry of cfg.workspaces!) {
    const live = available.find((workspace) => workspace.id === entry.workspaceId);
    if (live) workspaces.push(live);
    else unreachable.push({ ...entry });
  }
  if (unreachable.length > 0) {
    return {
      status: "error",
      code: "destinations_unreachable",
      reachable: workspaces.map(({ id, name }) => ({ workspaceId: id, workspaceName: name })),
      unreachable,
      organization,
      message: `this sign-in cannot use ${unreachable.map((item) => item.workspaceName ?? item.workspaceId).join(", ")}; you may need to be added to ${unreachable.length === 1 ? "that Workspace" : "those Workspaces"}. Nothing was created, and capture stays off in this checkout`,
    };
  }
  const previous = readLinks(resolved.projectRoot)?.links.map((link) => link.connectorId) ?? [];
  const prior = await priorLinks(
    picked.profileId,
    gateway,
    priorCandidateIds(resolved.projectRoot, { userId: owner.userId }),
    owner.userId,
  );
  const candidates = await adoptionCandidates(picked.profileId, gateway, owner, workspaces, prior.links, true);
  const unchecked = workspaces.filter((workspace) => candidates.get(workspace.id) instanceof Error);
  if (unchecked.length > 0) {
    return {
      status: "error",
      code: "join_failed",
      failed: unchecked.map((workspace) => ({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        message: describeError(candidates.get(workspace.id)),
      })),
      organization,
      message: `could not check this sign-in's existing links into ${unchecked.map((workspace) => workspace.name).join(", ")}; nothing was created, and capture stays off in this checkout`,
    };
  }
  const results = await linkWorkspaces(resolved.projectRoot, args, picked.profileId, gateway, owner, workspaces, candidates);
  const failed = results.filter((result) => !result.connectorId);
  if (failed.length > 0) {
    return {
      status: "error",
      code: "join_failed",
      failed: failed.map(({ workspaceId, workspaceName, message }) => ({ workspaceId, workspaceName, message })),
      organization,
      message: `could not link ${failed.map((result) => result.workspaceName).join(", ")}; capture stays off in this checkout. Any link already made is kept and reused when you join again`,
    };
  }
  const destinations = results.map(({ connectorId, workspaceId, workspaceName, action }) => ({
    connectorId: connectorId!,
    workspaceId,
    workspaceName,
    action: action!,
  }));
  const unsent = unsentFromAnotherSignIn(resolved.projectRoot, owner.userId);
  writeLinks(resolved.projectRoot, {
    profileId: picked.profileId,
    userId: owner.userId,
    projectKey: owner.projectKey,
    joinedAt: new Date().toISOString(),
    links: destinations.map(({ workspaceId, connectorId }) => ({ workspaceId, connectorId })),
  });
  // Links new to this checkout start at the end of its spool, never inheriting
  // records captured before they were affirmed here — including another
  // person's, after a different sign-in joined on this machine.
  const ids = destinations.map((destination) => destination.connectorId);
  try {
    new Outbox(resolved.projectRoot).registerDestinations(ids, { freshKeys: ids.filter((id) => !previous.includes(id)) });
  } catch {
    /* the shipper reconciles the set on its own; never fail a join over this */
  }
  return {
    status: "adopted",
    destinations,
    ...(unsent > 0 ? { unsentFromAnotherSignIn: unsent } : {}),
    organization,
    autoRecall: autoRecallSetting(cfg),
    captureHealth: captureHealth(resolved.projectRoot),
  };
}

/**
 * Change only the project's automatic-recall answer. It neither reconnects nor
 * touches the destinations, `captureSince` or any other field, so the Codex
 * capture boundary and every cursor stay where they are.
 *
 * Patched at the JSON level and replaced atomically: a torn write here would
 * leave a config that drops destinations the user consented to, which the
 * whole-file writer's contract exists to prevent. Allowed for either auth mode,
 * because the patch never reads or rewrites the credential itself.
 */
function setAutoRecall(projectRoot: string, autoRecall: boolean): JsonPayload {
  const cfg = loadProjectConfig(projectRoot);
  if (!cfg) {
    return {
      status: "error",
      code: "not_connected",
      message: "this project has no readable connection; connect it first, then change automatic recall",
    };
  }
  // The answer lives in the shared file, so it changes for everyone who pulls
  // it; a checkout that never joined the connection has not agreed to it either.
  if (cfg.authMode === "oauth" && cfg.join !== "joined") {
    return {
      status: "error",
      code: "not_joined",
      message: "this checkout has not joined its project's connection; join it with connect first, then change automatic recall",
    };
  }
  const path = configPath(projectRoot);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.autoRecall = autoRecall;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  chmodSync(path, 0o600);
  return { status: "auto_recall_updated", autoRecall: autoRecall ? "on" : "off" };
}

async function dispatchJsonVerb(
  resolved: ResolvedProject,
  args: Args,
): Promise<JsonPayload> {
  if (args.repairHarness) {
    if (args.health || args.probe || args.login || args.awaitLogin || args.verifyOnly ||
        args.workspaces !== undefined || args.createWorkspace !== undefined || args.apiKey ||
        args.endpoint || args.controlUrl || args.profile || args.autoRecall !== undefined || args.adopt) {
      return { status: "error", code: "conflicting_verbs", message: "--repair-harness uses the saved project connection; combine it only with --json, --project and --harness" };
    }
    return repairHarness(resolved.projectRoot, args);
  }
  if (args.health && (args.workspaces?.length || args.createWorkspace !== undefined || args.login || args.awaitLogin || args.probe || args.autoRecall !== undefined || args.adopt)) {
    return { status: "error", code: "conflicting_verbs", message: "--health is a local read-only operation; run it by itself with --json" };
  }
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
  // A throwaway machine with no checkout to carry the config: refuse before any
  // sign-in starts or any link is made, rather than write a config no later
  // session will ever read (and leave Connectors behind for it).
  if ((args.probe || args.login || args.awaitLogin || args.createWorkspace !== undefined || args.workspaces?.length || args.adopt) && ephemeralProject(resolved.projectRoot)) {
    const session = sessionEnvironment();
    return {
      status: "error",
      code: "ephemeral_project",
      session,
      message: ephemeralProjectMessage(resolved.projectRoot),
    };
  }
  // Joining uses the recorded connection exactly as it is, so nothing that
  // would choose, create or re-point anything may ride along with it.
  if (args.adopt) {
    if (args.workspaces?.length || args.createWorkspace !== undefined || args.login || args.awaitLogin ||
        args.probe || args.verifyOnly || args.autoRecall !== undefined || args.endpoint || args.controlUrl || args.profile) {
      return {
        status: "error",
        code: "conflicting_verbs",
        message: "--adopt joins the connection this project's config already records; run it alone with --json",
      };
    }
    return adoptProject(resolved, args);
  }
  // Alone, --auto-recall changes one setting of an existing connection. With
  // --workspace it rides along in that call's single config write instead.
  if (args.autoRecall !== undefined && !args.workspaces?.length) {
    if (args.createWorkspace !== undefined || args.login || args.awaitLogin || args.probe ||
        args.verifyOnly || args.endpoint || args.controlUrl || args.profile) {
      return {
        status: "error",
        code: "conflicting_verbs",
        message:
          "--auto-recall changes only this project's setting; run it alone with --json, or pass it with --workspace while connecting",
      };
    }
    return setAutoRecall(resolved.projectRoot, args.autoRecall);
  }
  if (args.createWorkspace !== undefined) {
    return createWorkspaceForSelection(resolved, args);
  }
  if (args.workspaces?.length) return connectToWorkspaces(resolved, args);
  if (args.awaitLogin) return awaitLogin(args);
  if (args.login) return startLogin(args);
  if (args.health) return { status: "capture_health", ...captureHealth(resolved.projectRoot) };
  if (args.probe) return probeConnection(resolved, args);
  return {
    status: "error",
    code: "no_verb",
    message:
      "--json requires one of --probe, --login, --await-login, --create-workspace <name>, --workspace <id> (repeatable), --adopt, or --auto-recall on|off",
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
  if (!Array.isArray(connectors)) {
    throw new Error("Augenta returned an invalid Connector assignment");
  }
  if (connectors.length === 0) {
    throw new Error("the platform key is not assigned to a Connector");
  }
  // This ban SURVIVES fan-out, deliberately. A signed-in project fans out because
  // a human affirmed a set of Workspaces; nothing on this path affirms anything —
  // there is no consent gate here, the recorded destination only describes the
  // assignment, and the shipper sends no Connector header in api-key mode.
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
  if (!connector || (["id", "orgId", "workspaceId"] as const).some((field) => {
    const value = connector[field];
    return typeof value !== "string" || !value.trim();
  })) {
    throw new Error("the assigned Connector must have non-empty id, orgId, and workspaceId fields");
  }
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
     which is how a local or dev environment is pointed, and what dev-e2e.ts
     does — this would have verified a different host than capture actually ships
     to, and a green check against the wrong gateway is worse than no check.

     An explicit --endpoint still wins: that is an operator saying "check this one".
     AUGENTA_INGEST_URL is deliberately not consulted — it overrides the ingest path
     only, and what is being verified here is the key and its Connector on the
     control surface. */
  const gateway = gatewayBase(cfg, endpointOverride);
  return { connector: await verifyApiKeyConnection(apiKey, gateway), gateway };
}

export async function connectWithApiKey(
  projectRoot: string,
  apiKey: string,
  endpoint?: string,
  /** An explicit `--auto-recall` answer; otherwise the prior one carries forward. */
  autoRecall?: boolean,
): Promise<{ path: string; connector: Connector }> {
  const prior = loadProjectConfig(projectRoot);
  const gateway = gatewayBase(prior, endpoint);
  const connector = await verifyApiKeyConnection(apiKey, gateway);
  return {
    path: writeApiKeyConfig(
      projectRoot,
      apiKey,
      gateway === DEFAULT_GATEWAY ? undefined : gateway,
      {
        org: { id: connector.orgId },
        destinations: [{ connectorId: connector.id, workspaceId: connector.workspaceId }],
        // An explicit flag wins. Otherwise a key rotation must not revert an
        // earlier `--auto-recall off`; the whole-file write would otherwise drop
        // the answer and turn it back on.
        autoRecall: autoRecall ?? prior?.autoRecall ?? false,
        ...(prior?.controlUrl ? { controlUrl: prior.controlUrl } : {}),
        ...(prior?.ingestUrl ? { ingestUrl: prior.ingestUrl } : {}),
      },
    ),
    connector,
  };
}

if (isMain(import.meta.url)) {
  // Before anything else: in a proxied sandbox, re-run with Node told to use it.
  reexecForEnvProxy();
  const argv = process.argv.slice(2);
  // Read straight off argv: parseArgs itself can throw, and a caller that asked
  // for JSON must get JSON back even for a bad flag.
  const wantsJson = argv.includes("--json");
  // One failure shape for the whole CLI, argument parsing included — every exit
  // the user can cause reads as `Augenta connect: <what went wrong>`, never a
  // stack trace.
  try {
    const args = parseArgs(argv);
    if (args.repairHarness && !args.json) throw new Error("--repair-harness requires --json and an explicit --harness");
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
            projectRoot,
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
        args.autoRecall,
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
