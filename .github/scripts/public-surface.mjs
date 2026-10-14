// Check public text without copying potentially private text into CI output.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_REPOSITORIES = new Set(["augenta-plugin"]);
// These prefixes identify public standards, advisories, issues, or runtimes.
// Branch names are normalized to catch private ticket IDs in any casing, so
// their public issue/runtime prefixes must be accepted here as well.
const STANDARD_LABELS = new Set([
  "SHA", "UTF", "HTTP", "ISO", "RFC", "FIPS",
  "CVE", "GHSA", "ISSUE", "GH", "NODE",
]);

export function publicTextFindings(text) {
  const findings = new Set();
  if (/\b(?:linear\.app|[\w.-]+\.atlassian\.net)\//i.test(text)) findings.add("private tracker link");
  for (const match of text.matchAll(/\b([A-Z]{2,12})-\d{2,}\b/g)) {
    if (!STANDARD_LABELS.has(match[1])) findings.add("ticket identifier");
  }
  for (const match of text.matchAll(/\bAugentaAI\/([\w.-]+)/gi)) {
    const name = match[1].replace(/\.git$/i, "").toLowerCase();
    if (!PUBLIC_REPOSITORIES.has(name)) findings.add("non-public repository reference");
  }
  if (/\baugenta\s*#\d+\b/i.test(text)) findings.add("cross-repository issue reference");
  if (/\bneuro(?:space|link|genesis)\b/i.test(text)) findings.add("internal product terminology");
  for (const match of text.matchAll(/\b([\w.-]+\.augenta\.ai)\b/gi)) {
    if (!["auth.augenta.ai", "api.augenta.ai"].includes(match[1].toLowerCase())) {
      findings.add("non-production service hostname");
    }
  }
  return [...findings];
}

export function auditPublicSurface({ root = process.cwd(), event, commits } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const failures = [];
  const check = (location, text) => {
    for (const rule of publicTextFindings(text)) failures.push({ location, rule });
  };
  // Include newly added files, but never dependencies or ignored local state.
  const files = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean);
  for (const file of new Set(files)) {
    if (!existsSync(resolve(root, file))) continue; // A pending deletion.
    check("tracked filename", file);
    const bytes = readFileSync(resolve(root, file));
    if (!bytes.includes(0)) check(file, bytes.toString("utf8"));
  }
  check("branch name", git("branch", "--show-current").toUpperCase());
  if (event?.pull_request) {
    const pr = event.pull_request;
    check("PR title", pr.title ?? "");
    check("PR description", pr.body ?? "");
    check("PR branch", (pr.head?.ref ?? "").toUpperCase());
    commits ??= `${pr.base.sha}..${pr.head.sha}`;
  } else if (event?.before && !/^0+$/.test(event.before)) {
    commits ??= `${event.before}..HEAD`;
  }
  // Old history requires its own coordinated cleanup. Never grandfather NEW
  // commits because an unrelated historical commit contains a finding.
  for (const sha of git("rev-list", commits ?? "HEAD^..HEAD").trim().split("\n").filter(Boolean)) {
    check(`commit ${sha.slice(0, 12)}`, git("show", "-s", "--format=%B", sha));
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = eventPath ? JSON.parse(readFileSync(eventPath, "utf8")) : undefined;
  const failures = auditPublicSurface({ event, commits: process.env.PUBLIC_AUDIT_COMMITS });
  for (const { location, rule } of failures) console.error(`${location}: ${rule}`);
  if (failures.length) process.exitCode = 1;
  else console.log("Public surface audit passed (text files and new Git/PR metadata). Review images manually.");
}
