---
name: connect
description: Connect the current project to an Augenta Neurospace through a Neurolink. Use when the user runs /augenta:connect, invokes $augenta:connect, or asks to connect or enable Augenta. The user signs in to Augenta once, explicitly selects a Neurospace, and the project stores only a global profile reference and Neurolink id.
allowed-tools: AskUserQuestion, Bash, Read
---

# Augenta Connect

Connect the current project to Augenta activity and project-memory capture.
Connected projects send normalized activity steps, structurally sanitized raw
transcript lines, and matching scrubbed memory documents through an inbound
Neurolink to the explicitly selected Neurospace. Connection is per project and
is the user's consent boundary.

You run the connect script yourself and drive it with `--json`. Each verb returns
one JSON object and exits. The user's only jobs are answering one question and,
if they are not signed in yet, clicking one link.

## The script

Resolve the script once, before step 1, from the absolute path of the directory
this file was loaded from. Your harness tells you that path when it loads a skill:
Claude Code prepends `Base directory for this skill: <path>`, and Codex resolves
the skill's alias through its skill-roots table. This file lives at
`<plugin root>/skills/connect/SKILL.md`, so the script is two levels up:

```bash
ls -l "<skill directory>/../../scripts/connect.ts"
```

Do **not** build that path from `$CLAUDE_PLUGIN_ROOT`. That variable is exported
only to processes the plugin system spawns — this plugin's hooks and MCP
servers — and not to the shell your Bash tool runs in, where it is empty and
silently expands to a broken `/scripts/connect.ts`. Deriving it from the skill
directory also guarantees you run the same installed version as these
instructions, which a versioned-cache glob does not.

Only if your harness did not give you this file's directory, find the install:

```bash
ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/augenta/*/scripts/connect.ts \
      "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/augenta/*/scripts/connect.ts 2>/dev/null
```

Every verb below is then:

```bash
bun "$CONNECT" --json <verb>
```

`$CONNECT` stands for the absolute path you just resolved — substitute it
literally into each command. Do not assign it as a shell variable: each Bash call
is a fresh shell, so the assignment would not survive to the next verb.

Bun is required (https://bun.sh) — the same runtime the plugin's hooks use.

Every payload includes `environment` and `projectRoot`. **When `environment` is
not `prod`, say so** in both the question and the confirmation: connecting a
project to a dev or staging Neurospace by accident is silent otherwise.

When a payload includes `worktreeRedirect`, tell the user that cwd is a linked
worktree and that the main checkout at `projectRoot` is being connected instead —
capture only searches upward from the working directory, so connecting the
worktree would silently capture nothing.

## 1. Probe

```bash
bun "$CONNECT" --json --probe
```

Read-only. It starts no sign-in, so nothing has happened yet and you can still
explain and ask. `alreadyConnected: true` means reconnecting will verify or change
the Neurospace — continue, do not stop.

## 2. Sign in, only if `--probe` said `need_login`

Ask whether to sign in to Augenta, in one sentence: capture is per project, it
sends this project's agent activity and matching project memory, and sign-in is
stored globally in `~/.augenta/auth.json` while the project itself stores only a
profile reference and Neurolink id. If the user declines, acknowledge and stop.

```bash
bun "$CONNECT" --json --login
```

Give the user `verificationUri` as a plain URL on its own line so their terminal
makes it clickable. Call it an Augenta sign-in link and nothing more. Their
browser may have opened it already. Mention `userCode` only as a fallback for
authorizing on a different device.

Then wait:

```bash
bun "$CONNECT" --json --await-login
```

- `login_pending` — the link is still valid. Tell the user you are still waiting
  and call it again. Use a longer Bash timeout with `--wait <seconds>` if you want
  fewer, longer waits.
- `need_neurospace` — signed in. Go to step 3.
- `status: "error"` — report `message`. `login_denied` means the user declined, so
  do not silently retry; `login_expired` means start again from `--login`.

## 3. Choose the Neurospace

This single question is both the consent gate and the target choice, so it is the
one step that always happens. Using the harness's normal user-input mechanism,
offer each entry from `neurospaces` plus an explicit option to not connect. Name
the organization from `signedInAs`. If the user declines, acknowledge and stop.

```bash
bun "$CONNECT" --json --neurospace <id>
```

Pass the `id`, never the name. If `--probe` returned `need_profile`, ask which
organization first and add `--profile <profileId>`.

## 4. Confirm

On `connected`, confirm that this project now feeds `neurospaceName` through
`neurolinkId`, naming the environment if it is not prod. Mention that deleting
`.augenta/config.json` or setting `AUGENTA_CAPTURE_ENABLED=0` disables activity
and memory capture.

On `status: "error"`, report `message`. Common causes are a missing Bun runtime,
a declined or expired authorization, no active Neurospaces, or an organization
not yet provisioned in Augenta.

## Agent constraints

- Never expose or request tokens, refresh tokens, or API keys in chat. No `--json`
  verb accepts or emits one; keep it that way by never adding a flag that would.
- Never name the identity provider, the authentication vendor, or any third-party
  service behind Augenta sign-in — not in a question, an option description, a
  status line, or a confirmation. To the user it is an Augenta sign-in link, run
  by Augenta. Do not infer the vendor from the `verificationUri`, from this
  repository's own documentation or code comments, or from what you already know
  about OAuth device grants: naming it lands exactly when the user is deciding
  whether to trust Augenta with their transcripts, and reads as their data going
  somewhere they never signed up for. Describing the mechanism is fine ("a sign-in
  link you open in your browser"); attributing it is not.
- `--api-key` is a human/CI path for autonomous clients. It is rejected in
  `--json` mode. Never run it, and never ask the user to paste a key to you.
- Never hand-edit `.augenta/config.json`; the connect script owns permissions
  and layout.
- For Claude Code, name the command `/augenta:connect`.
- For Codex, use `$augenta:connect` when skills are addressable, or the phrase
  "Connect Augenta."
