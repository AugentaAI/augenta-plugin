/** Runtime coordinates only: never scan transcripts or read their contents. */
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bindCoworkTask, CoworkError } from "./cowork-task";

export function claudeCloud(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_REMOTE === "true";
}

export interface ClaudeCloudTask { sessionId: string; transcriptPath: string }

/** The engine UUID is distinct from Cowork's cse display/task id. The layout
 * was observed in the cloud runtime. If the bounded candidates are absent or
 * ambiguous, require an explicitly confirmed path through the existing CLI. */
export function currentClaudeCloudTask(projectRoot: string, cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env): ClaudeCloudTask | undefined {
  if (!claudeCloud(env)) return undefined;
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId)) return undefined;
  const base = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const paths = new Set<string>();
  for (const dir of new Set([resolve(cwd), resolve(projectRoot)])) {
    const candidate = join(base, "projects", dir.replace(/[^a-zA-Z0-9-]/g, "-"), `${sessionId}.jsonl`);
    try {
      if (!lstatSync(candidate).isFile()) continue;
      accessSync(candidate, constants.R_OK);
      paths.add(realpathSync(candidate));
    } catch { /* unavailable on this runtime */ }
  }
  return paths.size === 1 ? { sessionId, transcriptPath: [...paths][0]! } : undefined;
}

/** Called only AFTER the human's Workspace selection has joined this project.
 * A failed binding leaves native capture and automatic recall off; it never
 * substitutes another task, path, transport, or destination. */
export async function bindCurrentClaudeCloudTask(projectRoot: string) {
  if (!claudeCloud()) return undefined;
  const task = currentClaudeCloudTask(projectRoot);
  if (!task) return { status: "error", code: "missing_transcript", message:
    "The project is connected, but this cloud task's engine session and transcript could not be confirmed. Native capture and automatic recall remain off. Confirm them on this runtime and bind the task with --cowork-task, --cowork-transport native and --cowork-transcript." };
  try {
    const binding = await bindCoworkTask(projectRoot, task.sessionId, "native", { transcriptPath: task.transcriptPath });
    return { status: "bound", ...task, boundAt: binding.boundAt };
  } catch (error) {
    return { status: "error", code: error instanceof CoworkError ? error.code : "binding_failed",
      message: error instanceof CoworkError ? error.message : "The project is connected but this cloud task could not be bound; native capture and automatic recall remain off." };
  }
}
