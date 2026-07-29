#!/usr/bin/env bun
/**
 * Human/plugin hosted E2E. Reuses a connected project's owner-only
 * profile, ships through the real outbox/shipper, and verifies the durable
 * landed record through the authenticated platform API. Tokens are never
 * printed or copied into environment variables.
 *
 * Usage:
 *   bun scripts/dev-e2e.ts \
 *     --project /absolute/path/to/connected-project \
 *     --control-url https://dev.augenta.ai
 */
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAugentaDir } from "../capture/augenta-dir";
import {
  augentaOAuthConfig,
  fetchWithProfile,
  getAuthProfile,
} from "../capture/auth";
import { loadProjectConfig } from "../capture/config";
import { Outbox } from "../capture/outbox";
import { resolveTargetProject } from "./connect";

interface Args {
  project?: string;
  controlUrl: string;
}

interface MeResponse {
  user: { id: string; name?: string; email?: string };
  org: { id: string; name: string };
}

interface Neurolink {
  id: string;
  neurospaceId: string;
  direction: "inbound" | "outbound" | "bidirectional";
  status: "active" | "disabled";
  revision: number;
}

interface ExperienceRow {
  path: string;
  sid: string;
  neurolinkId: string;
  caller?: { type?: string };
}

function parseArgs(argv: string[]): Args {
  const args: Args = { controlUrl: "https://dev.augenta.ai" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") {
      args.project = argv[++i];
    } else if (argv[i] === "--control-url") {
      args.controlUrl = argv[++i] || args.controlUrl;
    }
  }
  return args;
}

