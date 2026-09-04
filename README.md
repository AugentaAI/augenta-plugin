# Augenta

Your coding agents learn useful things every day: how your systems fit together,
which approaches failed, why a decision was made, and what finally worked. Most
of that context disappears when the session ends.

Augenta turns that work into durable, shared context. This plugin captures the
agent activity from projects you choose and sends it to your Augenta Workspace,
giving Augenta the source material it needs to build memory from how your team
actually works. It also preserves the high-signal project memory your agents
have already written, so useful context does not have to be reconstructed from
activity alone.

> An Augenta **Workspace** is a shared destination in your organization's
> account — where captured experience lands and memory is built. It is not a
> folder on your machine and has nothing to do with your editor's workspace.
> The thing on your machine is always a **project**; a project feeds one
> Workspace or several.

## Why use it?

- **Keep the context behind the code.** Preserve the prompts, tool calls,
  decisions, and outcomes that explain how work got done—not just the final
  diff.
- **Build memory from real work.** Give Augenta a continuous record of agent
  activity instead of relying on someone to document every discovery by hand.
- **Share learning across your Workspaces.** Turn isolated agent sessions into
  useful organizational context for the people and agents working alongside
  them. A project can feed one Workspace or several.
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

**Prerequisite:** [Node.js](https://nodejs.org) 20 or newer — the hooks and the
connect script run on it, as prebuilt bundles with no dependencies to install.

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

1. Pick **every** Workspace this project should feed — one or several, with at
   least one required. Everyone gets their own `Default Workspace`; the
   plugin also lets you create another Workspace before choosing. That choice is
   the consent boundary, and **each one you pick receives the full record**.
2. The first time only, click the `auth.augenta.ai` link your agent shows you.
   Later projects reuse that sign-in and skip this step.

There is nothing to copy into a second terminal. Your agent runs the connect
script's `--json` verbs directly; none of them accepts or emits a credential.

You can also run the script yourself for the interactive terminal flow:

```bash
node "<plugin-root>/dist/scripts/connect.mjs"
```

Either way it reuses your owner-only global sign-in when possible, otherwise
starts device login. It displays the authenticated organization, always requires
you to select at least one Workspace, can create a new Workspace when requested,
creates or reuses **one inbound agent Connector per selected Workspace** through
the normal `/v1` API, verifies each, and writes this private, self-ignored project
directory:

```text
<project>/.augenta/
├── .gitignore     "*"  — prevents the directory from being committed
└── config.json    profileId, connectorIds, optional endpoint (mode 0600)
```

Rotating access and refresh tokens live only in `~/.augenta/auth.json` (mode
`0600`, inside a `0700` directory). The project stores no OAuth token,
organization id, or Workspace id. Autonomous services and CI configure a **file** rather than run a command: write
`{"authMode": "api-key", "apiKey": "<AugentaKey>"}` to `.augenta/config.json` and
the plugin reads it directly. That path is single-destination and the assigned
Connector is derived server-side, so there is no id to look up.

Two CLI adjuncts exist for it, neither of them the interface. `--api-key <value>`
writes that same file and verifies the key first, which is convenient
interactively but expands the secret into `argv` where any local process can read
it. `--verify-only` runs the same gateway check against the key **already** on
disk and writes nothing — the pre-flight without the exposure, and the one to
reach for in CI after provisioning:

```bash
node "<plugin-root>/dist/scripts/connect.mjs" --verify-only
```

Whoever writes the file owns its permissions: `.augenta/` wants `0700` and the
config `0600`. The plugin narrows the directory to `0700` on every write it makes
under it, and adds the self-ignoring `.gitignore`, but it cannot chmod a config it
did not write.

The presence of a **readable** `.augenta/config.json` is the project's consent to
capture both agent activity and project memory. Delete that file—or the entire
`.augenta/` directory—to stop capture for the project. Set
`AUGENTA_CAPTURE_ENABLED=0` to disable both globally.

### Sending to several Workspaces

A project can feed more than one Workspace. Each gets its own inbound Connector,
and **every one receives the full record** — the same activity steps, the same raw
transcript lines, and the same memory documents, complete, in each. It is a copy
to each destination, not a split between them.

So the audience for a connected project is the **union** of everyone with access
to any Workspace you selected. That is the number worth thinking about before you
add a second destination, and it is why the raw-transcript caveat above applies to
each one.

Re-running `/augenta:connect` **replaces the whole set**: the answer is the
complete list of destinations, with the current ones shown already selected. A
Workspace you deselect stops receiving this project immediately — its id is
dropped from `config.json` — while its Connector is left in place and idle on the
platform, so nothing is disabled or deleted on your behalf and re-selecting it
later picks up the same link. There is no "select nothing" answer that
disconnects an already-connected project; deleting `.augenta/config.json` is how
you turn it all off.

One broken destination cannot stall the others: each keeps its own position in the
project's outbox, so a Workspace that is temporarily unreachable simply catches
up on a later turn.

### Upgrading from an earlier version

Augenta is pre-1.0 and does not carry old project configs forward. Reconnect once
per project after upgrading:

- **Connected before 0.3.0** — the project holds an API key from the old setup
  script, under an authentication scheme the platform no longer accepts.
- **Connected on 0.3.x** — the project's `authMode` holds an older
  provider-specific spelling, replaced by the provider-neutral `oauth`.
- **Connected before 0.7.0** — the routing key in `config.json` was renamed to
  `connectorIds`, along with the API route and header behind it. Every project
  connected on an earlier version must re-run `/augenta:connect`; there is no
  fallback read, so an unconverted project simply has no destination configured
  and captures nothing.

None of these is migrated automatically: reusing an old credential or routing decision
would turn a clear reconnect into an unexplained authentication failure. Each such
project instead gets one automatic prompt to run `/augenta:connect` again, which
is now a single question and, at most, one link to click. Anything already queued
in its outbox ships as soon as that succeeds. Capture for the project is paused,
not lost, in the meantime.

## What gets captured

Each prompt-to-stop cycle becomes one turn in Augenta. During the turn, the
plugin records the agent's messages, tool calls, and outcomes. When the turn
finishes, it sends two complementary forms of activity to your Workspace:

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
> activity you are comfortable sending to **every** Augenta Workspace you
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

The detached shipper also sends strict operational telemetry: upload duration,
counts, bytes, retries, failures, and outbox health. It never includes captured
activity, memory text, prompts, responses, query text, credentials, raw URLs,
exception messages, or local paths. Capture hooks remain network-free;
telemetry starts only in the background shipper, and telemetry failure cannot
delay capture or change an experience cursor. Hosted responses include an
`X-Augenta-Trace-Id` correlation handle for delivery diagnostics.

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

Augenta sign-in is a public-client OAuth device grant against Augenta's own
`auth.augenta.ai` issuer. The project stores the provider-neutral `authMode` of
`oauth` and no token of any kind.

## Development

Contributor setup, the verify commands, and the conventions this repository
holds itself to live in
[`CONTRIBUTING.md`](https://github.com/AugentaAI/augenta-plugin/blob/main/CONTRIBUTING.md)
and `AGENTS.md`.

## Troubleshooting

**The hooks do nothing.** Check that the project is connected — capture is a
deliberate silent no-op until `.augenta/config.json` exists in the project or one
of its parent directories, so an unconnected project looks exactly like a broken
install. `AUGENTA_CAPTURE_ENABLED=0` silences a connected project the same way.

**`Augenta hook: Node.js 20 or newer was not found`.** The plugin runs on Node
and looks for it in the usual version-manager locations before falling back to
`PATH`. Desktop apps often start with a much shorter `PATH` than your terminal,
so a Node that works when you type `node` can be invisible to a hook. Point at it
explicitly:

```bash
export AUGENTA_NODE=/absolute/path/to/node
```

That message only appears for a **connected** project — a missing Node in an
unconnected one stays silent, because nothing there opted in. If `AUGENTA_NODE`
itself is wrong you get `Augenta hook: AUGENTA_NODE is not a working Node.js 20+
executable` instead, which is deliberately not gated: you asked for that
executable by name, so a broken one is worth reporting either way.

**Codex captures nothing after installing or updating.** Codex requires each hook
to be trusted, pinned by content hash, and every plugin update re-prompts. Run
`/hooks` in Codex and approve them.

**A prompt appeared asking to run `/augenta:connect` again.** The project's config
was written by an older version that this one cannot read. Nothing is migrated on
purpose — reusing a stale credential or routing decision would surface later as an
unexplained authentication failure instead of a clear ask. Reconnect once; see
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

**Connect printed a command instead of a sign-in link.** The turn could not
complete a sign-in — a plan-mode or print-mode run has no interactive user to
click a link. Run the printed command in a terminal; it drives the same flow.

**The sign-in link expired.** Ask the agent for a fresh link. It will not mint one
on its own, so that a link you are part-way through opening is never invalidated
underneath you.

**Connect reported a different project directory.** In a git worktree, the plugin
connects the main checkout instead, because capture only ever walks upward from
the current directory and would never find a config written into a linked
worktree. Pass `--project` to override.

## License

See [`LICENSE`](LICENSE). The source is published so the plugin can be installed
and inspected; use of Augenta itself is governed by Augenta's terms.

## Links

- [augenta.ai](https://augenta.ai)
- [Issues](https://github.com/AugentaAI/augenta-plugin/issues)
- [Security policy](https://github.com/AugentaAI/augenta-plugin/blob/main/SECURITY.md)
