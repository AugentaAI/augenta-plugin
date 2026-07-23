---
name: init
description: Initialize Augenta agent activity and project-memory capture for the current project. Use when the user runs /augenta:init, or asks to initialize / set up / connect / enable Augenta. Walks the user through creating the project's .augenta/config.json with their API key via a command they run in their OWN terminal — the key never passes through the chat. This is the entry point right after installing the Augenta plugin.
allowed-tools: AskUserQuestion, Bash, Read
---

# Augenta Init

Opt the **current project** into Augenta agent activity and project-memory
capture: once initialized, the plugin captures this project's agent turns and
ships them to the user's Augenta Neurospace on two activity channels — normalized
steps (tool calls, messages, outcomes; step text scrubbed of secrets
client-side) plus raw transcript lines for each turn. Raw lines are not
secret-scrubbed, but opaque reasoning signatures/encrypted content and empty
thought fields are removed before upload. It also captures matching agent-memory documents separately as
scrubbed Markdown documents, never as raw transcript telemetry. Claude Code
uses the session's `memory/` files; Codex filters global memory to matching
scoped Task Groups. Initializing is consent for activity and memory. Nothing is
captured in projects that haven't been initialized.

Keep this warm and brief. The whole flow is ONE manual step for the user.

## 0. Silent check (do this first, print nothing)

Run with Bash and branch on the exit code — do not narrate this step:

```bash
test -f .augenta/config.json
```

- **Exit 0 (already initialized)** → say: "Augenta is already set up for this
  project — agent activity and matching project memory are being captured to
  your Neurospace." Mention the off switches (delete `.augenta/config.json`, or
  set `AUGENTA_CAPTURE_ENABLED=0`) only if the user asks. Stop here.
- **Exit non-zero** → continue to step 1.

## 1. Explain, in two sentences

Tell the user: initializing Augenta makes this project capture the agent's
activity and matching project memory to their Augenta Neurospace; the API key
lives in `.augenta/config.json`, which git-ignores itself so it can never be
committed. Ask if they'd like to proceed through the current harness's native
user-input mechanism. In Claude Code, use AskUserQuestion: "Initialize Augenta
for this project?" — Yes / Not now. In Codex, ask the same direct question in
chat.

If "Not now": acknowledge in one line and stop. Never re-raise it unprompted.

## 2. The one manual step (user's own terminal)

The API key must NOT be pasted into this chat — the user runs the setup script
themselves. Compose the exact command for them:

1. Resolve the installed plugin root to a literal absolute path (the user's
   shell does not have the plugin-root environment variable). On Claude Code,
   `CLAUDE_PLUGIN_ROOT` is available in your environment; if it is unset, or on
   Codex, locate the installed plugin root before printing.
2. Print, for the user to run **in their own terminal, at this project's root**
   (requires Bun — https://bun.sh — the same runtime the plugin's hooks use):

```bash
bun "<ABSOLUTE_PLUGIN_ROOT>/scripts/setup.ts" --api-key <your-key>
```

3. Tell them their key is issued at **https://augenta.ai** (shown once at
   signup), and that the script writes `.augenta/config.json` (owner-only,
   self-git-ignored) and nothing else — it makes no network calls.

Then wait for them to say it's done.

## 3. Confirm

Re-run the silent check (`test -f .augenta/config.json`):

- **Exit 0** → confirm: "Done — this project now captures agent activity and
  matching project memory to your Augenta Neurospace." Add one line: capture is
  per-project (only initialized projects ship anything), and the kill switch
  `AUGENTA_CAPTURE_ENABLED=0` disables both activity and memory.
- **Exit non-zero** → ask if the command errored; common causes are Bun missing
  (point at https://bun.sh) or running it in a different directory. On Codex,
  remind them they can ask "Initialize Augenta" again any time; on Claude Code,
  `/augenta:init`.

## Notes for the agent

- NEVER ask the user to paste the API key into the chat, and never run the
  setup script with a key yourself.
- Do not create `.augenta/` or `config.json` by hand — the script owns the safe
  file layout (permissions + the self-ignoring `.gitignore`).
- On Codex there are no slash commands; refer to this flow as "Initialize
  Augenta" instead of `/augenta:init`.
