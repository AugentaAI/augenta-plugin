/** Shared document sizing, identity and validated atomic local state. */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, readlinkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureAugentaDir } from "./augenta-dir";

export const MAX_DOCUMENT_EXPERIENCE_BYTES = 512 * 1024;
export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
export function boundedTitle(title: string): string { return [...title].slice(0, 512).join(""); }
export function normalizeLogicalPath(path: string): string { return path.split(sep).join("/"); }
export function sameSnapshot(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
export function safeBoundary(text: string, index: number): number {
  if (index > 0 && index < text.length &&
    text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff &&
    text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff) return index - 1;
  return index;
}
export function chunkText<T>(text: string, makeRecord: (text: string, index: number, count: number) => T): string[] {
  if (!text.length) return [""];
  const chunks: string[] = [];
  let start = 0;
  const sizingIndex = 999_999_999;
  while (start < text.length) {
    let lo = start + 1, hi = text.length, best = -1;
    while (lo <= hi) {
      const rawMid = Math.floor((lo + hi) / 2);
      const mid = safeBoundary(text, rawMid);
      if (mid <= start) { lo = rawMid + 1; continue; }
      if (jsonBytes(makeRecord(text.slice(start, mid), sizingIndex, sizingIndex)) < MAX_DOCUMENT_EXPERIENCE_BYTES) {
        best = mid; lo = rawMid + 1;
      } else hi = rawMid - 1;
    }
    if (best <= start) return [];
    chunks.push(text.slice(start, best)); start = best;
  }
  return chunks;
}
export function readDocumentIndex<T extends { documentId: string }>(
  root: string, file: string, valid: (value: unknown) => value is T, maxBytes = Infinity,
): Record<string, T> {
  try {
    const path = join(root, ".augenta", "state", file);
    if (statSync(path).size > maxBytes) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || parsed.version !== 1 || !parsed.documents ||
      typeof parsed.documents !== "object" || Array.isArray(parsed.documents)) return {};
    return Object.fromEntries(Object.entries(parsed.documents).filter(([id, value]) => valid(value) && value.documentId === id)) as Record<string, T>;
  } catch { return {}; }
}
export function writeDocumentIndex<T>(root: string, file: string, documents: Record<string, T>, maxBytes = Infinity): boolean {
  const dir = join(ensureAugentaDir(root), "state");
  const path = join(dir, file), tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const json = JSON.stringify({ version: 1, documents });
    if (Buffer.byteLength(json) > maxBytes) return false;
    mkdirSync(dir, { recursive: true }); writeFileSync(tmp, json, { mode: 0o600 }); renameSync(tmp, path);
    return true;
  } catch { return false; }
  finally { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } }
}

/** Only explicit ISO instants are observation or consent times. */
export function documentTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

/** Linux's MAXSYMLINKS: more hops than this is a loop, not a real location. */
const MAX_SYMLINK_HOPS = 40;

/** Where `path` points if it is itself a symlink, whether or not the target exists. */
function symlinkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An absolute path's physical form: its nearest existing ancestor with every
 * symlink resolved, and whatever no longer (or does not yet) exist re-appended.
 * Scope is decided on physical paths on both sides, the way the project lookup
 * resolves its input, so a logical alias of the project (macOS /var →
 * /private/var, a symlinked projects folder) matches it, and a symlink inside
 * the project that points elsewhere does not — including a dangling one, which
 * is followed to where it points rather than read as a missing folder here. A
 * Task Group can outlive the directory it names, which is why a missing tail
 * falls back to its ancestor instead of failing. A symlink loop has no physical
 * location, so it is `undefined` and never in scope.
 *
 * Unlike the project lookup, scope does not stop at a checkout nested inside
 * the project; that is a separate consent question, left as it was.
 */
export function physicalPath(path: string): string | undefined {
  let existing = resolve(path);
  const missing: string[] = [];
  let hops = 0;
  while (true) {
    try {
      return join(realpathSync(existing), ...missing);
    } catch {
      /* resolved below */
    }
    const target = symlinkTarget(existing);
    if (target !== undefined) {
      if (++hops > MAX_SYMLINK_HOPS) return undefined;
      existing = target;
      continue;
    }
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    missing.unshift(basename(existing));
    existing = parent;
  }
}

/** `root` must already be physical (see {@link physicalPath}). */
export function isScopedToProject(scope: string, root: string): boolean {
  if (!isAbsolute(scope)) return false;
  const target = physicalPath(scope);
  if (target === undefined) return false;
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

