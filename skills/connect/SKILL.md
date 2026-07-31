---
name: connect
description: Connect the current project to Augenta Neurospaces through Neurolinks. Use when the user runs /augenta:connect, invokes $augenta:connect, or asks to connect or enable Augenta. The user signs in to Augenta once, explicitly selects every Neurospace this project should feed, and the project stores only a global profile reference and its Neurolink ids.
allowed-tools: AskUserQuestion, Bash, Read
---

# Augenta Connect

Connect the current project to Augenta activity and project-memory capture.
Connected projects send normalized activity steps, structurally sanitized raw
transcript lines, and matching scrubbed memory documents through one inbound
Neurolink per explicitly selected Neurospace. **Every selected Neurospace
receives the full record — the same activity and memory, complete, in each.**
Connection is per project and is the user's consent boundary.

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
ls -l "<skill directory>/../../dist/scripts/connect.js"
```

Do **not** build that path from `$CLAUDE_PLUGIN_ROOT`. That variable is exported
only to processes the plugin system spawns — this plugin's hooks and MCP
servers — and not to the shell your Bash tool runs in, where it is empty and
silently expands to a broken `/dist/scripts/connect.js`. Deriving it from the skill
directory also guarantees you run the same installed version as these
instructions, which a versioned-cache glob does not.

Only if your harness did not give you this file's directory, find the install:

```bash
ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/augenta/*/dist/scripts/connect.js \
      "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/augenta/*/dist/scripts/connect.js 2>/dev/null
```

Every verb below is then:

```bash
node "$CONNECT" --json <verb>
```

`$CONNECT` stands for the absolute path you just resolved — substitute it
literally into each command. Do not assign it as a shell variable: each Bash call
is a fresh shell, so the assignment would not survive to the next verb.

Every payload includes `environment` and `projectRoot`. **When `environment` is
not `prod`, say so** in both the question and the confirmation: connecting a
project to a dev or staging Neurospace by accident is silent otherwise.

When a payload includes `worktreeRedirect`, tell the user that cwd is a linked
worktree and that the main checkout at `projectRoot` is being connected instead —
capture only searches upward from the working directory, so connecting the
worktree would silently capture nothing.

## 1. Probe

```bash
node "$CONNECT" --json --probe
```

Read-only. It starts no sign-in, so nothing has happened yet and you can still
explain and ask. `alreadyConnected: true` means reconnecting will verify or change
which Neurospaces this project feeds — continue, do not stop.

`destinations` lists the Neurospaces the project feeds right now; use it to
pre-select in step 3. Two cases there need saying out loud rather than quietly
dropping, because the project is still shipping to them and the answer in step 3
replaces the whole set:

- `unresolvedNeurolinkIds` — destinations whose Neurolink you cannot read at all.
- a `destinations` entry with no `neurospaceName` — its Neurospace is no longer in
  the organization's list, so it cannot be offered as an option in step 3 and will
  be dropped by whatever the user answers.

## 2. Sign in, only if `--probe` said `need_login`

Ask whether to sign in to Augenta, in one sentence: capture is per project, it
sends this project's agent activity and matching project memory, and sign-in is
stored globally in `~/.augenta/auth.json` while the project itself stores only a
profile reference and its Neurolink ids. If the user declines, acknowledge and
stop.

```bash
node "$CONNECT" --json --login
```

Give the user `verificationUri` as a plain URL on its own line so their terminal
makes it clickable. Call it an Augenta sign-in link and nothing more. Their
browser may have opened it already. Mention `userCode` only as a fallback for
authorizing on a different device.

Then wait:

```bash
node "$CONNECT" --json --await-login
```

- `login_pending` — the link is still valid. Tell the user you are still waiting
  and call it again. Use a longer Bash timeout with `--wait <seconds>` if you want
  fewer, longer waits.
- `need_neurospace` — signed in. Go to step 3.
- `status: "error"` — report `message`. `login_denied` means the user declined, so
  do not silently retry; `login_expired` means start again from `--login`.

## 3. Choose the Neurospaces

This single question is both the consent gate and the target choice, so it is the
one step that always happens. **The answer is the complete set of destinations** —
the project will feed exactly what the user selects here and nothing else. Ask it
every time, including when the organization has only one Neurospace and including
when the project is already connected. Never offer to keep the current selection
without showing it; never treat one answer as authorization for more than one
destination; never proceed on silence.

Before the user answers, say — in one or two sentences, naming the organization
from `signedInAs`:

- every Neurospace they select receives the **full record**: this project's agent
  activity, its raw transcript lines, and its project memory, complete, in each;
- so **anyone with access to any selected Neurospace can read this project's
  captured activity** — the audience is the union of all of them;
- and, if `environment` is not `prod`, which environment this is.

**If your harness's user-input mechanism can offer several options at once**, ask
one question listing every entry from `neurospaces`, with the Neurospaces in
`destinations` already selected, plus a final option `Don't connect this project`.

**If it cannot**, ask in plain text: number the entries, mark the current
destinations, and ask the user to reply with every number they want, or `none`.
Then **restate the set by name and get a yes before running the verb** — a typed
answer is your interpretation of what they meant, not something they saw
rendered.

If `Don't connect this project` comes back **together with** any Neurospace, that
answer has no meaning: say so and ask again. Do not connect. If they decline,
acknowledge and stop.

```bash
node "$CONNECT" --json --neurospace <id> --neurospace <id>
```

Repeat `--neurospace` once per selected Neurospace. Pass the `id`s, never the
names. If `--probe` returned `need_profile`, ask which organization first and add
`--profile <profileId>`.

## 4. Confirm

On `connected`, name **every** entry in `destinations` — this project now feeds
each of them, through that entry's `neurolinkId`. When there is more than one,
restate that the full record goes to each, so the audience is the union. Name the
environment if it is not `prod`. Restate that raw transcript records are
structurally sanitized but **not** secret-scrubbed, and that this now applies to
every destination you just named.

If `removed` is non-empty, name each removed Neurospace: this project **no longer
sends** to it. Its Neurolink is **left in place and idle** — nothing was disabled
or deleted; the user can remove it in Augenta if they want it gone.

If `unresolvedNeurolinkIds` is present, say that this project listed those
Neurolinks but they are no longer readable, so they have been dropped.

On `partially_connected`, report the truth in that order: which destinations
**are** live now (capture to them is on) — including the full-record and
secret-scrubbing points above, which apply to them exactly as on `connected` —
then which **failed**, with each `message`. A `failed` entry with
`wasConnected: true` is a destination this project **was** feeding and no longer
is; say that plainly rather than calling it a destination that could not be added.
The project is connected to the subset in `destinations` and to nothing else.
Re-running connect retries the rest; the failed destinations do **not** retry
themselves. Do not describe the result as connected to everything the user
selected.

Mention that deleting `.augenta/config.json` or setting
`AUGENTA_CAPTURE_ENABLED=0` disables activity and memory capture. There is no
"select nothing" answer that disconnects an already-connected project — deleting
the config is how the user turns it all off.

On `status: "error"`, report `message`. `unknown_neurospace` means an id did not
match the organization's live list and **nothing was created** — re-run `--probe`
and ask again rather than guessing. `no_destination_linked` means no destination
could be linked and no config was written. Other common causes are a missing Node.js
runtime, a declined or expired authorization, no active Neurospaces, or an
organization not yet provisioned in Augenta.

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
- Never add a destination the user did not select in the answer you just
  received, and never carry a destination forward from a previous run without
  showing it selected.
- For Claude Code, name the command `/augenta:connect`.
- For Codex, use `$augenta:connect` when skills are addressable, or the phrase
  "Connect Augenta."
