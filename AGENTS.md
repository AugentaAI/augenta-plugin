# Augenta contributor guide

## Commands

Use Bun for all repository work:

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun test
git diff --check
```

`bun install` is first because dependency resolution is a build input, not just
setup — see the runtime-boundary section below. `bun run build` refuses to run on
an unpinned Bun or a checkout resolving dependencies from elsewhere, so a failed
build there is telling you which of the two to fix.

Run `claude plugin validate . --strict` for the Claude package. The bundled
Codex plugin-creator validator currently rejects Codex's supported `hooks`
manifest field, so the Codex release gate is a real marketplace installation
with `codex plugin marketplace add` followed by `codex plugin add`.
Also run `claude --plugin-dir . plugin details augenta` and verify it reports
the manifest version, both skills (`connect` and `recall`), every event in
`hooks/hooks.json` (currently eight), and no load errors.

Codex trust-pins each hook by content hash in `~/.codex/config.toml`
(`[hooks.state]`), so **any** edit to `hooks/hooks.json` re-prompts every Codex
user for trust. Batch hook changes into a single deliberate release; never ship
them incrementally.

For a hosted dev release, follow the platform team's deployment runbook. Connect
a disposable project with:

```bash
bun scripts/connect.ts \
  --project /absolute/path/to/test-project \
  --control-url <control-url>
bun scripts/dev-e2e.ts \
  --project /absolute/path/to/test-project \
  --control-url <control-url>
