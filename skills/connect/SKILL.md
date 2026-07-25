---
name: connect
description: Connect the current project to an Augenta Neurospace through a Neurolink. Use when the user runs /augenta:connect, invokes $augenta:connect, or asks to connect or enable Augenta. The user signs in with WorkOS once, explicitly selects a Neurospace, and the project stores only a global profile reference and Neurolink id.
allowed-tools: AskUserQuestion, Bash, Read
---

# Augenta Connect

Connect the current project to Augenta activity and project-memory capture.
Connected projects send normalized activity steps, structurally sanitized raw
transcript lines, and matching scrubbed memory documents through an inbound
Neurolink to the explicitly selected Neurospace. Connection is per project and
is the user's consent boundary.

## 1. Check silently

Run:

```bash
test -f .augenta/config.json
```

If it exists, explain that reconnecting lets the user verify the WorkOS
organization and explicitly confirm or change the Neurospace. Do not stop just
because the project is already connected.

## 2. Explain and ask

In two sentences, explain that WorkOS login is stored globally in
`~/.augenta/auth.json`, while this project stores only `profileId`,
`neurolinkId`, and an optional environment endpoint in
`.augenta/config.json`. Connecting enables this project's activity and matching
project memory capture.

Ask whether to proceed using the harness's normal user-input mechanism. If the
user declines, acknowledge and stop.

## 3. Give the one terminal command

Never ask the user to paste an OAuth token or API key into chat, and do not run
the interactive login for them.

Resolve the installed plugin root to a literal absolute path. Then print this
command for the user to run in their own terminal at the project root:

```bash
bun "<ABSOLUTE_PLUGIN_ROOT>/scripts/connect.ts"
```

The command:

1. reuses a refreshable global WorkOS profile when possible or opens WorkOS
   device login;
2. displays the authenticated organization;
3. always requires explicit Neurospace selection;
4. creates or retargets an inbound `kind: "agent"` Neurolink through `/v1`;
5. verifies the Neurolink; and
6. writes the owner-only, self-gitignored project configuration.

`--api-key` is the advanced path for autonomous clients and CI. It accepts a
platform-managed Augenta key, verifies its active inbound Neurolink, and never
calls the WorkOS login flow.

Wait for the user to say the command completed.

## 4. Confirm

Re-run:

```bash
test -f .augenta/config.json
```

If present, confirm that this project is connected through its Neurolink.
Mention that deleting `.augenta/config.json` or setting
`AUGENTA_CAPTURE_ENABLED=0` disables activity and memory capture.

If absent, ask for the command's non-secret error text. Common causes are a
missing Bun runtime, denied/expired device authorization, no active
Neurospaces, or an organization not yet provisioned in Augenta.

## Agent constraints

- Never expose or request tokens, refresh tokens, or API keys in chat.
- Never hand-edit `.augenta/config.json`; the connect script owns permissions
  and layout.
- For Claude Code, name the command `/augenta:connect`.
- For Codex, use `$augenta:connect` when skills are addressable, or the phrase
  “Connect Augenta.”
