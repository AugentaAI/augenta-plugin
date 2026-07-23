#!/usr/bin/env bun
/**
 * Augenta project setup — the ONE manual step: install the API key into the
 * project's `.augenta/config.json`. Run by the USER in their own terminal (the
 * init skill hands them the exact command), never by the agent — the key must
 * not transit the chat.
 *
 *   bun scripts/setup.ts --api-key <key> [--project <dir>] [--endpoint <url>]
 *
 * Deliberately network-free: it writes the config and nothing else. There is no
 * identity probe — a wrong key simply surfaces as a rejected flush later, and
 * the buffered events wait for a corrected key. What it guarantees:
 *
 *   • <project>/.augenta/ exists with the self-ignoring .gitignore ("*") so the
 *     key and trajectory buffers can never be committed.
 *   • config.json is written 0600 (owner-only), pretty-printed:
 *       { "apiKey": "…", "endpoint"?: "…" }
 *   • Placing this file IS the project's capture consent — deleting it (or the
 *     whole .augenta/ dir) revokes it just as simply.
 *
 * Project resolution: --project wins, else the git toplevel of the cwd, else
 * the cwd itself. Pure Bun/Node builtins so it runs from the installed plugin
 * location (which has no node_modules).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureAugentaDir } from "../capture/augenta-dir";

interface Args {
  apiKey?: string;
  project?: string;
  endpoint?: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--api-key" || flag === "--apiKey") {
      args.apiKey = value;
      i++;
    } else if (flag === "--project") {
      args.project = value;
      i++;
    } else if (flag === "--endpoint") {
      args.endpoint = value;
      i++;
    }
  }
  return args;
}

/** --project wins; else the git toplevel of `cwd`; else `cwd` itself. */
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
    /* not a git repo — use cwd */
  }
  return cwd;
}

/** Write `<root>/.augenta/config.json` (0600) inside the self-gitignored dir. */
export function writeConfig(projectRoot: string, apiKey: string, endpoint?: string): string {
  const dir = ensureAugentaDir(projectRoot);
  const path = join(dir, "config.json");
  const config = { apiKey, ...(endpoint ? { endpoint } : {}) };
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return path;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = args.apiKey?.trim();

  if (!apiKey) {
    console.error(
      "usage: bun setup.ts --api-key <key> [--project <dir>] [--endpoint <url>]\n" +
        "\n" +
        "Get your Augenta API key at https://augenta.ai, then run this at the root\n" +
        "of the project you want to opt in.",
    );
    process.exit(1);
  }

  const projectRoot = resolveTargetProject(args, process.cwd());
  const existed = existsSync(join(projectRoot, ".augenta", "config.json"));
  const path = writeConfig(projectRoot, apiKey, args.endpoint?.trim() || undefined);

  console.log(`${existed ? "Updated" : "Wrote"} ${path} (0600).`);
  console.log("This project now captures agent turns to your Augenta Neurospace.");
  console.log("Off switch: delete .augenta/config.json, or set AUGENTA_CAPTURE_ENABLED=0.");
  process.exit(0);
}
