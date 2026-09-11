# Debugging and non-production testing

Contributor notes. Nothing here is user-facing, and `README.md` deliberately does
not link this file: every lever below either points a real project at a
non-production Augenta or rewrites local sign-in state, which is contributor work
and never something to walk a user through.

## Point the plugin at a non-production Augenta

Export the control URL. The shared `controlUrl` resolver in `capture/config.ts`
reads `AUGENTA_CONTROL_URL` on every connect path, so this reaches the interactive
script, every `--json` verb, and the connect skill alike:

```bash
export AUGENTA_CONTROL_URL=<control-url>
```

The control URL for a non-production Augenta is not recorded in this public
repository; get it from the platform team.

The variable selects one environment's **complete** login discovery — issuer,
public client id, and gateway together — by fetching
`<control-url>/.well-known/augenta.json`. `scripts/connect.ts --control-url <url>`
does the same for one invocation and wins over the variable.

Connect records `controlUrl` in `<project>/.augenta/config.json`. Reconnecting
without a flag or variable defaults to that recorded URL. Every URL follows
**CLI flag > environment variable > config.json > default**. The file's
`endpoint` can override the discovered gateway within its recorded environment.
Connect marks an automatically selected endpoint with `discoveredGateway`; if
those values still match, the next connect refreshes the endpoint from discovery.
A hand-edited endpoint differs from the marker and remains an override. Explicit
flag or environment overrides are written without the marker, even when their
value happens to equal discovery.
When the control URL changes, connect uses the new environment's discovered
gateway unless `--endpoint` or `AUGENTA_API_URL` explicitly overrides it. The payload's
`environmentChange` names the old and new environments when the control URL moves.

Do not use `--endpoint` alone to reach another environment. It moves the gateway
only, leaving the issuer and client id on the previous environment, which fails
later as an unexplained 401 rather than at the point of the mistake.

**Recall is not redirected by that variable, and does not need to be.** It never
touches the control plane: it posts to the GATEWAY in the project's own
`.augenta/config.json`, which connect wrote when the project was connected to
that environment. So a project connected against dev asks dev, whatever
`AUGENTA_CONTROL_URL` says. To aim recall somewhere else, either reconnect the
project or set `AUGENTA_API_URL`, which `gatewayBase` reads first. This is also
why `recallEnvironment` in `scripts/recall.ts` consults BOTH coordinates — the
control URL alone would report `prod` about a question going to dev.

**Neither skill has an environment flag, on purpose.** `SKILL.md` stays
environment-agnostic and the variable does the work, for two reasons. A user
connecting a project has no environment to choose, so an agent that knows about
one can offer a decision nobody can answer. And a flag would have to be applied
to *every* verb: `--await-login` compares the pending grant's issuer and client id
against fresh discovery and **clears the grant** on mismatch
(`scripts/connect.ts:1095`), so one verb missing the flag mid-flow throws away a
sign-in the user already authorized in their browser. A process-wide variable
cannot be applied to only some of the verbs.

Disclosure is unaffected. `environmentLabel` takes the resolved control URL,
so every payload's `environment` field becomes the literal URL
instead of `prod`, and `SKILL.md` requires the agent to state a non-prod
environment in both the Workspace question and the confirmation. If a skill run
reports `prod`, check the resolved URL. Session start also names a non-production
connection and its saved destinations, without a network lookup.

## Run the working tree instead of an installed copy

Claude Code loads a local checkout directly, so a skill or hook change is
testable without a version bump or a marketplace install:

```bash
AUGENTA_CONTROL_URL=<control-url> \
  claude --plugin-dir /absolute/path/to/augenta-plugin
```

Codex has no equivalent — `codex plugin` only installs from a marketplace
snapshot. Exercising a *changed* skill or hook under Codex needs a real version
bump across every release surface followed by `codex plugin marketplace add` and
`codex plugin add`. Until then Codex runs whatever is in
`~/.codex/plugins/cache/augenta/augenta/<version>/`, not your checkout. Check
which version each harness actually has before reading a result:

```bash
ls -d ~/.codex/plugins/cache/*/augenta/*/ ~/.claude/plugins/cache/*/augenta/*/
```

A directory there does not prove the plugin is installed — an uninstalled
marketplace leaves its cache behind. `claude plugin list` and `codex plugin list`
are the authority.

## Override the Node runtime used by hooks

Desktop hook processes can see a different PATH than the interactive terminal.
The shipped hook runner probes common Node version-manager locations and requires
Node 20 or newer. To pin one executable while diagnosing a host, set:

```bash
export AUGENTA_NODE=/absolute/path/to/node
```

The override is authoritative: an invalid or unloadable executable fails with a
specific hook error instead of falling through to another installation. It does
not affect `scripts/connect.ts`, which the agent invokes from its own shell.

Without the override, a host where no Node 20+ can be found is quiet on purpose:
the runner reads `cwd` out of the hook payload and reports the missing runtime
only when that project has `.augenta/config.json`, so an unconnected project
never sees an error about a runtime it does not use. To see the message, run a
hook by hand from a connected project with a PATH that has no working Node:

