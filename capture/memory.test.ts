/** Tests for project-memory capture: discovery is harness-specific, documents
 * are scrubbed and standalone, and state changes only after durable spooling. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentRecord } from "./event";
import { captureAgentMemory, codexHomeFromRollout, MAX_DOCUMENT_EXPERIENCE_BYTES, parseCodexTaskGroups } from "./memory";
import { isDocumentRecord, Outbox } from "./outbox";

function docs(project: string): DocumentRecord[] {
  return new Outbox(project).readPending().records.filter(isDocumentRecord);
}

describe("Claude Code memory discovery", () => {
  let project: string;
  let sessionDir: string;
  let transcript: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "aug-memory-project-"));
    sessionDir = mkdtempSync(join(tmpdir(), "aug-memory-session-"));
    transcript = join(sessionDir, "session.jsonl");
    writeFileSync(transcript, "");
    mkdirSync(join(sessionDir, "memory", "nested"), { recursive: true });
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  const scan = () => captureAgentMemory({ projectRoot: project, harness: "claude-code", transcriptPath: transcript });

  test("recursively captures regular Markdown files, with paths relative to memory/, and excludes symlinks", () => {
    writeFileSync(join(sessionDir, "memory", "architecture.md"), "# Architecture\nThe real document.");
    writeFileSync(join(sessionDir, "memory", "nested", "notes.MD"), "Nested note.");
    writeFileSync(join(sessionDir, "memory", "ignore.txt"), "Not markdown.");
    const outside = join(sessionDir, "outside.md");
    writeFileSync(outside, "# Outside\nNever capture this.");
    symlinkSync(outside, join(sessionDir, "memory", "linked.md"));

    expect(scan()).toMatchObject({ spooled: 2, changed: 2, tombstones: 0, complete: true });
    const captured = docs(project);
    expect(captured.map((doc) => doc.data.sourcePath)).toEqual(["architecture.md", "nested/notes.MD"]);
    expect(captured.map((doc) => doc.data.title)).toEqual(["Architecture", "notes"]);
    expect(captured.every((doc) => doc.type === "doc" && !("events" in doc))).toBe(true);
    expect(captured.every((doc) => doc.sid === `memory-${doc.data.documentId}`)).toBe(true);
  });

  test("initial snapshots, unchanged scans, revisions, and tombstones are durable and idempotent", () => {
    const source = join(sessionDir, "memory", "project.md");
    writeFileSync(source, "# Project\nInitial text");
    expect(scan()).toMatchObject({ spooled: 1, changed: 1, tombstones: 0 });
    const initial = docs(project)[0]!;

    expect(scan()).toMatchObject({ spooled: 0, changed: 0, tombstones: 0 });
    expect(docs(project)).toHaveLength(1);

    appendFileSync(source, "\nRevised text");
    expect(scan()).toMatchObject({ spooled: 1, changed: 1, tombstones: 0 });
    const changed = docs(project)[1]!;
    expect(changed.data.documentId).toBe(initial.data.documentId);
    expect(changed.data.revision).not.toBe(initial.data.revision);

    rmSync(source);
    expect(scan()).toMatchObject({ spooled: 1, changed: 0, tombstones: 1, complete: true });
    const tombstone = docs(project)[2]!;
    expect(tombstone.data).toMatchObject({
      documentId: initial.data.documentId,
      deleted: true,
      text: "",
      chunkIndex: 0,
      chunkCount: 1,
    });
    expect(tombstone.data.revision).not.toBe(changed.data.revision);
    expect(scan()).toMatchObject({ spooled: 0, tombstones: 0 });
  });

  test("a missing or unusable memory root never infers a deletion", () => {
    const source = join(sessionDir, "memory", "keep.md");
    writeFileSync(source, "Keep me");
    scan();

    rmSync(join(sessionDir, "memory"), { recursive: true, force: true });
    expect(scan()).toMatchObject({ spooled: 0, tombstones: 0, complete: false });

    // A non-directory root is likewise not a complete scan and cannot erase
    // the previous state merely because the harness source is temporarily bad.
    writeFileSync(join(sessionDir, "memory"), "unreadable-as-a-root");
    expect(scan()).toMatchObject({ spooled: 0, tombstones: 0, complete: false });
    expect(docs(project)).toHaveLength(1);
  });

  test("scrubs memory text before both revisioning and spooling", () => {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    writeFileSync(join(sessionDir, "memory", "secret.md"), `# Credential ${secret}\nToken: ${secret}`);
    scan();
    const captured = docs(project)[0]!.data;
    expect(captured.text).toContain("[redacted:");
    expect(captured.text).not.toContain(secret);
    expect(captured.title).toContain("[redacted:github-token]");
    expect(captured.title).not.toContain(secret);
  });

  test("splits oversized text on Unicode boundaries and keeps every document envelope below 512 KiB", () => {
    const source = "# Large\n" + "😊".repeat(150_000); // ~600 KiB of UTF-8 payload
    writeFileSync(join(sessionDir, "memory", "large.md"), source);
    const result = scan();
    expect(result.spooled).toBeGreaterThan(1);

    const captured = docs(project);
    expect(captured.every((doc) => Buffer.byteLength(JSON.stringify(doc), "utf8") < MAX_DOCUMENT_EXPERIENCE_BYTES)).toBe(true);
    expect(captured.map((doc) => doc.data.chunkIndex)).toEqual(captured.map((_doc, index) => index));
    expect(new Set(captured.map((doc) => doc.data.chunkCount))).toEqual(new Set([captured.length]));
    expect(captured.every((doc) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(doc.data.text))).toBe(true);
    expect(captured.map((doc) => doc.data.text).join("")).toBe(source);
  });

  test("does not advance memory state when the outbox is full, allowing a later retry", () => {
    const source = join(sessionDir, "memory", "retry.md");
    writeFileSync(source, "first");
    // The first append is accepted even though it crosses the tiny cap; later
    // scans are rejected until the spool drains.
    expect(captureAgentMemory({ projectRoot: project, harness: "claude-code", transcriptPath: transcript, maxSpoolBytes: 1 }).spooled).toBe(1);
    appendFileSync(source, " changed");
    expect(captureAgentMemory({ projectRoot: project, harness: "claude-code", transcriptPath: transcript, maxSpoolBytes: 1 })).toMatchObject({ spooled: 0, changed: 0 });

    const box = new Outbox(project);
    box.advance(box.readPending().endOffset);
    box.compact();
    expect(scan()).toMatchObject({ spooled: 1, changed: 1 });
    expect(docs(project)[0]!.data.text).toBe("first changed");
  });
});

describe("Codex Task Group memory", () => {
  let project: string;
  let codexHome: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "aug-memory-project-"));
    codexHome = mkdtempSync(join(tmpdir(), "aug-memory-codex-home-"));
    mkdirSync(join(codexHome, "memories"), { recursive: true });
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  test("the Codex home is read from a rollout path only when CODEX_HOME is unset", () => {
    expect(codexHomeFromRollout("/opt/codex/sessions/2026/09/29/rollout-2026-09-29T15-38-38-abc.jsonl")).toBe("/opt/codex");
    expect(codexHomeFromRollout("C:\\Users\\x\\.codex\\sessions\\2026\\06\\24\\rollout-abc.jsonl")).toBe("C:\\Users\\x\\.codex");
    expect(codexHomeFromRollout("/tmp/rollout-2026.jsonl")).toBeUndefined();
    expect(codexHomeFromRollout("/root/.claude/projects/-home-claude/abc.jsonl")).toBeUndefined();
    expect(codexHomeFromRollout(undefined)).toBeUndefined();

    // A cloud-style home the hook's environment does not name.
    writeFileSync(join(codexHome, "memories", "MEMORY.md"), `# Task Group: Cloud\napplies_to: cwd=${project}\nFrom the rollout's own home.`);
    const transcript = join(codexHome, "sessions", "2026", "09", "29", "rollout-2026-09-29T15-38-38-abc.jsonl");
    const previous = process.env.CODEX_HOME;
    try {
      delete process.env.CODEX_HOME;
      const result = captureAgentMemory({ projectRoot: project, harness: "codex", transcriptPath: transcript });
      expect(result).toMatchObject({ changed: 1, complete: true });
      expect(docs(project)[0]!.data.text).toContain("From the rollout's own home.");
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  test("parses only scoped Task Groups for the project or a descendant", () => {
    const child = join(project, "packages", "app");
    const text = [
      "# Profile\nGlobal preferences must not be selected.",
      "# Task Group: Current project",
      `applies_to: cwd=${project}`,
      "Remember the local architecture.",
      "# Global Profile",
      "This global section must not become part of the preceding Task Group.",
      "# Examples",
      "```md",
      "# Task Group: Fenced fake",
      `applies_to: cwd=${project}`,
      "Do not collect fenced examples.",
      "```",
      "# Task Group: Child project",
      `applies_to: cwd=${child}`,
      "Remember child details.",
      "# Task Group: Other project",
      "applies_to: cwd=/unrelated/project",
      "Do not collect.",
      "# Task Group: Unscoped",
      "This is body text, not scope metadata.",
      `applies_to: cwd=${project}`,
      "Do not collect either.",
    ].join("\n");
    writeFileSync(join(codexHome, "memories", "MEMORY.md"), text);

    const parsed = parseCodexTaskGroups(text, project);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((group) => group.title)).toEqual(["Task Group: Current project", "Task Group: Child project"]);

    const result = captureAgentMemory({ projectRoot: project, harness: "codex", codexHome });
    expect(result).toMatchObject({ spooled: 2, changed: 2, complete: true });
    const captured = docs(project);
    expect(captured.every((doc) => doc.src === "codex" && doc.type === "doc" && !("events" in doc))).toBe(true);
    expect(captured.every((doc) => doc.data.sourcePath.startsWith("MEMORY.md#task-group-") && !doc.data.sourcePath.includes(codexHome))).toBe(true);
    expect(captured.map((doc) => doc.data.text)).toEqual([
      expect.stringContaining("Remember the local architecture."),
      expect.stringContaining("Remember child details."),
    ]);
    expect(captured.flatMap((doc) => [doc.data.text]).join("\n")).not.toContain("Do not collect");
    expect(captured.flatMap((doc) => [doc.data.text]).join("\n")).not.toContain("global section");
  });

  test("scope is decided physically: an alias into the project matches, a symlink out of it does not", () => {
    // The project lookup resolves symlinks, so a Task Group recorded through a
    // symlinked path belongs to the physical checkout, and a folder that is only
    // linked INTO the project does not. Explicit links keep this platform-neutral.
    const aliasHome = mkdtempSync(join(tmpdir(), "aug-memory-alias-"));
    const outside = mkdtempSync(join(tmpdir(), "aug-memory-outside-"));
    try {
      const alias = join(aliasHome, "project");
      symlinkSync(project, alias, "dir");
      mkdirSync(join(project, "packages", "app"), { recursive: true });
      symlinkSync(outside, join(project, "linked"), "dir");
      // Dangling links still point somewhere; a loop points nowhere at all.
      symlinkSync(join(outside, "gone"), join(project, "dangling-out"), "dir");
      symlinkSync(join(project, "not-yet"), join(aliasHome, "dangling-in"), "dir");
      symlinkSync(join(project, "loop-b"), join(project, "loop-a"), "dir");
      symlinkSync(join(project, "loop-a"), join(project, "loop-b"), "dir");
      const text = [
        "# Task Group: Through an alias",
        `applies_to: cwd=${alias}`,
        "The project root, reached through a symlink.",
        "# Task Group: Child through an alias",
        `applies_to: cwd=${join(alias, "packages", "app")}`,
        "An existing child, reached through the symlink.",
        "# Task Group: Deleted child through an alias",
        `applies_to: cwd=${join(alias, "since-deleted")}`,
        "A directory that no longer exists resolves through its nearest ancestor.",
        "# Task Group: Linked out of the project",
        `applies_to: cwd=${join(project, "linked")}`,
        "Lexically inside the project, physically outside it.",
        "# Task Group: Below the outward link",
        `applies_to: cwd=${join(project, "linked", "missing")}`,
        "Still outside, although the tail does not exist.",
        "# Task Group: Dangling link out",
        `applies_to: cwd=${join(project, "dangling-out", "sub")}`,
        "Its target is gone, but it pointed outside the project.",
        "# Task Group: Dangling link in",
        `applies_to: cwd=${join(aliasHome, "dangling-in")}`,
        "Its target does not exist yet, but it points into the project.",
        "# Task Group: Symlink loop",
        `applies_to: cwd=${join(project, "loop-a")}`,
        "No physical location, so never in scope.",
      ].join("\n");
      const inScope = [
        "Task Group: Through an alias",
        "Task Group: Child through an alias",
        "Task Group: Deleted child through an alias",
        "Task Group: Dangling link in",
      ];

      expect(parseCodexTaskGroups(text, project).map((group) => group.title)).toEqual(inScope);
      // The root is resolved too, so a caller holding a logical root agrees.
      expect(parseCodexTaskGroups(text, alias).map((group) => group.title)).toEqual(inScope);
    } finally {
      rmSync(aliasHome, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("memory captured for a folder that becomes a symlink out of the project is withdrawn", () => {
    // Scope is re-decided on every complete scan, so a Task Group whose folder
    // leaves the project's physical scope is tombstoned, like any document that
    // disappears. This is the retention change the release notes describe.
    const outside = mkdtempSync(join(tmpdir(), "aug-memory-outside-"));
    try {
      const folder = join(project, "vendored");
      mkdirSync(folder);
      writeFileSync(
        join(codexHome, "memories", "MEMORY.md"),
        `# Task Group: Vendored\napplies_to: cwd=${folder}\nVendored notes.`,
      );
      expect(captureAgentMemory({ projectRoot: project, harness: "codex", codexHome }))
        .toMatchObject({ changed: 1, tombstones: 0, complete: true });

      rmSync(folder, { recursive: true });
      symlinkSync(outside, folder, "dir");
      expect(captureAgentMemory({ projectRoot: project, harness: "codex", codexHome }))
        .toMatchObject({ changed: 0, tombstones: 1, complete: true });
      const [live, tombstone] = docs(project);
      expect(tombstone!.data).toMatchObject({ documentId: live!.data.documentId, deleted: true, text: "" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a custom CODEX_HOME source is used and an absent MEMORY.md cannot tombstone prior state", () => {
    const source = join(codexHome, "memories", "MEMORY.md");
    writeFileSync(source, `# Task Group: Current\napplies_to: cwd=${project}\nTracked.`);
    expect(captureAgentMemory({ projectRoot: project, harness: "codex", codexHome }).spooled).toBe(1);
    rmSync(source);
    expect(captureAgentMemory({ projectRoot: project, harness: "codex", codexHome })).toMatchObject({ spooled: 0, tombstones: 0, complete: false });
  });

  test("follows Codex's resolved MEMORY.md when the configured file is a stable symlink", () => {
    const target = join(codexHome, "actual-memory.md");
    writeFileSync(target, `# Task Group: Current\napplies_to: cwd=${project}\nLinked memory.`);
    symlinkSync(target, join(codexHome, "memories", "MEMORY.md"));
    expect(captureAgentMemory({ projectRoot: project, harness: "codex", codexHome })).toMatchObject({
      spooled: 1,
      changed: 1,
      complete: true,
    });
  });

  test("memory state records only successful outbox revisions", () => {
    const source = join(codexHome, "memories", "MEMORY.md");
    writeFileSync(source, `# Task Group: Current\napplies_to: cwd=${project}\nOne.`);
    captureAgentMemory({ projectRoot: project, harness: "codex", codexHome });
    const statePath = join(project, ".augenta", "state", "memory.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { documents: Record<string, { revision: string }> };
    expect(Object.keys(state.documents)).toHaveLength(1);
    expect(Object.values(state.documents)[0]!.revision).toBe(docs(project)[0]!.data.revision);
  });
});
