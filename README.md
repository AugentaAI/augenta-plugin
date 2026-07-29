# Augenta

Your coding agents learn useful things every day: how your systems fit together,
which approaches failed, why a decision was made, and what finally worked. Most
of that context disappears when the session ends.

Augenta turns that work into durable, shared context. This plugin captures the
agent activity from projects you choose and sends it to your Augenta Neurospace,
giving Augenta the source material it needs to build memory from how your team
actually works. It also preserves the high-signal project memory your agents
have already written, so useful context does not have to be reconstructed from
activity alone.

## Why use it?

- **Keep the context behind the code.** Preserve the prompts, tool calls,
  decisions, and outcomes that explain how work got done—not just the final
  diff.
- **Build memory from real work.** Give Augenta a continuous record of agent
  activity instead of relying on someone to document every discovery by hand.
- **Share learning across your Neurospaces.** Turn isolated agent sessions into
  useful organizational context for the people and agents working alongside
  them. A project can feed one Neurospace or several.
- **Capture without changing your workflow.** Once a project is connected,
  Augenta runs quietly in the background and tolerates temporary network
  failures without interrupting the agent.
- **Choose exactly where capture happens.** Projects are opted in individually.
  Unconnected projects are silent no-ops, and a global kill switch is always
  available.

Augenta currently works with Claude Code and OpenAI Codex. Both integrations
provide the same core experience: install the plugin once, opt in the projects
that matter, and let Augenta capture agent activity and matching project memory
in the background.

## Install

