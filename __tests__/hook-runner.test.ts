import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    /** No AUGENTA_NODE, no PATH, and a HOME with no version-manager installs. */
    function runWithout(payload: string): { exitCode: number; stderr: string } {
      const home = mkdtempSync(join(tmpdir(), "augenta-node-runner-home-"));
      temporaryDirectories.push(home);
      const result = Bun.spawnSync(["sh", RUNNER, "/tmp/hook.mjs"], {
        env: { PATH: "", HOME: home },
        stdin: Buffer.from(payload),
      });
      return { exitCode: result.exitCode, stderr: result.stderr.toString() };
    }

    test("stays a silent no-op for a project that never opted in", () => {
      // A missing runtime is not evidence of consent, and a hook that has no
      // work to do must print nothing (AGENTS.md → Privacy invariants).
      const project = mkdtempSync(join(tmpdir(), "augenta-node-runner-project-"));
      temporaryDirectories.push(project);

      const result = runWithout(`{"cwd":"${project}","hook_event_name":"Stop"}`);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
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
      expect(runWithout(JSON.stringify({ cwd: alias }))).toEqual({ exitCode: 0, stderr: "" });
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
      expect(runWithout(JSON.stringify({ cwd: nested }))).toEqual({ exitCode: 0, stderr: "" });
    });
  });
});
