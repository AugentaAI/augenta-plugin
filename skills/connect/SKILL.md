---
name: connect
description: Connect the current project to Augenta Workspaces through Connectors. Use when the user runs /augenta:connect, invokes $augenta:connect, or asks to connect or enable Augenta. The user signs in to Augenta once, explicitly selects every Workspace this project should feed, and the project records a profile reference, environment URLs, organization and destinations.
allowed-tools: AskUserQuestion, Bash, Read
---

# Augenta Connect

Connect the current project to Augenta activity and project-memory capture.
Connected projects send normalized activity steps, structurally sanitized raw
transcript lines, and matching scrubbed memory documents through one inbound
Connector per explicitly selected Workspace. **Every selected Workspace
receives the full record — the same activity and memory, complete, in each.**
Connection is per project and is the user's consent boundary.

You run the connect script yourself and drive it with `--json`. Each verb returns
one JSON object and exits. The user's only jobs are answering the Workspace
question, naming a new Workspace if they choose to create one, and, if they are
not signed in yet, clicking one link.

## The script

Resolve the script once, before step 1, from the absolute path of the directory
this file was loaded from. Your harness tells you that path when it loads a skill:
Claude Code prepends `Base directory for this skill: <path>`, and Codex resolves
the skill's alias through its skill-roots table. This file lives at
`<plugin root>/skills/connect/SKILL.md`, so the script is two levels up:

```bash
ls -l "<skill directory>/../../dist/scripts/connect.mjs"
```

Do **not** build that path from `$CLAUDE_PLUGIN_ROOT`. That variable is exported
only to processes the plugin system spawns — this plugin's hooks and MCP
servers — and not to the shell your Bash tool runs in, where it is empty and
silently expands to a broken `/dist/scripts/connect.mjs`. Deriving it from the skill
directory also guarantees you run the same installed version as these
instructions, which a versioned-cache glob does not.

Only if your harness did not give you this file's directory, find the install:

```bash
ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/augenta/*/dist/scripts/connect.mjs \
      "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/augenta/*/dist/scripts/connect.mjs 2>/dev/null
```

Every verb below is then:

```bash
node "$CONNECT" --json <verb>
```

`$CONNECT` stands for the absolute path you just resolved — substitute it
literally into each command. Do not assign it as a shell variable: each Bash call
is a fresh shell, so the assignment would not survive to the next verb.

Node is required — the same runtime the plugin's hooks use. It is a prebuilt
bundle, so there is nothing to install and no dependencies to fetch.

## If this turn cannot finish a sign-in, print the command and stop

Signing in needs a person to open a link during **this** turn. Some turns cannot
get one: `--permission-mode plan`, a `-p` / print-mode run, or any turn with no
interactive user on the other end. There the deliverable is **the resolved
command, printed** — never a started sign-in. A grant nobody can complete only
expires, and waiting on it hangs the turn until something kills it.

Decide this **before step 1**. If the turn cannot sign in:

1. Resolve the script as above and confirm it exists (`ls -l`).
2. Print the command as one literal line, with the path fully resolved — an
   absolute path, no `$CONNECT`, no `~`, no variables:

   ```
   node /absolute/path/to/dist/scripts/connect.mjs
   ```

3. Say in one sentence what it does: connects this project to Augenta
   Workspaces and asks which ones it should feed.

Then stop. Do not run `--login`. Do not narrate the sign-in flow — describing a
link this turn cannot produce reads as though one is already waiting.

That printed form is the human entry point and needs no `--json`: run bare, the
script requires a real terminal and drives the questions itself. It is the only
situation in which the user runs the command instead of you — everywhere else
you run it, and the rules below apply.

Every payload includes `environment` and `projectRoot`. **When `environment` is
not `prod`, say so** in both the question and the confirmation: connecting a
project to a dev or staging Workspace by accident is silent otherwise.

When `environmentChange` is present, say the project is moving from `from` to
`to` before the destination question and in the confirmation.

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
which Workspaces this project feeds — continue, do not stop.

`current` describes the saved connection before live checks: its `environment`,
`organization`, and `destinations` (including saved names). Use it for context;
the live top-level `destinations` and Workspace list win when choosing the set.

If `current.authMode` is `api-key`, state before the destination question that
browser connection will replace this project's platform-key configuration with
the selected sign-in and Workspaces. The saved key is never shown or copied.
`alreadyConnected: true` does not mean this is already a browser connection.

`destinations` lists the Workspaces the project feeds right now; use it to
pre-select in step 3. Two cases there need saying out loud rather than quietly
dropping, because the project is still shipping to them and the answer in step 3
replaces the whole set:

- `unresolvedConnectorIds` — destinations whose Connector you cannot read at all.
- a `destinations` entry with no `workspaceName` — its Workspace is no longer in
  the organization's list, so it cannot be offered as an option in step 3 and will
  be dropped by whatever the user answers.

## 2. Sign in, only if `--probe` said `need_login`

Ask whether to sign in to Augenta, in one sentence: capture is per project, it
sends this project's agent activity and matching project memory, and sign-in is
stored globally in `~/.augenta/auth.json` while the project records a profile
reference, environment URLs, organization and chosen destinations. If the user declines, acknowledge and
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
- `need_workspace` — signed in. Go to step 3.
- `status: "error"` — report `message`. `login_denied` means the user declined, so
  do not silently retry.

