#!/usr/bin/env bun
/**
 * Connect one project to a Neurolink, by Augenta sign-in or a platform key.
 *
 * Two front ends over the same core. A human running this in a terminal gets the
 * interactive prompts. An agent runs the `--json` verbs — `--probe`, `--login`,
 * `--await-login`, `--neurospace` — each of which returns one JSON object and
 * exits, so the sign-in link reaches the user in a bounded call instead of after
 * a poll loop nobody can see. No verb accepts or emits a credential: tokens go
 * browser → `~/.augenta/auth.json`, and `--api-key` stays human/CI-only.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ensureAugentaDir } from "../capture/augenta-dir";
import {
  DEFAULT_GATEWAY,
  loadProjectConfig,
} from "../capture/config";
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
  neurospace?: string;
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
export const PLUGIN_VERSION = "0.5.0";

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
      args.neurospace = valueFor(flag, i++);
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

export function writeOAuthConfig(
  projectRoot: string,
  profileId: string,
  neurolinkId: string,
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
        neurolinkId,
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
 * Numbered interactive pick. A single option is auto-selected — there is nothing
 * to decide — unless `alwaysAsk` is set, which the Neurospace choice uses: WHICH
 * Neurospace a project feeds is the user's consent decision, so it stays explicit
 * even when only one exists (see skills/connect/SKILL.md).
 */
async function choose<T>(
  prompt: string,
  values: T[],
  label: (value: T) => string,
  opts: { alwaysAsk?: boolean } = {},
): Promise<T> {
  if (values.length === 0) throw new Error(`no choices available for ${prompt}`);
  if (values.length === 1 && !opts.alwaysAsk) return values[0]!;
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

async function selectedNeurospace(
  profileId: string,
  gateway: string,
): Promise<Neurospace> {
  return choose(
    "Choose the Neurospace for this project:",
    await listNeurospaces(profileId, gateway),
    (neurospace) => `${neurospace.name} (${neurospace.id})`,
    { alwaysAsk: true },
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

async function connectNeurolink(
  projectRoot: string,
  args: Args,
  profileId: string,
  gateway: string,
  neurospace: Neurospace,
  priorId?: string,
): Promise<Neurolink> {
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
  const existing = await currentNeurolink(profileId, gateway, priorId);
  if (existing?.kind === "agent" && existing.status === "active") {
    const { kind: _kind, ...mutableFields } = fields;
    return (
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
  }
  return (
    await bearerJson<{ neurolink: Neurolink }>(
      profileId,
      `${gateway}/v1/neurolinks`,
      { method: "POST", body: JSON.stringify(fields) },
    )
  ).neurolink;
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
): { profileId?: string; neurolinkId?: string } | undefined {
  if (!existsSync(join(projectRoot, ".augenta", "config.json"))) return undefined;
  try {
    const existing = loadProjectConfig(projectRoot);
    return existing?.authMode === "oauth"
      ? { profileId: existing.profileId, neurolinkId: existing.neurolinkId }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Create or retarget the Neurolink, verify it landed, then write the config. */
async function establishNeurolink(
  projectRoot: string,
  args: Args,
  profileId: string,
  gateway: string,
  neurospace: Neurospace,
  priorId?: string,
): Promise<{ neurolink: Neurolink; configPath: string }> {
  const neurolink = await connectNeurolink(
    projectRoot,
    args,
    profileId,
    gateway,
    neurospace,
    priorId,
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
  return {
    neurolink: verified.neurolink,
    configPath: writeOAuthConfig(
      projectRoot,
      profileId,
      verified.neurolink.id,
      gateway === DEFAULT_GATEWAY ? undefined : gateway,
    ),
  };
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
  const neurospace = await selectedNeurospace(selected.profileId, gateway);
  const { neurolink, configPath } = await establishNeurolink(
    projectRoot,
    args,
    selected.profileId,
    gateway,
    neurospace,
    prior?.neurolinkId,
  );
  console.log(
    `Wrote ${configPath} (0600). This project now feeds ${neurospace.name} through Neurolink ${neurolink.id}.`,
  );
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
 * Read-only "what happens next". Deliberately starts NO authorization: the caller
 * needs to describe the choice and get consent before anything leaves the machine.
 *
 * An existing connection is reported as a field, not a terminal status — the skill
 * must still be able to reconnect a project to verify or change its Neurospace.
 */
export async function probeConnection(
  resolved: ResolvedProject,
  args: Args,
): Promise<JsonPayload> {
  const { oauth, gateway } = await resolveOAuth(args);
  const prior = priorConnection(resolved.projectRoot);
  const connected = prior?.neurolinkId
    ? { alreadyConnected: true, neurolinkId: prior.neurolinkId }
    : { alreadyConnected: false };
  const usable = await usableProfiles(oauth, prior?.profileId);
  if (usable.length === 0) return { status: "need_login", ...connected };
  if (usable.length > 1) {
    return {
      status: "need_profile",
      ...connected,
      profiles: usable.map((item) => ({
        profileId: item.profileId,
        organization: item.me.org.name,
        email: item.me.user.email,
      })),
    };
  }
  return {
    ...(await neurospaceStep(usable[0]!.profileId, gateway, usable[0]!.me)),
    ...connected,
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
 * Finish: bind the project to the chosen Neurospace. The id must be one the
 * organization actually has — a wrong or invented id fails loudly here instead of
 * quietly misrouting a project's transcripts.
 */
export async function connectToNeurospace(
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
  const neurospaces = await listNeurospaces(picked.profileId, gateway);
  const neurospace = neurospaces.find((item) => item.id === args.neurospace);
  if (!neurospace) {
    return {
      status: "error",
      code: "unknown_neurospace",
      message: `${args.neurospace} is not an active Neurospace in ${picked.me.org.name}`,
    };
  }
  const { neurolink, configPath } = await establishNeurolink(
    resolved.projectRoot,
    args,
    picked.profileId,
    gateway,
    neurospace,
    prior?.neurolinkId,
  );
  return {
    status: "connected",
    neurolinkId: neurolink.id,
    neurospaceId: neurospace.id,
    neurospaceName: neurospace.name,
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
  if (args.neurospace) return connectToNeurospace(resolved, args);
  if (args.awaitLogin) return awaitLogin(args);
  if (args.login) return startLogin(args);
  if (args.probe) return probeConnection(resolved, args);
  return {
    status: "error",
    code: "no_verb",
    message:
      "--json requires one of --probe, --login, --await-login, or --neurospace <id>",
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
  // Capture writes to exactly one link; with several visible there is no
  // non-arbitrary pick, and guessing would silently misroute the project.
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

if (import.meta.main) {
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
