# Augenta

**Neuroplasticity for Agents, a living memory that focuses on relevant context. Help your agents remember and share their work.**

Augenta saves your agent's activity and project notes so you can ask about them
later. It works with Claude Code and Codex.

Connect a project and choose where its records go. A **Workspace** is a place
in Augenta to keep that memory. Use your own Workspace or one shared with your
team.

- **Save as you work.** Activity and project notes are sent in the background.
- **Ask about past work.** Try “What did we decide about sign-in?”
- **Choose what to connect.** Each project has its own connection.

Nothing is captured until you connect that project.

**Before you connect:** saved records include full chat transcripts, which can
contain secrets. Every Workspace you choose gets the same records.
[Read what gets captured](#what-gets-captured).

## Quick start

### Prerequisites

You need [Node.js 20 or newer](https://nodejs.org) and an
[Augenta account](https://augenta.ai). Check that your agent's terminal can run
`node --version`. Your first sign-in gives you a private Default Workspace.

Choose your app below. The [setup guide](https://augenta.ai/dashboard/getting-started)
also has screenshots for desktop apps.

### Claude Code

Send each command as its own message:

```text
/plugin marketplace add AugentaAI/augenta-plugin
```

```text
/plugin install augenta@augenta
```

Restart Claude Code, open your project, and run:

```text
/augenta:connect
```

### Codex CLI

Run these in your terminal:

```bash
codex plugin marketplace add AugentaAI/augenta-plugin --ref main
codex plugin add augenta@augenta
```

Start a new session in your project. Trust the Augenta hooks when asked.
Hooks let the plugin save activity as you work. If you dismiss the prompt,
run `/hooks`. Changes to hooks can make Codex ask again after an update.

Then ask **“Connect Augenta”**, or run:

```text
$augenta:connect
```

### Claude Desktop

Open **Customize → Plugins → Add → Add marketplace**. Enter
`https://github.com/AugentaAI/augenta-plugin`, keep automatic sync on, and
enable Augenta.

Start a new Code or Cowork task with your project folder attached. Choose
Augenta's connect skill from the `/` or `+` menu.

### ChatGPT Desktop

Open **Plugins → Add → Add a marketplace**. Use
`https://github.com/AugentaAI/augenta-plugin` as the source, `main` as the Git
ref, and leave Sparse paths empty. Install or enable Augenta.

Start a new Codex or Work task with your project. Ask **“Connect Augenta”**,
or run `$augenta:connect`.

## Connect and confirm

1. Open the sign-in link in your browser.
2. Choose **every** Workspace this project should feed. Pick at least one.
   You can also create a Workspace, then choose where to send the records.
3. Work in the project for a few minutes. Open your chosen Workspace in
   [Augenta](https://augenta.ai) and check **Experiences** for the saved work.

The plugin saves records on your machine first, then sends them in the
background. A short wait is normal.

To change Workspaces, run connect again. It shows your current choices and asks
you to pick the full set each time. See [connection settings](docs/configuration.md)
for what happens when you add or remove a Workspace.

## Recall what Augenta remembers

Ask your agent **“What does Augenta remember about our sign-in setup?”**

Or use the recall command in Claude Code:

```text
/augenta:recall what did we decide about sign-in?
```

In Codex:

```text
$augenta:recall what did we decide about sign-in?
```

Usage: `/augenta:recall [answer | context] <question>` (or `$augenta:recall` in Codex).
Your agent can also use recall when a task needs past context. Each connected
Workspace is asked, and each result shows where it came from. **Augenta's model
writes the answer by default**, taking up to a minute. Say `context` before the
question to get the saved memory for your agent to answer from without an Augenta
answer-model call. If the model is unavailable, the plugin tries context once and
your agent explains that it is answering from memory.

A new Workspace may have nothing to recall yet. If recall is not available,
the plugin will say so.

## What gets captured

Every selected Workspace gets the **full record**:

| Records | What they include |
| --- | --- |
| Agent activity | Messages, tool actions, and results in a common format |
| Raw transcript records | The chat records written by your coding app |
| Project memory | Saved agent notes that match this project |

The plugin removes common secret patterns from activity and project notes.
**Raw transcript records are structurally sanitized but are not secret-scrubbed.**
This means some internal fields are removed, but passwords, keys, and private
text can still be sent in the chat records.

Only connect projects you are comfortable sharing with all chosen Workspaces.
The audience is the **union** of their members: anyone with access to any
selected Workspace may see the records.

Recall sends only the question text, with no files or transcript attached.
Augenta records the request but keeps no copy of the question or answer. It
keeps a one-way fingerprint of the question to check for retries. Short
questions can be guessed from that fingerprint, so treat them as visible to
the Workspace's audience.

## Turn it off

To stop both capture and recall for a project, delete its `.augenta/config.json`.
This does not delete records already sent to Augenta.

To pause capture across projects, set `AUGENTA_CAPTURE_ENABLED=0` in the
environment that starts your coding app. Recall still works while a project
has its config file.

## Configuration

Connect handles setup for you. Your project stores its connection in
`.augenta/config.json`: sign-in profile reference, environment URLs, organization
and chosen destinations. Sign-in tokens stay in your private global profile.
Older `connectorIds` configs need one reconnect per project. See
[connection settings](docs/configuration.md) for file details and changing Workspaces.

## Connecting CI or a service

Jobs that cannot sign in through a browser can use an API key. Follow the
[CI and service setup](docs/configuration.md#ci-or-a-service). Never paste a
key into an agent conversation.

## Links

- [How the plugin works](docs/architecture.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Report a bug](https://github.com/AugentaAI/augenta-plugin/issues)
- [License](LICENSE)