```

This is the positive human OAuth gate. GitHub Actions intentionally verifies
the platform-key path and must never receive a human WorkOS access or refresh
token. `--endpoint` overrides only the gateway; use `--control-url` when
selecting a non-production issuer/client/gateway set.

`DEBUG.md` carries the rest of the contributor levers: pointing a harness at a
non-production Augenta with `AUGENTA_CONTROL_URL`, running the working tree
instead of an installed copy, and resetting local sign-in state. It is contributor
documentation and stays unlinked from `README.md` — neither skill has an
environment flag, and the reasoning for that is recorded there.

## The runtime boundary: Bun builds, Node ships

**Users need Node and nothing else.** Bun is a build-time tool here, in the same
role as a compiler — tests, typecheck, and bundling. Nothing that reaches a user
may depend on it.

What ships is `dist/`: six Node ESM bundles built from the six entrypoints by
`scripts/build.ts`. `hooks/hooks.json` and the two SKILL.md files invoke those
bundles, never the `.ts` sources, which are not directly Node-runnable anyway
(`moduleResolution: "bundler"` means extensionless relative imports). `dist/` is
committed because both marketplaces install a git checkout and run no build step,
so **the bundles are the shipped artifact** — run `bun run build` and commit the
result whenever a shipped source changes. CI fails a PR whose `dist/` has drifted.

**The build is byte-reproducible, and that is enforced rather than hoped for.**
CI compares a fresh build against the committed bundles, so anything that changes
the bundler's output is a build input. Two of them do:

- **The Bun version**, pinned in `.bun-version`. Bun's bundler codegen changes
  between releases — 1.3.14 emits the `__toESMCache_*` ESM-interop prelude, 1.3.5
  the older `get: () => mod[key]` form, 1.4.1 something else again — so one
  version off rewrites every bundle. `scripts/build.ts` reads the same file
  CI does and refuses to build on any other Bun, naming the version and how to
  install it. Do not re-type the number into a workflow; a contract test fails
  that. To move the pin, edit `.bun-version` and commit the rebuilt `dist/` with
  it.
- **Where `node_modules` resolved from.** Bun labels every bundled module with
  its path relative to the build root, so a checkout that resolves a dependency
  from an ancestor directory bakes `../../../node_modules/…` into the bytes. A
  git worktree is the easy way in: `.claude/worktrees/` is gitignored, so a
  worktree starts with no `node_modules`, and one created before a dependency was
  added keeps resolving it from the parent checkout. `bun run build` refuses
  this too and tells you to `bun install --frozen-lockfile` in that directory.

**What is not a build input is the platform.** Measured 2026-09-04 at 1.3.14:
darwin-arm64 and CI's linux-x64 emit byte-identical bundles. A macOS contributor
needs the pinned Bun and a local `bun install`, not a container.

The asymmetry to keep in mind: contributors exercise *sources under Bun* while
users exercise *bundles under Node*, so a Bun-only API can enter runtime code and
fail only in the field. Three gates close that, and none is optional — the
contract test scans `dist/**` for `Bun.` and `import.meta.dir`/`main`,
`__tests__/dist-smoke.test.ts` executes every bundle under real `node`, and CI's
`install-smoke` fires a hook under Node from an actual marketplace install.

**A committed `dist/` multiplies every CodeQL alert.** This repo uses CodeQL
default setup, which takes no config file, so `dist/` cannot be excluded from
scanning and inline `// codeql[...]` markers do not suppress code-scanning alerts
(see the note at `capture/auth.ts:463`). Each bundle inlines its whole import
graph, so one flagged source line becomes one alert per bundle that contains it —
each needing its own dismissal, and **re-minted whenever line numbers shift**,
because a dismissal is bound to a location. Expect this when a change moves
flagged code, and dismiss the generated copies as duplicates of the source
finding rather than chasing them. Converting to CodeQL advanced setup with
`paths-ignore: dist/**` would end it permanently.

**No entrypoint may import another entrypoint.** Bundling inlines the imported
file's `isMain` block into the importer's bundle, where — one module remaining
after bundling — the guard is TRUE and the wrong hook body runs first. This
shipped once in a prototype: `hooks/session-start.ts` imported `spawnShipper`
from `capture/capture.ts`, and the built SessionStart hook silently consumed
stdin and exited before ever emitting the connect prompt, killing onboarding with
exit 0 and no output. Shared code goes in a non-entrypoint module —
`capture/shipper.ts` exists for exactly this — and a contract test enforces it.

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

Hook commands go through `scripts/run-node-hook.sh`. Desktop harnesses can expose
a smaller PATH than an interactive terminal, and a package-manager `node` can be
present but unloadable. The runner accepts an explicit `AUGENTA_NODE`, checks
common version-manager installs, and only then scans PATH; every candidate must
actually start and report Node 20+. Keep the hook bundles themselves Node-only.

Two things about that runner are invariants, not implementation. Every probe
takes `</dev/null`: stdin is the hook PAYLOAD, and something on PATH named `node`
that is not Node would consume it and leave the bundle an empty stream — the
silent-then-exit-0 failure recorded above. And when no runtime is found it reads
the payload's `cwd`, staying **silent for a project with no `.augenta/config.json`**
and complaining only for a connected one: a missing Node is not evidence anyone
opted in, and hooks are a silent no-op without project config. That tail uses
shell builtins only, because the PATH it would otherwise depend on is the thing
under suspicion.

## Releases

Version changes are atomic, across **eight** values in six files, and the
contract test pins every one of them to a single value:

- `package.json` — `version`
- `.claude-plugin/plugin.json` — `version`
- `.codex-plugin/plugin.json` — `version`
- `.claude-plugin/marketplace.json` — `metadata.version` AND `plugins[0].version`
- `.agents/plugins/marketplace.json` — `metadata.version` AND `plugins[0].version`
- `runtime/version.ts` — `PLUGIN_VERSION`, the ONE version written in TypeScript

Update the versioned marketplace descriptions at the same time, and bump
`RELEASE_VERSION` in `__tests__/contract.test.ts` to match.

**Never write a version literal anywhere else.** Both things that report a
version — the Connector metadata `scripts/connect.ts` sends and the
OpenTelemetry attribution `capture/ship.ts` sends — import `PLUGIN_VERSION`.
The shipper's used to be its own hardcoded string and it silently drifted a
release behind; a gate now fails on any quoted semver in `capture/`, `hooks/`,
`runtime/` or `scripts/` outside `runtime/version.ts`.

The `CHANGELOG.md` entry is part of the same atomic change, not a follow-up. It
is the only account of a release a user can read — the marketplaces install from
`main` and show no notes — so a version that lands without one ships a break
nobody can look up. Write it in the user's terms: what changed for a connected
project, and whether reconnecting is required.

**Do not cite private-repo issues or PRs in commit messages or PR
descriptions.** This repository is public and its commit log is part of what
users read; a bare `#123` against a repository nobody can open is noise at best
and a disclosure of internal planning at worst. Describe the platform-side
change in words instead — "pairs with the platform change that pages
`GET /v1/workspaces`" says everything the number was carrying.

## Privacy invariants

Augenta remains opt-in per project. Do not change telemetry APIs, payloads,
consent semantics, or capture behavior without an explicit product decision.
OAuth tokens stay in the owner-only global `~/.augenta/auth.json`; a connected
project stores only a profile reference and its Connector ids. Capture must stay a
silent no-op without project config, and `AUGENTA_CAPTURE_ENABLED=0` remains the
global kill switch.

**Recall is a READ, and its invariants are its own.** `scripts/recall.ts` is the
only outbound path that is not capture, so the rules above do not all transfer
and the differences are deliberate:

- **Only the question text leaves.** The request body is the query and — for a
  signed-in project — the Workspace id, and nothing else. No transcript line, no
  file content, no memory document. Adding a field to that body is a change to
  what a user's machine discloses, not a feature.
- **It is NOT gated on `AUGENTA_CAPTURE_ENABLED`,** on purpose. That switch stops
  a project SENDING; someone who turned it off may still legitimately ask what
  was already remembered, and gating a read on it would make one off switch
  silently mean two things. What governs recall is the same thing that governs
  everything else: a readable `.augenta/config.json`. Deleting it remains the one
  off switch for both, and README says so in those words.
- **It needs no consent gate because it creates no new disclosure.** Recall asks
  only the destinations the user already selected — `connectorIds`, resolved to
  their Workspaces — and `--workspace` may only NARROW that set. A destination
  the project does not feed is refused (`unknown_workspace`), never asked. If a
  future change would let recall reach a Workspace the project does not send to,
  that is a new consent question and belongs in front of the user first.
- **The client never names an organization.** It sends `workspace`; the platform
  composes the retrieval `scope` from the authenticated identity. Do not add a
  `scope` field — the door refuses one, and the refusal is the tenant-isolation
  boundary rather than a validation detail.
- **No credential in the payload**, exactly as for connect: the agent is the
  normal caller of `--json`, so everything it can read must be safe to paste into
  a transcript. The platform key travels in the request from the project config
  and appears in no output.
- **A young Workspace is not an error.** `empty_scope` means "nothing remembered
  yet"; reporting it as a failure sends a user to look for a fault that is not
  there, and invites a reconnect that would change nothing.

**No credential passes through the agent.** The line is what a process *handles*,
not who starts it. The agent is the normal caller of `scripts/connect.ts --json`
(`--probe`, `--login`, `--await-login`, `--create-workspace`, `--workspace`):
those verbs never accept a credential as an argument
and never emit an access token, refresh token, or device code in their payload,
so tokens travel browser → `~/.augenta/auth.json` without touching a transcript.
Do not add a `--json` verb or field that breaks that. Platform keys are different
— `--api-key` takes a secret on the command line, so it stays a human/CI path, is
rejected in `--json` mode, and is never run by the agent. Never ask a user to
paste any credential into chat.

**Consent stays explicit and in the user's hands.** Which Workspaces a project
feeds is the user's decision, asked every time, and the answer is always a
**non-empty, complete set of destinations** — never defaulted, never inferred,
never carried forward from a previous run. Every member is provisioned their
own `Default Workspace`, but availability is not consent: the question is still
asked when that is the only Workspace and when the project is already connected
(the current set is shown pre-selected and must be re-affirmed). Moving that
question from a terminal menu into the harness's user-input mechanism is fine;
removing it, auto-selecting a destination, offering a "keep current" shortcut, or
accepting `none` is not. One answer never authorizes more than one destination,
and silence never authorizes any. A user can cancel the flow without connecting;
`chooseMany` in `scripts/connect.ts` is deliberately a separate function from
`choose` with no auto-select knob to flip.

**A valid selection is the consent; a second yes/no is not asked.** This holds
for the destination set as well as for creation — a user who just answered the
question with numbers has consented, and re-confirming the same answer trains
people to click through it. What the removed echo-back guarded still has to
hold: the skill passes exactly the entries the user picked, one `--workspace`
per selection, ids and never names, and adds nothing the user did not select.
The rendered menu the answer refers to is what makes that checkable, so the
menu is always shown before the question — never a set the model summarized.

**Workspace creation is an explicit, separate mutation.** Offer `Create a new
Workspace` alongside the live destination list. It must be chosen by itself, its
non-empty name is asked for in the named organization, and the refreshed
non-empty destination question is asked afterward. Choosing creation and giving
the name is the request: do not add a redundant yes/no confirmation before
`POST /v1/workspaces`. Creating a Workspace never connects the project or treats
the new Workspace as selected — it is not pre-marked in the refreshed terminal
menu, where `[x]` means only "this project already feeds it". `--create-workspace`
and `--workspace` are separate calls and are refused together.

**More than one destination is a stronger disclosure, not the same one repeated.**
Before the user answers, and again when confirming, they are told that every
selected Workspace receives the **full record** — the same activity, raw
transcript lines, and memory documents, complete, in each — so the effective
audience is the **union** of everyone with access to any of them. When more than
one is selected, the confirmation also restates that raw transcript records are
structurally sanitized but not secret-scrubbed. Destinations dropped from the set
are **named** in the confirmation; they are removed from the project config, which
stops shipping to them immediately, and their Connectors are **left in place and
idle** rather than disabled or deleted — the plugin makes no org-level destructive
change on the strength of a menu answer, and a local removal cannot half-fail the
way a network mutation can.

**The written destination set is always a subset of the set the user just
confirmed.** A destination that fails to link is reported and omitted; nothing is
ever written that the user did not just affirm, so a partial failure is a safe
outcome rather than an ambiguous one. Writing NOTHING leaves the previous set on
disk and still shipping, so no confirmation may claim a destination was dropped
unless a config was actually written. Empty destination sets are rejected;
canceling an already-connected flow changes nothing. Deleting
`.augenta/config.json` remains the only off switch. Reconnecting never moves an
existing Connector to a different Workspace — a destination gets its own link,
created once and adopted thereafter, so history already attached to a link keeps
its route. A non-production `environment` must be stated to the user before they
answer.

**The platform-key path stays single-destination.** `--api-key` has no consent
gate, and the config format it writes has no place to express a route — the key's
server-side assignment *is* the routing decision, and the shipper sends no
Connector header in that mode. `verifyApiKeyConnection` therefore continues to
refuse a key assigned to more than one Connector. Fan-out exists because a human
affirmed a set; nothing here affirms one.

**One wedged destination must not cost the others.** Spool reclamation is gated on
the slowest destination, so a permanently broken Connector — a 403 is transient and
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

`connectorIds` is the **only** routing key read, and only as an array. A scalar
is not read forward, and neither is any other spelling: 0.7.0 renamed the
routing surface end to end, so an id written against the old surface is a guess,
not a migration. A config keyed the old way is simply unparseable and becomes
the reconnect prompt — as does a config whose *meaning* changed (the pre-0.4.0
`authMode: "workos"` spelling, the pre-0.3.0 `{apiKey}` file) or that cannot be
read at all. The write path emits only the plural form.
