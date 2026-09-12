/** Registration identity is supplied by the caller when possible. Environment
 * hints are best-effort only: an unset Codex variable is not evidence of Claude
 * Code, and a machine-wide CODEX_HOME is not evidence of the current harness. */
export type Harness = "claude-code" | "codex";

export function detectedHarness(explicit?: Harness, env: NodeJS.ProcessEnv = process.env): Harness | undefined {
  if (explicit) return explicit;
  const codex = Boolean(env.CODEX_THREAD_ID || env.CODEX_SANDBOX ||
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === "Codex Desktop");
  const claude = env.CLAUDECODE === "1";
  if (codex === claude) return undefined;
  return codex ? "codex" : "claude-code";
}
