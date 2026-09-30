# Changelog

All notable changes to the Augenta plugin, newest first. Each version is tagged
`vX.Y.Z` in this repository.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
except that there is no Unreleased section: every entry lands under the version
that ships it. Versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html),
with one caveat: before 1.0, **old project configs are not carried forward**, and
an entry that needs you to reconnect says so.

Both marketplaces install from `main` and show no release notes, so this file is
where to read what changed.

## [0.11.0] — 2026-09-29

### Upgrading

- **Reconnect each browser-connected project once.** This version stores the
  connection in a new format and does not read the old one. Run connect in the project: it
  asks you to confirm your Workspaces, keeps using your existing Connectors, and
  keeps the project's environment and any URL overrides. Projects connected with
  a platform key keep working as they are.
- **Update Codex's copy of the plugin before reconnecting.** An older cached copy
  cannot read the new format and asks to reconnect again.
- **Codex asks once to approve the updated prompt hook**, because its timeout
  changed.
- **Worktrees:** if a project in a Git worktree was connected from the main
  checkout, connect once from the worktree itself (see Fixed).

### Added

- **Automatic recall, if you turn it on.** Connect now asks whether the project
  should look up past work each time you submit a prompt. Off is pre-selected.
  When it is on:
  - The plugin asks the project's Workspaces what they remember about the prompt
    and passes any match to your agent as background. It asks for saved memory
    only; no Augenta answer model runs.
  - Pasted blocks and common secret patterns are removed first. Commands and
    replies under three words are skipped.
  - It waits at most five seconds. If Augenta is slow, offline or has nothing
    saved, the prompt goes ahead as usual.
  - Each prompt leaves a one-way fingerprint of the question in each Workspace,
    as any recall does. The recalled text is never captured back.
  - Ask your agent to turn it on or off at any time, without reconnecting.
    `AUGENTA_CAPTURE_ENABLED=0` pauses it along with capture, and
    `AUGENTA_AUTO_RECALL=0` turns off only automatic recall, for every project.
    `/augenta:recall` works either way.
  - A project connected before connect asked this keeps it on until you change
    it or reconnect.
- **Share a project's setup through Git.** A browser-connected
  `.augenta/config.json` now holds no sign-in token and no Connector, so you can
  commit it and everyone who checks out the repository points at the same
  Workspaces. Git sees only that file; the rest of `.augenta/` stays out.
  - Each checkout joins once. Connect signs you in if needed, shows the
    project's Workspaces with the usual disclosure, and asks whether to use them.
  - You send through your own Connector in each Workspace. It is made the first
    time you join and reused by your other clones, worktrees and cloud sessions.
  - You need access to every Workspace the project records, so someone may need
    to add you. Nothing is created until that access is confirmed.
  - If a pulled change adds or removes a Workspace, capture stops in each
    checkout until someone there confirms the new set. The same happens when
    someone else signs in on that machine, and connect says how much of the
    first person's queued work was left unsent.
  - Everyone sharing a config needs 0.11.0 or newer. Platform-key configs hold
    the key, so connect never lets Git see them.