```bash
printf '{"cwd":"%s","hook_event_name":"Stop"}' "$PWD" \
  | env -i HOME="$HOME" PATH= sh "<plugin-root>/scripts/run-node-hook.sh" \
      "<plugin-root>/dist/capture/capture.mjs"
```

## The hosted dev loop

```bash
bun scripts/connect.ts \
  --project /absolute/path/to/test-project \
  --control-url <control-url>

bun scripts/dev-e2e.ts \
  --project /absolute/path/to/test-project \
  --control-url <control-url>
```

`dev-e2e.ts` requires `--control-url`; it has no default, so there is no
environment it can silently reach.

The connect step needs an interactive terminal: the Workspace choice goes through
`chooseMany`, which refuses a non-TTY rather than print a menu nobody can answer.
It is a comma-separated multi-select (`1,3`) over every Workspace, with the
project's current destinations marked `[x]`, and it always asks — there is no
auto-select even for a single Workspace. The menu also offers `Create a new
Workspace`; after creation it refreshes and asks for the complete destination set
again. **An empty answer is rejected**, so the dev loop must type at least one
Workspace number. This is the positive human OAuth gate described in `AGENTS.md`;
GitHub Actions verifies the platform-key path instead and must never receive a
human access or refresh token.

Once connected, the project's `.augenta/config.json` carries the dev gateway as
`endpoint` alongside `controlUrl`, so hooks ship to dev and reconnect discovers
dev with no variable set at runtime. Both are recorded in the config.

## Local state, and how to reset it

| Path | Written by | Reset effect |
| --- | --- | --- |
| `~/.augenta/auth.json` | completed sign-in | removes every stored profile; all connected projects need a fresh sign-in |
| `~/.augenta/pending-login.json` | `--login` | abandons an in-flight grant |
| `~/.augenta/state/connect-prompted.json` | SessionStart | the one-time connect offer fires again for that project |
| `<project>/.augenta/config.json` | connect | disconnects the project from all destinations; capture returns to a silent no-op |

A stale `pending-login.json` from another environment is self-healing: the next
`--await-login` recognizes the foreign issuer, clears it, and asks for a fresh
`--login`. Deleting it is only a shortcut.

Two different variables relocate the two global roots, and an isolated sandbox
needs **both**:

- `AUGENTA_AUTH_HOME` → `auth.json`, `auth.lock`, `pending-login.json`
  (`capture/auth.ts:79`)
- `AUGENTA_HOME` → `state/connect-prompted.json` (`hooks/session-start.ts:109`)

Setting only one leaves half your state in the real `~/.augenta`, which reads as
a bug in whichever half you were not watching.

## Other runtime overrides

`AUGENTA_CONTROL_URL`/`controlUrl` selects discovery,
`AUGENTA_API_URL`/`endpoint` overrides the gateway base, and
`AUGENTA_INGEST_URL`/`ingestUrl` redirects the experiences endpoint. Environment
variables win over file values; explicit CLI flags win over both. Connect keeps
a hand-set `ingestUrl` on reconnect. None opts a project into capture — capture still
requires `.augenta/config.json`. `AUGENTA_CAPTURE_ENABLED=0` is the global kill
switch.

## Known non-production wrinkle

Prod's issuer is Augenta's own `auth.augenta.ai`, which is what keeps the identity
provider out of every user-facing string. A dev deployment whose issuer is still a
raw vendor hostname discloses that provider in the sign-in URL itself, and the
agent has to print that URL. That is a dev topology gap, not a plugin regression:
do not read a dev transcript as evidence the invariant is broken, and do not
"fix" it in the plugin. The fix is a custom domain on the non-production issuer.

## Before opening a PR

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun test
git diff --check
claude plugin validate . --strict
claude --plugin-dir . plugin details augenta
```

`bun run build` comes first for a reason: `hooks/hooks.json` runs the bundles in
`dist/`, not your edited sources, so **`claude --plugin-dir .` below executes
whatever you last built.** Skip the build after changing a hook and you will watch
the old behavior and conclude your change did nothing.

If `bun run build` refuses to run, it is one of the two build inputs behind CI's
byte-comparison of `dist/`, and the message names which:

- **Wrong Bun.** `dist/` is built on the version in `.bun-version`, because Bun's
  bundler codegen differs between releases. Install that exact version —
  `curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat .bun-version)"`;
  plain `bun upgrade` goes to latest and will not pin.
- **Dependencies resolved from outside this checkout.** Run
  `bun install --frozen-lockfile` **in this directory**. This is the common one
  in a git worktree, which starts without `node_modules` and will otherwise
  quietly use the parent checkout's.

Neither is platform-related: a Mac and CI's linux runner produce identical
bundles on one Bun, so there is no container step to reproduce a CI `dist/`
failure locally.

`AUGENTA_ALLOW_BUN_MISMATCH=1` skips the version check for a one-off experiment
— bisecting a bundler regression, or seeing what a newer Bun emits. It does not
skip the dependency check, and its output must never be committed: CI rebuilds on
the pinned Bun and will reject it. To actually move the pin, edit `.bun-version`
and commit the rebuilt `dist/` in the same change instead.

