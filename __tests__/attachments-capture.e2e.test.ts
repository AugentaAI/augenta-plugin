/** Built Node capture -> detached shipper -> real local HTTP receiver. No hosted processing claim. */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentExperience, Experience } from "../capture/event";
import { Outbox } from "../capture/outbox";
const ROOT = join(import.meta.dir, "..");
const t = (n: number) => new Date(Date.UTC(2026, 8, 30, 10, 0, n)).toISOString();
async function waitFor(check: () => boolean) { const until = Date.now() + 6000; while (Date.now() < until) { if (check()) return; await Bun.sleep(20); } throw Error("receiver did not drain"); }

test("supplied documents ship standalone, PDF bytes decode, telemetry has no base64, and replay cannot regress revisions", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "augenta-attachment-e2e-")));
  const project = join(work, "project"); const sessionDir = join(work, ".claude/projects/fixture");
  const experiences: Experience[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { expect(req.headers.get("authorization")).toBe("AugentaKey fixture-only"); const body = await req.json() as { experiences: Experience[] }; experiences.push(...body.experiences); return new Response(null, { status: 202 }); } });
  const fixture = (name: string) => readFileSync(join(ROOT, "capture/__fixtures__", `${name}.jsonl`), "utf8").trim().split("\n").map(x => JSON.parse(x.replaceAll("/project", project)));
  const mention = (n: number, text: string) => {
    const records = fixture("mention-text"); for (const [i, x] of records.entries()) { x.uuid = `mention-${n}-${i}`; x.timestamp = t(n); }
    records[1].parentUuid = records[0].uuid; records[1].attachment.content.file.content = text;
    return records;
  };
  const documents = () => experiences.filter((x): x is DocumentExperience => x.type === "doc");
  const fire = (records: any[], name: string, extra: Record<string, string> = {}) => {
    const transcript = join(sessionDir, name); writeFileSync(transcript, records.map(x => JSON.stringify(x)).join("\n") + "\n");
    const proc = Bun.spawnSync(["node", join(ROOT, "dist/capture/capture.mjs")], { cwd: ROOT,
      stdin: Buffer.from(JSON.stringify({ cwd: project, transcript_path: transcript, session_id: "fixture", hook_event_name: "Stop" })),
      env: { ...(process.env as Record<string, string>), AUGENTA_CAPTURE_ENABLED: "1", AUGENTA_CAPTURE_ATTACHMENTS: "all", AUGENTA_INGEST_URL: `${server.url.origin}/v1/experiences`, ...extra }, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0); expect(proc.stdout.toString()).toBe(""); expect(proc.stderr.toString()).toBe("");
  };
  const drained = () => !new Outbox(project).hasPendingBytes() && !existsSync(join(project, ".augenta/outbox/.lock"));
  try {
    mkdirSync(join(project, ".augenta"), { recursive: true }); mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(project, ".augenta/config.json"), JSON.stringify({ authMode: "api-key", apiKey: "fixture-only", attachmentsConsentedAt: t(1) }));
    const sdk = fixture("sdk-read-resume");
    for (const x of sdk) x.timestamp = t(2);
    const pdfBytes = Buffer.from(sdk[2].toolUseResult.file.base64, "base64"); writeFileSync(join(project, "fixture.pdf"), pdfBytes);
    fire([...mention(0, "Historical claim excluded."), ...mention(2, "First supplied claim."), ...sdk], "session.jsonl");
    await waitFor(() => documents().length === 3 && drained());
    const first = documents();
    expect(first.every(x => x.data.kind === "agent-attachment" && !("events" in x))).toBe(true);
    expect(JSON.stringify(first)).not.toContain("Historical claim excluded");
    const pdfDoc = first.find(x => x.data.format === "application/pdf")!;
    expect(pdfDoc.data.kind === "agent-attachment" && pdfDoc.data.encoding === "base64" && Buffer.from(pdfDoc.data.content, "base64").equals(pdfBytes)).toBe(true);
    const trajectory = experiences.filter(x => x.type === "trajectory");
    expect(trajectory.length).toBeGreaterThan(0); expect(JSON.stringify(trajectory)).not.toContain(pdfBytes.toString("base64"));
    expect(JSON.stringify(trajectory)).toContain("sha256:");
    const original = first.find(x => x.data.sourcePath === "notes.md")!;
    fire([...mention(3, "Replacement claim."), ...mention(5, "Replacement claim."), ...mention(4, "Older conflicting replay.")], "edit.jsonl");
    await waitFor(() => documents().length === 4 && drained());
    const revised = documents()[3]!;
    expect(revised.sid).toBe(original.sid); expect(revised.data.revision).not.toBe(original.data.revision); expect(revised.data.capturedAt).toBe(t(3));
    const index = JSON.parse(readFileSync(join(project, ".augenta/state/attachments.json"), "utf8"));
    expect(index.documents[revised.data.documentId].capturedAt).toBe(t(5));
    const before = experiences.length;
    fire([...mention(2, "First supplied claim."), ...mention(4, "Older conflicting replay.")], "resume.jsonl");
    await waitFor(() => experiences.length > before && drained());
    expect(documents()).toHaveLength(4);
    fire(mention(6, "Disabled attachment."), "disabled.jsonl", { AUGENTA_CAPTURE_ATTACHMENTS: "off" });
    await waitFor(() => drained()); expect(documents()).toHaveLength(4);
  } finally {
    await waitFor(() => !existsSync(join(project, ".augenta/outbox/.lock"))).catch(() => {});
    server.stop(true); rmSync(work, { recursive: true, force: true });
  }
}, 20000);