**Prerequisite:** [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`) —
the hooks and scripts run on it.

### Claude Code

Run these commands in your terminal:

```bash
claude plugin marketplace add AugentaAI/augenta-plugin
claude plugin install augenta@augenta
```

Or, from inside an interactive Claude Code session:

```text
/plugin marketplace add AugentaAI/augenta-plugin
/plugin install augenta@augenta
```

Restart Claude Code or start a new task, open a project you want Augenta to
learn from, and run `/augenta:connect`.

### OpenAI Codex

Run these commands in your terminal:

```bash
codex plugin marketplace add AugentaAI/augenta-plugin --ref main
codex plugin add augenta@augenta
```

On first launch, run `/hooks` and trust Augenta's hooks. Codex asks again after
plugin updates; capture remains off until the hooks are trusted. Then open a
project you want Augenta to learn from and run `$augenta:connect` or ask
**"Connect Augenta."**

The corresponding desktop apps share plugin configuration with their CLI. Once
the marketplace has been added, you can enable Augenta from the plugin browser
in Claude's Code tab or ChatGPT's Codex mode.

## Connect a project

Connection is a deliberate per-project opt-in. Run `/augenta:connect` (Codex:
`$augenta:connect` or "Connect Augenta") and answer in the chat:

1. Pick **every** Neurospace this project should feed — one, several, or none.
   That choice is the consent boundary, and **each one you pick receives the full
   record**.
2. The first time only, click the `auth.augenta.ai` link your agent shows you.
   Later projects reuse that sign-in and skip this step.

There is nothing to copy into a second terminal. Your agent runs the connect
script's `--json` verbs directly; none of them accepts or emits a credential.

You can also run the script yourself for the interactive terminal flow:

```bash
bun "<plugin-root>/scripts/connect.ts"
```

Either way it reuses your owner-only global sign-in when possible, otherwise
starts device login. It displays the authenticated organization, always requires
you to select the Neurospaces, creates or reuses **one inbound agent Neurolink per
selected Neurospace** through the normal `/v1` API, verifies each, and writes this
private, self-ignored project directory:

```text
<project>/.augenta/
├── .gitignore     "*"  — prevents the directory from being committed
└── config.json    profileId, neurolinkIds, optional endpoint (mode 0600)
```

Rotating access and refresh tokens live only in `~/.augenta/auth.json` (mode
`0600`, inside a `0700` directory). The project stores no OAuth token,
organization id, or Neurospace id. Autonomous services and CI can use the
advanced `--api-key <AugentaKey>` option; that path is single-destination and the
assigned Neurolink is derived server-side.

The presence of a **readable** `.augenta/config.json` is the project's consent to
capture both agent activity and project memory. Delete that file—or the entire
`.augenta/` directory—to stop capture for the project. Set
`AUGENTA_CAPTURE_ENABLED=0` to disable both globally.

### Sending to several Neurospaces

A project can feed more than one Neurospace. Each gets its own inbound Neurolink,
and **every one receives the full record** — the same activity steps, the same raw
transcript lines, and the same memory documents, complete, in each. It is a copy
to each destination, not a split between them.

So the audience for a connected project is the **union** of everyone with access
to any Neurospace you selected. That is the number worth thinking about before you
add a second destination, and it is why the raw-transcript caveat above applies to
each one.

Re-running `/augenta:connect` **replaces the whole set**: the answer is the
complete list of destinations, with the current ones shown already selected. A
Neurospace you deselect stops receiving this project immediately — its id is
dropped from `config.json` — while its Neurolink is left in place and idle on the
platform, so nothing is disabled or deleted on your behalf and re-selecting it
later picks up the same link. There is no "select nothing" answer that
disconnects an already-connected project; deleting `.augenta/config.json` is how
you turn it all off.

One broken destination cannot stall the others: each keeps its own position in the
project's outbox, so a Neurospace that is temporarily unreachable simply catches
up on a later turn.

### Upgrading from an earlier version

Augenta is pre-1.0 and does not carry old project configs forward. Reconnect once
per project after upgrading:

- **Connected before 0.3.0** — the project holds an API key from the old setup
  script, under an authentication scheme the platform no longer accepts.
- **Connected on 0.3.x** — the project's `authMode` uses the older `workos`
  spelling, replaced by the provider-neutral `oauth`.

Projects connected on **0.5.x keep working** and need no action: their single
Neurolink is read forward as a one-destination set. Re-run `/augenta:connect` when
you want to add a second Neurospace.

Neither is migrated automatically: reusing an old credential or routing decision
would turn a clear reconnect into an unexplained authentication failure. Each such
project instead gets one automatic prompt to run `/augenta:connect` again, which
is now a single question and, at most, one link to click. Anything already queued
in its outbox ships as soon as that succeeds. Capture for the project is paused,
not lost, in the meantime.

## What gets captured

Each prompt-to-stop cycle becomes one turn in Augenta. During the turn, the
plugin records the agent's messages, tool calls, and outcomes. When the turn
finishes, it sends two complementary forms of activity to your Neurospace:

- **Normalized events:** structured trajectory steps whose text is scrubbed
  client-side for common credential patterns, including private keys, JWTs,
  URL credentials, and common service tokens.
- **Raw transcript records:** otherwise-original transcript JSONL lines. Before
  upload, the plugin removes opaque reasoning signatures/encrypted content and
  empty `thinking`/`reasoning` fields so those artifacts are not retained.
- **Subagent activity:** work a subagent performs is recorded in its own
  transcript rather than the session's, so it is captured from that file when the
  subagent finishes. These steps carry their own session id and name the session
  that spawned them. Both forms above apply to them equally.

> **Important:** raw transcript records are not secret-scrubbed. They are
> structurally sanitized to remove opaque reasoning artifacts, then uploaded.
> Connecting a project consents to uploading both the scrubbed event stream
> and these raw transcript records. Only connect projects whose agent
> activity you are comfortable sending to **every** Augenta Neurospace you
> select.

Project memory is captured separately from trajectory activity. Memory becomes
standalone scrubbed Markdown document experiences; it is never appended to raw
transcript telemetry. The plugin applies the same client-side credential
scrubber to memory text before it enters the durable outbox.

- **Claude Code:** captures regular, non-symlink Markdown files under the
  session's sibling `memory/` directory.
- **Codex:** reads its global `MEMORY.md`, but captures only `# Task Group:`
  blocks whose required `applies_to: cwd=...` scope is the connected project
  or one of its descendants. Global summaries, profiles, unscoped blocks, and
  unrelated Task Groups are excluded.

Memory revisions and deletion notices are buffered durably just like turns.
Nothing is scanned or uploaded without `.augenta/config.json`; the
`AUGENTA_CAPTURE_ENABLED=0` kill switch disables activity and memory capture.

Project routing and queued activity or memory live under the self-git-ignored
`.augenta/` directory; reusable sign-in credentials live in the global
owner-only auth file. A durable, size-bounded outbox keeps records safe during
network interruptions or expired login and retries delivery idempotently.

## How capture works

| Moment | Plugin behavior |
|---|---|
| Project opens | Offers to connect Augenta once if the project has not opted in. A connected project scans memory changes and drains any durable outbox. |
| Prompt submitted | Starts a new turn. |
| Tool completes | Captures new transcript activity into the local outbox; no network request is made. |
| Agent stops | Captures the final activity and memory changes, then sends completed records to Augenta in the background. |

Every hook is a silent no-op unless the project or one of its parent directories
contains `.augenta/config.json`.

For integrations and local development, `AUGENTA_API_URL` overrides the gateway
base and `AUGENTA_INGEST_URL` redirects the experiences endpoint. Neither
variable opts a project into capture.

`AUGENTA_CONTROL_URL` (or `scripts/connect.ts --control-url`) selects the
environment's complete public login discovery: issuer, public client id, and
gateway. Use it when connecting to dev or staging. `--endpoint` changes only the
gateway and must not be used by itself for a new cross-environment sign-in.

Augenta sign-in is a public-client OAuth device grant against WorkOS AuthKit,
reached through Augenta's own `auth.augenta.ai` issuer. That is an implementation
detail of the platform: no user-facing string in this plugin names the identity
provider, and the stored `authMode` is the provider-neutral `oauth`.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test:e2e
bun test
```

After the platform dev topology, backend, and Pages app are deployed, connect a
disposable project to dev and run the hosted human/plugin E2E:

```bash
bun scripts/connect.ts \
  --project /absolute/path/to/test-project \
  --control-url https://dev.augenta.ai

bun scripts/dev-e2e.ts \
  --project /absolute/path/to/test-project \
  --control-url https://dev.augenta.ai
```

The test uses the stored owner-only sign-in profile, real outbox and shipper,
and authenticated experience-read API to verify durable schema-v2 landing. It
does not print or export the access or refresh token. The platform deployment
order, GitHub Actions gates, variables, and browser acceptance steps live in
the platform repository's `docs/deployment-runbook.md`.

For local testing, add this repository as a plugin marketplace and install it:

```bash
# Claude Code
claude plugin marketplace add ./path/to/augenta-plugin
claude plugin install augenta@augenta

# Codex
codex plugin marketplace add ./path/to/augenta-plugin
codex plugin add augenta@augenta
```

The main implementation lives in:

- `hooks/` — lifecycle entrypoints for supported coding agents
- `capture/` — normalization, scrubbing, durable buffering, and delivery
- `scripts/connect.ts` — sign-in, Neurolink selection, safe project config, and
  the agent-driven `--json` verbs
- `scripts/dev-e2e.ts` — hosted sign-in/profile/plugin/durable-landing verification
- `skills/connect/` — the guided connection flow