- **Cloud sessions.** Connect recognizes a session whose machine is discarded
  when it ends, such as Claude Code or Codex in the cloud, and says before
  sign-in that the sign-in lasts only for that session. There it refuses to
  connect a folder outside a Git repository, because nothing could outlast the
  session. [README](README.md#cloud-sessions) explains what runs where.
  `AUGENTA_EPHEMERAL=1` or `0` overrides the detection.
- **Proxy support.** Where `HTTPS_PROXY` or `HTTP_PROXY` is set, as in cloud
  sessions and Cowork's VM, connect, recall and the hooks send through that
  proxy and trust the sandbox's own proxy certificate. This needs Node.js 22.21
  or newer; older versions ignore the proxy.

### Changed

- **`/augenta:recall` answers by default.** Augenta's model writes an answer
  from your Workspaces. Use `/augenta:recall context <question>` for the matching
  memory without a model call. If the model is unavailable, recall falls back to
  memory once and your agent says so.
- **Capture needs this machine's sign-in.** Where the saved sign-in for a
  browser-connected project is missing, for example in a fresh cloud session or
  after deleting `~/.augenta/auth.json`, capture stops instead of queueing, and
  session start says to sign in. An expired sign-in still queues, as before.
- **Recall checks each Connector before asking.** Disabled links are skipped,
  and Workspace names are refreshed for display without rewriting the config.
- **Simpler guides.** Setup, recall and privacy guidance is shorter, with
  separate pages for [connection settings](docs/configuration.md) and
  [how the plugin works](docs/architecture.md).

### Fixed

- **Blocked networks are named.** Behind an allowlisting proxy, connect used to
  fail with "Request was cancelled." before asking anything. It now checks
  `augenta.ai`, `auth.augenta.ai` and `api.augenta.ai` and says which are
  blocked and why. Other network errors name a proxy refusal, a dropped
  connection or a timeout instead of Node's generic wording.
- **Windows sign-in link.** Connect opens it through the system's URL handler
  instead of `cmd /c start`, which re-read the link as a command line: an `&` in
  a crafted link could have started a second command.
- **Worktrees.** Connecting from a Git worktree now connects that worktree,
  where its hooks read configuration. The main checkout and sibling worktrees,
  including nested ones, stay separate. Symlinked folders follow the checkout
  they physically belong to.
- **Codex memory** counts as this project's only when the folder it names
  physically lies inside the project, however it was reached (`/tmp`, `/var` or
  a symlinked projects folder). Memory already captured for a folder that was
  only symlinked in is withdrawn at the next Codex memory scan.
- **Codex harness labels.** Connect passes the harness explicitly, and a missing
  hint no longer labels an agent as Claude Code or overwrites an existing label.
  `connect --json --repair-harness --harness codex` fixes the labels on this
  project's own Connectors without reconnecting.
- **Capture health** tells a missing configuration from an invalid one.
- **Platform keys.** A key whose Connector assignment is malformed is refused
  before it replaces the project's config.
- **Cloud layouts.** A Claude Code transcript under `/root/.claude/projects/` is
  no longer mistaken for Codex, and Codex memory is found under a non-default
  Codex home such as `/opt/codex`.
- **`claude -p` in an unconnected project** no longer starts with an extra
  `/augenta:connect` turn ahead of your prompt. Interactive sessions are
  unchanged.
- **Unreadable configs are always raised.** A config that becomes unreadable
  after an earlier reconnect prompt gets the prompt again, instead of turning
  capture off in silence. Projects whose config was already unreadable see it
  once more.

## [0.10.2] — 2026-09-11

### Fixed

- Codex capture uses native turn IDs, so delayed reads and missing prompt hooks
  no longer combine known turns. Unknown history is marked explicitly. Concurrent
  capture processes serialize their cursor updates.
- Local capture health separates hook activity, capture, pending delivery and API
  acceptance. Success timestamps survive queue compaction and later failures.
  Check with the installed connect bundle's `--project <path> --json --health`.

### Changed

- New connections exclude Codex turns that started before connection, including
  the connection turn. Existing configs keep their scope until reconnected;
  reconnecting sets a new capture baseline. No reconnect is required for the
  native-turn fix. Project-memory and destination selection retain their scope.
- Added a real installed Codex lifecycle regression with a local fixture receiver.
  Active desktop approval/activation and hosted ingestion remain release acceptance
  requirements; these changes do not claim to resolve an unobserved host dispatch
  failure. No hook manifest or host trust records are changed.

## [0.10.1] — 2026-09-08

Claude captures now distinguish tools the harness denied from tools that ran and failed.
Recognized skill-instruction injections, aborted assistant fragments, and standalone user
interruption notices no longer become memory events; their raw records remain available.
Command output and interrupted running-tool results remain captured. No reconnect is required.

## [0.10.0] — 2026-09-05

### Added

- **`/augenta:recall` — ask your Workspaces what they remember.** A connected
  project can now read back what it has been feeding Augenta. Run
  `/augenta:recall what did we decide about the landing path` in Claude Code, or
  `$augenta:recall` in Codex; your agent also reaches for it on its own when you
  ask what was decided, tried, or learned before.

  Every Workspace the project feeds is asked, in parallel, and each answer comes
  back labelled with the Workspace it came from. An answer is written by a model
  over the matching memory, so a call can take up to a minute.

  **Only your question leaves the machine** — no file contents and no transcript
  text. Augenta records that a recall happened; it keeps no copy of the question
  or the answer, only a one-way fingerprint of the question used to tell a retry
  from a new question. Recall reads; it changes nothing about what a project
  sends, and it asks only the destinations you already selected. Signed-in projects and
  platform-key projects both work; a platform key's Connector already fixes the
  Workspace, so there is nothing to choose there.

  A Workspace nobody has fed yet has nothing to recall — that is a normal
  answer, not an error. Recall is available where Augenta has it deployed and
  says so plainly where it is not.

  No reconnection is required: recall reads the `.augenta/config.json` you
  already have. `hooks/hooks.json` is unchanged, so Codex does not re-prompt for
  hook trust.

- `SECURITY.md` — what the plugin touches, how to report a vulnerability
  privately, and what is out of scope.
- `CONTRIBUTING.md`, issue forms, and a pull-request template.
- This changelog.

### Changed

- `AUGENTA_CAPTURE_ENABLED=0` is documented as the switch for **capture** only.
  Recall is a read, so it keeps working while a project has a config; deleting
  `.augenta/config.json` remains the one off switch for both.
- Both marketplace listings show `support@augenta.ai` as the owner contact,
  replacing a personal address.
- `README.md` was reorganized around what a user does — install, connect,
  recall, and what leaves the machine — and lost the contributor and deployment
  notes that belonged in `CONTRIBUTING.md` and `AGENTS.md`.

## [0.9.3] — 2026-09-04

### Fixed

- **The destination menu could be incomplete.** The Workspace listing is paged,
  and the connect flow read only the first page — so in a large organization a
  Workspace could be missing from the menu with nothing to indicate it. That
  menu *is* the consent question, so a partial list is a partial consent
  surface; the flow now follows the listing to the end, and refuses outright
  rather than offering a truncated one. A normal organization is still one
  request.
- **Delivery telemetry reported the previous version.** The background shipper's
  attribution carried its own hardcoded version string and had drifted a release
  behind. Both places that report a version now import one constant, and a gate
  fails on any version literal written elsewhere.
- Hardened a wildcard pattern in a bundled dependency. The plugin never
  exercises that code path, but `dist/` is shipped executable code and is
  patched at build time until the dependency is fixed upstream.

### Changed

- Corrected documentation that said an organization starts with one shared
  `Default Workspace`. Every member is provisioned their own.

## [0.9.2] — 2026-08-17

### Fixed

- **Hooks failed silently when Node was not on the harness's `PATH`.** Desktop
  apps can start with a much shorter `PATH` than an interactive terminal, and a
  package-manager `node` can be present but unloadable. Hook commands now go
  through a runner that accepts an explicit `AUGENTA_NODE`, checks the common
  version-manager installs, then scans `PATH`, and requires each candidate to
  actually start and report Node 20+. When no runtime is found it stays silent
  for an unconnected project and reports the problem only for a connected one —
  a missing Node is not evidence anyone opted in.
- **An empty answer to the destination question is rejected.** Connecting
  requires naming at least one Workspace; there is no auto-select, not even when
  only one Workspace exists.

### Changed

- Hook commands changed, so **Codex re-prompts for hook trust** on upgrade.

## [0.9.1] — 2026-08-16

### Fixed

- The Codex session-start hook emitted JSON Codex could not parse.
- The one automatic connect prompt on Codex described a connection already in
  progress — "starting connection", "reconnecting" — when nothing had started.
  It now states the fact and names the invocation to run, which is the whole
  point of the only prompt a project ever gets.

## [0.9.0] — 2026-08-14

### Changed

- **The plugin runs on Node 20+ and no longer requires Bun.** Bun previously had
  to be installed to run any hook, the shipper, or the connect script, so on a
  machine without it the hooks failed silently and connecting was impossible.
  Bun is now a contributor toolchain only and reaches no user.
- Every hook command changed, so **Codex re-prompts for hook trust** on upgrade.

### Fixed

- Only `https` sign-in URLs are handed to the platform browser opener. The URL
  comes from login discovery, and refusing anything else costs nothing — the
  link and code are always printed for the user to open themselves.

## [0.8.0] — 2026-08-13

### Changed

- **Renamed the destination concept to *Workspace*** across the API, the CLI
  flag, and the connect flow. The previous name was invented jargon for the
  same thing. README now says plainly, where the term first appears, that an
  Augenta Workspace is a destination in your organization's account and **not**
  a folder or an editor workspace; the local side is always the "project".
- This release only talks to a platform that has the same rename.

### Reconnect required

Every connected project must re-run `/augenta:connect`. The wire format the
plugin ships is unchanged, but the ids in an existing `.augenta/config.json` no
longer resolve. Autonomous clients need re-issued platform keys, since a key is
assigned to one Connector.

## [0.7.0] — 2026-08-12

### Changed

- **Renamed the routing surface to *Connector*** end to end: the API routes, the
  request header, and the `connectorIds` key in a project's config.

### Removed

- The single-destination read-forward from before fan-out. `connectorIds` is now
  the only routing key read, and only as an array — no version ever read a single
  value under the new name, so keeping one would have asserted a compatibility
  path that never existed.

### Reconnect required

Every project connected on an earlier version must re-run `/augenta:connect`.
There is no fallback read, so an unconverted project has no destination
configured and captures nothing.

## [0.6.0] — 2026-07-28

### Added

- **A project can feed several Workspaces.** The connect question is now a
  multi-select whose answer is the complete set of destinations, and one
  delivery reaches all of them.
- Because more than one destination is a stronger disclosure than the same one
  repeated, both the question and the confirmation state that **every** selected
  Workspace receives the full record — the same activity, transcript lines, and
  memory documents, complete, in each — so the effective audience is the union
  of everyone with access to any of them.
- Each destination keeps its own position in the project's outbox, so a
  temporarily unreachable Workspace catches up later without holding up the
  others. A permanently wedged one is bounded rather than allowed to fill the
  spool and start dropping records for everybody — and that discard only ever
  fires after several consecutive drains in which another destination made
  progress, so an offline stretch can never trigger it.

### Changed

- Reconnecting **replaces the whole set** and is asked every time. A destination
  you drop is named in the confirmation and stops receiving records immediately;
  its Connector is left in place and idle rather than deleted. Reconnecting never
  moves an existing Connector to a different Workspace, so history keeps its
  route.
- The platform-key path stays single-destination: it has no consent gate, and its
  config format has no field in which to express a route.

## [0.5.1] — 2026-07-28

### Fixed

- **Codex showed a permanent warning about the `SessionEnd` hook timeout.** Codex
  enforces a per-event *maximum* and caps shutdown-path hooks at 3s, so the
  declared 10s was silently clamped and reported as a disagreement. One manifest
  serves both harnesses, so a declared timeout must be the minimum they both
  allow.
- The clamp was load-bearing, not cosmetic: a kill at 3s could land before the
  shipper handoff and leave the outbox undrained, which is the exact problem
  `SessionEnd` was added to fix. It no longer scans memory — the heaviest step
  between reading the transcript and handing off — because `Stop` scans at the
  end of every turn and session start scans as the backstop.

## [0.5.0] — 2026-07-28

### Added

- **Subagent work is captured.** It was entirely invisible: a subagent's activity
  lives in its own transcript file, never inline in the parent, so a project saw
  the delegating call and its final result and nothing in between. Subagent turns
  are recorded under their own session identity so they cannot overwrite the
  parent's steps.
- The hook set moved from four events to eight, in a single release because every
  hook change re-prompts Codex users for trust.

### Fixed

- **Compaction could stop capture permanently.** The read position is a byte
  offset and nothing handled a rewritten transcript, so once the file was shorter
  than the cursor the tail was skipped forever. Three independent layers now cover
  it.
- **Sessions that ended without a stop stranded their queue** until the next
  session in the same project, which may never come — closing a desktop window is
  the common case. Session end is now the ordinary drain.
- **Reported cost was materially wrong.** Cache-creation and cache-read tokens
  were dropped entirely, and Codex reported no tokens at all. On a real
  transcript, cache reads were over five thousand times the counted input volume.
  Codex turns now also record the model.

## [0.4.0] — 2026-07-27

### Changed

- **Connecting a project is one question and, at most, one link to click.** It
  previously took six steps across two terminals: the agent printed a versioned
  cache path, you pasted it into another shell, authorized in a browser, answered
  a numbered menu, then came back to chat to say you had finished. The agent now
  drives the flow itself. A second project reuses the global sign-in and needs no
  link at all.
- **No credential passes through the agent.** The verbs the agent runs never
  accept a credential as an argument and never emit an access token, refresh
  token, or device code, so tokens travel from the browser to the owner-only
  global auth file without touching a transcript. The interactive terminal path
  is unchanged, and consent is asked before any network side effect.
- No user-facing string names the identity provider. Identity keys on Augenta's
  own user and organization ids, and a project's `authMode` is the
  provider-neutral `oauth`.

### Fixed

- Connecting from a git worktree wrote a config the real repository could never
  see, so every hook kept silently doing nothing. The main checkout is resolved
  instead, and the redirect is reported rather than applied silently.

### Reconnect required

A config written before 0.4.0 becomes a one-time reconnect prompt rather than a
reused credential that fails later as an unexplained 401.

## [0.3.0] — 2026-07-27

### Added

- **Sign-in replaces the setup script.** A project connects through an OAuth
  device grant; rotating tokens live only in the owner-only global auth file, and
  the project stores a profile reference and its destination ids.

### Fixed

- A project holding a pre-0.3.0 API-key config was treated as connected — so
  capture was off *and* the connect prompt was unreachable by construction, since
  it is gated on the file's absence. Capture died silently and permanently. An
  unreadable config is now treated as unconnected and gets its own one-time
  reconnect prompt.

### Reconnect required

Projects configured by the old setup script hold a credential under an
authentication scheme the platform no longer accepts. They are not migrated:
reusing the old credential would trade a clear reconnect for an unexplained
authentication failure.

## [0.2.3] — 2026-07-22

### Added

- First release: opt-in, per-project capture of coding-agent activity and project
  memory for Claude Code and Codex.

[0.11.0]: https://github.com/AugentaAI/augenta-plugin/compare/v0.10.2...v0.11.0
[0.10.2]: https://github.com/AugentaAI/augenta-plugin/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/AugentaAI/augenta-plugin/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/AugentaAI/augenta-plugin/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/AugentaAI/augenta-plugin/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/AugentaAI/augenta-plugin/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/AugentaAI/augenta-plugin/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/AugentaAI/augenta-plugin/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/AugentaAI/augenta-plugin/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/AugentaAI/augenta-plugin/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/AugentaAI/augenta-plugin/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/AugentaAI/augenta-plugin/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/AugentaAI/augenta-plugin/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/AugentaAI/augenta-plugin/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AugentaAI/augenta-plugin/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/AugentaAI/augenta-plugin/releases/tag/v0.2.3
