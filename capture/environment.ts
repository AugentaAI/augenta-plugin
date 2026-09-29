/**
 * Whether this process runs in a session whose machine is thrown away when the
 * session ends: a cloud session, or a sandbox that says so.
 *
 * It matters for two things. The sign-in lives in the home directory, so in
 * such a session it lasts only for that session, and connect should say so. And
 * a project folder that is not inside a Git checkout has nothing to carry its
 * config forward, so connecting it would write a config nobody will ever read
 * again (the Cowork-cloud case, where the container's working directory is
 * scratch space rather than the user's folder). Detection is by documented
 * signals first; the Codex one is a heuristic and is labelled as one. Pure
 * builtins; reads only the environment and the filesystem.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type SessionKind = "claude-cloud" | "codex-cloud" | "declared";

export interface SessionEnvironment {
  /** The machine is discarded when the session ends. */
  ephemeral: boolean;
  kind?: SessionKind;
  /** Which signals decided it, so a wrong guess can be reported and overridden. */
  signals: string[];
}

/**
 * `AUGENTA_EPHEMERAL=1` declares an ephemeral session and `=0` declares a
 * lasting one; either overrides the detection below.
 *
 * - `CLAUDE_CODE_REMOTE=true` is documented to be set in every Claude Code cloud
 *   session and never locally. `CLAUDE_CODE_REMOTE_SESSION_ID` carries the same
 *   `cse_` session ids Cowork's cloud sessions use, so it is taken as the same
 *   signal. Not yet measured inside a Cowork cloud session.
 * - `CODEX_HOME=/opt/codex` is where Codex cloud keeps its home. Heuristic.
 */
export function sessionEnvironment(env: NodeJS.ProcessEnv = process.env): SessionEnvironment {
  const declared = env.AUGENTA_EPHEMERAL?.trim().toLowerCase();
  if (declared === "0" || declared === "false") return { ephemeral: false, signals: ["AUGENTA_EPHEMERAL=0"] };
  const signals: string[] = [];
  let kind: SessionKind | undefined;
  if (env.CLAUDE_CODE_REMOTE === "true") {
    signals.push("CLAUDE_CODE_REMOTE");
    kind ??= "claude-cloud";
  }
  if (env.CLAUDE_CODE_REMOTE_SESSION_ID?.trim()) {
    signals.push("CLAUDE_CODE_REMOTE_SESSION_ID");
    kind ??= "claude-cloud";
  }
  if (env.CODEX_HOME?.trim().replace(/\/+$/, "") === "/opt/codex") {
    signals.push("CODEX_HOME=/opt/codex (heuristic)");
    kind ??= "codex-cloud";
  }
  if (declared === "1" || declared === "true") {
    signals.push("AUGENTA_EPHEMERAL=1");
    kind ??= "declared";
  }
  return { ephemeral: signals.length > 0, ...(kind ? { kind } : {}), signals };
}

/** A `.git` (directory, or worktree file) in `dir` or an ancestor. No git binary
 *  needed, the same boundary the project lookup uses. */
export function insideGitCheckout(dir: string): boolean {
  let current = resolve(dir);
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Connecting `projectRoot` here would write a config that cannot outlast the session. */
export function ephemeralProject(projectRoot: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return sessionEnvironment(env).ephemeral && !insideGitCheckout(projectRoot);
}
