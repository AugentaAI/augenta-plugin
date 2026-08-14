/**
 * The handful of things the shipped entrypoints needed a package-manager runtime
 * for. Everything here is a plain node builtin, so the built bundles run on a
 * stock Node with nothing else installed — which is the whole point: an end user
 * installs the plugin and needs Node, not the toolchain this repo is built with.
 *
 * The sources still run under Bun in dev and in the test suite, so each helper
 * has to behave identically in both worlds.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Read all of a hook's stdin payload. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Portable equivalent of Bun's `import.meta.main`.
 *
 * Both sides get canonicalized before comparing. `process.argv[1]` arrives
 * exactly as the caller typed it — relative if the invocation was relative, and
 * never resolved through symlinks — while `import.meta.url` is always absolute
 * and real. The paths this runs from are symlink-prone by nature: the harnesses'
 * `plugins/cache/...` trees, `claude --plugin-dir` aimed at a symlinked checkout,
 * and `/tmp` -> `/private/tmp` on macOS, which is every test tempdir. A raw string
 * compare returns false for what really is the entrypoint, and the hook becomes a
 * silent no-op — exit 0, no output, no error anywhere.
 */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false; // `node -e`, a REPL, or an embedder
  return canonical(fileURLToPath(metaUrl)) === canonical(entry);
}

function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute; // an unresolvable path is not a reason to misreport
  }
}

/**
 * Best-effort browser launch for the interactive connect command.
 *
 * Every argument is passed as an argv array with no shell, so nothing here is
 * interpreted by a shell. The remaining exposure is the URL itself: it arrives
 * from login discovery, and handing an arbitrary string to `open`/`xdg-open`
 * would let a non-https scheme (`file:`, or a registered app handler) reach the
 * platform opener. Discovery is only as trustworthy as AUGENTA_CONTROL_URL, so
 * the scheme is checked here rather than assumed.
 *
 * Refusing costs nothing: the caller always prints the URL and user code, so a
 * skipped or failed open just means the user clicks the link themselves.
 *
 * (The previous Bun.spawnSync form passed the same URL to the same openers —
 * CodeQL simply could not model Bun's API. Moving to node's spawnSync made an
 * existing path analyzable rather than introducing a new one.)
 */
export function openBrowser(command: string[]): void {
  const opener = command[0];
  if (!opener) return;
  const url = command[command.length - 1];
  if (!url || !isHttpsUrl(url)) return;
  spawnSync(opener, command.slice(1), { stdio: "ignore" });
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