`plugin details` must report the manifest version, both skills (`connect` and
`recall`), every event in `hooks/hooks.json`, and no load errors. It cannot catch an over-declared
hook timeout — only a real Codex install can. See `AGENTS.md`.

## Capture health and native-turn acceptance

Use the installed version's connect bundle for a local, read-only diagnostic:

```bash
node <plugin-root>/dist/scripts/connect.mjs --project <project-root> --json --health
```

This command makes no network request and prints no credentials, transcript
contents or Connector IDs. The CLI prints `projectRoot`, the directory whose
configuration and activity it inspected. It uses the same nearest-config lookup
as capture and never substitutes the main checkout for a worktree. `configuration`
distinguishes missing, invalid and valid configuration. `configured` means the config parsed;
`dispatch` means a Node hook entrypoint ran; `capture` records the latest local
capture result; `pendingBytes` is the current queue depth; `delivery` records API
acceptance/retry/rejection. Success counters count observed successful capture
passes and accepted HTTP requests, not unique turns or lifetime deliveries.
`lastSuccessAt` survives a later failure and spool compaction. Ingestion into the
lake remains `unverified`: accepting an HTTP request is a different boundary.
The counters are local best-effort diagnostics, not a billing ledger. Their
`activityScope` is `project`: concurrent sessions and manual invocations share
them. `hostDispatch` stays `unverified`; a dispatch counter cannot prove which
host or invocation caused it.

For a verified mislabeled project, repair only its current active agent links:

```bash
node <plugin-root>/dist/scripts/connect.mjs --json --repair-harness --harness codex
```

Use `claude-code` for a verified Claude Code project. The explicit value is
required; the command uses the saved profile and endpoint, ignoring ambient URL
overrides, and checks each link's recorded Workspace and revision before PATCH.
It never reconnects, changes routes, rewrites config, or resets `captureSince`.
Partial failure returns an error with separate `repaired` and `failed` lists;
successful repairs remain applied. A missing or obsolete config must be connected
through the normal consent flow first. For new connections, pass `--harness`
explicitly; absent or conflicting process signals leave harness metadata unset
on creation and preserve existing metadata on adoption.

If there is no dispatch, inspect the host's hook approval and plugin activation
UI first, then its runtime launcher errors. This plugin cannot infer approval
from a manifest or change a host's trust state. A missing transcript after
dispatch is reported as `missing_transcript`; a queue with retries points to the
delivery boundary. Malformed stdin before a project can be identified cannot
produce project health. The launcher still emits its bounded Node diagnostic
for connected projects when Node cannot start. Deleting capture/turn cursors is
not a recovery procedure: it can replay history and reset sequence identity.

The installed host regression uses a disposable home, a real marketplace
installation and real Codex lifecycle dispatch, with a deterministic local model
endpoint and a local ingestion receiver:

```bash
bun scripts/codex-lifecycle-e2e.ts /absolute/path/to/codex
bun scripts/codex-lifecycle-e2e.ts /absolute/path/to/codex --worktree
```

It exercises connection after an existing task, a fresh connected task, a tool
call followed by a text-only turn, final assistant persistence, process restart,
offline retry, disabled capture and accepted-step deduplication. Tool failures
from a nested sandbox still exercise the tool lifecycle. No capture or shipper
function is called manually. The worktree variant uses a real external Git
worktree, a separately connected main checkout, and the installed connect command
without a `--project` override. The invocation-only hook-trust flag is used solely
for these vetted repository hooks in the disposable profile. It does **not**
prove a user's approval flow. It never edits an installed cache or trust record.

Measured 2026-09-11 with Node 20+ bundles built by the pinned Bun:

| Host | Installed lifecycle fixture | Active desktop approval/activation | Hosted ingestion |
| --- | --- | --- | --- |
| Shell Codex CLI 0.144.4 | Passed ordinary-project and external-worktree regressions | Not applicable | Not tested |
| Desktop-embedded Codex 0.153.4, launched as CLI | Passed external-worktree regression | Not tested | Not tested |
| Active desktop session using the embedded runtime | Not established | Unresolved | Not tested |

Read-only process inspection confirmed the embedded executable differs from the
shell CLI. Local native rollout schemas include `turn_id` on `task_started`,
`turn_context` and `task_complete`. The start marker's `started_at` is Unix seconds;
its envelope `timestamp` preserves the subsecond consent boundary. Fixtures use
synthetic text and identifiers in those observed shapes.

**Release acceptance remains open:** the worktree configuration mismatch is
fixed and covered by the installed lifecycle regression, but active Desktop
approval/activation has not been verified. An independently launched embedded
executable or a successful direct bundle test cannot close that gap. Complete two short
turns in the actual desktop after supported approval/activation, correlate hook
execution with local health and destination ingestion, and repeat both fresh and
mid-task connection before claiming the desktop defect fixed. Do not broaden
capture scope, bulk-replay history, edit trust files, or modify a marketplace
cache to make that acceptance pass. Historical recovery needs a separately
explicit transcript/time range and destination selection; this change adds no
bulk recovery command.
