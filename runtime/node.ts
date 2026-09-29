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
import { accessSync, constants, realpathSync } from "node:fs";
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

/** A sandbox's own proxy CA, where Cowork's VM leaves it. Kept in step with
 *  scripts/run-node-hook.sh. */
const SANDBOX_PROXY_CA = "/usr/local/share/ca-certificates/mitm-proxy-ca.crt";
/** The system bundle, trusted only alongside a proxy Node was told to use. */
const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/**
 * Node honors `NODE_USE_ENV_PROXY` from 24.0 and, backported, 22.21 (the
 * `added:` history in Node's doc/api/cli.md). Older versions ignore the
 * variable, so it is safe to set but does nothing there.
 */
export function nodeHonorsEnvProxy(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The environment to re-run a CLI in so that Node's fetch works in a sandbox's
 * network, or undefined when there is nothing to gain. Two things are only read
 * at process start, which is why a re-run is needed at all:
 *
 * - `NODE_USE_ENV_PROXY`: without it, Node ignores HTTPS_PROXY and connects
 *   directly, which a sandbox that allows egress only through its proxy refuses.
 *   Measured on 22.21 and 25.2. `NODE_NO_WARNINGS` hides 22.x's
 *   "EnvHttpProxyAgent is experimental" notice.
 * - `NODE_EXTRA_CA_CERTS`: the sandbox's own proxy CA whenever it is readable,
 *   even with no proxy variable, because a TLS-intercepting proxy can be
 *   transparent; the system bundle only alongside a proxy Node was told to use.
 *   Never over a CA the environment already chose.
 *
 * Pure, so the decision is tested without spawning anything.
 */
export function envProxyReexecEnv(
  env: NodeJS.ProcessEnv,
  nodeVersion: string,
  runningUnderBun: boolean,
  isReadable: (path: string) => boolean = readable,
): NodeJS.ProcessEnv | undefined {
  if (env.AUGENTA_PROXY_REEXEC || runningUnderBun) return undefined;
  const proxied = Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
  const useProxy = proxied && !env.NODE_USE_ENV_PROXY && nodeHonorsEnvProxy(nodeVersion);
  const ca = env.NODE_EXTRA_CA_CERTS
    ? undefined
    : isReadable(SANDBOX_PROXY_CA)
      ? SANDBOX_PROXY_CA
      : (useProxy || env.NODE_USE_ENV_PROXY) && isReadable(SYSTEM_CA_BUNDLE)
        ? SYSTEM_CA_BUNDLE
        : undefined;
  if (!useProxy && !ca) return undefined;
  return {
    ...env,
    // The loop guard: the re-run itself must never re-run.
    AUGENTA_PROXY_REEXEC: "1",
    ...(useProxy ? { NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: env.NODE_NO_WARNINGS ?? "1" } : {}),
    ...(ca ? { NODE_EXTRA_CA_CERTS: ca } : {}),
  };
}

/**
 * Re-run this CLI once in {@link envProxyReexecEnv}'s environment when it
 * applies, and exit with the re-run's status. The skills start the CLIs with a
 * bare `node`, not through the hook runner, so this is where they get what
 * scripts/run-node-hook.sh exports for hooks. Environment variables only, never
 * a CLI flag, so no Node version can reject the re-run. If the spawn itself
 * fails, the CLI simply runs here as it would have.
 */
export function reexecForEnvProxy(): void {
  const next = envProxyReexecEnv(process.env, process.versions.node, Boolean(process.versions.bun));
  if (!next) return;
  const result = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: next,
  });
  if (result.error) return;
  process.exit(result.status ?? 1);
}

/**
 * The program that opens a URL on each platform: fixed here, never taken from
 * input, and never a shell. Windows once went through `cmd /c start "" <url>`,
 * which re-parses the URL as a command line, so an `&` in a query string would
 * start a second command; `url.dll`'s handler takes the URL as data.
 */
export function urlOpener(platform: NodeJS.Platform = process.platform): [file: string, ...args: string[]] {
  if (platform === "darwin") return ["open"];
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler"];
  return ["xdg-open"];
}

/**
 * Best-effort browser launch for the interactive connect command.
 *
 * The program is a constant ({@link urlOpener}) and the URL is its last argv
 * entry, with no shell, so nothing here is interpreted as a command. The
 * remaining exposure is the URL itself: it arrives from login discovery, and
 * handing an arbitrary string to the platform opener would let a non-https
 * scheme (`file:`, or a registered app handler) reach it. Discovery is only as
 * trustworthy as AUGENTA_CONTROL_URL, so the scheme is checked here rather than
 * assumed; an https URL cannot begin with `-`, so it is never read as an option.
 *
 * Refusing costs nothing: the caller always prints the URL and user code, so a
 * skipped or failed open just means the user clicks the link themselves.
 */
export function openBrowser(url: string): void {
  if (!isHttpsUrl(url)) return;
  const [file, ...args] = urlOpener();
  spawnSync(file, [...args, url], { stdio: "ignore" });
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
