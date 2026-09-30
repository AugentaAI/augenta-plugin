/**
 * Tests for session-start.ts — the SessionStart connect prompt, memory scan, and
 * stranded-outbox drain.
 *
 * Contract under test: an unconnected project fires the connect prompt exactly
 * once per project, through additionalContext alone on both harnesses (agent-
 * directed on Claude Code, naming /augenta:connect; a user-facing reminder with
 * no agent-only scaffolding on Codex); a connected project is
 * silent; a previously-prompted project is silent — including one prompted
 * under the pre-0.3.0 `init-prompted.json` map. A config file the current
 * parser REJECTS counts as unconnected and gets its own one-shot reconnect
 * prompt; it must never be silently treated as connected.
 *
 * Run as a subprocess with an isolated AUGENTA_HOME (the prompted-marker map)
 * and a temp project as cwd.
 *
 * Run: bun test hooks/session-start.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDocumentRecord, Outbox } from "../capture/outbox";
import { joinCheckout, writeSharedConfig, TEST_USER_ID } from "../__tests__/fixtures";
import { DEFAULT_GATEWAY, type Destination } from "../capture/config";
import type { CaptureEvent } from "../capture/event";

const HOOK = join(import.meta.dir, "session-start.ts");
const CODEX_TP = "C:/Users/x/.codex/sessions/2026/06/24/rollout-2026-06-24T00-00-00-abc.jsonl";
const CLAUDE_TP = "C:/Users/x/.claude/projects/enc/sess-1.jsonl";

let home: string;
let project: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aug-ss-home-"));
  // Physical path, matching the root the hook resolves (macOS tmpdir() is under
  // the /var → /private/var symlink).
  project = realpathSync(mkdtempSync(join(tmpdir(), "aug-ss-proj-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** Seed a prompted-marker map in the isolated AUGENTA_HOME. */
function writeMarkers(file: string, markers: Record<string, string>): void {
  const stateDir = join(home, ".augenta", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, file), JSON.stringify(markers));
}

/** This machine signed in to `profileId` as `userId`, for the gateway a config
 *  with no `endpoint` resolves to — as connect pairs them. */
function signIn(profileId: string, userId = TEST_USER_ID): void {
  const authDir = join(home, ".augenta");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({
    version: 1,
    profiles: { [profileId]: { userId, orgId: "org_1", gateway: DEFAULT_GATEWAY, accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, updatedAt: new Date().toISOString() } },
  }));
}

/** Signed in here, and this checkout joined those destinations with its own
 *  links: what connect leaves behind, and what capture now requires. */
function signInAndJoin(profileId: string, destinations: readonly Destination[]): void {
  signIn(profileId);
  joinCheckout(project, { profileId, destinations });
}

function fire(payload: object, overrides: Record<string, string> = {}): string {
  // AUGENTA_AUTH_HOME too: the capture gate reads the sign-in store, and a test
  // must never read the developer's real ~/.augenta/auth.json.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AUGENTA_CONTROL_URL: "",
    AUGENTA_HOME: home,
    AUGENTA_AUTH_HOME: join(home, ".augenta"),
    // Lasting unless a test says otherwise, even when the suite runs in a cloud session.
    AUGENTA_EPHEMERAL: "0",
    ...overrides,
  };
  const proc = Bun.spawnSync(["bun", "run", HOOK], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.stdout.toString();
}

