# Augenta

Your coding agents learn useful things every day, but most of that context
disappears when a session ends. The Augenta plugin captures activity and
project memory from projects you explicitly connect, then sends it to the
Augenta Workspaces you choose so it can become shared memory and skills — and
lets your agent ask those Workspaces what they remember.

## Quick start

**Prerequisite:** [Node.js](https://nodejs.org) 20 or newer.

For the current guided setup, including screenshots, open
[Getting Started](https://augenta.ai/dashboard/getting-started) in Augenta.

### Claude Code

Run these commands inside Claude Code:

```text
/plugin marketplace add AugentaAI/augenta-plugin
/plugin install augenta@augenta
```

Restart Claude Code, open the project you want to connect, and run:

```text
/augenta:connect
```

### Codex CLI

Run these commands in your terminal:

```bash
codex plugin marketplace add AugentaAI/augenta-plugin --ref main
codex plugin add augenta@augenta
```

Start a new session and trust the Augenta hooks when Codex asks. Codex asks
again after plugin updates; if you dismiss the prompt, run `/hooks`. Open the
project you want to connect and run:

```text
$augenta:connect
```

You can also ask Codex to "Connect Augenta."

### Claude Desktop

Open **Customize → Plugins → Add → Add marketplace**, enter
`https://github.com/AugentaAI/augenta-plugin`, keep automatic sync on, and
enable Augenta. Start a new Code or Cowork task with the project folder
attached, then choose Augenta's connect skill.

### ChatGPT Desktop

Open **Plugins → Add → Add a marketplace**. Use
`https://github.com/AugentaAI/augenta-plugin` as the source, `main` as the Git
ref, and leave Sparse paths empty. Install or enable Augenta, then start a new
Codex or Work task with the project and run `$augenta:connect` or ask the app to
connect Augenta.

## Connect and confirm

The connect skill signs you in through your browser when needed, then asks you
to select **every** Workspace this project should feed. At least one is
required, and you can choose more than one.

That selection is the consent boundary. The effective audience is the
**union** of everyone with access to any selected Workspace.

## Recall what Augenta remembers

Once a project is connected, ask its Workspaces what they already know:

```text
/augenta:recall what did we decide about the landing path
```

On Codex, use `$augenta:recall`, or just ask what Augenta remembers about
something. Your agent also reaches for it on its own when you ask what was
decided, tried, or learned before.

Every Workspace the project feeds is asked, and each answer is labelled with
the Workspace it came from. An answer is written by a model over the matching
memory, so a call can take up to a minute. **Only your question leaves the
machine** — no file contents and no transcript text. Augenta records that a
recall happened and stores neither the question nor the answer.

A brand-new Workspace has nothing to recall yet; that is normal, not an error.
Recall is available where Augenta has it deployed, and reports plainly when it
is not.

## What gets captured

Every selected Workspace receives the **full record**: the same normalized
agent activity, raw transcript records, and project memory. Normalized activity
and project memory are scrubbed for common credential patterns.

Raw transcript records are structurally sanitized but are **not
secret-scrubbed**. Only connect projects whose agent activity you are
comfortable sending to every Workspace you select.

After connecting, work in the project for a few minutes, then return to
[Getting Started](https://augenta.ai/dashboard/getting-started) to confirm that
experiences are landing.

**On request: recall.** A recall sends one thing — the question you asked, or
the one your agent formed from it — to each Workspace the project feeds. It
reads; it writes nothing, and Augenta keeps neither the question nor the answer.

To stop capture for one project, delete `.augenta/config.json`. To disable
capture globally, set `AUGENTA_CAPTURE_ENABLED=0`. That variable is the switch
for **capture** only: recall is a read, so it keeps working while the project
has a config. Deleting `.augenta/config.json` turns off both.

## Links

- [Getting Started](https://augenta.ai/dashboard/getting-started)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Issues](https://github.com/AugentaAI/augenta-plugin/issues)
- [License](LICENSE)
