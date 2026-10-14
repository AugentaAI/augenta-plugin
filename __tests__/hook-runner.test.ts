import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCodexHarness } from "../hooks/harness";

const RUNNER = join(import.meta.dir, "..", "scripts", "run-node-hook.sh");
const temporaryDirectories: string[] = [];

function executable(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "augenta-node-runner-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "node");
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("hook Node runner: a proxy the environment names reaches Node", () => {
  /** A fake node that, as the bundle, prints the proxy settings it was started with. */
  const reporter = () => executable(`#!/bin/sh
if [ "$1" = "-e" ]; then exit 0; fi
printf 'USE=%s\\nWARN=%s\\nCA=%s\\n' "\${NODE_USE_ENV_PROXY:-}" "\${NODE_NO_WARNINGS:-}" "\${NODE_EXTRA_CA_CERTS:-}"
`);
  const run = (extra: Record<string, string>) => {
    // Built from nothing, so a proxy in the developer's own shell cannot leak in.
    const result = Bun.spawnSync(["sh", RUNNER, "/tmp/hook.mjs"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", AUGENTA_NODE: reporter(), ...extra },
    });
    expect(result.exitCode).toBe(0);
    return Object.fromEntries(result.stdout.toString().trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
  };

  test("no proxy: nothing is set", () => {
    expect(run({})).toEqual({ USE: "", WARN: "", CA: "" });
  });

  test("a proxy in any spelling turns on Node's env-proxy support and quiets its notice", () => {
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      const seen = run({ [name]: "http://127.0.0.1:3128" });
      expect(seen.USE, name).toBe("1");
      expect(seen.WARN, name).toBe("1");
      // Only ever a file Node can read, or nothing at all.
      if (seen.CA) expect(existsSync(seen.CA)).toBe(true);
    }
  });

  test("values the environment already chose are left alone", () => {
    expect(run({ HTTPS_PROXY: "http://p:1", NODE_USE_ENV_PROXY: "0", NODE_NO_WARNINGS: "0", NODE_EXTRA_CA_CERTS: "/mine.pem" }))
      .toEqual({ USE: "0", WARN: "0", CA: "/mine.pem" });
  });
});

describe("hook Node runner", () => {
  test("uses an explicit working Node and preserves bundle arguments", () => {
    const fakeNode = executable(`#!/bin/sh
if [ "$1" = "-e" ]; then exit 0; fi
printf '%s\\n' "$@"
`);
    const target = "/tmp/Augenta bundle with spaces.mjs";
    const result = Bun.spawnSync(["sh", RUNNER, target, "one", "two words"], {
      env: { ...process.env, AUGENTA_NODE: fakeNode },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      target,
      "one",
      "two words",
    ]);
  });

  test("fails clearly instead of ignoring an invalid explicit runtime", () => {
    const brokenNode = executable("#!/bin/sh\nexit 134\n");
    const result = Bun.spawnSync(["sh", RUNNER, "/tmp/hook.mjs"], {
      env: { ...process.env, AUGENTA_NODE: brokenNode },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "AUGENTA_NODE is not a working Node.js 20+ executable",
    );
  });

  test("hands the hook payload to the bundle, not to a probe", () => {
    // The version probe reads nothing, but stdin is the hook PAYLOAD. A `node`
    // on PATH that is not Node would consume it and the bundle would see an
    // empty stream — the silent stdin-then-exit-0 failure this runner prevents.
    const greedyNode = executable(`#!/bin/sh
if [ "$1" = "-e" ]; then cat >/dev/null; exit 0; fi
cat
`);
    const payload = '{"cwd":"/tmp/p","hook_event_name":"Stop"}';
    const result = Bun.spawnSync(["sh", RUNNER, "/tmp/hook.mjs"], {
      env: { ...process.env, AUGENTA_NODE: greedyNode },
      stdin: Buffer.from(payload),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(payload);
  });

  describe("when no working Node exists", () => {
    function temporary(prefix: string): string {
      const directory = mkdtempSync(join(tmpdir(), prefix));
      temporaryDirectories.push(directory);
      return directory;
    }

    /**
     * No AUGENTA_NODE, no PATH, and a HOME with no version-manager installs. An
     * empty PATH is the point: the no-runtime tail must work on shell builtins
     * alone, because the PATH that led there is the thing under suspicion.
     */
    function runWithout(
      payload: string,
      env: Record<string, string> = {},
      cwd?: string,
    ): { exitCode: number; stdout: string; stderr: string } {
      const result = Bun.spawnSync(["sh", RUNNER, "/tmp/hook.mjs"], {
        env: { PATH: "", HOME: temporary("augenta-node-runner-home-"), ...env },
        stdin: Buffer.from(payload),
        ...(cwd ? { cwd } : {}),
      });
      return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    }
    const quiet = { exitCode: 0, stdout: "", stderr: "" };

    test("stays a silent no-op for a project that never opted in", () => {
      // A missing runtime is not evidence of consent, and a hook that has no
      // work to do must print nothing (AGENTS.md → Privacy invariants).
      const project = mkdtempSync(join(tmpdir(), "augenta-node-runner-project-"));
      temporaryDirectories.push(project);

      expect(runWithout(`{"cwd":"${project}","hook_event_name":"Stop"}`)).toEqual(quiet);
    });

    test("tells a CONNECTED project that its capture has stopped", () => {
      const project = mkdtempSync(join(tmpdir(), "augenta-node-runner-project-"));
      temporaryDirectories.push(project);
      mkdirSync(join(project, ".augenta"));
      writeFileSync(join(project, ".augenta", "config.json"), "{}");

      const result = runWithout(`{"cwd":"${project}","hook_event_name":"Stop"}`);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Node.js 20 or newer was not found");
      expect(result.stderr).toContain("AUGENTA_NODE");
    });

    test("symlinked folders use the physical checkout for missing-runtime diagnostics", () => {
      const root = mkdtempSync(join(tmpdir(), "augenta-node-runner-project-"));
      temporaryDirectories.push(root);
      const main = join(root, "main");
      const worktree = join(root, "worktree");
      const deep = join(worktree, "src");
      mkdirSync(join(main, ".augenta"), { recursive: true });
      writeFileSync(join(main, ".augenta/config.json"), "{}");
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(worktree, ".git"), "gitdir: /fixture");
      const alias = join(main, "linked-src"); symlinkSync(deep, alias, "dir");
      expect(runWithout(JSON.stringify({ cwd: alias }))).toEqual(quiet);
      mkdirSync(join(worktree, ".augenta"));
      writeFileSync(join(worktree, ".augenta/config.json"), "{}");
      expect(runWithout(JSON.stringify({ cwd: alias })).exitCode).toBe(1);
    });

    test("diagnoses nested folders but stops at another checkout boundary", () => {
      const project = mkdtempSync(join(tmpdir(), "augenta-node-runner-project-"));
      temporaryDirectories.push(project);
      mkdirSync(join(project, ".augenta"));
      writeFileSync(join(project, ".augenta/config.json"), "{}");
      const nested = join(project, "nested"); mkdirSync(nested);
      expect(runWithout(JSON.stringify({ cwd: nested })).exitCode).toBe(1);
      writeFileSync(join(nested, ".git"), "gitdir: /fixture");
      expect(runWithout(JSON.stringify({ cwd: nested }))).toEqual(quiet);
    });

    // Without Node, SessionStart's connect prompt cannot run either, so a host
    // with no Node would otherwise never hear from the plugin at all. It gets ONE
    // notice per computer, through the channel that prompt would have used.
    describe("the one notice a computer gets", () => {
      const marker = (home: string) => join(home, ".augenta", "state", "node-missing-notified");
      const sessionStart = (cwd: string, transcriptPath?: string) =>
        JSON.stringify({ session_id: "s", ...(transcriptPath ? { transcript_path: transcriptPath } : {}), cwd, hook_event_name: "SessionStart" });

      /** The notice's text, after holding it to the only two fields Codex's SessionStart schema accepts. */
      function notice(stdout: string): string {
        const parsed = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
        expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
        expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
        expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
        return parsed.hookSpecificOutput.additionalContext;
      }

      test("an unconnected SessionStart says Node is missing, once per computer", () => {
        const home = temporary("augenta-node-runner-home-");
        const project = temporary("augenta-node-runner-project-");

        const first = runWithout(sessionStart(project), { HOME: home });
        expect(first.exitCode).toBe(0);
        expect(first.stderr).toBe("");
        const text = notice(first.stdout);
        expect(text).toContain("Node.js 20 or newer");
        expect(text).toContain("AUGENTA_NODE");
        expect(existsSync(marker(home))).toBe(true);

        // Per computer, not per project: the same project and a new one are both quiet now.
        expect(runWithout(sessionStart(project), { HOME: home })).toEqual(quiet);
        expect(runWithout(sessionStart(temporary("augenta-node-runner-project-")), { HOME: home })).toEqual(quiet);
      });

      test("a SessionStart with no usable cwd still gets the notice: it is about the computer", () => {
        for (const payload of ['{"hook_event_name":"SessionStart"}', '{"cwd":"relative","hook_event_name":"SessionStart"}',
          '{"cwd":"/nonexistent/augenta-runner","hook_event_name":"SessionStart"}']) {
          expect(notice(runWithout(payload).stdout), payload).toContain("Node.js 20 or newer");
        }
      });

      test("every other event stays silent and leaves the notice unspent", () => {
        const home = temporary("augenta-node-runner-home-");
        const project = temporary("augenta-node-runner-project-");
        for (const event of ["UserPromptSubmit", "PostToolUse", "SubagentStop", "Stop", "SessionEnd", "PreCompact", "PostCompact"]) {
          expect(runWithout(JSON.stringify({ cwd: project, hook_event_name: event }), { HOME: home }), event).toEqual(quiet);
        }
        expect(existsSync(marker(home))).toBe(false);
        expect(notice(runWithout(sessionStart(project), { HOME: home }).stdout)).toContain("Node.js 20 or newer");
      });

      test("concurrent sessions print it exactly once", async () => {
        const home = temporary("augenta-node-runner-home-");
        const project = temporary("augenta-node-runner-project-");
        const runs = Array.from({ length: 8 }, () => Bun.spawn(["sh", RUNNER, "/tmp/hook.mjs"], {
          env: { PATH: "", HOME: home }, stdin: Buffer.from(sessionStart(project)), stdout: "pipe", stderr: "pipe",
        }));
        const outputs = await Promise.all(runs.map(async (run) => {
          expect(await run.exited).toBe(0);
          expect(await new Response(run.stderr).text()).toBe("");
          return new Response(run.stdout).text();
        }));
        expect(outputs.filter((output) => output !== "")).toHaveLength(1);
      });

      test("AUGENTA_HOME holds the marker, as it holds the connect prompt's", () => {
        const home = temporary("augenta-node-runner-home-");
        const augentaHome = temporary("augenta-node-runner-augenta-home-");
        const project = temporary("augenta-node-runner-project-");

        notice(runWithout(sessionStart(project), { HOME: home, AUGENTA_HOME: augentaHome }).stdout);
        expect(existsSync(marker(augentaHome))).toBe(true);
        expect(readdirSync(home)).toEqual([]);
      });

      test("a home that is not an absolute path gets silence and plants nothing", () => {
        const project = temporary("augenta-node-runner-project-");
        const homes: Record<string, string>[] = [{ AUGENTA_HOME: "" }, { AUGENTA_HOME: "relative/home" }, { HOME: "" }, { HOME: "relative" }];
        for (const env of homes) {
          // The hook's own cwd is the project, so a relative marker would land in it.
          expect(runWithout(sessionStart(project), env, project), JSON.stringify(env)).toEqual(quiet);
        }
        expect(readdirSync(project)).toEqual([]);
      });

      test("a marker that cannot be written means silence, never a notice on every session", () => {
        const home = temporary("augenta-node-runner-home-");
        const project = temporary("augenta-node-runner-project-");
        mkdirSync(join(home, ".augenta"));
        writeFileSync(join(home, ".augenta", "state"), "a file where the state directory belongs");

        expect(runWithout(sessionStart(project), { HOME: home })).toEqual(quiet);
        expect(runWithout(sessionStart(project), { HOME: home })).toEqual(quiet);
      });

      test("a connected project keeps its diagnostic and spends no notice", () => {
        const home = temporary("augenta-node-runner-home-");
        const project = temporary("augenta-node-runner-project-");
        mkdirSync(join(project, ".augenta"));
        writeFileSync(join(project, ".augenta", "config.json"), "{}");

        const result = runWithout(sessionStart(project), { HOME: home });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Node.js 20 or newer was not found");
        expect(existsSync(join(home, ".augenta"))).toBe(false);
      });

      test("the wording follows the harness, decided as hooks/harness.ts decides it", () => {
        const project = temporary("augenta-node-runner-project-");
        const told = (transcriptPath?: string, env: Record<string, string> = {}) =>
          notice(runWithout(sessionStart(project, transcriptPath), env).stdout);

        const codex = told("/home/u/.codex/sessions/2026/10/14/rollout-2026-10-14T00-00-00-abc.jsonl");
        expect(codex).toContain("$augenta:connect");
        expect(codex).not.toContain("[Augenta]");
        expect(codex).toContain("When you first reply, tell the user");
        expect(codex).toContain("unless the user asks");
        const claude = told("/home/u/.claude/projects/-home-u-p/abc.jsonl");
        expect(claude.startsWith("[Augenta]")).toBe(true);
        expect(claude).toContain("Tell the user");
        expect(claude).toContain("/augenta:connect");

        // The shell cannot import isCodexHarness, so hold it to the same answers.
        // The runner sees no CODEX_HOME here, so neither may the oracle.
        const savedCodexHome = process.env.CODEX_HOME;
        delete process.env.CODEX_HOME;
        try {
          for (const path of [
            "/home/u/.codex/sessions/2026/10/14/rollout-1.jsonl",
            "/srv/elsewhere/rollout-1.jsonl",
            "/srv/elsewhere/ROLLOUT-1.JSONL",
            "/srv/rollout-dir/transcript.jsonl",
            "/home/u/.claude/projects/p/s.jsonl",
            "/root/.claude/projects/.codex/s.jsonl",
            "/srv/transcript.jsonl",
          ]) {
            expect(told(path), path).toBe(isCodexHarness(path) ? codex : claude);
          }
        } finally {
          if (savedCodexHome !== undefined) process.env.CODEX_HOME = savedCodexHome;
        }
        // CODEX_HOME counts, but Claude Code's own layout wins when CODEX_HOME is the home itself.
        const codexHome = temporary("augenta-node-runner-codex-home-");
        expect(told(join(codexHome, "sessions", "s.jsonl"), { CODEX_HOME: codexHome + "/" })).toBe(codex);
        expect(told("/root/.claude/projects/p/s.jsonl", { CODEX_HOME: "/root" })).toBe(claude);
        // No transcript reads as Claude Code, as it does in isCodexHarness.
        expect(told()).toBe(claude);
      });
    });
  });
});
