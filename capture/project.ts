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
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { insideGitCheckout } from "./environment";

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

/** Whether git tracks `relativePath` in the checkout at `projectRoot`. False
 *  when git is absent, the directory is not a checkout, or the file is
 *  untracked. Never throws. */
export function isTrackedByGit(projectRoot: string, relativePath: string): boolean {
  return gitTracks(projectRoot, relativePath) === true;
}

/**
 * Whether git tracks `relativePath`: true or false when git answered, and
 * undefined when it could not — not on this process's PATH (a desktop harness
 * can hand hooks a smaller one), or refusing the repository (`safe.directory`).
 * `ls-files --error-unmatch` exits 1 for an untracked path; anything else is
 * no answer. A caller guarding something git would reveal decides what an
 * unanswered question means. Never throws.
 */
/**
 * For a file that must never be committed: `tracked` when git tracks it, and
 * `unverified` inside a checkout where git could not answer — the same verdict,
 * so a missing `git` cannot open a guard. Outside any checkout (a `.git`
 * marker, found without git) there is nothing to commit it to: undefined.
 */
export function gitTracking(projectRoot: string, relativePath: string): "tracked" | "unverified" | undefined {
  const tracked = gitTracks(projectRoot, relativePath);
  if (tracked === true) return "tracked";
  return tracked === undefined && insideGitCheckout(projectRoot) ? "unverified" : undefined;
}

export function gitTracks(projectRoot: string, relativePath: string): boolean | undefined {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    return (error as { status?: unknown }).status === 1 ? false : undefined;
  }
}

/** Shared consent lookup. A Git checkout/worktree is a boundary, even when
 * nested under a connected checkout. Invalid local configs stop lookup too:
 * parsing failure must never fall through to a different project's consent.
 * The .git marker also works when Git is absent from the host's PATH. */
export function resolveProjectRoot(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  // Hosts can supply a logical cwd through a symlink into another checkout.
  // Walk physical parents so the alias cannot borrow its parent's consent.
  let dir: string;
  try { dir = realpathSync(cwd); } catch { return undefined; }
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
