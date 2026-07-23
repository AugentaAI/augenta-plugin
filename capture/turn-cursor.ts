/**
 * Per-transcript TURN cursor — which agent turn is in progress.
 *
 * A *turn* is one `UserPromptSubmit`→`Stop` cycle (the natural turn-completed
 * boundary). The UserPromptSubmit hook BUMPS this ordinal (a new turn begins);
 * the capture hook STAMPS the current value onto every event
 * (`CaptureEvent.turn`) so the Stop-hook flush can group a turn's steps into one
 * experience. Kept in its OWN small state file — deliberately separate from the
 * capture byte/seq cursor (`capture-cursor.ts`) so the turn ordinal and the tail
 * cursor evolve independently. Keyed by absolute transcript path under
 * <project>/.augenta/state/turn.json:
 *
 *   { "/abs/transcript.jsonl": 3, ... }
 *
 * Atomic writes (temp-then-rename) so a crash never corrupts the map. Pure
 * builtins only, so this runs from the installed plugin location (which has no
 * node_modules), like the rest of `capture/`.
 */
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { ensureAugentaDir } from "./augenta-dir";

export class TurnState {
  readonly path: string;
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.path = join(projectRoot, ".augenta", "state", "turn.json");
  }

  private readAll(): Record<string, number> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
    } catch {
      return {}; // corrupt map → start clean rather than wedge capture
    }
  }

  private writeAll(all: Record<string, number>): void {
    ensureAugentaDir(this.projectRoot); // dir + self-gitignore invariant
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(all));
    renameSync(tmp, this.path);
  }

  /** Current turn ordinal for a transcript; 0 before the first UserPromptSubmit (or if malformed). */
  get(transcriptPath: string): number {
    const v = this.readAll()[transcriptPath];
    return typeof v === "number" && v >= 0 ? v : 0;
  }

  /** Begin a new turn: increment and persist the ordinal (atomic), returning the new value. */
  bump(transcriptPath: string): number {
    const all = this.readAll();
    const cur = typeof all[transcriptPath] === "number" && all[transcriptPath]! >= 0 ? all[transcriptPath]! : 0;
    all[transcriptPath] = cur + 1;
    this.writeAll(all);
    return cur + 1;
  }
}
