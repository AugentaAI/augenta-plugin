# Augenta

Your coding agents learn useful things every day, but most of that context
disappears when a session ends. The Augenta plugin captures activity and
project memory from projects you explicitly connect, then sends it to the
Augenta Workspaces you choose so it can become shared memory and skills.

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

Start a new session and trust the Augenta hooks when Codex asks. Open the
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

That selection is the consent boundary. Every selected Workspace receives the
**full record**: the same agent activity, raw transcript records, and project
memory. The effective audience is the **union** of everyone with access to any
selected Workspace.

Raw transcript records are structurally sanitized but are **not
secret-scrubbed**. Only connect projects whose agent activity you are
comfortable sending to every Workspace you select.

After connecting, work in the project for a few minutes, then return to
[Getting Started](https://augenta.ai/dashboard/getting-started) to confirm that
experiences are landing.

To stop capture for one project, delete `.augenta/config.json`. To disable
capture globally, set `AUGENTA_CAPTURE_ENABLED=0`.

## Links

- [Getting Started](https://augenta.ai/dashboard/getting-started)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Issues](https://github.com/AugentaAI/augenta-plugin/issues)
- [License](LICENSE)
