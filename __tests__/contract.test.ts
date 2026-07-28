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

// The capture plugin ships exactly one connection skill.
const EXPECTED_SKILLS = new Set(["connect"]);

const SEMVER = /^\d+\.\d+\.\d+(?:[-+].*)?$/;
const RELEASE_VERSION = "0.4.0";
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

  test("exactly the expected skills are present", () => {
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
        expect(metadata).toContain('display_name: "Connect Augenta"');
        expect(metadata).toContain('short_description: "Connect this project through a Neurolink"');
        expect(metadata).toContain('default_prompt: "Use $augenta:connect to connect Augenta for this project."');
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

describe("network calls are bounded", () => {
  // The plugin runs inside a hook with a hard timeout, and connect runs in a
  // person's terminal right after they authorized in the browser — before the
  // tokens are persisted. An unbounded fetch there hangs the terminal and throws
  // the login away, and no behavioural test catches it (a hang looks like a slow
  // test). So assert it structurally: every fetch must carry a signal.
  const sources = ["capture/auth.ts", "capture/ship.ts", "scripts/connect.ts"];

  test("every fetch passes an AbortSignal", () => {
    const unbounded: string[] = [];
    for (const rel of sources) {
      const text = readFileSync(join(PLUGIN_ROOT, rel), "utf8");
      // Each `fetch(` call, up to the closing brace of its init object. Crude on
      // purpose — a false positive is a comment away, a false negative is a hang.
      for (const match of text.matchAll(/\bfetch\(/g)) {
        const start = match.index!;
        const call = text.slice(start, start + 600);
        const end = call.indexOf("\n  });") >= 0 ? call.indexOf("\n  });") : call.length;
        if (!/\bsignal\s*:/.test(call.slice(0, end))) {
          const line = text.slice(0, start).split("\n").length;
          unbounded.push(`${rel}:${line}`);
        }
      }
    }
    expect(unbounded).toEqual([]);
  });
});

describe("no inert CodeQL suppression markers", () => {
  // `// codeql[rule-id]` is an LGTM-era marker that GitHub code scanning does
  // NOT honor — an adjacent one was verified firing anyway. Leaving them in
  // reads as "this is handled" when nothing is handling it. Alerts here are
  // adjudicated by dismissal in the Security tab; keep the prose explaining WHY
  // a finding is a false positive, not a marker that implies a mechanism.
  test("source files carry no codeql[...] markers", () => {
    const orphans: string[] = [];
    for (const rel of ["capture/auth.ts", "capture/ship.ts", "scripts/connect.ts"]) {
      const lines = readFileSync(join(PLUGIN_ROOT, rel), "utf8").split("\n");
      lines.forEach((line, index) => {
        // Only a marker STANDING ALONE on its comment line is the suppression
        // form; prose that merely names it (explaining why it does not work) is
        // documentation and must not trip this.
        if (/^\s*\/\/\s*codeql\[[^\]]+\]\s*$/.test(line)) orphans.push(`${rel}:${index + 1}`);
      });
    }
    expect(orphans).toEqual([]);
  });
});

describe("the connect skill drives connect itself", () => {
  // The agent runs the script; the user answers one question and, at most, clicks
  // one link. The old design printed a versioned cache path for the user to paste
  // into a second terminal — long, easy to truncate, and impossible to guess if
  // the model got it wrong. Pin the replacement so it cannot regress into a
  // hand-off.
  const skill = readFileSync(join(SKILLS_DIR, "connect", "SKILL.md"), "utf8");
  const flat = skill.replace(/\s+/g, " ");

  test("drives every JSON verb the CLI exposes", () => {
    for (const verb of ["--json", "--probe", "--login", "--await-login", "--neurospace"]) {
      expect(skill).toContain(verb);
    }
  });

  test("resolves the script from its own environment, with a Codex fallback", () => {
    expect(skill).toContain("CLAUDE_PLUGIN_ROOT");
    expect(skill).toMatch(/plugins\/cache/);
    expect(skill).toMatch(/CODEX_HOME/);
  });

  test("never tells the user to run the connect command themselves", () => {
    // The whole point: no context switch and no "tell me when it finished".
    expect(flat).not.toMatch(/run (this|it) in (your|their) own terminal/i);
    expect(flat).not.toMatch(/wait for the user to say the command completed/i);
  });

  test("surfaces the sign-in link and keeps credentials out of chat", () => {
    expect(skill).toContain("verificationUri");
    expect(flat).toMatch(/Never expose or request tokens/i);
    // --api-key takes a secret as an argv value, so the agent must never run it.
    expect(flat).toMatch(/--api-key.{0,200}?never run it/i);
  });

  test("requires a non-production environment to be stated before connecting", () => {
    // Otherwise a project silently starts feeding dev or staging.
    expect(skill).toContain("environment");
    expect(flat).toMatch(/not `prod`, say so/);
  });

  test("explains the worktree redirect instead of retargeting silently", () => {
    expect(skill).toContain("worktreeRedirect");
  });
});

describe("the identity provider stays behind the scenes", () => {
  // Augenta sign-in runs on WorkOS AuthKit behind auth.augenta.ai. The vendor name
  // means nothing to a user and lands precisely when they are deciding whether to
  // trust this plugin with their transcripts — it reads as data going somewhere
  // they never signed up for. Runtime code names it NOWHERE, in any casing: not in
  // an identifier, not in a stored value, not in an id it keys on. The plugin's
  // user and org identity are Augenta's own `/v1/me` `user.id` and `org.id`; the
  // IdP's separate `org.workosOrgId` is deliberately unused. Comments may explain
  // all of this — that is the only place the name belongs.
  const RUNTIME = [
    "capture/auth.ts",
    "capture/ship.ts",
    "capture/config.ts",
    "capture/capture.ts",
    "scripts/connect.ts",
    "hooks/session-start.ts",
    "hooks/user-prompt.ts",
  ];

  test("no runtime code line outside a comment names the provider, in any casing", () => {
    const offenders: string[] = [];
    for (const rel of RUNTIME) {
      readFileSync(join(PLUGIN_ROOT, rel), "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (/workos/i.test(line)) offenders.push(`${rel}:${index + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test("the connect skill never names it at all", () => {
    // Every word of the skill is user-facing, directly or as agent instructions.
    expect(readFileSync(join(SKILLS_DIR, "connect", "SKILL.md"), "utf8")).not.toContain(
      "WorkOS",
    );
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
    // connect.ts reports its version to the platform as Neurolink metadata, so
    // it is a release surface too — and the only one not expressed as JSON, which
    // is exactly how it drifted a release behind before this assertion existed.
    const connectSource = readFileSync(join(PLUGIN_ROOT, "scripts", "connect.ts"), "utf8");
    const pluginVersion = connectSource.match(
      /^export const PLUGIN_VERSION = "([^"]+)";$/m,
    )?.[1];
    const versions = new Set([
      claudePluginJson.version,
      claudeMarketplaceJson.metadata?.version,
      claudeMarketplaceJson.plugins?.[0]?.version,
      codexPluginJson.version,
      agentsMarketplaceJson.metadata?.version,
      agentsMarketplaceJson.plugins?.[0]?.version,
      packageJson.version,
      pluginVersion,
    ]);
    expect([...versions]).toEqual([RELEASE_VERSION]);
  });

  test("the versioned marketplace descriptions track the release", () => {
    // AGENTS.md → Releases: descriptions carry the version in prose, so they go
    // stale silently unless something pins them to the same bump.
    for (const description of [
      claudeMarketplaceJson.plugins?.[0]?.description,
      agentsMarketplaceJson.plugins?.[0]?.description,
    ]) {
      expect(description).toContain(`v${RELEASE_VERSION}`);
    }
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
    expect(readme).toContain("/augenta:connect");
    expect(readme).toContain("$augenta:connect");
    expect(readme).not.toContain("codex plugin install");
  });
});