describe("unconnected project — the connect prompt, harness-aware", () => {
  test("an old connectorIds config gets the reconnect prompt", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "oauth", profileId: "profile_one", connectorIds: ["connector_one"] }));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toContain("cannot read");
  });

  test("the pre-release shape, Connectors in the shared file, gets the reconnect prompt", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({
      authMode: "oauth", profileId: "profile_one",
      destinations: [{ connectorId: "connector_one", workspaceId: "ws-one" }],
    }));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toContain("cannot read");
  });

  test("a saved non-production environment is disclosed through Codex additionalContext", () => {
    const destinations = [{ connectorId: "connector_one", workspaceId: "ws-one", workspaceName: "Platform" }];
    writeSharedConfig(project, { profileId: "profile_one", destinations, extra: { controlUrl: "https://control.example.com" } });
    signInAndJoin("profile_one", destinations);
    const payload = JSON.parse(fire({ transcript_path: CODEX_TP, cwd: project }));
    expect(payload.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext: "Augenta: this project is connected to the https://control.example.com environment, not production, feeding Platform.",
    });
    expect(fire({ transcript_path: CODEX_TP, cwd: project }, { AUGENTA_CONTROL_URL: "https://augenta.ai" })).toBe("");
  });

  test("Claude Code: agent-directed context naming /augenta:connect, no initialUserMessage", () => {
    const out = fire({ transcript_path: CLAUDE_TP, cwd: project });
    const parsed = JSON.parse(out);
    // initialUserMessage acts only in `-p` runs, where it would put a connect
    // turn ahead of a headless caller's own prompt. The hidden context is the
    // channel that reaches the model interactively, so it is the only one used.
    expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual([
      "additionalContext",
      "hookEventName",
    ]);
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("/augenta:connect");
    expect(out).toContain("never be pasted");
  });

  test("Codex: schema-valid reminder, no Claude-only field or agent scaffolding", () => {
    const out = fire({ transcript_path: CODEX_TP, cwd: project });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput?.initialUserMessage).toBeUndefined();
    expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual([
      "additionalContext",
      "hookEventName",
    ]);
    // Nothing auto-fires on Codex, so the one prompt this project ever gets must
    // name how to act on it — a bare narration would strand the user.
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("$augenta:connect");
    expect(out).not.toContain("/augenta:connect");
    expect(out).not.toContain("[Augenta]");
  });

  test("fires exactly once per project (second session is silent)", () => {
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).not.toBe("");
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("distinct projects each get their one prompt", () => {
    const other = mkdtempSync(join(tmpdir(), "aug-ss-proj2-"));
    try {
      expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).not.toBe("");
      expect(fire({ transcript_path: CLAUDE_TP, cwd: other })).not.toBe("");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a throwaway session outside any checkout is not prompted: connect would refuse it", () => {
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project }, { AUGENTA_EPHEMERAL: "1" })).toBe("");
    // Nothing was recorded either, so a lasting session there still gets its one prompt.
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).not.toBe("");
  });

  test("a throwaway session in a checkout is still prompted", () => {
    mkdirSync(join(project, ".git"));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project }, { AUGENTA_EPHEMERAL: "1" })).not.toBe("");
  });

  test("a project already prompted under the pre-0.3.0 marker is not re-prompted", () => {
    // Renaming the skill renamed the marker map. Reading only the new name would
    // re-fire the "one automatic prompt it will ever get" at every project every
    // user had already dismissed.
    writeMarkers("init-prompted.json", { [project]: "2026-01-01T00:00:00.000Z" });
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });
});

