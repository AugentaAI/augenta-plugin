/**
 * Contract + manifest validation for the Augenta plugin.
 *
 * Nothing else in the repo validates the *shape* of the plugin: that every
 * SKILL.md has portable, well-formed frontmatter and Codex UI metadata, that
 * invocable skills declare the tools they use, that all seven release version
 * declarations are internally consistent and agree on one
 * version, and that every file a skill or hook points at actually exists. A
 * rename or a typo'd frontmatter key would ship silently today; this test
 * turns those into a red build.
 *
 * Pure structural checks against the real plugin files — no fakes, no network.
 *
 * Run: bun test __tests__/contract.test.ts
 */
import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// This repo IS the plugin: __tests__/ sits at the repo root, so PLUGIN_ROOT is
// the repo root (one level up from here).
const PLUGIN_ROOT = join(import.meta.dir, "..");
const SKILLS_DIR = join(PLUGIN_ROOT, "skills");

// The tools a SKILL.md may legitimately request. Keep in sync with Claude Code's
// tool surface; an unknown name in `allowed-tools` is almost always a typo.
const KNOWN_TOOLS = new Set([
  "AskUserQuestion", "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "Skill", "Task", "Agent", "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite",
]);

// Recognized hook events (shared surface between Claude Code and Codex). An
// unrecognized key in hooks.json never fires — it's dead config, so we fail on it.
const KNOWN_HOOK_EVENTS = new Set([
  "SessionStart", "SessionEnd", "Stop", "SubagentStop", "UserPromptSubmit",
  "PreToolUse", "PostToolUse", "PreCompact", "Notification",
]);

// The telemetry-only plugin ships exactly ONE skill: init.
const EXPECTED_SKILLS = new Set(["init"]);

const SEMVER = /^\d+\.\d+\.\d+(?:[-+].*)?$/;
const RELEASE_VERSION = "0.2.3";
const PORTABLE_SKILL_FRONTMATTER_KEYS = new Set(["name", "description", "allowed-tools"]);

interface Frontmatter {
  raw: string;
  fields: Record<string, string>;
}

/** Minimal frontmatter reader — the SKILL.md files use one scalar per line. */
function readFrontmatter(file: string): Frontmatter | null {
  const text = readFileSync(file, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const raw = m[1]!;
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[kv[1]!] = value;
  }
  return { raw, fields };
}

function skillDirs(): string[] {
  return readdirSync(SKILLS_DIR).filter((d) => {
    const p = join(SKILLS_DIR, d);
    return statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"));
  });
}

/** Resolve every concrete file path a SKILL.md / hook command references. */
function referencedPaths(text: string): string[] {
  const out: string[] = [];
  // ${CLAUDE_PLUGIN_ROOT}/<path> — explicit, plugin-root-relative, optionally quoted.
  for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_\-./]+)/g)) {
    out.push(join(PLUGIN_ROOT, m[1]!));
  }
  return [...new Set(out)];
}

describe("skill frontmatter", () => {
  const dirs = skillDirs();

  test("exactly the expected skills are present (single init surface)", () => {
    expect(new Set(dirs)).toEqual(EXPECTED_SKILLS);
  });

  for (const dir of skillDirs()) {
    describe(dir, () => {
      const skillDir = join(SKILLS_DIR, dir);
      const file = join(skillDir, "SKILL.md");
      const fm = readFrontmatter(file);

      test("has a frontmatter block with a non-empty description", () => {
        expect(fm).not.toBeNull();
        expect((fm!.fields.description ?? "").trim().length).toBeGreaterThan(0);
      });

      test("uses exactly the portable frontmatter keys", () => {
        expect(new Set(Object.keys(fm!.fields))).toEqual(PORTABLE_SKILL_FRONTMATTER_KEYS);
      });

      test("name is the exact skill directory name", () => {
        expect(fm!.fields.name).toBe(dir);
      });

      test("allowed-tools, if present, only lists known tools", () => {
        const tools = fm?.fields["allowed-tools"];
        if (!tools) return;
        for (const t of tools.split(",").map((s) => s.trim()).filter(Boolean)) {
          expect(KNOWN_TOOLS.has(t)).toBe(true);
        }
      });

      if (EXPECTED_SKILLS.has(dir)) {
        test("invocable skill declares allowed-tools", () => {
          expect((fm!.fields["allowed-tools"] ?? "").trim().length).toBeGreaterThan(0);
        });
      }

      test("includes complete Codex UI metadata", () => {
        const metadataPath = join(skillDir, "agents", "openai.yaml");
        expect(existsSync(metadataPath)).toBe(true);
        const metadata = readFileSync(metadataPath, "utf8");
        expect(metadata).toContain('display_name: "Initialize Augenta"');
        expect(metadata).toContain('short_description: "Enable Augenta for the current project"');
        expect(metadata).toContain('default_prompt: "Use $augenta:init to initialize Augenta for this project."');
        expect(metadata).toContain("allow_implicit_invocation: true");
      });

      test("every file it references exists", () => {
        const body = readFileSync(file, "utf8");
        for (const p of referencedPaths(body)) {
          expect(existsSync(p), `referenced path missing: ${p}`).toBe(true);
        }
      });
    });
  }
});

