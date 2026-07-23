#!/usr/bin/env bun
/**
 * Augenta capture hook — wired to PostToolUse + Stop.
 *
 * On each fire it does the cheap, deterministic OBSERVE step and NOTHING that
 * touches the network: read the new bytes of the transcript since the capture
 * cursor and buffer them into the project's durable outbox on TWO channels —
 * normalized + scrubbed canonical events (the scrub applies to event text
 * ONLY), plus one structurally-sanitized RawRecord per consumed valid JSON
 * transcript line (the project opt-in is consent for both channels). Both get the
 * current turn stamp; then the cursor advances. PostToolUse stops there — it is
 * buffer-only. A genuine Stop also scans harness memory into standalone,
 * scrubbed document records before spawning a detached shipper to flush the
 * completed records. No model call, no blocking on the network — the hook must
 * never slow the user's turn.
 *
 * Consent gate: everything is a NO-OP unless the project has opted in via
 * `<project>/.augenta/config.json` (see capture/config.ts). No config → silent
 * exit.
 *
 * Self-contained: only Bun/Node builtins + sibling capture modules, so it runs
 * from the installed plugin location with no node_modules.
 */
import { existsSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { normalizeClaudeTranscript, normalizeCodexRollout, type Scrubber } from "./normalize";
import type { CaptureEvent, RawRecord } from "./event";
import { scrub as defaultScrub } from "./scrub";
import { Outbox } from "./outbox";
import { CaptureState } from "./capture-cursor";
import { TurnState } from "./turn-cursor";
import { captureEnabled, projectConfig, resolveProjectRoot } from "./config";
import { captureAgentMemory } from "./memory";
import { isCodexHarness, sniffHarness } from "../hooks/harness";

export interface CapturePayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** Claude Code sets this on a Stop fired by a previous Stop hook's output — never re-flush. */
  stop_hook_active?: boolean;
}

export interface RunCaptureOptions {
  /** Project root holding .augenta/ (defaults to walking up from payload.cwd). */
  projectRoot?: string;
  /** Scrubber applied before events are built; defaults to the real secret scrub. */
  scrub?: Scrubber;
  /** Spawn the detached shipper on a flush-worthy fire. Off in tests. */
  spawnShipper?: boolean;
  /** Cap on bytes read from the transcript per hook fire; defaults to
   *  {@link MAX_TAIL_BYTES_PER_FIRE}. Injectable for tests. */
  maxTailBytes?: number;
  /** Spool byte cap passed through to the {@link Outbox}; defaults to
   *  {@link MAX_SPOOL_BYTES}. Injectable for tests. */
  maxSpoolBytes?: number;
}

/** Text of the ONE synthetic marker event emitted on the first drop of a
 *  spool-overflow episode (see {@link Outbox.markDropped}) — loud, so an
 *  overflow can never pass unnoticed even though the events that triggered
 *  it are themselves lost (the transcript on disk remains the recovery source). */
export const SPOOL_FULL_MARKER =
  "[augenta: local spool full — capture records are being dropped until the outbox drains]";

/** Stop buffering catch-up reads past this many bytes on a NON-flush (PostToolUse)
 *  hook fire — bounds the frequent hot-path read against 5s/10s hook timeouts on a
 *  long-running session. The once-per-turn Stop fire reads uncapped (see runCapture)
 *  so a turn is always fully captured. A read capped here still always makes
 *  progress: see {@link readTail}. */
export const MAX_TAIL_BYTES_PER_FIRE = 8 * 1024 * 1024;

/**
 * Read the transcript's unread tail starting at `offset`, capped at `cap`
 * bytes so one hook fire can't block on an O(total-file) read on a
 * long-running session. If the capped window contains no newline AND more
 * bytes remain beyond it, the window is doubled — repeatedly — until either a
 * newline appears or the file's true end is reached, so a single line larger
 * than `cap` still gets fully read (and consumed) in this fire rather than
 * wedging the tail forever (every subsequent fire would otherwise re-read the
 * exact same zero-newline window and never advance the cursor).
 *
 * A short read (`bytesRead < length`) means the file's true end was reached —
 * a regular file returns the full request until EOF — so we return then even
 * if `size` was a stale-large fstat (e.g. the transcript was truncated between
 * the fstat and this read). Without that, a newline-free short slice would
 * never satisfy `offset+len >= size` and the doubling would spin forever.
 */
