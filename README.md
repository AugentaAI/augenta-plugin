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
- **Share learning across a Neurospace.** Turn isolated agent sessions into
  useful organizational context for the people and agents working alongside
  them.
- **Capture without changing your workflow.** Once a project is initialized,
  Augenta runs quietly in the background and tolerates temporary network
  failures without interrupting the agent.
- **Choose exactly where capture happens.** Projects are opted in individually.
  Uninitialized projects are silent no-ops, and a global kill switch is always
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
learn from, and run `/augenta:init`.

### OpenAI Codex

Run these commands in your terminal:

```bash
codex plugin marketplace add AugentaAI/augenta-plugin --ref main
codex plugin add augenta@augenta
```

On first launch, run `/hooks` and trust Augenta's hooks. Codex asks again after
plugin updates; capture remains off until the hooks are trusted. Then open a
project you want Augenta to learn from and run `$augenta:init` or ask
**"Initialize Augenta."**

The corresponding desktop apps share plugin configuration with their CLI. Once
the marketplace has been added, you can enable Augenta from the plugin browser
in Claude's Code tab or ChatGPT's Codex mode.

## Initialize a project

Initialization is a deliberate per-project opt-in. Get an API key from
[augenta.ai](https://augenta.ai), then follow the initialization flow in your
agent. It gives you a command like this to run in your own terminal at the
project root:

```bash
bun "<plugin-root>/scripts/setup.ts" --api-key <your-key>
```

Your key never needs to pass through the agent chat. The setup script makes no
network calls and creates only this private, self-ignored directory:

```text
<project>/.augenta/
├── .gitignore     "*"  — prevents the directory from being committed
└── config.json    API key and optional endpoint (mode 0600)
```

The presence of `.augenta/config.json` is the project's consent to capture both
agent activity and project memory. Delete that file—or the entire `.augenta/`
directory—to stop capture for the project. Set `AUGENTA_CAPTURE_ENABLED=0` to
disable both globally.

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

> **Important:** raw transcript records are not secret-scrubbed. They are
> structurally sanitized to remove opaque reasoning artifacts, then uploaded.
> Initializing a project consents to uploading both the scrubbed event stream
> and these raw transcript records. Only initialize projects whose agent
> activity you are comfortable sending to your Augenta Neurospace.

Project memory is captured separately from trajectory activity. Memory becomes
standalone scrubbed Markdown document experiences; it is never appended to raw
transcript telemetry. The plugin applies the same client-side credential
scrubber to memory text before it enters the durable outbox.

- **Claude Code:** captures regular, non-symlink Markdown files under the
  session's sibling `memory/` directory.
- **Codex:** reads its global `MEMORY.md`, but captures only `# Task Group:`
  blocks whose required `applies_to: cwd=...` scope is the initialized project
  or one of its descendants. Global summaries, profiles, unscoped blocks, and
  unrelated Task Groups are excluded.

Memory revisions and deletion notices are buffered durably just like turns.
Nothing is scanned or uploaded without `.augenta/config.json`; the
`AUGENTA_CAPTURE_ENABLED=0` kill switch disables activity and memory capture.

All local state—including the API key and any queued activity or memory—lives
under the self-git-ignored `.augenta/` directory. A durable, size-bounded outbox
keeps records safe during network interruptions and retries delivery
idempotently when connectivity returns.

## How capture works

| Moment | Plugin behavior |
|---|---|
| Project opens | Offers to initialize Augenta once if the project has not opted in. An initialized project scans memory changes and drains any durable outbox. |
| Prompt submitted | Starts a new turn. |
| Tool completes | Captures new transcript activity into the local outbox; no network request is made. |
| Agent stops | Captures the final activity and memory changes, then sends completed records to Augenta in the background. |

Every hook is a silent no-op unless the project or one of its parent directories
contains `.augenta/config.json`.

For integrations and local development, `AUGENTA_API_URL` overrides the gateway
base and `AUGENTA_INGEST_URL` redirects the experiences endpoint. Neither
variable opts a project into capture.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test:e2e
bun test
```

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
- `scripts/setup.ts` — safe per-project credential setup
- `skills/init/` — the guided initialization flow