describe("connected, but capture is off in this checkout — the join notice", () => {
  // A committed config arrives in every clone and worktree. Until connect runs
  // here, capture is off, and the one thing SessionStart owes is saying so.
  const recorded = (connectorIds: string[]) =>
    connectorIds.map((connectorId, i) => ({ connectorId, workspaceId: `ws-${i}`, workspaceName: `Workspace ${i}` }));
  const committed = (connectorIds = ["connector_one"]) =>
    writeSharedConfig(project, {
      profileId: "profile_one",
      destinations: recorded(connectorIds),
      extra: { org: { id: "org_1", name: "Example Org" } },
    });

  test("not signed in here: named destinations, capture off, offered and never started", () => {
    committed();
    const out = fire({ transcript_path: CLAUDE_TP, cwd: project });
    const context = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("Workspace 0 (Example Org)");
    expect(context).toContain("capture is off in this checkout because this machine is not signed in to Augenta for it");
    expect(context).toContain("/augenta:connect");
    expect(context).toContain("Do not start a sign-in without their go-ahead");
    // Nothing was captured or written into the project while it is off.
    expect(existsSync(join(project, ".augenta", "outbox"))).toBe(false);
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("signed in but not joined, then joined: the notice stops and capture is live", () => {
    committed();
    signIn("profile_one");
    const out = fire({ transcript_path: CLAUDE_TP, cwd: project });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("this checkout has not joined it");
    signInAndJoin("profile_one", recorded(["connector_one"]));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("a pulled change to the Workspaces is raised again, an addition or a removal", () => {
    committed(["connector_one", "connector_two"]);
    signInAndJoin("profile_one", recorded(["connector_one", "connector_two"]));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
    committed(["connector_one"]);
    const removal = fire({ transcript_path: CLAUDE_TP, cwd: project });
    expect(JSON.parse(removal).hookSpecificOutput.additionalContext).toContain("its Workspaces changed since this checkout joined");
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
    committed(["connector_one", "connector_two", "connector_three"]);
    const addition = fire({ transcript_path: CLAUDE_TP, cwd: project });
    expect(JSON.parse(addition).hookSpecificOutput.additionalContext).toContain("its Workspaces changed since this checkout joined");
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
    // Back to the set this checkout joined: live again, and quiet.
    committed(["connector_one", "connector_two"]);
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("a pulled endpoint that points away from this sign-in's gateway is named, once, with its history first", () => {
    committed();
    signInAndJoin("profile_one", recorded(["connector_one"]));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
    writeSharedConfig(project, {
      profileId: "profile_one",
      destinations: recorded(["connector_one"]),
      extra: { org: { id: "org_1", name: "Example Org" }, endpoint: "https://evil.example.com", discoveredGateway: "https://evil.example.com" },
    });
    const out = fire({ transcript_path: CLAUDE_TP, cwd: project });
    const context = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(context).toContain(`it now points Augenta at https://evil.example.com, not ${DEFAULT_GATEWAY}`);
    expect(context).toContain("git log -p .augenta/config.json");
    expect(context).toContain("Nothing was sent there");
    expect(existsSync(join(project, ".augenta", "outbox"))).toBe(false);
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
    // Another destination is another change, raised again.
    writeSharedConfig(project, {
      profileId: "profile_one",
      destinations: recorded(["connector_one"]),
      extra: { org: { id: "org_1", name: "Example Org" }, endpoint: "https://elsewhere.example.com" },
    });
    expect(JSON.parse(fire({ transcript_path: CODEX_TP, cwd: project })).hookSpecificOutput.additionalContext)
      .toContain("check the history of .augenta/config.json");
  });

  test("a platform-key config git tracks is off, said once, and never names connect as the fix", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "platform-test-key" }));
    spawnSync("git", ["init", "-q"], { cwd: project });
    spawnSync("git", ["add", "-f", ".augenta/config.json"], { cwd: project });
    const out = fire({ transcript_path: CLAUDE_TP, cwd: project });
    const context = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("git rm --cached .augenta/config.json");
    expect(context).toContain("Do not run the connect skill");
    expect(context).not.toContain("platform-test-key");
    expect(existsSync(join(project, ".augenta", "outbox"))).toBe(false);
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("a join under another sign-in is named as that, not as changed Workspaces", () => {
    committed();
    signIn("profile_one");
    joinCheckout(project, { profileId: "profile_other", destinations: recorded(["connector_one"]) });
    const out = fire({ transcript_path: CLAUDE_TP, cwd: project });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("this checkout joined it under a different sign-in");
  });

  test("another person signing in to the same organization here is told, once", () => {
    committed();
    signInAndJoin("profile_one", recorded(["connector_one"]));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
    // Same organization, so the same profile id, but not the person whose links these are.
    signIn("profile_one", "user_2");
    const out = fire({ transcript_path: CLAUDE_TP, cwd: project });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("this checkout joined it under a different sign-in");
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("Codex gets user-facing wording and the $ invocation", () => {
    committed();
    const parsed = JSON.parse(fire({ transcript_path: CODEX_TP, cwd: project }));
    expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
    expect(parsed.hookSpecificOutput.additionalContext).toStartWith("Augenta: this project is set up to send capture to Workspace 0");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("$augenta:connect");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("[Augenta]");
  });

  test("the kill switch keeps it silent", () => {
    committed();
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project }, { AUGENTA_CAPTURE_ENABLED: "0" })).toBe("");
  });
});

describe("the kill switch means silence, notices included", () => {
  test("a pending auth notice is neither shown nor consumed while capture is off", () => {
    // hooks.json promises AUGENTA_CAPTURE_ENABLED=0 disables the hook. Nagging
    // about a connection the user deliberately switched off breaks that — and
    // leaving the marker unread means it still surfaces once capture is back,
    // which is the moment it becomes actionable.
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(
      join(project, ".augenta", "config.json"),
      JSON.stringify({ authMode: "api-key", apiKey: "k" }),
    );
    const notice = join(project, ".augenta", "relogin-required");
    writeFileSync(notice, "relogin\n");

    expect(fire({ transcript_path: CLAUDE_TP, cwd: project }, { AUGENTA_CAPTURE_ENABLED: "0" })).toBe("");
    expect(existsSync(notice)).toBe(true);

    // Re-enabled: the same pending notice now surfaces, exactly once.
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toContain("queued capture");
    expect(existsSync(notice)).toBe(false);
  });
});

describe("a config file the parser rejects is UNCONNECTED, not connected", () => {
  // The failure this covers: resolveProjectRoot finds a config by existence, so
  // an unreadable one took the connected branch — capture off (it does not load)
  // AND unpromptable (the prompt is gated on the file's ABSENCE). Silent, and
  // permanent. Every pre-0.3.0 `{apiKey}` config from the removed setup.ts is
  // exactly this shape.
  const LEGACY = JSON.stringify({ apiKey: "k-from-setup-ts" });

  function writeConfig(body: string): void {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), body);
  }

  test("a legacy setup.ts config prompts to reconnect instead of going silent", () => {
    writeConfig(LEGACY);
    const parsed = JSON.parse(fire({ transcript_path: CLAUDE_TP, cwd: project }));
    expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual([
      "additionalContext",
      "hookEventName",
    ]);
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("/augenta:connect");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("cannot read");
  });

  test("truncated JSON prompts the same way", () => {
    writeConfig('{"authMode":"workos","profileId":');
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).not.toBe("");
  });

  test("the reconnect prompt also fires exactly once", () => {
    writeConfig(LEGACY);
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).not.toBe("");
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("a config made unreadable by a later format change is raised again", () => {
    // A project that reconnected through an earlier format change already holds
    // a reconnect marker; the next change must not turn capture off in silence.
    writeConfig(LEGACY);
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).not.toBe("");
    writeConfig(JSON.stringify({ authMode: "oauth", profileId: "p", destinations: [{ connectorId: "c", workspaceId: "w" }] }));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toContain("cannot read");
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("the pre-0.3.0 marker does NOT suppress it", () => {
    // Every project holding a legacy config was prompted under the old flow, so
    // honoring that marker here would re-silence exactly the users who need this.
    writeConfig(LEGACY);
    writeMarkers("init-prompted.json", { [project]: "2026-01-01T00:00:00.000Z" });
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).not.toBe("");
  });

  test("Codex gets user-facing wording with no agent scaffolding", () => {
    writeConfig(LEGACY);
    const out = fire({ transcript_path: CODEX_TP, cwd: project });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput?.initialUserMessage).toBeUndefined();
    // Same strict key set as the unconnected Codex case: both branches share one
    // emit site, so any field Codex would reject must fail on either path.
    expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual([
      "additionalContext",
      "hookEventName",
    ]);
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("can no longer be read");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("$augenta:connect");
    expect(out).not.toContain("[Augenta]");
    expect(out).not.toContain("/augenta:connect");
  });
});