function readTail(fd: number, offset: number, size: number, cap: number): Buffer {
  // Math.max(1, …) so a pathological cap ≤ 0 can't seed a zero-length read that
  // doubles to zero forever; it degrades to a 1-byte read that grows normally.
  let length = Math.max(1, Math.min(cap, size - offset));
  for (;;) {
    const chunk = Buffer.alloc(length);
    const bytesRead = readSync(fd, chunk, 0, length, offset);
    const slice = bytesRead === length ? chunk : chunk.subarray(0, bytesRead);
    if (bytesRead < length || offset + slice.length >= size || slice.includes(0x0a)) return slice;
    length = Math.min(size - offset, length * 2);
  }
}

/**
 * Which harness produced this transcript: path patterns are checked first —
 * unchanged behavior for the known `~/.codex/…` and `~/.claude/…` locations.
 * Only when the path matches NEITHER pattern (e.g. a nonstandard CODEX_HOME)
 * is the shape of the first complete line sniffed, defaulting to Claude Code
 * if even that comes back inconclusive. {@link SPOOL_FULL_MARKER}'s sibling,
 * the G7 raws-only synthetic event, is the loud backstop for any residual
 * mismatch (a wrong-normalizer fire still ships its structurally sanitized raw
 * lines).
 */
function resolveHarness(transcriptPath: string, firstLine: string): boolean {
  if (isCodexHarness(transcriptPath)) return true;
  if (/\.claude\//.test(transcriptPath.replace(/\\/g, "/"))) return false;
  return sniffHarness(firstLine) === "codex";
}

/** Resolve the harness for a boundary-only memory scan. A neutral transcript
 * path (notably a custom Codex home) falls back to its first complete line, so
 * a Stop with no unread tail still selects Codex memory correctly. */
function resolveMemoryHarness(transcriptPath: string | undefined): "claude-code" | "codex" {
  if (!transcriptPath) return "claude-code";
  if (isCodexHarness(transcriptPath)) return "codex";
  if (/\.claude\//.test(transcriptPath.replace(/\\/g, "/"))) return "claude-code";

  let fd = -1;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    if (size <= 0) return "claude-code";
    const firstWindow = readTail(fd, 0, size, 64 * 1024);
    const newline = firstWindow.indexOf(0x0a);
    const firstLine = firstWindow.subarray(0, newline === -1 ? firstWindow.length : newline).toString("utf8");
    return resolveHarness(transcriptPath, firstLine) ? "codex" : "claude-code";
  } catch {
    return "claude-code";
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/**
 * The flush decision, kept pure for tests: only a genuine Stop (the agent-turn
 * boundary) flushes; PostToolUse is buffer-only, and a Stop re-fired by a Stop
 * hook's own output (`stop_hook_active`) never cascades.
 */
export function shouldFlush(payload: CapturePayload): boolean {
  return payload.hook_event_name === "Stop" && !payload.stop_hook_active;
}

/**
 * Tail the transcript from the stored cursor, normalize+scrub the new COMPLETE
 * lines into canonical events AND wrap each consumed non-blank valid JSON line as a
 * structurally-sanitized RawRecord (including lines that produced no event — the cursor
 * advances past them, so without a wrapper they would be lost), stamp the
 * current turn on both, append everything to the outbox in one call, and
 * advance the cursor. Returns how many EVENTS were appended (raws ride along
 * uncounted) and whether this fire is a turn-boundary flush. Best-effort: any
 * failure returns zeros rather than throwing, so a hook never breaks the
 * session.
 *
 * Only whole lines (terminated by `\n`) are consumed; a partial final line that
 * the harness is still writing is left for the next fire — so we never emit a
 * half-written transcript record.
 */
export function runCapture(
  payload: CapturePayload,
  opts: RunCaptureOptions = {},
): { appended: number; flushed: boolean } {
  const projectRoot = opts.projectRoot ?? resolveProjectRoot(payload.cwd);
  const transcriptPath = payload.transcript_path;
  const flush = shouldFlush(payload);
  if (!projectRoot) return { appended: 0, flushed: false };

  const scrub = opts.scrub ?? defaultScrub;
  const maxTailBytes = opts.maxTailBytes ?? MAX_TAIL_BYTES_PER_FIRE;
  let memoryHarness: "claude-code" | "codex" | undefined;

  // Memory has its own scrubbed document contract and only runs at genuine
  // session boundaries. It must complete its local outbox append BEFORE the
  // detached shipper starts so this Stop flush can deliver the new revision.
  const finish = (appended: number): { appended: number; flushed: boolean } => {
    if (flush) {
      try {
        captureAgentMemory({
          projectRoot,
          harness: memoryHarness ?? resolveMemoryHarness(transcriptPath),
          transcriptPath,
          scrub,
          maxSpoolBytes: opts.maxSpoolBytes,
        });
      } catch {
        /* memory is best-effort and must never interrupt trajectory capture */
      }
      if (opts.spawnShipper !== false) spawnShipper(projectRoot);
    }
    return { appended, flushed: flush };
  };

  if (!transcriptPath || !existsSync(transcriptPath)) return finish(0);

  const state = new CaptureState(projectRoot);
  const cursor = state.get(transcriptPath);

  // Positional read: only the unread tail from `cursor.offset`, never the
  // whole file — a full re-read every fire is O(total transcript) and risks
  // stalling past the hook's 5s/10s timeout on a long session.
  //
  // The per-fire byte cap bounds the FREQUENT PostToolUse hot-path reads. The
  // Stop (flush) fire runs once per turn at the boundary and reads the FULL
  // unread tail (uncapped): a capped Stop could strand a >cap tail with no
  // later fire on this transcript to catch up — a SILENT loss when the session
  // then ends. Positional reads already make even a full-tail read O(unread
  // bytes), not O(file), so uncapping the once-per-turn Stop reintroduces no
  // O(n²) stall.
  let tailBuf: Buffer | undefined;
  let fd = -1;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    if (cursor.offset < size) tailBuf = readTail(fd, cursor.offset, size, flush ? Infinity : maxTailBytes);
  } catch {
    return finish(0);
  } finally {
    if (fd >= 0) closeSync(fd);
  }

  if (!tailBuf) return finish(0); // nothing new; a Stop still flushes the buffer

  // Decode only the unread tail, then keep COMPLETE lines (drop a trailing
  // partial — held for the next fire: a still-writing line, or bytes beyond
  // this fire's byte budget). split("\n") leaves a trailing "" for a
  // newline-terminated slice and the partial line otherwise — either way
  // slice(0, -1) keeps whole lines.
  const tail = tailBuf.toString("utf8");
  const completeLines = tail.split("\n").slice(0, -1);
  if (completeLines.length === 0) return finish(0);

  // Harness (Codex vs Claude Code) selects the matching normalizer and stamps
  // each event, since the two agents record their transcripts in different
  // JSONL shapes. Inferred from the transcript PATH first, falling back to
  // sniffing the first line's shape when the path matches neither pattern
  // (see resolveHarness).
  const codex = resolveHarness(transcriptPath, completeLines[0]!);
  const src = codex ? ("codex" as const) : ("claude-code" as const);
  memoryHarness = src;
  const sessionId = payload.session_id || "unknown";
  const project = payload.cwd || process.cwd();
  const normalize = codex ? normalizeCodexRollout : normalizeClaudeTranscript;
  const { events, raws: rawLines, nextSeq, nextOffset } = normalize({
    lines: completeLines,
    ctx: { sessionId, project, transcriptPath, harness: src },
    startSeq: cursor.seq,
    startOffset: cursor.offset,
    scrub,
  });

  // Raw-telemetry channel: one RawRecord per consumed non-blank valid JSON line,
  // structurally sanitized but otherwise UNSCRUBBED — including lines that
  // produced no event (the cursor advances past them; without a wrapper they
  // would be lost). The sid
  // comes from the normalizer's OWN per-line derivation (the sibling event's
  // sid), so a resumed session's replayed lines — which keep their original
  // sessionId — can never split the raw channel from its steps into a
  // zero-event group that ship would drop.
  const raws: RawRecord[] = rawLines.map(({ raw, sid }) => ({ raw, src, sid, proj: project }));

  // seq to persist in the cursor — bumped past any synthetic event below so a
  // later real event can never collide with one.
  let finalSeq = nextSeq;

  // Capture-time synthetic event (G7): a raws-only fire — lines that carry no
  // mappable step (Claude bookkeeping floods are common even after the G5/G6
  // fidelity work) — would otherwise group into a ZERO-EVENT experience that
  // ship.ts's groupIntoExperiences drops outright, and the raws evaporate
  // structurally. Fixed HERE, not at ship time: capture owns the seq counter,
  // while a ship-time synthetic would need a fabricated seq that could
  // collide across turns and overwrite another turn's landed record.
  //
  // ONE synthetic per DISTINCT sid: a single raws-only fire can carry raws
  // under more than one sid (a resumed session replays history lines that keep
  // their original sessionId). ship groups by sid, so a lone synthetic under
  // just raws[0]'s sid would leave any other-sid raws in a zero-event group
  // that gets dropped — the exact orphaning this synthetic exists to prevent
  // (see normalize-core.ts). Each synthetic takes its own monotonic seq.
  if (events.length === 0 && raws.length > 0) {
    const linesBySid = new Map<string, number>();
    for (const r of raws) linesBySid.set(r.sid, (linesBySid.get(r.sid) ?? 0) + 1);
    for (const [sid, count] of linesBySid) {
      events.push({
        src,
        sid,
        proj: project,
        ts: new Date().toISOString(),
        seq: finalSeq,
        kind: "session",
        role: "system",
        text: `[augenta: ${count} transcript line(s) with no mappable steps — raw channel attached]`,
      });
      finalSeq += 1;
    }
  }

  // Stamp the current agent turn (UserPromptSubmit bumps it) on both channels
  // so the flush can group this turn's steps + raws into one experience.
  // Best-effort — never block capture over turn bookkeeping.
  let turn: number | undefined;
  try {
    turn = new TurnState(projectRoot).get(transcriptPath);
    for (const e of events) e.turn = turn;
    for (const r of raws) r.turn = turn;
  } catch {
    /* records ship without a turn stamp; the grouper buckets them as turn 0 */
  }

  // finalSeq is bumped again below if a drop marker consumes a seq of its
  // own, so a later real event can never collide with it either.
  if (events.length + raws.length > 0) {
    const box = new Outbox(projectRoot, { maxSpoolBytes: opts.maxSpoolBytes });
    const ok = box.append([...events, ...raws]);
    if (!ok && box.markDropped()) {
      // First drop of a new overflow episode: this fire's events/raws above
      // are lost (the transcript on disk remains the recovery source), but a
      // SINGLE loud marker bypasses the cap so the overflow is never silent.
      // One per episode, not one per fire — markDropped() gates that.
      //
      // Accepted crash-window limitation: the marker append (forceAppend) and
      // the cursor write (state.set below) aren't atomic. A process kill
      // between them, DURING an active overflow, leaves the marker spooled at
      // this seq while the cursor stays behind; a later fire (episode already
      // marked) then advances the cursor over that seq and a future real event
      // could reuse it, overwriting one record server-side. Not worth
      // restructuring this hot path for: it needs a kill inside a one-syscall
      // window during an episode that is ALREADY dropping records loudly, and
      // the at-least-once model tolerates the same crash-window dup for every
      // ordinary append too.
      const marker: CaptureEvent = {
        src,
        sid: events[0]?.sid ?? raws[0]?.sid ?? sessionId,
        proj: project,
        ts: new Date().toISOString(),
        seq: finalSeq,
        kind: "session",
        role: "system",
        text: SPOOL_FULL_MARKER,
        ...(turn !== undefined ? { turn } : {}),
      };
      box.forceAppend([marker]);
      finalSeq += 1;
    }
  }
  // Always advance past consumed bytes — lines that produced no event (e.g.
  // empty/system markers) must not be re-scanned forever.
  state.set(transcriptPath, { offset: nextOffset, seq: finalSeq });

  return finish(events.length);
}

/**
 * Detached fire-and-forget shipper — never blocks the hook, ignores all I/O.
 * The project root rides as argv (explicit and visible in `ps`) so the child
 * drains the SAME project the hook captured into, regardless of its own cwd.
 * Exported so other hooks (SessionStart — see hooks/session-start.ts) can
 * spawn the same drain for a spool stranded by a Stop that never fired or
 * failed before it could ship.
 */
export function spawnShipper(projectRoot: string): void {
  try {
    const child = spawn("bun", ["run", join(import.meta.dir, "ship.ts"), projectRoot], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch {
    /* spawning the shipper is best-effort; the next Stop will retry the drain */
  }
}

if (import.meta.main) {
  // Hook entrypoint: parse the payload, gate on the project's opt-in, run
  // capture, always exit 0.
  try {
    const payload = JSON.parse(await Bun.stdin.text()) as CapturePayload;
    if (captureEnabled(projectConfig(payload.cwd))) {
      runCapture(payload);
    }
  } catch {
    /* malformed payload or capture failure — stay silent, never block the turn */
  }
  process.exit(0);
}
