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
project stores only a profile reference and its Neurolink ids. Capture must stay a
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

**Consent stays explicit and in the user's hands.** Which Neurospaces a project
feeds is the user's decision, asked every time, and the answer is always the
**complete set of destinations** — never defaulted, never inferred, never carried
forward from a previous run. It is asked when the organization has exactly one
Neurospace (the user still affirms it) and when the project is already connected
(the current set is shown pre-selected and must be re-affirmed). Moving that
question from a terminal menu into the harness's user-input mechanism is fine;
removing it, defaulting it, or offering a "keep current" shortcut is not. One
answer never authorizes more than one destination, and silence never authorizes
any. `chooseMany` in `scripts/connect.ts` is deliberately a separate function from
`choose` with no auto-select knob to flip.

**More than one destination is a stronger disclosure, not the same one repeated.**
Before the user answers, and again when confirming, they are told that every
selected Neurospace receives the **full record** — the same activity, raw
transcript lines, and memory documents, complete, in each — so the effective
audience is the **union** of everyone with access to any of them. When more than
one is selected, the confirmation also restates that raw transcript records are
structurally sanitized but not secret-scrubbed. Destinations dropped from the set
are **named** in the confirmation; they are removed from the project config, which
stops shipping to them immediately, and their Neurolinks are **left in place and
idle** rather than disabled or deleted — the plugin makes no org-level destructive
change on the strength of a menu answer, and a local removal cannot half-fail the
way a network mutation can.

**The written destination set is always a subset of the set the user just
confirmed.** A destination that fails to link is reported and omitted; nothing is
ever written that the user did not just affirm, so a partial failure is a safe
outcome rather than an ambiguous one. The corollary is that writing NOTHING leaves
the previous set on disk and still shipping, so no confirmation may claim a
destination was dropped unless a config was actually written — and selecting
nothing for an already-connected project changes nothing rather than disconnecting
it. Deleting `.augenta/config.json` remains the only off switch. Reconnecting never moves an existing
Neurolink to a different Neurospace — a destination gets its own link, created
once and adopted thereafter, so history already attached to a link keeps its
route. A non-production `environment` must be stated to the user before they
answer.

**The platform-key path stays single-destination.** `--api-key` has no consent
gate, and the config format it writes has no place to express a route — the key's
server-side assignment *is* the routing decision, and the shipper sends no
Neurolink header in that mode. `verifyApiKeyConnection` therefore continues to
refuse a key assigned to more than one Neurolink. Fan-out exists because a human
affirmed a set; nothing here affirms one.

**One wedged destination must not cost the others.** Spool reclamation is gated on
the slowest destination, so a permanently broken Neurolink — a 403 is transient and
retries forever — would fill `MAX_SPOOL_BYTES` and start dropping records for every
destination. `Outbox.enforceLag` bounds that by fast-forwarding a destination that
falls more than `MAX_DEST_LAG_BYTES` behind the furthest one.

That discard is a data-retention decision, not a tuning knob, and three guards
have to stay in place. It fires only when another destination made progress in the
same drain, so an offline stretch — which leaves everyone behind at once — can
never trip it. It fires only after `LAG_STRIKES` **consecutive** such drains, so a
single timed-out POST on the first reconnect after a week offline cannot delete a
week of records; any successful ship resets the count, and every cursor write must
carry the count forward or the hysteresis silently never accumulates. And it is
reported through `Outbox.markDiscarded`, deliberately NOT `markAuthNotice`: those
notices are consumed together with only the most urgent reported, so a concurrent
401 would swallow it, and their "queued records will resume shipping" wording is
the opposite of the truth for records that were deleted. Lag is measured against
the furthest destination rather than the nearest so that two simultaneously wedged
destinations cannot shield each other while the spool fills anyway.

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

Widening a field's shape without changing its meaning is not migration. A 0.5.x
config's scalar `neurolinkId` parses as the one-element `neurolinkIds` set: the
same link id keeps meaning exactly what it meant, no credential or routing
decision is re-derived, and rejecting it would hand a silent capture outage plus a
single reconnect prompt to every already-connected project for a change they did
not ask for. What is still never carried forward is a config whose *meaning*
changed (the pre-0.4.0 `authMode: "workos"` spelling, the pre-0.3.0 `{apiKey}`
file) or that cannot be read at all. The write path emits only the plural form.
