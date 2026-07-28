# Augenta contributor guide

## Commands

Use Bun for all repository work:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
git diff --check
```

Run `claude plugin validate . --strict` for the Claude package. The bundled
Codex plugin-creator validator currently rejects Codex's supported `hooks`
manifest field, so the Codex release gate is a real marketplace installation
with `codex plugin marketplace add` followed by `codex plugin add`.
Also run `claude --plugin-dir . plugin details augenta` and verify it reports
the manifest version, one `connect` skill, every event in `hooks/hooks.json`
(currently eight), and no load errors.

Codex trust-pins each hook by content hash in `~/.codex/config.toml`
(`[hooks.state]`), so **any** edit to `hooks/hooks.json` re-prompts every Codex
user for trust. Batch hook changes into a single deliberate release; never ship
them incrementally.

For a hosted dev release, follow the platform repository's
`docs/deployment-runbook.md`. Connect a disposable project with:

```bash
bun scripts/connect.ts \
  --project /absolute/path/to/test-project \
  --control-url https://dev.augenta.ai
bun scripts/dev-e2e.ts \
  --project /absolute/path/to/test-project \
  --control-url https://dev.augenta.ai
```

This is the positive human OAuth gate. GitHub Actions intentionally verifies
the platform-key path and must never receive a human WorkOS access or refresh
token. `--endpoint` overrides only the gateway; use `--control-url` when
selecting a non-production issuer/client/gateway set.

`DEBUG.md` carries the rest of the contributor levers: pointing a harness at a
non-production Augenta with `AUGENTA_CONTROL_URL`, running the working tree
instead of an installed copy, and resetting local sign-in state. It is contributor
documentation and stays unlinked from `README.md` — the connect skill itself has
no environment flag, and the reasoning for that is recorded there.

## Cross-harness packaging

This repository is one plugin for Claude Code and Codex. Keep runtime skills in
`skills/` and hooks in `hooks/` at the plugin root; do not duplicate either
under `.claude-plugin/` or `.codex-plugin/`. Claude auto-discovers
`hooks/hooks.json`, so `.claude-plugin/plugin.json` must not declare `hooks`.
Codex requires the explicit `hooks` declaration in `.codex-plugin/plugin.json`.

Keep `CLAUDE_PLUGIN_ROOT` quoted in hook commands and express hook timeouts in
seconds. Any harness-specific instructional wording must remain portable:
describe the current harness's native user-input mechanism and never add
Codex-only tools to Claude `allowed-tools`.

A declared hook timeout must be the **minimum** the two harnesses allow, because
one manifest serves both. Codex enforces a per-event **maximum** and caps
shutdown-path hooks at 3s — over-declaring does not fail the load, it clamps the
value and shows `1 issue loading hooks for this source` in the Codex plugin panel
for good. Claude accepts the larger number, so `claude plugin validate` and
`plugin details` cannot catch this; only a real Codex install can. `SessionEnd`
is the event this bites (hence its 3s budget, and why it skips the memory scan
that `Stop` and `SessionStart` already cover).

`CLAUDE_PLUGIN_ROOT` belongs in `hooks/hooks.json` and nowhere else. It is
exported only to processes the plugin system spawns — hooks and MCP servers —
not to the shell behind an agent's Bash tool, where it is empty and expands to a
broken `/scripts/...`. A skill that shells out to a plugin script must derive the
path from the absolute skill directory the harness gives the model (Claude Code
prepends `Base directory for this skill:`; Codex resolves the skill-root alias),
which also pins the script to the version of the skill being followed.

## Releases

Version changes are atomic. Keep the same version in `package.json`, both
plugin manifests, and both marketplace metadata and plugin entries. Update the
versioned marketplace descriptions at the same time.

## Privacy invariants

Augenta remains opt-in per project. Do not change telemetry APIs, payloads,
consent semantics, or capture behavior without an explicit product decision.
OAuth tokens stay in the owner-only global `~/.augenta/auth.json`; a connected
project stores only a profile reference and Neurolink id. Capture must stay a
silent no-op without project config, and `AUGENTA_CAPTURE_ENABLED=0` remains the
global kill switch.

**No credential passes through the agent.** The line is what a process *handles*,
not who starts it. The agent is the normal caller of `scripts/connect.ts --json`
(`--probe`, `--login`, `--await-login`, `--neurospace`): those verbs never accept
a credential as an argument and never emit an access token, refresh token, or
device code in their payload, so tokens travel browser → `~/.augenta/auth.json`
without touching a transcript. Do not add a `--json` verb or field that breaks
that. Platform keys are different — `--api-key` takes a secret on the command
line, so it stays a human/CI path, is rejected in `--json` mode, and is never run
by the agent. Never ask a user to paste any credential into chat.

**Consent stays explicit and in the user's hands.** Which Neurospace a project
feeds is the user's decision, asked every time even when only one exists. Moving
that question from a terminal menu into the harness's user-input mechanism is
fine; removing or defaulting it is not. A non-production `environment` must be
stated to the user before they answer.

**The identity provider appears nowhere in the plugin.** Augenta sign-in runs on
WorkOS AuthKit behind `auth.augenta.ai`, and that fact lives only in comments. The
project config's `authMode` is `oauth`; a stored profile holds `userId`/`orgId`,
taken from Augenta's own `/v1/me` `user.id` and `org.id`. The IdP's separate
`org.workosOrgId` is deliberately unused — identity keys on Augenta's ids, not the
provider's. A contract test fails on any casing of the vendor name in runtime code
outside a comment; keep it that way.

**Stale configs are reconnected, never migrated.** Pre-release versions are not
carried forward. A config this version cannot parse becomes session-start's
one-time reconnect prompt, which is a clear ask; reusing an old credential or
routing decision would instead surface later as an unexplained 401.
