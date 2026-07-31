#!/usr/bin/env bun
/**
 * Connect one project to its Neurolinks, by Augenta sign-in or a platform key.
 *
 * Two front ends over the same core. A human running this in a terminal gets the
 * interactive prompts. An agent runs the `--json` verbs — `--probe`, `--login`,
 * `--await-login`, `--neurospace` — each of which returns one JSON object and
 * exits, so the sign-in link reaches the user in a bounded call instead of after
 * a poll loop nobody can see. No verb accepts or emits a credential: tokens go
 * browser → `~/.augenta/auth.json`, and `--api-key` stays human/CI-only.
 *
 * A signed-in project may feed SEVERAL Neurospaces — one inbound Neurolink each,
 * `--neurospace` repeated once per destination. The answer is always the complete
 * destination set, so this file's job is to make the config a faithful record of
 * what the user just confirmed and nothing more: see `establishNeurolinks` for the
 * subset invariant and `linkForNeurospace` for why links are adopted, never moved.
 * A platform key stays single-destination (`verifyApiKeyConnection`).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isMain } from "../runtime/node";
import { ensureAugentaDir } from "../capture/augenta-dir";
import {
  configPath,
  DEFAULT_GATEWAY,
  loadProjectConfig,
} from "../capture/config";
import { Outbox } from "../capture/outbox";
import {
  augentaOAuthConfig,
  beginDeviceLogin,
  clearPendingLogin,
  DEFAULT_CONTROL_URL,
  deviceLogin,
  fetchWithProfile,
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
  probe?: boolean;
  login?: boolean;
  awaitLogin?: boolean;
  waitSeconds?: number;
  /** Every Neurospace the project should feed. `--neurospace` is repeatable and
   *  the list is the COMPLETE destination set, not an addition. */
  neurospaces?: string[];
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

interface Neurospace {
  id: string;
  name: string;
}

interface Neurolink {
  id: string;
  kind: string;
  direction: "inbound" | "outbound" | "bidirectional";
  status: "active" | "disabled";
  neurospaceId: string;
  _etag?: string;
}

/**
 * Reported to the platform as Neurolink metadata. Part of the atomic release set
 * (AGENTS.md → Releases) alongside both plugin manifests, both marketplace files,
 * and package.json; the contract test pins all of them to one value.
 */
export const PLUGIN_VERSION = "0.6.1";

class AugentaRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AugentaRequestError";
  }
}

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
    } else if (flag === "--neurospace") {
      // Repeatable rather than comma-separated: `valueFor` keeps validating each
      // occurrence, so `--neurospace --profile p` still fails loudly. Splitting a
      // string would move that check inside the value, where an empty segment or
      // a stray comma becomes a silent mis-selection instead of an error.
      (args.neurospaces ??= []).push(valueFor(flag, i++));
    } else if (flag === "--profile") {
      args.profile = valueFor(flag, i++);
    } else if (flag === "--wait") {
      const value = Number(valueFor(flag, i++));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--wait must be a positive number of seconds");
      }
      args.waitSeconds = value;
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

export interface ResolvedProject {
  projectRoot: string;
  /** Set when cwd was a linked worktree and the main checkout was used instead.
   *  Reported rather than applied silently — the caller tells the user. */
  worktreeRedirect?: { from: string; to: string };
}

