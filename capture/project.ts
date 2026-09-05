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
import { dirname, resolve } from "node:path";

export interface ResolvedProject {
  projectRoot: string;
  /** Set when cwd was a linked worktree and the main checkout was used instead.
   *  Reported rather than applied silently — the caller tells the user. */
  worktreeRedirect?: { from: string; to: string };
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

/**
 * Pick the project a command is about: `--project` > main checkout > git toplevel > cwd.
 *
 * The main-checkout step exists because `--show-toplevel` returns the LINKED
 * WORKTREE's root, and capture only ever walks UPWARD from cwd looking for
 * `.augenta/config.json` (capture/config.ts → resolveProjectRoot). Connect from
 * an out-of-tree worktree such as `~/.codex/worktrees/<id>/<name>` and the config
 * lands somewhere the real repo can never see, so every hook keeps silently
 * no-opping — the user completes the whole flow and captures nothing. Recall has
 * the mirror-image problem: the config the project really has is invisible from
 * the worktree, so recall would report an opted-in project as `not_connected`.
 *
 * `--git-common-dir` prints relative to cwd in a normal repo (`../.git`) and
 * absolute in a linked worktree, which `resolve` handles either way.
 */
export function resolveProject(args: ProjectArgs, cwd: string): ResolvedProject {
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

export function resolveTargetProject(args: ProjectArgs, cwd: string): string {
  return resolveProject(args, cwd).projectRoot;
}
