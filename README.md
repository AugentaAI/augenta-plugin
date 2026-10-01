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
Augenta's connect skill from the `/` or `+` menu. Cloud tasks work differently;
see [Cloud sessions](#cloud-sessions).

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
answer-model call. If the model is unavailable or external-model access has not
been acknowledged, the plugin tries context once and your agent explains why it
is using memory instead. An administrator can acknowledge model access to enable
answers after a consent refusal.

A new Workspace may have nothing to recall yet. If recall is not available,
the plugin will say so.

**Recall also runs on its own, if you turn it on.** Connect asks whether to turn
on automatic recall for the project; it is off unless you choose it. When it is
on, each prompt you submit in the project is also a recall question:

- Your Workspaces are asked for saved memory only, with no Augenta answer-model
  call, and any match reaches your agent as background it uses when relevant.
- Pasted blocks and common secret patterns are removed from the prompt first,
  and commands and very short replies are skipped.
- It waits at most five seconds. If Augenta is slow, offline, or has nothing
  saved, your prompt goes ahead as usual.
- The looked-up memory is not captured back into your Workspaces.

Your agent can still use the recall command whether automatic recall is on or
off.

## What gets captured

Every selected Workspace gets the **full record**:

| Records | What they include |
| --- | --- |
| Agent activity | Messages, tool actions, and results in a common format |
| Raw transcript records | The chat records written by your coding app |
| Project memory | Saved agent notes that match this project |
| Supplied documents | Text documents you attach or mention, and PDFs supplied or referenced in supported file-tool records, including generated and temporary PDFs |

The plugin removes common secret patterns from activity and project notes.
**Raw transcript records are structurally sanitized but are not secret-scrubbed.**
This means some internal fields are removed, but passwords, keys, and private
text can still be sent in the chat records.
Embedded document and image bytes are replaced with hash, size and media-type
references in telemetry. Eligible text and PDFs are sent separately as documents.
Text documents have common secret patterns removed. **PDF bytes are not
secret-scrubbed**, and every selected Workspace receives the whole PDF.
Images remain placeholders; they are not sent as documents.

Document capture starts after **this checkout** connects or joins with the new
disclosure. Earlier transcript history is not rescanned for documents. Existing
connections keep their current activity and memory capture with attachments off
until you reconnect or join again. **Upgrade every installed harness before
enabling attachments:** an older plugin sharing the queue can skip document
records. This update also makes Codex ask you to trust the changed hooks again.

Text is split into parts below 512 KiB. A PDF must fit a single envelope
(roughly 380 KiB of PDF bytes); a larger PDF is skipped whole. Missing, changing
or unreadable referenced PDFs are skipped. The plugin reads only the recorded
file paths; it does not scan folders or fetch documents from the network.

Only connect projects you are comfortable sharing with all chosen Workspaces.
The audience is the **union** of their members: anyone with access to any
selected Workspace may see the records.

Recall sends only the question text, with no files or transcript attached.
Augenta records the request but keeps no copy of the question or answer. It
keeps a one-way fingerprint of the question to check for retries. Short
questions can be guessed from that fingerprint, so treat them as visible to
the Workspace's audience. When automatic recall is on, it uses each prompt you
submit as the question, so every prompt leaves such a fingerprint in each
selected Workspace.

## Turn it off

To stop both capture and recall for a project, delete its `.augenta/config.json`.
This does not delete records already sent to Augenta.

To pause capture across projects, set `AUGENTA_CAPTURE_ENABLED=0` in the
environment that starts your coding app. This also pauses automatic recall.
Asking with the recall command still works while a project has its config file.

To stop new attachment capture while keeping activity and memory capture, set
`AUGENTA_CAPTURE_ATTACHMENTS=0` (also accepts `off` or `false`). `all` still
captures only text and PDFs; it does not enable images. Already queued documents
remain queued for delivery.

To turn automatic recall on or off for one project, ask your agent to change
it, or run connect again and answer that question. To turn it off for every
project, set `AUGENTA_AUTO_RECALL=0` in the same environment. Capture and the
recall command keep working either way.

## Configuration

Connect handles setup for you. Your project stores its connection in
`.augenta/config.json`: sign-in profile reference, environment URLs, organization
and chosen Workspaces. Sign-in tokens stay in your private global profile. See
[connection settings](docs/configuration.md) for file details and changing
Workspaces.

Upgrading a browser-connected project from 0.10 or earlier? Run connect once in
it; the [changelog](CHANGELOG.md) says why.

### Share a project's setup

A browser-connected `config.json` holds no sign-in token and no Connector, so
you can commit it. Everyone who checks out the repository then points at the
same Workspaces. The rest of `.augenta/` stays out of Git on its own. To keep the
config private instead, add `.augenta/` to your repository's `.gitignore`.

- **Each checkout joins once.** Until its user runs connect there, a checkout
  with a committed config neither captures nor sends recall questions. Connect
  signs them in if needed, shows the project's Workspaces, and asks whether to
  use them.
- **Each person sends through their own Connector** in each Workspace. It is
  made the first time they join and reused by their other clones, worktrees and
  cloud sessions. They need access to every one of those Workspaces, so someone
  may need to add them first.
- **Changes are confirmed.** A pulled change to the project's Workspaces stops
  capture in each checkout until someone there confirms the new set. So does
  another person signing in on the same machine.
- **Your sign-in goes only where you signed in.** If the config, or an
  environment variable, points a checkout at a different Augenta address than
  the one your sign-in was made for, that checkout stops capturing and recalling
  and says where it points. If the config changed, connecting again restores the
  environment's own address; if a variable is the cause, unset it. Either way,
  if nobody on the team made that change, check its history first. Connect never
  sends your sign-in to a gateway that only the environment or the config chose,
  and it names a non-production environment before you sign in.
- **Everyone sharing a config needs plugin 0.11.0 or newer** to read it, and
  0.12.0 or newer for that check. API-key configs hold the key, so connect never makes them committable, and one
  that git tracks neither captures nor recalls.

## Cloud sessions

A cloud session runs on a machine that is discarded when the session ends. Your
Augenta sign-in there lasts only for that session, and the project's connection
lasts only if its `.augenta/config.json` is committed (see
[Share a project's setup](#share-a-projects-setup)). Each new session then signs
in and joins it.

| Where | Does Augenta run there? |
| --- | --- |
| Claude Code in the cloud (claude.ai/code) | No. Cloud sessions don't install plugins that your repository or your own settings turn on. The only route is your organization's server-managed settings, set by a Team or Enterprise Owner, and Augenta hasn't been tested that way. |
| Cowork in the cloud | No. The plugin runs on Anthropic's machine while your project folder stays on your computer, so connect can't connect it. Use a local Cowork session instead. On Team and Enterprise plans an Owner controls this in Organization settings → Cowork → "Run Cowork in the cloud". From October 6, 2026, new Pro and Max Cowork tasks run only in the cloud. |
| Codex cloud | Untested. Internet access is off by default; turn it on and allow the hosts below. |

Experimental Cowork capture commands are available for a controlled
[native and OTLP pilot](docs/cowork-pilot.md). They require an explicit task-to-project
binding and the project's affirmed Workspace set. Real Cowork delivery remains
unverified; the existing connect skill does not connect a split cloud/device runtime.

Wherever commands run behind a network allowlist, allow `augenta.ai`,
`auth.augenta.ai` and `api.augenta.ai`:

| Where | Setting |
| --- | --- |
| Cowork, local or cloud | Organization settings → Capabilities → Code execution → Allow network egress. It applies to sessions created afterwards. |
| Claude Code in the cloud | The environment's Network access, set to Custom. |
| Codex cloud | The environment's internet access, with all HTTP methods allowed. The GET, HEAD and OPTIONS-only setting blocks sign-in, capture and recall. |

If a host is blocked, connect tells you which one and why, and what to ask your
administrator to allow. In Cowork, start a new task after the setting changes;
existing tasks keep their original settings. Where the environment sets `HTTPS_PROXY`, connect, recall and the hooks
send through that proxy and trust the sandbox's proxy certificate. This needs
Node.js 22.21 or newer; older versions ignore the proxy.

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
