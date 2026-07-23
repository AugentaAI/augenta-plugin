/**
 * The project's `.augenta/` state dir, with its safety invariant: the directory
 * can NEVER exist without a `.gitignore` inside it that ignores everything. The
 * dir holds the API key (config.json) and raw trajectory buffers (outbox/), so a
 * single forgotten repo-root .gitignore entry must not be able to leak either
 * into version control. Same trick `.terraform/` uses: the dir ignores itself.
 *
 * Every module that writes under `.augenta/` calls {@link ensureAugentaDir}
 * first. Pure builtins only, like the rest of `capture/`.
 */
import { join } from "node:path";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";

/**
 * Create `<root>/.augenta` (0700 — it holds a credential) and its self-ignoring
 * `.gitignore` when absent. Idempotent; an existing user-authored .gitignore is
 * left untouched. Returns the dir path. Never throws.
 */
export function ensureAugentaDir(projectRoot: string): string {
  const dir = join(projectRoot, ".augenta");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  } catch {
    /* best-effort — callers fail soft on their own writes */
  }
  return dir;
}
