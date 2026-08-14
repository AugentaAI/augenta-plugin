/**
 * Spawning the detached shipper.
 *
 * This lives in its own module, apart from `capture/capture.ts`, because BOTH
 * `capture.ts` and `hooks/session-start.ts` need it and both of those are hook
 * entrypoints that get bundled separately. An entrypoint that imports another
 * entrypoint drags the imported file's `isMain` block into its own bundle, where
 * — there being only one module left after bundling — the guard is TRUE and the
 * wrong hook body runs first. That shipped once: session-start imported
 * `spawnShipper` from capture.ts, and the built session-start hook silently
 * consumed stdin and exited before ever emitting the connect prompt. A contract
 * test now forbids the import shape; this module is what makes that possible.
 *
 * Only node builtins here, so it costs the importing bundle almost nothing.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the shipper entry, correct from every bundle that can reach
 * this code AND from the .ts sources.
 *
 * "Sibling of import.meta.url" is not enough: this module is inlined into
 * `dist/hooks/session-start.mjs` as well (SessionStart drains a spool stranded by
 * a Stop that never fired), and there the sibling would be `dist/hooks/ship.mjs`,
 * which does not exist. The spawn is detached with stdio ignored, so that miss is
 * perfectly silent — the outbox would simply never drain.
 *
 * Both layouts have the same shape — `<root>/capture/ship.<ext>` alongside
 * `<root>/{capture,hooks,scripts}/<entry>.<ext>` — so take the extension from
 * THIS module's own path, try the sibling, then fall back to the capture/ peer.
 */
function shipperEntry(): string {
  const self = fileURLToPath(import.meta.url);
  const ext = self.endsWith(".ts") ? ".ts" : ".mjs";
  const here = dirname(self);
  const sibling = join(here, `ship${ext}`);
  return existsSync(sibling) ? sibling : join(here, "..", "capture", `ship${ext}`);
}

/**
 * Detached fire-and-forget shipper — never blocks the hook, ignores all I/O.
 * The project root rides as argv (explicit and visible in `ps`) so the child
 * drains the SAME project the hook captured into, regardless of its own cwd.
 */
export function spawnShipper(projectRoot: string): void {
  try {
    // process.execPath, never a runtime named as a string: it is `node` when a
    // built bundle runs (hooks are invoked as `node <bundle>`) and `bun` when the
    // .ts source runs under a test or `claude --plugin-dir`. Each can execute the
    // extension shipperEntry() just picked, so one call serves both worlds and
    // the plugin never depends on anything being on PATH.
    const child = spawn(process.execPath, [shipperEntry(), projectRoot], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch {
    /* spawning the shipper is best-effort; the next Stop will retry the drain */
  }
}
