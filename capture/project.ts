/**
 * Which directory a command is actually about.
 *
 * Extracted from `scripts/connect.ts` so a second entrypoint can reach it: an
 * entrypoint may not import another entrypoint (bundling would inline the
 * imported file's `isMain` block and run the wrong body first — see AGENTS.md →
 * "The runtime boundary"), so anything two CLIs share has to live in a plain
 * module like this one.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ResolvedProject {
  projectRoot: string;
}

/** The only argument shape this module needs. Both CLIs pass their own parsed
 *  args, which are supersets of it. */
export interface ProjectArgs {
  project?: string;
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

/** Shared consent lookup. A Git checkout/worktree is a boundary, even when
 * nested under a connected checkout. Invalid local configs stop lookup too:
 * parsing failure must never fall through to a different project's consent.
 * The .git marker also works when Git is absent from the host's PATH. */
export function resolveProjectRoot(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  let dir = resolve(cwd);
  // Each iteration removes a path component, so this is bounded by the input
  // path. An arbitrary depth cap would let connect's Git fallback find a config
  // that a deeply nested hook still could not discover.
  while (true) {
    if (existsSync(join(dir, ".augenta", "config.json"))) return dir;
    if (existsSync(join(dir, ".git"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Explicit target > nearest local config > current Git checkout > cwd.
 * Connecting a worktree consents only that worktree, never its main checkout
 * or siblings. Existing nested project configs have the same precedence here
 * as they do in hooks, recall and health. */
export function resolveProject(args: ProjectArgs, cwd: string): ResolvedProject {
  if (args.project) return { projectRoot: resolve(cwd, args.project) };
  const configured = resolveProjectRoot(cwd);
  if (configured) return { projectRoot: configured };
  const top = gitRevParse(cwd, "--show-toplevel");
  // A non-git directory is still a valid explicitly connected project.
  if (!top) return { projectRoot: cwd };
  return { projectRoot: top };
}

export function resolveTargetProject(args: ProjectArgs, cwd: string): string {
  return resolveProject(args, cwd).projectRoot;
}