function gitRevParse(cwd: string, arg: string): string | undefined {
  try {
    const value = execFileSync("git", ["rev-parse", arg], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pick the project to connect: `--project` > main checkout > git toplevel > cwd.
 *
 * The main-checkout step exists because `--show-toplevel` returns the LINKED
 * WORKTREE's root, and capture only ever walks UPWARD from cwd looking for
 * `.augenta/config.json` (capture/config.ts → resolveProjectRoot). Connect from
 * an out-of-tree worktree such as `~/.codex/worktrees/<id>/<name>` and the config
 * lands somewhere the real repo can never see, so every hook keeps silently
 * no-opping — the user completes the whole flow and captures nothing.
 *
 * `--git-common-dir` prints relative to cwd in a normal repo (`../.git`) and
 * absolute in a linked worktree, which `resolve` handles either way.
 */
export function resolveProject(args: Args, cwd: string): ResolvedProject {
  if (args.project) return { projectRoot: resolve(cwd, args.project) };
  const top = gitRevParse(cwd, "--show-toplevel");
  // A non-git directory is still a valid explicitly connected project.
  if (!top) return { projectRoot: cwd };
  const commonDir = gitRevParse(cwd, "--git-common-dir");
  if (commonDir) {
    const mainRoot = dirname(resolve(cwd, commonDir));
    if (mainRoot !== top && existsSync(mainRoot)) {
      return { projectRoot: mainRoot, worktreeRedirect: { from: top, to: mainRoot } };
    }
  }
  return { projectRoot: top };
}

export function resolveTargetProject(args: Args, cwd: string): string {
  return resolveProject(args, cwd).projectRoot;
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
  neurolinkIds: readonly string[],
  endpoint?: string,
): string {
  const dir = ensureAugentaDir(projectRoot);
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        authMode: "oauth",
        profileId,
        neurolinkIds: [...neurolinkIds],
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
 * nothing to decide. The Neurospace choice deliberately does NOT come through
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
 * {@link choose}. WHICH Neurospaces a project feeds is the user's consent
 * decision, so it is asked every time — including when the organization has only
 * one, and including when the project is already connected, where the current set
 * is shown pre-selected and must be re-affirmed rather than kept by default (see
 * skills/connect/SKILL.md, AGENTS.md → Privacy invariants).
 *
 * An EMPTY answer means "select nothing" and is returned as `[]`: a user who
 * changes their mind at the gate needs an exit that is not Ctrl-C. (For an
 * already-connected project that leaves the existing destinations alone — the
 * caller says so; the off switch is deleting the config.)
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
        `Selection (comma-separated, e.g. 1,3 — empty to select nothing) [1-${values.length}]: `,
      );
      if (!answer.trim()) return [];
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
    throw new Error("no valid Neurospace selection was given");
  } finally {
    rl.close();
  }
}

async function bearerJson<T>(
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

async function listNeurospaces(
  profileId: string,
  gateway: string,
): Promise<Neurospace[]> {
  const { neurospaces } = await bearerJson<{ neurospaces: Neurospace[] }>(
    profileId,
    `${gateway}/v1/neurospaces`,
  );
  if (neurospaces.length === 0) {
    throw new Error("the authenticated organization has no active Neurospaces");
  }
  return neurospaces;
}

async function selectedNeurospaces(
  profileId: string,
  gateway: string,
  preselectedIds: readonly string[] = [],
  available?: readonly Neurospace[],
): Promise<Neurospace[]> {
  return chooseMany(
    "Choose every Neurospace this project should feed (each one receives the full record):",
    [...(available ?? (await listNeurospaces(profileId, gateway)))],
    (neurospace) => `${neurospace.name} (${neurospace.id})`,
    { preselected: (neurospace) => preselectedIds.includes(neurospace.id) },
  );
}

async function currentNeurolink(
  profileId: string,
  gateway: string,
  id: string | undefined,
): Promise<Neurolink | undefined> {
  if (!id) return undefined;
  const response = await fetchWithProfile(
    profileId,
    `${gateway}/v1/neurolinks/${encodeURIComponent(id)}`,
  );
  if (response.status === 403 || response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`could not inspect the existing Neurolink (${response.status})`);
  }
  return ((await response.json()) as { neurolink: Neurolink }).neurolink;
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
): Promise<Neurolink[]> {
  const links: Neurolink[] = [];
  for (const id of ids) {
    // `currentNeurolink` throws on anything other than 403/404, which would abort
    // the whole reconnect — the opposite of this function's job. Any unreadable
    // prior link is treated as unresolved and reported by the caller.
    const link = await currentNeurolink(profileId, gateway, id).catch(() => undefined);
    if (link) links.push(link);
  }
  return links;
}

/**
 * The one link that carries this project into `neurospace` — adopted when one of
 * this project's prior links ALREADY points there, otherwise created.
 *
 * `neurospaceId` is never mutated. The pre-fan-out code retargeted the single
 * link by PATCHing a new `neurospaceId` onto it, which under fan-out would (a)
 * steal a link belonging to a destination the user KEPT and (b) relabel the route
 * of history already attached to that link. Adopt-or-create instead makes "one
 * link per (project, Neurospace)" a stable identity, so re-running connect with
 * the same answer converges instead of accumulating siblings.
 *
 * Adoption is scoped to ids from THIS project's config, never matched against the
 * organization's live links by `projectName` — folder names are not unique across
 * an org, so that would let one user's `~/code/api` adopt another's Neurolink,
 * which is a misrouting bug strictly worse than a duplicate.
 */
async function linkForNeurospace(
  projectRoot: string,
  args: Args,
  profileId: string,
  gateway: string,
  neurospace: Neurospace,
  adoptable: readonly Neurolink[],
): Promise<{ neurolink: Neurolink; action: "adopted" | "created" }> {
  const name = basename(projectRoot);
  const fields = {
    neurospaceId: neurospace.id,
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
      link.neurospaceId === neurospace.id,
  );
  if (existing) {
    // Refresh the mutable metadata only. `kind` is immutable and `neurospaceId`
    // already matches by construction, so neither is sent.
    const { kind: _kind, neurospaceId: _neurospaceId, ...mutableFields } = fields;
    const neurolink = (
      await bearerJson<{ neurolink: Neurolink }>(
        profileId,
        `${gateway}/v1/neurolinks/${encodeURIComponent(existing.id)}`,
        {
          method: "PATCH",
          headers: {
            ...(existing._etag ? { "if-match": existing._etag } : {}),
          },
          body: JSON.stringify({ ...mutableFields, _etag: existing._etag }),
        },
      )
    ).neurolink;
    return { neurolink, action: "adopted" };
  }
  const neurolink = (
    await bearerJson<{ neurolink: Neurolink }>(
      profileId,
      `${gateway}/v1/neurolinks`,
      { method: "POST", body: JSON.stringify(fields) },
    )
  ).neurolink;
  return { neurolink, action: "created" };
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
): { profileId?: string; neurolinkIds?: string[] } | undefined {
  if (!existsSync(join(projectRoot, ".augenta", "config.json"))) return undefined;
  try {
    const existing = loadProjectConfig(projectRoot);
    return existing?.authMode === "oauth"
      ? { profileId: existing.profileId, neurolinkIds: existing.neurolinkIds }
      : undefined;
  } catch {
    return undefined;
  }
}

/** One destination's outcome. `neurolinkId` is present iff it verified. */
export interface DestinationResult {
  neurospaceId: string;
  neurospaceName: string;
  neurolinkId?: string;
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
  neurolinkId: string;
  neurospaceId: string;
  neurospaceName?: string;
  /** The Neurolink is left alone on the platform — see below. */
  disposition: "left_in_place";
}

/**
 * Link every selected Neurospace, verify each, then write the config ONCE.
 *
 * Verification is per destination and NON-FATAL. The single-destination code
 * threw on a failed verify, which under fan-out would let one unreachable
 * Neurospace lose the two that worked.
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
 * half-fail after the user was told "done" — while their Neurolinks are LEFT IN
 * PLACE. Disabling or deleting them would be an org-level mutation with blast
 * radius nobody was asked about, would break re-selection (adoption only takes
 * `status: "active"` links, so a disabled one would come back as a sibling), and
 * `status` is outside the mutable field set this code has ever exercised.
 */
async function establishNeurolinks(
  projectRoot: string,
  args: Args,
  profileId: string,
  gateway: string,
  neurospaces: readonly Neurospace[],
  priorNeurolinkIds: readonly string[],
  /** The organization's live Neurospaces, so removals can be NAMED rather than
   *  reported as bare ids. */
  available: readonly Neurospace[] = neurospaces,
  /** Prior links resolved by the caller, to avoid a second round of GETs. */
  preresolved?: readonly Neurolink[],
): Promise<{
  results: DestinationResult[];
  removed: RemovedDestination[];
  /** Prior destinations that could not be resolved at all. They are dropped from
   *  the config, so they must be reported rather than vanishing. */
  unresolvedNeurolinkIds: string[];
  configPath?: string;
}> {
  const adoptable = preresolved ?? (await priorLinks(profileId, gateway, priorNeurolinkIds));
  const unresolvedNeurolinkIds = priorNeurolinkIds.filter(
    (id) => !adoptable.some((link) => link.id === id),
  );
  const priorNeurospaceIds = adoptable.map((link) => link.neurospaceId);
  const results: DestinationResult[] = [];
  for (const neurospace of neurospaces) {
    try {
      const { neurolink, action } = await linkForNeurospace(
        projectRoot,
        args,
        profileId,
        gateway,
        neurospace,
        adoptable,
      );
      const verified = await bearerJson<{ neurolink: Neurolink }>(
        profileId,
        `${gateway}/v1/neurolinks/${encodeURIComponent(neurolink.id)}`,
      );
      if (
        verified.neurolink.status !== "active" ||
        verified.neurolink.neurospaceId !== neurospace.id
      ) {
        throw new Error("Neurolink verification failed");
      }
      results.push({
        neurospaceId: neurospace.id,
        neurospaceName: neurospace.name,
        neurolinkId: verified.neurolink.id,
        action,
      });
    } catch (error) {
      results.push({
        neurospaceId: neurospace.id,
        neurospaceName: neurospace.name,
        message: error instanceof Error ? error.message : String(error),
        // A destination the project ALREADY fed is being dropped, not merely not
        // added. Same message either way would hide a change of state.
        ...(priorNeurospaceIds.includes(neurospace.id) ? { wasConnected: true } : {}),
      });
    }
  }

  const verifiedIds = results
    .map((result) => result.neurolinkId)
    .filter((id): id is string => Boolean(id));
  // Removed means DESELECTED — its Neurospace is not in the set the user just
  // confirmed. A destination they kept but that failed to link is a failure, not a
  // removal, and must never be reported as one.
  const selectedIds = neurospaces.map((neurospace) => neurospace.id);
  const nameFor = (id: string): string | undefined =>
    available.find((neurospace) => neurospace.id === id)?.name;
  const removed = adoptable
    .filter((link) => !selectedIds.includes(link.neurospaceId))
    .map((link) => {
      const name = nameFor(link.neurospaceId);
      return {
        neurolinkId: link.id,
        neurospaceId: link.neurospaceId,
        ...(name ? { neurospaceName: name } : {}),
        disposition: "left_in_place" as const,
      };
    });

  if (verifiedIds.length === 0) return { results, removed, unresolvedNeurolinkIds };
  const configPath = writeOAuthConfig(
    projectRoot,
    profileId,
    verifiedIds,
    gateway === DEFAULT_GATEWAY ? undefined : gateway,
  );
  // Stamp the outbox's destination map here, while we still know which links were
  // just CREATED. A newly added Neurospace must not inherit the pending tail a
  // pre-fan-out cursor accumulated for the destination that earned it, and by the
  // time the shipper runs that distinction is gone (see Outbox.registerDestinations).
  try {
    const freshKeys = results
      .filter((result) => result.action === "created" && result.neurolinkId)
      .map((result) => result.neurolinkId!);
    new Outbox(projectRoot).registerDestinations(verifiedIds, { freshKeys });
  } catch {
    /* the shipper reconciles the set on its own; never fail a connect over this */
  }
  return { results, removed, unresolvedNeurolinkIds, configPath };
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
  const priorIds = prior?.neurolinkIds ?? [];
  const resolvedPrior = await priorLinks(selected.profileId, gateway, priorIds);
  const available = await listNeurospaces(selected.profileId, gateway);
  const environment = environmentLabel(args);

  // BEFORE the answer, not after. This is the disclosure the consent invariant
  // turns on (AGENTS.md → Privacy invariants): a list of Neurospace names does not
  // tell anyone how many people can read their transcripts, and a warning that
  // arrives after the selection cannot change it.
  console.log(
    "Every Neurospace you select receives the FULL record — this project's agent activity, its raw transcript lines (structurally sanitized, but NOT secret-scrubbed), and its project memory, complete, in each.",
  );
  console.log(
    "So anyone with access to ANY Neurospace you select can read this project's captured activity: the audience is the union of all of them.",
  );
  if (environment !== "prod") {
    console.log(`This is the ${environment} environment, not production.`);
  }

  const neurospaces = await selectedNeurospaces(
    selected.profileId,
    gateway,
    resolvedPrior.map((link) => link.neurospaceId),
    available,
  );
  if (neurospaces.length === 0) {
    // "Nothing connected" would be false for a project that is already connected:
    // leaving the config untouched means it keeps shipping to every prior
    // destination. Selecting nothing is not the off switch; deleting the file is.
    if (priorIds.length > 0) {
      const current = resolvedPrior
        .map((link) => {
          const name = available.find((n) => n.id === link.neurospaceId)?.name;
          return name ?? link.neurospaceId;
        })
        .join(", ");
      console.log(
        `Nothing changed. This project still feeds ${current || "its existing destinations"}. To stop capture entirely, delete ${configPath(projectRoot)}.`,
      );
    } else {
      console.log("Nothing connected. No config was written.");
    }
    return;
  }

  const { results, removed, unresolvedNeurolinkIds, configPath: written } =
    await establishNeurolinks(
      projectRoot,
      args,
      selected.profileId,
      gateway,
      neurospaces,
      priorIds,
      available,
      resolvedPrior,
    );
  const live = results.filter((result) => result.neurolinkId);
  const failed = results.filter((result) => !result.neurolinkId);
  if (live.length > 0) {
    console.log(
      `Wrote ${written} (0600). This project now feeds ${live
        .map((result) => `${result.neurospaceName} (Neurolink ${result.neurolinkId})`)
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
        ? `Could not link ${result.neurospaceName}, which this project WAS feeding: ${result.message}. It has been dropped — re-run connect to restore it.`
        : `Could not link ${result.neurospaceName}: ${result.message}`,
    );
  }
  // Only true once a config actually replaced the old one. With nothing written,
  // the previous destinations are all still live.
  if (written) {
    for (const entry of removed) {
      console.log(
        `No longer sending to ${entry.neurospaceName ?? entry.neurospaceId}. Its Neurolink ${entry.neurolinkId} is left in place and idle — remove it in Augenta if you want it gone.`,
      );
    }
    if (unresolvedNeurolinkIds.length > 0) {
      console.log(
        `Dropped ${unresolvedNeurolinkIds.join(", ")}: this project listed ${unresolvedNeurolinkIds.length === 1 ? "that Neurolink" : "those Neurolinks"} but ${unresolvedNeurolinkIds.length === 1 ? "it is" : "they are"} no longer readable with this sign-in.`,
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

/** `prod` or the literal non-production control URL, so a caller can say which
 *  environment a project is about to feed instead of connecting dev by accident. */
function environmentLabel(args: Args): string {
  const url = (
    args.controlUrl?.trim() ||
    process.env.AUGENTA_CONTROL_URL ||
    DEFAULT_CONTROL_URL
  ).replace(/\/+$/, "");
  return url === DEFAULT_CONTROL_URL ? "prod" : url;
}

function secondsUntil(timestamp: number): number {
  return Math.max(0, Math.round((timestamp - Date.now()) / 1000));
}

/** Signed in and ready to choose a target. Also the terminal state of a
 *  successful `--await-login`, saving the caller a round trip. */
async function neurospaceStep(
  profileId: string,
  gateway: string,
  me: MeResponse,
): Promise<JsonPayload> {
  const neurospaces = await listNeurospaces(profileId, gateway);
  return {
    status: "need_neurospace",
    profileId,
    signedInAs: {
      name: me.user.name || me.user.email,
      email: me.user.email,
      organization: me.org.name,
    },
    neurospaces: neurospaces.map(({ id, name }) => ({ id, name })),
  };
}

/**
 * The destinations this project currently feeds, resolved to Neurospace names so
 * the caller can pre-select them.
 *
 * Ids that cannot be resolved are reported in `unresolvedNeurolinkIds` rather
 * than dropped: the project is still SHIPPING to them, so silently omitting one
 * would quietly drop a live destination out of the pre-selection — and, because
 * the answer is the complete set, out of the project's config on the next
 * reconnect. Read-only; `currentNeurolink` already treats 403/404 as "not
 * visible" instead of an error.
 */
async function priorDestinations(
  profileId: string,
  gateway: string,
  ids: readonly string[],
  neurospaces: readonly Neurospace[],
): Promise<{
  destinations: Array<{ neurolinkId: string; neurospaceId: string; neurospaceName?: string }>;
  unresolvedNeurolinkIds: string[];
}> {
  const destinations: Array<{
    neurolinkId: string;
    neurospaceId: string;
    neurospaceName?: string;
  }> = [];
  const unresolvedNeurolinkIds: string[] = [];
  for (const id of ids) {
    const link = await currentNeurolink(profileId, gateway, id).catch(() => undefined);
    if (!link) {
      unresolvedNeurolinkIds.push(id);
      continue;
    }
    const name = neurospaces.find((n) => n.id === link.neurospaceId)?.name;
    destinations.push({
      neurolinkId: link.id,
      neurospaceId: link.neurospaceId,
      ...(name ? { neurospaceName: name } : {}),
    });
  }
  return { destinations, unresolvedNeurolinkIds };
}

/**
 * Read-only "what happens next". Deliberately starts NO authorization: the caller
 * needs to describe the choice and get consent before anything leaves the machine.
 *
 * An existing connection is reported as fields, not a terminal status — the skill
 * must still be able to reconnect a project to verify or change which Neurospaces
 * it feeds.
 */
export async function probeConnection(
  resolved: ResolvedProject,
  args: Args,
): Promise<JsonPayload> {
  const { oauth, gateway } = await resolveOAuth(args);
  const prior = priorConnection(resolved.projectRoot);
  const priorIds = prior?.neurolinkIds ?? [];
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
  const step = await neurospaceStep(usable[0]!.profileId, gateway, usable[0]!.me);
  return {
    ...step,
    ...alreadyConnected,
    ...(await priorDestinations(
      usable[0]!.profileId,
      gateway,
      priorIds,
      step.neurospaces as Neurospace[],
    )),
  };
}

/** Start the grant and return the link immediately. */
export async function startLogin(args: Args): Promise<JsonPayload> {
  const { oauth } = await resolveOAuth(args);
  const pending = await beginDeviceLogin(oauth);
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
    return neurospaceStep(profileId, gateway, me);
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
 * Finish: bind the project to the chosen Neurospaces. The answer is the COMPLETE
 * destination set — what the project feeds after this call, and nothing else.
 *
 * Every id must be one the organization actually has. Validation happens for the
 * WHOLE set before anything is created, and one bad id fails all of it: if a
 * single id does not match the live list then the answer does not match what the
 * user saw rendered, so none of it is trustworthy. Failing closed beats quietly
 * misrouting a project's transcripts, or connecting a subset nobody confirmed.
 */
export async function connectToNeurospaces(
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
  const available = await listNeurospaces(picked.profileId, gateway);
  const requested = [...new Set(args.neurospaces ?? [])];
  const unknown = requested.filter((id) => !available.some((item) => item.id === id));
  if (unknown.length > 0) {
    return {
      status: "error",
      code: "unknown_neurospace",
      unknown,
      message: `${unknown.join(", ")} ${unknown.length === 1 ? "is not an active Neurospace" : "are not active Neurospaces"} in ${picked.me.org.name}; nothing was created`,
    };
  }
  // Iterate in LIVE-LIST order rather than flag order, so the config is
  // byte-deterministic however the caller happened to order its arguments.
  const neurospaces = available.filter((item) => requested.includes(item.id));
  const { results, removed, unresolvedNeurolinkIds, configPath } = await establishNeurolinks(
    resolved.projectRoot,
    args,
    picked.profileId,
    gateway,
    neurospaces,
    prior?.neurolinkIds ?? [],
    available,
  );
  const destinations = results.filter((result) => result.neurolinkId);
  const failed = results.filter((result) => !result.neurolinkId);
  if (destinations.length === 0) {
    return {
      status: "error",
      code: "no_destination_linked",
      message: `no destination could be linked; no config was written (${failed
        .map((result) => `${result.neurospaceName}: ${result.message}`)
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
            ({ neurospaceId, neurospaceName, message, wasConnected }) => ({
              neurospaceId,
              neurospaceName,
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
    ...(unresolvedNeurolinkIds.length > 0 ? { unresolvedNeurolinkIds } : {}),
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
  if (args.neurospaces?.length) return connectToNeurospaces(resolved, args);
  if (args.awaitLogin) return awaitLogin(args);
  if (args.login) return startLogin(args);
  if (args.probe) return probeConnection(resolved, args);
  return {
    status: "error",
    code: "no_verb",
    message:
      "--json requires one of --probe, --login, --await-login, or --neurospace <id> (repeatable)",
  };
}

export async function verifyApiKeyConnection(
  apiKey: string,
  gateway: string,
): Promise<Neurolink> {
  const response = await fetch(
    `${gateway.replace(/\/+$/, "")}/v1/neurolinks`,
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
  const neurolinks = ((await response.json()) as { neurolinks?: Neurolink[] })
    .neurolinks ?? [];
  if (neurolinks.length === 0) {
    throw new Error("the platform key is not assigned to a Neurolink");
  }
  // This ban SURVIVES fan-out, deliberately. A signed-in project fans out because
  // a human affirmed a set of Neurospaces; nothing on this path affirms anything —
  // there is no consent gate here, the config format it writes has no field to
  // express a route, and the shipper sends no Neurolink header in api-key mode.
  // A platform key's server-side assignment IS its routing decision, so with
  // several links visible there is no non-arbitrary pick and the plugin cannot
  // verify which one the door will choose. Fail loudly now rather than let a CI
  // pipeline discover it from where its transcripts landed. Fanning a key out to
  // several Neurospaces is a platform feature (assign the key to a link that does
  // it server-side, or issue one key per destination), not a plugin one.
  if (neurolinks.length > 1) {
    throw new Error(
      `the platform key is assigned to ${neurolinks.length} Neurolinks; capture requires exactly one`,
    );
  }
  const neurolink = neurolinks[0]!;
  if (
    neurolink.status !== "active" ||
    (neurolink.direction !== "inbound" &&
      neurolink.direction !== "bidirectional")
  ) {
    throw new Error("the platform key requires an active inbound Neurolink");
  }
  return neurolink;
}

export async function connectWithApiKey(
  projectRoot: string,
  apiKey: string,
  endpoint?: string,
): Promise<{ path: string; neurolink: Neurolink }> {
  const gateway = (endpoint?.trim() || DEFAULT_GATEWAY).replace(/\/+$/, "");
  const neurolink = await verifyApiKeyConnection(apiKey, gateway);
  return {
    path: writeApiKeyConfig(
      projectRoot,
      apiKey,
      gateway === DEFAULT_GATEWAY ? undefined : gateway,
    ),
    neurolink,
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
    const resolved = resolveProject(args, process.cwd());
    const projectRoot = resolved.projectRoot;
    if (args.json) {
      const payload = await runJsonVerb(resolved, args);
      console.log(
        JSON.stringify(
          {
            ...payload,
            environment: environmentLabel(args),
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
    } else if (args.apiKey?.trim()) {
      const existed = existsSync(join(projectRoot, ".augenta", "config.json"));
      const { path, neurolink } = await connectWithApiKey(
        projectRoot,
        args.apiKey.trim(),
        args.endpoint,
      );
      console.log(
        `${existed ? "Updated" : "Wrote"} ${path} (0600). Platform-key capture is enabled through Neurolink ${neurolink.id}.`,
      );
      console.log(
        "Off switch: delete .augenta/config.json, or set AUGENTA_CAPTURE_ENABLED=0.",
      );
    } else if (!input.isTTY) {
      throw new Error(
        "signing in needs an interactive terminal; agents should use --json with --probe/--login/--await-login/--neurospace, and --api-key is for autonomous or CI clients.",
      );
    } else {
      await connectProject(projectRoot, args);
    }
  } catch (error) {
    const message = (error as Error).message;
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
