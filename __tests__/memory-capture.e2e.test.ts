/**
 * End-to-end verification of the installed-hook execution path:
 *
 *   hook subprocess -> memory/trajectory capture -> durable outbox ->
 *   detached shipper -> HTTP experiences receiver
 *
 * These tests intentionally keep the real process boundary and network stack.
 * Unit tests cover the individual parsers and outbox operations in more detail.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentExperience, Experience, TrajectoryExperience } from "../capture/event";
import { Outbox } from "../capture/outbox";

const ROOT = join(import.meta.dir, "..");
const CAPTURE_HOOK = join(ROOT, "capture", "capture.ts");
const SESSION_START_HOOK = join(ROOT, "hooks", "session-start.ts");
const SECRET = "ghp_0123456789abcdefghijklmnopqrstuvwx";

interface ReceivedRequest {
  authorization: string | null;
  subscriptionKey: string | null;
  experiences: Experience[];
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function runHook(script: string, payload: object, env: Record<string, string>): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["bun", "run", script], {
    cwd: ROOT,
    stdin: Buffer.from(JSON.stringify(payload)),
    env: { ...(process.env as Record<string, string>), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function configureProject(project: string, apiKey: string): void {
  mkdirSync(join(project, ".augenta"), { recursive: true });
  writeFileSync(join(project, ".augenta", "config.json"), JSON.stringify({ apiKey }));
}

function receiver(requests: ReceivedRequest[]) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as { experiences: Experience[] };
      requests.push({
        authorization: request.headers.get("authorization"),
        subscriptionKey: request.headers.get("ocp-apim-subscription-key"),
        experiences: body.experiences,
      });
      return new Response(null, { status: 202 });
    },
  });
}

async function waitForShipper(project: string, requests: ReceivedRequest[], minimumExperiences: number): Promise<void> {
  const box = new Outbox(project);
  const lock = join(project, ".augenta", "outbox", ".lock");
  await waitFor(
    () => requests.flatMap((request) => request.experiences).length >= minimumExperiences &&
      !box.hasPendingBytes() && !existsSync(lock),
    "the detached shipper to deliver and drain the outbox",
  );
}

describe("memory capture E2E", () => {
  test("Claude Stop ships scrubbed memory beside a trajectory while preserving the consented raw channel", async () => {
    const work = mkdtempSync(join(tmpdir(), "augenta-e2e-claude-"));
    const project = join(work, "project");
    const sessionDir = join(work, ".claude", "projects", "encoded-project");
    const transcript = join(sessionDir, "session.jsonl");
    const requests: ReceivedRequest[] = [];
    const server = receiver(requests);

    try {
      mkdirSync(project, { recursive: true });
      configureProject(project, "e2e-claude-key");
      mkdirSync(join(sessionDir, "memory"), { recursive: true });
      const rawLine = JSON.stringify({
        type: "user",
        message: { role: "user", content: `Use ${SECRET} only for this test.` },
      });
      writeFileSync(transcript, rawLine + "\n");
      writeFileSync(
        join(sessionDir, "memory", "project.md"),
        `# Credential ${SECRET}\nRemember that ${SECRET} must never survive document capture.\n`,
      );

      const result = runHook(
        CAPTURE_HOOK,
        { session_id: "claude-e2e", transcript_path: transcript, cwd: project, hook_event_name: "Stop" },
        {
          AUGENTA_CAPTURE_ENABLED: "1",
          AUGENTA_INGEST_URL: `http://127.0.0.1:${server.port}/v1/experiences`,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout?.toString()).toBe("");
      expect(result.stderr?.toString()).toBe("");

      await waitForShipper(project, requests, 2);
      const experiences = requests.flatMap((request) => request.experiences);
      const trajectories = experiences.filter((item): item is TrajectoryExperience => item.type === "trajectory");
      const documents = experiences.filter((item): item is DocumentExperience => item.type === "doc");

      expect(trajectories).toHaveLength(1);
      expect(documents).toHaveLength(1);
      expect(trajectories[0]!.events[0]!.text).toContain("[redacted:github-token]");
      expect(trajectories[0]!.events[0]!.text).not.toContain(SECRET);
      expect(trajectories[0]!.data).toEqual([rawLine]);
      expect(trajectories[0]!.data![0]).toContain(SECRET);

      const document = documents[0]!;
      expect(document.src).toBe("claude-code");
      expect(document.proj).toBe(project);
      expect(document.sid).toBe(`memory-${document.data.documentId}`);
      expect(document.data.sourcePath).toBe("project.md");
      expect(document.data.title).toContain("[redacted:github-token]");
      expect(document.data.text).toContain("[redacted:github-token]");
      expect(JSON.stringify(document)).not.toContain(SECRET);
      expect("events" in document).toBe(false);

      expect(requests.every((request) => request.authorization === "Bearer e2e-claude-key")).toBe(true);
      expect(requests.every((request) => request.subscriptionKey === "e2e-claude-key")).toBe(true);
    } finally {
      await waitFor(
        () => !existsSync(join(project, ".augenta", "outbox", ".lock")),
        "the Claude E2E shipper to exit",
        2_000,
      ).catch(() => {});
      server.stop(true);
      rmSync(work, { recursive: true, force: true });
    }
  }, 10_000);

  test("Codex SessionStart ships only Task Groups scoped to the initialized project", async () => {
    const work = mkdtempSync(join(tmpdir(), "augenta-e2e-codex-"));
    const project = join(work, "project");
    const childProject = join(project, "packages", "app");
    const codexHome = join(work, "custom-codex-home");
    const transcript = join(codexHome, "sessions", "neutral-session.jsonl");
    const requests: ReceivedRequest[] = [];
    const server = receiver(requests);

    try {
      mkdirSync(childProject, { recursive: true });
      configureProject(project, "e2e-codex-key");
      mkdirSync(join(codexHome, "memories"), { recursive: true });
      mkdirSync(join(codexHome, "sessions"), { recursive: true });
      writeFileSync(transcript, "");
      writeFileSync(
        join(codexHome, "memories", "MEMORY.md"),
        [
          "# Profile",
          "Global memory must remain private.",
          "# Task Group: Current project",
          `applies_to: cwd=${project}`,
          "Remember the local release process.",
          "# Task Group: Child project",
          `applies_to: cwd=${childProject}`,
          "Remember the package-specific test.",
          "# Task Group: Unrelated",
          "applies_to: cwd=/tmp/not-this-project",
          "Never capture this unrelated memory.",
          "# Task Group: Unscoped",
          "This block only mentions scope later.",
          `applies_to: cwd=${project}`,
          "Never capture this unscoped memory.",
        ].join("\n") + "\n",
      );

      const result = runHook(
        SESSION_START_HOOK,
        { transcript_path: transcript, cwd: project },
        {
          AUGENTA_CAPTURE_ENABLED: "1",
          AUGENTA_INGEST_URL: `http://127.0.0.1:${server.port}/v1/experiences`,
          CODEX_HOME: codexHome,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout?.toString()).toBe("");
      expect(result.stderr?.toString()).toBe("");

      await waitForShipper(project, requests, 2);
      const experiences = requests.flatMap((request) => request.experiences);
      const documents = experiences.filter((item): item is DocumentExperience => item.type === "doc");

      expect(experiences).toHaveLength(2);
      expect(documents).toHaveLength(2);
      expect(documents.map((document) => document.data.title).sort()).toEqual([
        "Task Group: Child project",
        "Task Group: Current project",
      ]);
      expect(documents.every((document) => document.src === "codex" && document.proj === project)).toBe(true);
      expect(documents.every((document) => document.sid === `memory-${document.data.documentId}`)).toBe(true);
      expect(documents.every((document) => document.data.sourcePath.startsWith("MEMORY.md#task-group-"))).toBe(true);
      expect(documents.every((document) => !document.data.sourcePath.includes(codexHome))).toBe(true);
      expect(documents.every((document) => !("events" in document))).toBe(true);
      const wire = JSON.stringify(documents);
      expect(wire).toContain("Remember the local release process.");
      expect(wire).toContain("Remember the package-specific test.");
      expect(wire).not.toContain("Global memory must remain private.");
      expect(wire).not.toContain("Never capture this unrelated memory.");
      expect(wire).not.toContain("Never capture this unscoped memory.");
      expect(requests.every((request) => request.authorization === "Bearer e2e-codex-key")).toBe(true);
      expect(requests.every((request) => request.subscriptionKey === "e2e-codex-key")).toBe(true);
    } finally {
      await waitFor(
        () => !existsSync(join(project, ".augenta", "outbox", ".lock")),
        "the Codex E2E shipper to exit",
        2_000,
      ).catch(() => {});
      server.stop(true);
      rmSync(work, { recursive: true, force: true });
    }
  }, 10_000);
});
