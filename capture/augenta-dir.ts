/**
 * The project's `.augenta/` state dir, with its safety invariant: the directory
 * can NEVER exist without a `.gitignore` inside it. The dir holds raw trajectory
 * buffers (outbox/), local state, and in API-key mode the key itself
 * (config.json), so a single forgotten repo-root .gitignore entry must not be
 * able to leak any of them into version control. Same trick `.terraform/` uses:
 * the dir ignores itself. The one exception is a browser connection's
 * config.json, which holds no credential and may be committed on purpose
 * ({@link SHARED_IGNORE}).
 *
 * Every module that writes under `.augenta/` calls {@link ensureAugentaDir}
 * first. Pure builtins only, like the rest of `capture/`.
 */
import { join } from "node:path";
import { chmodSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** Ignores everything: the form for a directory that may hold an API key. */
export const LOCAL_IGNORE = "*\n";
/**
 * Ignores everything except the ignore file itself and a browser connection's
 * config, which holds no credential (a profile reference, URLs, organization,
 * destinations). Committing it lets a repository or shared folder point every
 * checkout at the same Workspaces; each checkout still joins through connect
 * (capture/adoption.ts). Anchored, so nothing nested under state/ or outbox/
 * can match. An API-key config never gets this form: its key is in the file.
 */
export const SHARED_IGNORE = "*\n!/.gitignore\n!/config.json\n";

/**
 * Create `<root>/.augenta` (0700 — it holds a credential) and its self-ignoring
 * `.gitignore` when absent. Idempotent; an existing user-authored .gitignore is
 * left untouched, and the directory is narrowed to 0700 whether we made it or
 * not. Returns the dir path. Never throws.
 */
export function ensureAugentaDir(projectRoot: string): string {
  const dir = join(projectRoot, ".augenta");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    /* `mode` above applies at CREATION only, so a directory someone made by hand
       keeps whatever their umask gave it — 0755 by default. That used to be the odd
       case; it is now the common one, because writing `.augenta/config.json`
       yourself is the documented way to configure an autonomous client, which means
       the plugin is usually NOT the one that creates the directory.

       The directory mode is the protection that actually matters here. Reading
       `.augenta/config.json` needs search permission on `.augenta`, so 0700 on the
       directory keeps every other local user out regardless of the file's own mode
       — the config's 0600 is defence in depth behind it, not the barrier.

       Its own try: a chmod we are not permitted to make (a directory owned by
       someone else) must not cost the .gitignore below, which is the invariant that
       keeps a key out of version control. */
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* not ours to narrow — the .gitignore still gets written */
    }
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, LOCAL_IGNORE);
  } catch {
    /* best-effort — callers fail soft on their own writes */
  }
  return dir;
}

/**
 * Put `.augenta/.gitignore` in one of the two plugin-authored forms. A file in
 * neither form was written by someone else and is left exactly as it is, so a
 * team that chose its own rules keeps them. Never throws.
 */
export function setAugentaIgnore(projectRoot: string, form: "local" | "shared"): void {
  const path = join(ensureAugentaDir(projectRoot), ".gitignore");
  const wanted = form === "shared" ? SHARED_IGNORE : LOCAL_IGNORE;
  try {
    const current = readFileSync(path, "utf8");
    if (current === wanted || (current !== LOCAL_IGNORE && current !== SHARED_IGNORE)) return;
    writeFileSync(path, wanted);
  } catch {
    /* best-effort, like ensureAugentaDir */
  }
}
