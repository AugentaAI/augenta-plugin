import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Read all hook input without relying on a package-manager runtime API. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Portable equivalent of Bun's import.meta.main. */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && fileURLToPath(metaUrl) === entry;
}

/** Best-effort browser launch for the interactive connect command. */
export function openBrowser(command: string[]): void {
  spawnSync(command[0]!, command.slice(1), { stdio: "ignore" });
}