describe("connected / silent paths", () => {
  test("a project with .augenta/config.json is silent", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });

  test("a config in an ancestor also counts as connected", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
    const sub = join(project, "src");
    mkdirSync(sub);
    expect(fire({ transcript_path: CLAUDE_TP, cwd: sub })).toBe("");
  });

  test("a connected Codex SessionStart captures matching global-memory Task Groups before its detached drain", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "aug-ss-codex-home-"));
    try {
      mkdirSync(join(project, ".augenta"), { recursive: true });
      writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
      mkdirSync(join(codexHome, "memories"), { recursive: true });
      writeFileSync(
        join(codexHome, "memories", "MEMORY.md"),
        `# Task Group: Current\napplies_to: cwd=${project}\nBackground memory.`,
      );

      expect(
        fire(
          { transcript_path: CODEX_TP, cwd: project },
          { CODEX_HOME: codexHome, AUGENTA_INGEST_URL: "http://127.0.0.1:1/v1/experiences" },
        ),
      ).toBe("");
      const captured = new Outbox(project).readPending().records.filter(isDocumentRecord);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.data.text).toContain("Background memory.");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("a Task Group recorded through a symlinked path to the project is still captured", () => {
    // A harness can report, and Codex record, a path through a symlink. The hook
    // resolves the project physically, so the Task Group's scope has to be
    // resolved the same way or that project's memory is silently skipped.
    const codexHome = mkdtempSync(join(tmpdir(), "aug-ss-codex-home-"));
    const aliasHome = mkdtempSync(join(tmpdir(), "aug-ss-alias-"));
    try {
      const alias = join(aliasHome, "project");
      symlinkSync(project, alias, "dir");
      mkdirSync(join(project, ".augenta"), { recursive: true });
      writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
      mkdirSync(join(codexHome, "memories"), { recursive: true });
      writeFileSync(
        join(codexHome, "memories", "MEMORY.md"),
        `# Task Group: Aliased\napplies_to: cwd=${alias}\nAliased memory.`,
      );

      expect(
        fire(
          { transcript_path: CODEX_TP, cwd: alias },
          { CODEX_HOME: codexHome, AUGENTA_INGEST_URL: "http://127.0.0.1:1/v1/experiences" },
        ),
      ).toBe("");
      const captured = new Outbox(project).readPending().records.filter(isDocumentRecord);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.data.text).toContain("Aliased memory.");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(aliasHome, { recursive: true, force: true });
    }
  });
});

