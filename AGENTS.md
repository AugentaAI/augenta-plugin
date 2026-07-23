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
the manifest version, one `init` skill, four hooks, and no load errors.

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

## Releases

Version changes are atomic. Keep the same version in `package.json`, both
plugin manifests, and both marketplace metadata and plugin entries. Update the
versioned marketplace descriptions at the same time.

## Privacy invariants

Augenta remains opt-in per project. Do not change telemetry APIs, payloads,
consent semantics, or capture behavior without an explicit product decision.
The API key stays out of chat and is written only by `scripts/setup.ts` to
`.augenta/config.json`; the setup script is never run by the agent with a user
key. Capture must stay a silent no-op without that config, and
`AUGENTA_CAPTURE_ENABLED=0` remains the global kill switch.
