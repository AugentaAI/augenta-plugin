#!/usr/bin/env bun
/** Connect one project to a Neurolink using WorkOS device login or a platform key. */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ensureAugentaDir } from "../capture/augenta-dir";
import {
  DEFAULT_GATEWAY,
  loadProjectConfig,
} from "../capture/config";
import {
  augentaOAuthConfig,
  deviceLogin,
  fetchWithProfile,
  ReLoginRequiredError,
  REQUEST_TIMEOUT_MS,
  reusableProfiles,
  saveDeviceProfile,
  type OAuthConfig,
} from "../capture/auth";

interface Args {
  apiKey?: string;
  project?: string;
  endpoint?: string;
  controlUrl?: string;
  harness?: "claude-code" | "codex";
}

interface MeResponse {
  user: { id: string; name: string; email: string };
  org: { id: string; name: string; workosOrgId?: string };
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
export const PLUGIN_VERSION = "0.3.0";

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
    }
  }
  return args;
}

export function resolveTargetProject(args: Args, cwd: string): string {
  if (args.project) return resolve(cwd, args.project);
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (top) return top;
  } catch {
    // A non-git directory is still a valid explicitly connected project.
  }
  return cwd;
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

export function writeWorkosConfig(
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
        authMode: "workos",
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
    throw new Error(`Augenta rejected the WorkOS login (${response.status})`);
  }
  const me = (await response.json()) as MeResponse;
  if (!me.user?.id || !me.org?.workosOrgId) {
    throw new Error("the authenticated WorkOS organization is not provisioned");
  }
  return me;
}

async function selectOrCreateProfile(
  oauth: OAuthConfig,
  preferredProfileId?: string,
): Promise<{ profileId: string; me: MeResponse }> {
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
  if (usable.length > 0) {
    return choose(
      "Choose the signed-in WorkOS organization:",
      usable,
      (item) => `${item.me.org.name} (${item.me.org.workosOrgId})`,
    );
  }

  const tokens = await deviceLogin(oauth);
  const me = await verifyFreshLogin(oauth, tokens.accessToken);
  const saved = await saveDeviceProfile(oauth, tokens, {
    workosUserId: me.user.id,
    workosOrgId: me.org.workosOrgId!,
  });
  return { profileId: saved.profileId, me };
}

async function selectedNeurospace(
  profileId: string,
  gateway: string,
): Promise<Neurospace> {
  const { neurospaces } = await bearerJson<{ neurospaces: Neurospace[] }>(
    profileId,
    `${gateway}/v1/neurospaces`,
  );
  if (neurospaces.length === 0) {
    throw new Error("the authenticated organization has no active Neurospaces");
  }
  return choose(
    "Choose the Neurospace for this project:",
    neurospaces,
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

export async function connectProject(
  projectRoot: string,
  args: Args,
): Promise<void> {
  const discovered = await augentaOAuthConfig(args.controlUrl);
  const gateway = (args.endpoint?.trim() || discovered.gateway).replace(/\/+$/, "");
  const oauth = { ...discovered, gateway };
  const existing = existsSync(join(projectRoot, ".augenta", "config.json"))
    ? loadProjectConfig(projectRoot)
    : undefined;
  const selected = await selectOrCreateProfile(
    oauth,
    existing?.authMode === "workos" ? existing.profileId : undefined,
  );
  console.log(
    `Signed in as ${selected.me.user.name || selected.me.user.email} to ${selected.me.org.name} (${selected.me.org.workosOrgId}).`,
  );
  const neurospace = await selectedNeurospace(selected.profileId, gateway);
  const neurolink = await connectNeurolink(
    projectRoot,
    args,
    selected.profileId,
    gateway,
    neurospace,
    existing?.authMode === "workos" ? existing.neurolinkId : undefined,
  );
  const verified = await bearerJson<{ neurolink: Neurolink }>(
    selected.profileId,
    `${gateway}/v1/neurolinks/${encodeURIComponent(neurolink.id)}`,
  );
  if (
    verified.neurolink.status !== "active" ||
    verified.neurolink.neurospaceId !== neurospace.id
  ) {
    throw new Error("Neurolink verification failed");
  }
  const endpointOverride = gateway === DEFAULT_GATEWAY ? undefined : gateway;
  const path = writeWorkosConfig(
    projectRoot,
    selected.profileId,
    verified.neurolink.id,
    endpointOverride,
  );
  console.log(
    `Wrote ${path} (0600). This project now feeds ${neurospace.name} through Neurolink ${verified.neurolink.id}.`,
  );
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
  // One failure shape for the whole CLI, argument parsing included — every exit
  // the user can cause reads as `Augenta connect: <what went wrong>`, never a
  // stack trace.
  try {
    const args = parseArgs(process.argv.slice(2));
    const projectRoot = resolveTargetProject(args, process.cwd());
    if (args.apiKey?.trim()) {
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
        "WorkOS login requires an interactive terminal; --api-key is for autonomous or CI clients.",
      );
    } else {
      await connectProject(projectRoot, args);
    }
  } catch (error) {
    console.error(`Augenta connect: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