describe("SessionStart drains a stranded outbox (G2)", () => {
  function stubEvent(seq: number): CaptureEvent {
    return { src: "claude-code", sid: "s1", proj: project, ts: "2026-06-15T00:00:00.000Z", seq, kind: "msg", role: "user", text: `stranded ${seq}` };
  }

  test("a connected project with a pending spool still exits silently — the drain is detached, output is unaffected", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
    // Seed a spool as if a prior session's final Stop never drained it.
    new Outbox(project).append([stubEvent(0)]);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      AUGENTA_HOME: home,
      // Unreachable on purpose — the spawned shipper's POST must fail fast and
      // harmlessly rather than ever reaching the real prod gateway.
      AUGENTA_INGEST_URL: "http://127.0.0.1:1/v1/experiences",
    };
    const proc = Bun.spawnSync(["bun", "run", HOOK], {
      stdin: Buffer.from(JSON.stringify({ transcript_path: CLAUDE_TP, cwd: project })),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe("");
  });

  test("a connected project with NOTHING pending is still silent (no spurious spawn)", () => {
    mkdirSync(join(project, ".augenta"), { recursive: true });
    writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ authMode: "api-key", apiKey: "k" }));
    expect(fire({ transcript_path: CLAUDE_TP, cwd: project })).toBe("");
  });
});
