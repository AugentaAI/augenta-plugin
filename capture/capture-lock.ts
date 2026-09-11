/** Serialize cursor read/append/commit across hook processes in one project. */
import { mkdirSync, openSync, readFileSync, closeSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureAugentaDir } from "./augenta-dir";
export function captureLock(projectRoot: string): (() => void) | undefined {
  const dir = join(ensureAugentaDir(projectRoot), "state");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "capture.lock");
  const deadline = Date.now() + 750;
  do {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return () => { try { unlinkSync(path); } catch { /* already removed */ } };
    } catch (error: any) {
      if (error.code !== "EEXIST") return;
      try {
        const pid = Number(readFileSync(path, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (e: any) { if (e.code === "ESRCH") { unlinkSync(path); continue; } }
        } else if (Date.now() - statSync(path).mtimeMs > 30_000) { unlinkSync(path); continue; }
      } catch { /* contender is publishing/releasing its lock */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  } while (Date.now() < deadline);
  return;
}
