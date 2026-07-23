/** Tests for project-memory capture: discovery is harness-specific, documents
 * are scrubbed and standalone, and state changes only after durable spooling. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentRecord } from "./event";
import { captureAgentMemory, MAX_DOCUMENT_EXPERIENCE_BYTES, parseCodexTaskGroups } from "./memory";
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