`login_expired` means the link was never opened. **Say so and stop there.** Do not
mint a replacement on your own: only run `--login` again after the user asks for a
fresh link. A link nobody opened is usually a user who stepped away or changed
their mind, and re-minting unprompted turns that into an unbounded loop of dead
links — which is exactly how this skill once hung a non-interactive turn until it
was killed.

## 3. Choose the Workspaces

This single question is both the consent gate and the target choice, so it is the
one step that always happens. **The answer is the complete set of destinations
and must be non-empty** — the project will feed exactly what the user selects
here and nothing else, and a successful connection must feed at least one Workspace.
Everyone has their own `Default Workspace`. Ask it every time,
including when that is the only Workspace and including when the project is
already connected. Never offer to keep the current selection without showing it;
never treat one answer as authorization for more than one destination; never
proceed on silence.

Before the user answers, say — in one or two sentences, naming the organization
from `signedInAs`:

- every Workspace they select receives the **full record**: this project's agent
  activity, its raw transcript lines, and its project memory, complete, in each;
- so **anyone with access to any selected Workspace can read this project's
  captured activity** — the audience is the union of all of them;
- and, if `environment` is not `prod`, which environment this is.

For Codex, also explain that capture starts with native turns beginning after
connection: the connection turn and older history are excluded. Project-memory
capture keeps its existing scope.

**If your harness's user-input mechanism can offer several options at once**, ask
one question listing every entry from `workspaces`, with the Workspaces in
`destinations` already selected, plus a final option `Create a new Workspace`.

**If it cannot**, ask in plain text: number the entries, mark the current
destinations, add `Create a new Workspace` as the final numbered option, and say
`Reply with every number you want. Choose at least one Workspace.` A valid
numbered selection is the user's consent: run the verb from that selection
without asking for a second yes/no confirmation.

An empty answer or `none` is not a valid destination set: ask again and do not
run the verb. If the user cancels the flow, acknowledge and stop; for an already
connected project, cancellation leaves its current destinations unchanged.

If `Create a new Workspace` is selected, it must be the only selection. Ask for
the name and state that it will be created in the named organization. Selecting
the create option and supplying a non-empty name is the explicit creation
request, so do not add a second yes/no confirmation. Then shell-escape the name
as one argument and run:

```bash
node "$CONNECT" --json --create-workspace <name>
```

If `--probe` returned `need_profile`, add `--profile <profileId>`. On
`status: "need_workspace"`, name `createdWorkspace`, use the returned refreshed
`workspaces` list, and ask the required non-empty destination question again.
Creating a Workspace does not connect the project or select that Workspace by
itself. On `workspace_created`, creation succeeded but the refreshed list failed:
name `createdWorkspace`, run `--probe` once, and continue from its live list; do
not create the Workspace again. On `status: "error"`, report `message`; do not
claim creation succeeded.

```bash
node "$CONNECT" --json --workspace <id> --workspace <id>
```

Repeat `--workspace` once per selected Workspace. Pass the `id`s, never the
names. The arguments are exactly the entries the user selected from the list you
rendered — never a destination the user did not select, and never one they
dropped. If `--probe` returned `need_profile`, ask which organization first and
add `--profile <profileId>`.

Creation and connection are separate calls: never pass `--create-workspace` and
`--workspace` together, which is refused as `conflicting_verbs`.

## 4. Confirm

Connector creation proves configuration only. After the next completed turn,
run the same installed `dist/scripts/connect.mjs` with `--project <projectRoot> --json --health` to check activity. If dispatch is absent, direct the user to
review the plugin hooks in their host and follow its activation/restart guidance.
Never change host trust records or invoke capture/delivery manually as proof.
Report API acceptance separately from verified ingestion.

On `connected`, name **every** entry in `destinations` — this project now feeds
each of them, through that entry's `connectorId`. When there is more than one,
restate that the full record goes to each, so the audience is the union. Name the
environment if it is not `prod`. Restate that raw transcript records are
structurally sanitized but **not** secret-scrubbed, and that this now applies to
every destination you just named.

If `removed` is non-empty, name each removed Workspace: this project **no longer
sends** to it. Its Connector is **left in place and idle** — nothing was disabled
or deleted; the user can remove it in Augenta if they want it gone.

If `unresolvedConnectorIds` is present, say that this project listed those
Connectors but they are no longer readable, so they have been dropped.

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
`AUGENTA_CAPTURE_ENABLED=0` disables activity and memory capture. A completed
connection always has at least one Workspace; deleting the config is how the user
turns capture off.

On `status: "error"`, report `message`. `unknown_workspace` means an id did not
match the organization's live list and **nothing was created** — re-run `--probe`
and ask again rather than guessing. `no_destination_linked` means no destination
could be linked and no config was written. `workspace_required` means the caller
sent no destination; ask the required question again. Other common causes are a
missing Node runtime, a declined or expired authorization, no active Workspaces,
or an organization not yet provisioned in Augenta.

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
- **You** must never write or hand-edit `.augenta/config.json` — on this path the
  connect script owns its permissions and layout, and editing it yourself is how a
  key would end up in your context. Note this is a constraint on *you*, not a
  claim about the file: an autonomous client is configured precisely by writing it
  from config management, with no agent involved. `--verify-only` checks the key a
  project already has without writing anything, so it is the one api-key-adjacent
  command that is safe for you to run if asked to confirm a connection.
- Never add a destination the user did not select in the answer you just
  received, and never carry a destination forward from a previous run without
  showing it selected.
- For Claude Code, name the command `/augenta:connect`.
- For Codex, use `$augenta:connect` when skills are addressable, or the phrase
  "Connect Augenta."
