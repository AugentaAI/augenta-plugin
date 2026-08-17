import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