function sameUrl(left: string, right: string): boolean {
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

async function json<T>(
  profileId: string,
  url: string,
): Promise<T> {
  const response = await fetchWithProfile(profileId, url);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `${url} returned ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * Every landed row for this sid — one per destination the project feeds. Polls
 * until every expected destination is COVERED, so a fan-out that only reached the
 * first Neurospace fails the check instead of passing on the row that did arrive.
 *
 * Gating on coverage rather than row count matters: if the platform ever records
 * more than one row per (sid, destination), a count would be satisfied by rows
 * from a single destination and the coverage assertion below would then fail
 * spuriously against a fan-out that was actually fine.
 */
async function waitForExperiences(
  profileId: string,
  gateway: string,
  sid: string,
  expected: readonly string[],
  timeoutMs = 60_000,
): Promise<ExperienceRow[]> {
  const started = Date.now();
  let found: ExperienceRow[] = [];
  while (Date.now() - started < timeoutMs) {
    const page = await json<{ items?: ExperienceRow[] }>(
      profileId,
      `${gateway}/v1/experiences?limit=200`,
    );
    found = page.items?.filter((item) => item.sid === sid) ?? [];
    const landed = new Set(found.map((row) => row.neurolinkId));
    if (expected.every((id) => landed.has(id))) return found;
    await Bun.sleep(1_000);
  }
  return found;
}

let failures = 0;
function check(ok: boolean, label: string, detail?: string): void {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const args = parseArgs(process.argv.slice(2));
const projectRoot = resolveTargetProject(
  { ...(args.project ? { project: args.project } : {}) },
  process.cwd(),
);
const cfg = loadProjectConfig(projectRoot);
if (cfg?.authMode !== "oauth" || !cfg.profileId || !cfg.neurolinkIds?.length) {
  console.error(
    `Connect ${projectRoot} with an Augenta sign-in before running this test.`,
  );
  process.exit(2);
}
/**
 * Every destination the connected project feeds. The harness ships once and then
 * asserts the record landed in EACH of them — that is the only end-to-end proof
 * that fan-out reached more than the first Neurospace.
 */
const destinations = cfg.neurolinkIds;

console.log(`dev-e2e — project=${projectRoot}`);
const discovered = await augentaOAuthConfig(args.controlUrl);
const gateway = (cfg.endpoint || discovered.gateway).replace(/\/+$/, "");
const profile = getAuthProfile(cfg.profileId);
check(Boolean(profile), "global sign-in profile exists");
check(
  Boolean(
    profile &&
      sameUrl(profile.issuer, discovered.issuer) &&
      profile.clientId === discovered.clientId &&
      sameUrl(profile.gateway, discovered.gateway),
  ),
  "project profile matches the selected environment discovery",
);
check(
  sameUrl(gateway, discovered.gateway),
  "project gateway matches the selected environment",
  gateway,
);
if (failures > 0) process.exit(1);

const me = await json<MeResponse>(cfg.profileId, `${gateway}/v1/me`);
check(
  Boolean(me.user?.id && me.org?.id),
  "stored sign-in reaches /v1/me",
  `${me.user?.email || me.user?.id} · ${me.org?.name}`,
);
const links = new Map<string, Neurolink>();
for (const id of destinations) {
  const { neurolink } = await json<{ neurolink: Neurolink }>(
    cfg.profileId,
    `${gateway}/v1/neurolinks/${encodeURIComponent(id)}`,
  );
  links.set(id, neurolink);
  check(
    neurolink.status === "active" &&
      (neurolink.direction === "inbound" ||
        neurolink.direction === "bidirectional"),
    `configured Neurolink ${id} is active and inbound`,
    `neurospace=${neurolink.neurospaceId}`,
  );
}
check(
  new Set([...links.values()].map((l) => l.neurospaceId)).size === destinations.length,
  "each destination is a DISTINCT Neurospace",
);

const tempProject = mkdtempSync(join(tmpdir(), "augenta-hosted-e2e-"));
try {
  const augentaDir = ensureAugentaDir(tempProject);
  const configPath = join(augentaDir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        authMode: "oauth",
        profileId: cfg.profileId,
        neurolinkIds: destinations,
        endpoint: gateway,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(configPath, 0o600);

  const sid = `sess-hosted-oauth-${Date.now()}`;
  const now = new Date().toISOString();
  const box = new Outbox(tempProject);
  check(
    box.append([
      {
        src: "codex",
        sid,
        proj: projectRoot,
        ts: now,
        seq: 1,
        turn: 1,
        kind: "msg",
        role: "user",
        text: "Augenta hosted OAuth plugin E2E",
      },
      {
        src: "codex",
        sid,
        proj: projectRoot,
        ts: now,
        seq: 2,
        turn: 1,
        kind: "msg",
        role: "assistant",
        text: "Verified through the real durable outbox and Neurolink",
      },
    ]),
    "real plugin outbox accepted the test turn",
  );

  const shipper = Bun.spawn(
    ["bun", "run", join(import.meta.dir, "..", "capture", "ship.ts"), tempProject],
    {
      env: { ...process.env } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(shipper.stdout).text(),
    new Response(shipper.stderr).text(),
    shipper.exited,
  ]);
  check(
    exitCode === 0,
    "real plugin shipper exited cleanly",
    stderr.trim() || stdout.trim() || `code=${exitCode}`,
  );
  check(!box.hasPendingBytes(), "durable outbox advanced after accepted delivery");

  const rows = await waitForExperiences(cfg.profileId, gateway, sid, destinations);
  check(rows.length > 0, "experience landed and is visible to its user");
  // The load-bearing fan-out assertion: ONE ship reached EVERY destination, with
  // the same bytes attributed to each Neurolink in turn.
  const landed = new Set(rows.map((r) => r.neurolinkId));
  check(
    destinations.every((id) => landed.has(id)),
    `experience landed in all ${destinations.length} configured destination(s)`,
    `landed=${[...landed].join(", ")}`,
  );

  for (const row of rows) {
    const detail = await json<{
      experience: {
        sid?: string;
        v?: number;
        neurolinkId?: string;
        neurolinkRevision?: number;
        routing?: { caller?: { type?: string; userId?: string } };
      };
    }>(
      cfg.profileId,
      `${gateway}/v1/experiences/blob?path=${encodeURIComponent(row.path)}`,
    );
    check(
      detail.experience.sid === sid &&
        detail.experience.v === 2 &&
        detail.experience.neurolinkId === row.neurolinkId &&
        detail.experience.neurolinkRevision ===
          links.get(row.neurolinkId)?.revision &&
        // Platform-side wire value in the routing snapshot, not ours to rename:
        // this asserts what the server recorded about the caller.
        detail.experience.routing?.caller?.type === "workos" &&
        detail.experience.routing?.caller?.userId === me.user.id,
      `durable record preserves schema-v2 caller and Neurolink snapshot (${row.neurolinkId})`,
    );
  }
} finally {
  rmSync(tempProject, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\nAll hosted sign-in/plugin checks passed."
    : `\n${failures} hosted E2E check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
