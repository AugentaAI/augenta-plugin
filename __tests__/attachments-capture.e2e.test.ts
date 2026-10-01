/** Built Node capture -> detached shipper -> real local HTTP receiver. No hosted processing claim. */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentExperience, Experience } from "../capture/event";
import { readLinks, writeLinks } from "../capture/links";
import { Outbox } from "../capture/outbox";
import { joinCheckout, TEST_USER_ID, writeSharedConfig } from "./fixtures";
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

test("renewed checkout consent delivers fresh unchanged text and PDFs to each selected Workspace under Node", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "augenta-attachment-fanout-e2e-")));
  const project = join(work, "project");
  const sessionDir = join(work, ".claude/projects/fixture");
  const authHome = join(work, "auth");
  const received = new Map<string, Experience[]>();
  const a = { workspaceId: "workspace-a", connectorId: "link-a" };
  const b = { workspaceId: "workspace-b", connectorId: "link-b" };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/experiences") return new Response(null, { status: 202 });
      expect(req.headers.get("authorization")).toBe("Bearer fixture-only");
      const key = req.headers.get("x-augenta-connector-id")!;
      expect([a.connectorId, b.connectorId]).toContain(key);
      const body = await req.json() as { experiences: Experience[] };
      received.set(key, [...(received.get(key) ?? []), ...body.experiences]);
      return new Response(null, { status: 202 });
    },
  });
  const fixture = (name: string) => readFileSync(join(ROOT, "capture/__fixtures__", `${name}.jsonl`), "utf8")
    .trim().split("\n").map(x => JSON.parse(x.replaceAll("/project", project)));
  const mention = (n: number, text = "Unchanged supplied claim.") => {
    const records = fixture("mention-text");
    for (const [i, x] of records.entries()) { x.uuid = `mention-${n}-${i}`; x.timestamp = t(n); }
    records[1].parentUuid = records[0].uuid;
    records[1].attachment.content.file.content = text;
    return records;
  };
  const pdfRead = (n: number) => {
    const records = fixture("sdk-read-resume").slice(1, 3);
    for (const [i, x] of records.entries()) { x.uuid = `pdf-${n}-${i}`; x.timestamp = t(n); }
    records[1].parentUuid = records[0].uuid;
    return records;
  };
  const experiences = (key: string) => received.get(key) ?? [];
  const documents = (key: string) => experiences(key).filter((x): x is DocumentExperience => x.type === "doc");
  const box = new Outbox(project);
  const drained = () => !box.hasPendingBytes() && !existsSync(join(project, ".augenta/outbox/.lock"));
  const connect = (n: number, destinations: typeof a[]) => {
    const config = { profileId: "fixture-profile", joinedAt: t(n), destinations, extra: { endpoint: server.url.origin } };
    writeSharedConfig(project, config); joinCheckout(project, config);
    writeLinks(project, { ...readLinks(project)!, attachmentsConsentedAt: t(n) });
    box.registerDestinations(destinations.map(d => d.connectorId), { freshKeys: destinations.filter(d => d === b).map(d => d.connectorId) });
  };
  const fire = (records: any[], name: string) => {
    const transcript = join(sessionDir, name);
    writeFileSync(transcript, records.map(x => JSON.stringify(x)).join("\n") + "\n");
    const proc = Bun.spawnSync(["node", join(ROOT, "dist/capture/capture.mjs")], {
      cwd: ROOT,
      stdin: Buffer.from(JSON.stringify({ cwd: project, transcript_path: transcript, session_id: "fixture", hook_event_name: "Stop" })),
      env: { ...(process.env as Record<string, string>), AUGENTA_AUTH_HOME: authHome,
        AUGENTA_CAPTURE_ENABLED: "1", AUGENTA_CAPTURE_ATTACHMENTS: "all",
        AUGENTA_API_URL: server.url.origin, AUGENTA_INGEST_URL: `${server.url.origin}/v1/experiences` },
      stdout: "pipe", stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0); expect(proc.stdout.toString()).toBe(""); expect(proc.stderr.toString()).toBe("");
  };
  try {
    mkdirSync(sessionDir, { recursive: true }); mkdirSync(authHome, { recursive: true });
    // Synthetic stored sign-in: this exercises routing, not the human OAuth gate.
    writeFileSync(join(authHome, "auth.json"), JSON.stringify({ version: 1, profiles: { "fixture-profile": {
      gateway: server.url.origin, userId: TEST_USER_ID, orgId: "fixture-org",
      accessToken: "fixture-only", refreshToken: "fixture-only", expiresAt: Date.now() + 3600000, updatedAt: t(1),
    } } }));
    connect(1, [a]);
    const pdfBytes = Buffer.from(pdfRead(2)[1].toolUseResult.file.base64, "base64");
    writeFileSync(join(project, "fixture.pdf"), pdfBytes);
    fire([...mention(2), ...pdfRead(2)], "original.jsonl");
    await waitFor(() => documents(a.connectorId).length === 2 && drained());
    const original = documents(a.connectorId);

    connect(3, [a, b]);
    const beforeHistorical = experiences(a.connectorId).length;
    fire([...mention(2), ...pdfRead(2)], "historical.jsonl");
    await waitFor(() => experiences(a.connectorId).length > beforeHistorical && drained());
    expect(documents(b.connectorId)).toHaveLength(0);
    fire([...mention(4), ...pdfRead(4)], "fresh.jsonl");
    await waitFor(() => documents(a.connectorId).length === 4 && documents(b.connectorId).length === 2 && drained());
    for (const key of [a.connectorId, b.connectorId]) {
      const fresh = documents(key).slice(-2);
      for (const previous of original) {
        const doc = fresh.find(x => x.sid === previous.sid)!;
        expect(doc.data.revision).toBe(previous.data.revision);
        expect(doc.data.capturedAt).toBe(t(4));
        expect(doc.data.kind).toBe("agent-attachment"); expect("events" in doc).toBe(false);
      }
      const pdf = fresh.find(x => x.data.format === "application/pdf")!;
      expect(pdf.data.kind === "agent-attachment" && pdf.data.encoding === "base64" && Buffer.from(pdf.data.content, "base64").equals(pdfBytes)).toBe(true);
      const trajectories = experiences(key).filter(x => x.type === "trajectory");
      expect(trajectories.length).toBeGreaterThan(0);
      expect(JSON.stringify(trajectories)).not.toContain(pdfBytes.toString("base64"));
    }

    const beforeDuplicate = experiences(b.connectorId).length;
    fire([...mention(5), ...pdfRead(5), ...mention(4, "Older conflicting claim.")], "duplicate.jsonl");
    await waitFor(() => experiences(b.connectorId).length > beforeDuplicate && drained());
    expect(documents(a.connectorId)).toHaveLength(4); expect(documents(b.connectorId)).toHaveLength(2);
    const index = JSON.parse(readFileSync(join(project, ".augenta/state/attachments.json"), "utf8"));
    for (const doc of original) {
      expect(index.documents[doc.data.documentId].capturedAt).toBe(t(5));
      expect(index.documents[doc.data.documentId].consentedAt).toBe(t(3));
    }
    fire(mention(6, "Replacement claim."), "edit.jsonl");
    await waitFor(() => documents(a.connectorId).length === 5 && documents(b.connectorId).length === 3 && drained());
    const revised = documents(b.connectorId)[2]!;
    expect(revised.sid).toBe(original.find(x => x.data.sourcePath === "notes.md")!.sid);
    expect(revised.data.revision).not.toBe(original.find(x => x.sid === revised.sid)!.data.revision);
    const beforeReplay = experiences(b.connectorId).length;
    fire(mention(5), "replay.jsonl");
    await waitFor(() => experiences(b.connectorId).length > beforeReplay && drained());
    expect(documents(a.connectorId)).toHaveLength(5); expect(documents(b.connectorId)).toHaveLength(3);
  } finally {
    await waitFor(() => !existsSync(join(project, ".augenta/outbox/.lock"))).catch(() => {});
    server.stop(true); rmSync(work, { recursive: true, force: true });
  }
}, 30000);