describe("repository guidance", () => {
  test("AGENTS.md exists and CLAUDE.md imports it", () => {
    const agents = join(PLUGIN_ROOT, "AGENTS.md");
    const claude = join(PLUGIN_ROOT, "CLAUDE.md");
    expect(existsSync(agents)).toBe(true);
    expect(existsSync(claude)).toBe(true);
    expect(readFileSync(claude, "utf8").trim()).toBe("@AGENTS.md");
  });
});

describe("manifests — cross-harness packaging and one version", () => {
  const claudePluginJson = JSON.parse(
    readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const claudeMarketplaceJson = JSON.parse(
    readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "marketplace.json"), "utf8"),
  );
  const codexPluginJson = JSON.parse(
    readFileSync(join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const agentsMarketplaceJson = JSON.parse(
    readFileSync(join(PLUGIN_ROOT, ".agents", "plugins", "marketplace.json"), "utf8"),
  );

  function expectPluginManifest(manifest: Record<string, unknown>) {
    expect(manifest.name).toBe("augenta");
    expect(String(manifest.version)).toMatch(SEMVER);
    expect(String(manifest.description ?? "").length).toBeGreaterThan(0);
    expect(manifest.skills).toBe("./skills/");
    const skillsPath = join(PLUGIN_ROOT, String(manifest.skills));
    expect(statSync(skillsPath).isDirectory()).toBe(true);
  }

  test("both plugin manifests are well-formed and their root skills paths resolve", () => {
    expectPluginManifest(claudePluginJson);
    expectPluginManifest(codexPluginJson);
    expect(existsSync(join(PLUGIN_ROOT, ".claude-plugin", "skills"))).toBe(false);
    expect(existsSync(join(PLUGIN_ROOT, ".codex-plugin", "skills"))).toBe(false);
  });

  test("Claude auto-discovers hooks while Codex explicitly declares them", () => {
    expect(claudePluginJson.hooks).toBeUndefined();
    expect(codexPluginJson.hooks).toBe("./hooks/hooks.json");
    expect(existsSync(join(PLUGIN_ROOT, String(codexPluginJson.hooks)))).toBe(true);
  });

  test("all release surfaces agree on ONE version", () => {
    const packageJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8"));
    const versions = new Set([
      claudePluginJson.version,
      claudeMarketplaceJson.metadata?.version,
      claudeMarketplaceJson.plugins?.[0]?.version,
      codexPluginJson.version,
      agentsMarketplaceJson.metadata?.version,
      agentsMarketplaceJson.plugins?.[0]?.version,
      packageJson.version,
    ]);
    expect([...versions]).toEqual([RELEASE_VERSION]);
  });

  test("Claude marketplace lists this plugin at the repo root", () => {
    const entry = claudeMarketplaceJson.plugins?.find((p: { name: string }) => p.name === "augenta");
    expect(entry).toBeDefined();
    expect(entry.source).toBe("./");
  });

  test("agents marketplace lists this plugin as a local source at the repo root", () => {
    // `local` + "./" resolves inside the marketplace snapshot itself, so ONE
    // form works for both a local-path add and a GitHub add (Codex clones the
    // marketplace repo and resolves the path within the clone).
    const entry = agentsMarketplaceJson.plugins?.find((p: { name: string }) => p.name === "augenta");
    expect(entry).toBeDefined();
    expect(entry.source).toEqual({ source: "local", path: "./" });
  });

  test("hooks.json only wires known events to commands that exist", () => {
    const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")).hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string; timeout?: number }> }>
    >;

    // The telemetry surface is exactly these four events.
    expect(new Set(Object.keys(hooks))).toEqual(
      new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]),
    );
    const expectedTimeouts: Record<string, number> = {
      SessionStart: 5,
      UserPromptSubmit: 5,
      PostToolUse: 5,
      Stop: 10,
    };

    for (const [event, groups] of Object.entries(hooks)) {
      expect(KNOWN_HOOK_EVENTS.has(event), `unknown hook event: ${event}`).toBe(true);
      expect(groups).toHaveLength(1);
      for (const group of groups) {
        expect(group.hooks).toHaveLength(1);
        for (const h of group.hooks) {
          expect(h.timeout).toBe(expectedTimeouts[event]);
          expect(h.command).toMatch(/"\$\{CLAUDE_PLUGIN_ROOT\}\//);
          const refs = referencedPaths(h.command);
          expect(refs.length, `hook command references no resolvable file: ${h.command}`)
            .toBeGreaterThan(0);
          for (const p of refs) {
            expect(existsSync(p), `hook command target missing: ${p}`).toBe(true);
          }
        }
      }
    }
  });

  test("README documents the current shell install commands", () => {
    const readme = readFileSync(join(PLUGIN_ROOT, "README.md"), "utf8");
    expect(readme).toContain("claude plugin marketplace add AugentaAI/augenta-plugin");
    expect(readme).toContain("claude plugin install augenta@augenta");
    expect(readme).toContain("codex plugin marketplace add AugentaAI/augenta-plugin --ref main");
    expect(readme).toContain("codex plugin add augenta@augenta");
    expect(readme).toContain("/augenta:init");
    expect(readme).toContain("$augenta:init");
    expect(readme).not.toContain("codex plugin install");
  });
});
