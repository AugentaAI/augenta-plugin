import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicTextFindings, auditPublicSurface } from "../.github/scripts/public-surface.mjs";

describe("public surface audit", () => {
  test("rejects private references without returning the matched text", () => {
    const ticket = ["OPS", "123"].join("-");
    const repository = ["AugentaAI", "private-service"].join("/");
    for (const text of [ticket, repository, `https://${["linear", "app"].join(".")}/team/issue/${ticket}`,
      ["neuro", "space"].join(""), `https://${["staging", "augenta", "ai"].join(".")}`]) {
      const findings = publicTextFindings(text);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.join(" ")).not.toContain(text);
    }
  });

  test("accepts public links, protocol names, and synthetic fixture URLs", () => {
    expect(publicTextFindings("AugentaAI/augenta-plugin#42 https://github.com/AugentaAI/augenta-plugin.git " +
      "SHA-256 UTF-16 RFC-6749 HTTP-401 https://auth.augenta.ai https://api.augenta.ai " +
      "https://dev.example.com /Users/x/.codex")).toEqual([]);
  });

  test("checks added files, commits, PR text, and branch names without scanning old history", () => {
    const root = mkdtempSync(join(tmpdir(), "public-audit-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const ticket = ["OPS", "123"].join("-");
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.com");
      writeFileSync(join(root, "README.md"), "Public plugin instructions\n");
      git("add", ".");
      git("commit", "-qm", `old reference ${ticket}`);
      const base = git("rev-parse", "HEAD");
      git("commit", "--allow-empty", "-qm", "Public cleanup");
      const head = git("rev-parse", "HEAD");
      expect(auditPublicSurface({ root, commits: `${base}..${head}` })).toEqual([]);
      writeFileSync(join(root, "new.md"), ticket);
      expect(auditPublicSurface({ root, commits: `${base}..${head}` })).toContainEqual({ location: "new.md", rule: "ticket identifier" });
      rmSync(join(root, "new.md"));
      git("commit", "--allow-empty", "-qm", `new reference ${ticket}`);
      expect(auditPublicSurface({ root, commits: `${base}..HEAD` }).some((f: { rule: string }) => f.rule === "ticket identifier")).toBe(true);
      const failures = auditPublicSurface({ root, event: { pull_request: {
        title: ticket, body: ticket, head: { sha: head, ref: `fix/${ticket}` }, base: { sha: base },
      } } });
      expect(failures.map((f: { location: string }) => f.location)).toEqual(["PR title", "PR description", "PR branch"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
