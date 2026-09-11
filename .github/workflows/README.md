# GitHub workflows — augenta-plugin

Six workflows, built around one principle: **"does it work?" is decided by a
deterministic check, not by an LLM's opinion** — and every forward gate (formal approval,
merge) stays human-owned.

| Workflow | Trigger | What it does | Can it change code? |
|----------|---------|--------------|---------------------|
| `ci.yml` | every PR · push to `main` · nightly | the deterministic gate: four offline agent gates · typecheck · test · a real marketplace install into both the `claude` and `codex` CLIs | no (`contents: read`) |
| `claude-auto-triage.yml` | issue **opened** | classifies and labels for documentation, then stops — the only step with no human in the loop | no (`contents: read`) |
| `claude-code-review.yml` | PR opened / synchronize / ready / reopened, or dispatched | the READ half: posts inline findings as `claude[bot]` plus one marked summary as `github-actions[bot]` | no (`contents: read`) |
| `claude-review-fix.yml` | `workflow_run` after the review | the WRITE half: applies the inline findings, verifies with this repo's own gates, pushes `fix(review):` commits, resolves the threads it proved fixed | **yes** (`contents: write`) |
| `claude.yml` | `@claude …` on an issue/PR/review | the on-demand bot: runs dev/test commands, can edit code and open/update PRs | **yes** (`contents: write`) |
| `cancel-stale-runs.yml` | PR **closed** | reaps PR-ref runs still in flight when the PR closes | no (`actions: write` only) |

## Prerequisite

The four Claude workflows need a repo secret:

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo AugentaAI/augenta-plugin
```

Without it the jobs run and do nothing. It is a *repo-level* secret rather than an org
secret, so it has to be set on this repository separately.

## `ci.yml` — the deterministic gate

Two jobs, `contents: read` only, superseded runs cancelled:

1. **`typecheck + test`** — four offline agent gates first (below), then
   `bun install --frozen-lockfile` (fails on lockfile drift), `bun run build`,
   `bun run typecheck`, `bun test`, and a byte-comparison proving the committed `dist/`
   matches a fresh build.
2. **`Claude + Codex marketplace install smoke test`** — installs the plugin into the real
   `claude` and `codex` CLIs and asserts the reported version, every skill in `skills/`,
   and the hook count. Every expected value is *derived* from `package.json` /
   `hooks/hooks.json`, never hardcoded — a hardcoded version silently rotted through a
   release once already.

This is the single source of truth for "this branch is green."

It also runs **nightly against `main`**, which the two PR triggers cannot replace: the
smoke job installs the `claude` and `codex` CLIs unpinned from npm, so their next release
can break a plugin nobody touched. A no-change run is what catches that before somebody's
unrelated PR does.

### The four offline gates

They run first, before any toolchain, because each costs under a second and each guards a
failure that is **silent** — nothing turns red, the agent simply loses a capability or an
assertion starts lying.

| Gate | What it refuses |
|---|---|
| `.github/gates/claude-allowlist-shape.sh` | an `--allowed-tools` value that is not ONE quoted argument (the action word-splits it and shreds every `Bash(...)` pattern containing a space); a bare ` *` where the `:*` prefix wildcard was meant; approve/merge/`gh api` granted to either review half; a write tool in the read-only half; and a reviewer or fixer missing any piece of the incremental-review or budget machinery |
| `.github/gates/claude-fix-resolution.sh` | a post-fix resolver that would resolve anything but a fresh finding reported `fixed` by a commit proven to be on the PR's first-parent line **and** on origin. `gh` is a fixture; nothing touches the network |
| `.github/gates/claude-fix-rounds.sh` | a round counter that miscounts the budget in either direction — under-count and the fix cycle never ends, over-count and the agent stops fixing things a human asked for |
| `.github/gates/workflow-pipefail-grep.sh` | three pipelines whose reported status is not the status of the thing that mattered: `… \| grep -q` under `pipefail`, `curl … \| bash`, and a command substitution piping into a consumer that stops short |

The two privileged helpers they exercise live in `.github/scripts/`, not `scripts/` —
`scripts/` is the plugin's *runtime* surface and ships to users, while `.codexignore`
prunes `.github/` from the Codex bundle.

## The autonomous edges

`claude-auto-triage.yml` labels a freshly opened **issue** and stops. This repo has no
`type:`/`area:`/`complexity:` label schema — only GitHub's defaults plus `codex` — so the
agent reads `gh label list` first and applies **only** labels that already exist. Area and
complexity are recorded in the triage comment as prose instead of being dropped, and there
is no `topic:security` label, so a security-sensitive report is flagged at the top of the
comment body.

It used to carry a second `triage-pr` job that labelled newly opened PRs. That was dropped:
it labelled PRs the maintainers opened themselves, against a label schema this repo does
not have, and the review already reports the PR's intent and the surface its diff touches.

## The review, in two halves

`claude-code-review.yml` is the **read** half. It reviews the merge ref with
`contents: read`, posts line-specific findings with the inline-comment tool as
`claude[bot]`, and returns a typed summary that the *workflow* — not the model — posts as
`github-actions[bot]` carrying a `<!-- augenta-code-review -->` marker. The model is not
granted `gh pr comment`, `gh pr review`, `gh pr merge` or `gh api`, so it cannot post a
top-level comment, approve, or merge. The brief points at `AGENTS.md` rather than
restating it, so the two cannot drift apart.

The review deliberately does not re-derive what `ci.yml` proves. It exists for the class of
defect that compiles, passes, and installs while breaking an `AGENTS.md` invariant: a
credential reachable through the agent, consent defaulted or carried forward, a
non-atomic version bump, a hook timeout over-declared past what Codex accepts, an
entrypoint importing another entrypoint, a shipped source changed without a rebuilt
`dist/`.

`claude-review-fix.yml` is the **write** half. It runs on `workflow_run` after the review —
which means GitHub executes the copy on the **default branch**, never the PR's, so a pull
request cannot rewrite the workflow that holds write access to its own branch. It starts
only when that specific review run left inline findings (bounded by the run's start and
completion timestamps, so a finding already fixed, or posted by a later concurrent review,
never enters its prompt). It merges `origin/main`, applies the findings, verifies with
`bun install --frozen-lockfile` / `bun run build` / `bun run typecheck` / `bun test` /
`git diff --check`, and pushes `fix(review):` commits only if those are green.

The model returns one typed disposition per finding. A **trusted workflow step** — running
`.github/scripts/resolve-fixed-review-threads.sh`, downloaded at `github.workflow_sha`
rather than executed from the PR checkout — resolves only the conversations whose named
fixing commit is on the PR's first-parent line after the reviewed head **and** actually
reached origin. `git push` is all-or-nothing per ref, so a push rejected for touching
workflow YAML leaves every fix commit in the runner's `HEAD` and none on the PR; asking
origin is what tells those apart. Omitted findings, `not_fixed` findings, and cross-file
fixes that cannot prove the binding all stay open.

The agent may not modify a workflow **definition** — any `.yml`/`.yaml` under
`.github/workflows/`. That is prompt text, but the job token refuses such a push
structurally. Other files in that directory, this README included, remain fixable.

### Incremental reviews, and two budgets

The fix agent's push is a `pull_request: synchronize` event like any other, so it starts a
fresh review. Left alone, review → fix → push → review has no natural end. Two guards:

- **Every review after the first is incremental.** Each summary records the head it
  reviewed (`<!-- augenta-code-review-head: … -->`). The next review is scoped to
  `git diff` from that head, is handed the `🔧 fix-agent` report so it can check each
  claimed fix against its fixing commit, and is told not to raise anything about code
  unchanged since. A clean round posts no inline finding, so the fix half has nothing to
  do and the cycle ends there.
- **Both halves have a lifetime budget that never resets.** `MAX_AUTOMATED_REVIEWS` (2)
  automatic reviews — the PR, then the fix round — after which a push starts nothing and
  one `<!-- augenta-code-review-budget -->` notice says so. `MAX_FIX_ROUNDS` (2) fix
  rounds, counted by `.github/scripts/count-review-fix-rounds.sh` from the `🔧 fix-agent`
  comments floored by the agent's pushes bucketed between review summaries, after which
  triage leaves the findings open, completes the PR check `neutral`, and posts one
  `<!-- augenta-review-fix-cap -->` notice.

Past the budget a person fixes by hand, or runs a review manually (below), which ignores
the budget and does not start the fix half.

### `Claude Code Review / fix` in the PR checks

GitHub displays a `workflow_run` run under `main`, detached from the PR. The fix workflow
therefore creates a check run named `Claude Code Review / fix` against the reviewed head
SHA and completes it with the outcome — `success` when there was nothing to fix, `neutral`
at the round cap, `failure` when the agent failed. Execution stays in the trusted context;
only the visibility is mirrored.

⚠️ **A `fix(review):` push may get no CI run.** GitHub frequently holds the runs a
bot-actor push starts at *action_required* until a maintainer clicks *Approve and run* —
which is also what can stall the second round. Read the head SHA on the PR's checks before
concluding a fix was verified by CI; the agent running the gates itself is the check that
is actually guaranteed.

## `claude.yml` — the on-demand `@claude` bot

Triggered when a teammate writes `@claude …` on an issue, PR, or review (works from the
GitHub mobile app too). It runs with `contents: write` and its allowlist includes
`Edit`/`Write`, `git commit`, and `git push` — so it **can** alter code and open PRs.

What it cannot do is **merge**. `gh pr`, `gh issue`, and `gh label` are enumerated by
subcommand rather than wildcarded, specifically to withhold `gh pr merge` and every
`delete`. The merge gate itself is enforced by GitHub: the `protect-main` ruleset on the
default branch requires both `ci.yml` checks, one approving review, and a squash merge.
The allowlist is defense in depth behind that — a `gh pr *` wildcard plus `contents: write`
would let a prompt-injected issue comment talk the bot into *trying* to merge its own
unreviewed work, and not handing it the verb costs nothing, since a human merging is no
hardship.

The `claude` and `codex` CLIs are deliberately not installed in this job; the
marketplace-install check lives in `ci.yml` and runs on any PR the bot opens.

## Activation facts that cause confusion

- **`issues` and `issue_comment` events read the workflow from the DEFAULT branch.** So
  issue triage and `@claude` go live only after the workflow is merged to `main` — they
  cannot be tested from a PR.
- **`pull_request` events read it from the PR head.** So `claude-code-review.yml` is the
  only Claude workflow whose file a PR can change before a merge — and
  `claude-review-fix.yml`, on `workflow_run`, always runs `main`'s copy.
- **A PR that edits a Claude workflow gets a green check that reviewed nothing.** The
  action refuses to run when the file differs from the default branch — `Skipping action
  due to workflow validation` — and reports that skip as **passing**, in about 11 seconds.
  So the automatic path can never test a change to itself, and a fast green here means
  "skipped", not "approved". Use the manual trigger below to get a real review.
- **Fork PRs are skipped, not failed.** A fork `pull_request` gets a read-only token, no
  secrets and no OIDC grant, so `id-token: write` is ignored and the action dies with
  `Could not fetch an OIDC token` rather than skipping politely. Both review halves
  therefore require `head.repo.full_name == github.repository`. The consequence is real:
  **a teammate's fork PR gets no automated review and no fix round.** The remedy is
  process, not YAML — push branches to `AugentaAI/augenta-plugin` directly.
  `pull_request_target` is not an option; see the safety section below.

## Running a review on demand

`claude-code-review.yml` takes a `workflow_dispatch` with a PR number:

```bash
gh workflow run claude-code-review.yml -f pr=42
```

A dispatch runs from the default branch, so the file always matches its own copy and the
validation skip cannot fire. This is the only reliable way to exercise the review — after
changing the workflow, after setting the token, or against a draft. The draft filter is
deliberately bypassed on this path: a dispatch is explicitly human-invoked. A manual review
does not count against `MAX_AUTOMATED_REVIEWS` and the fix half does **not** follow it
(it triggers only on a `pull_request`-event review run). It is incremental whenever the
head has moved since the last recorded one; an unchanged head with no fix report to
verify falls back to a full review, because there is nothing else for an incremental
pass to look at.

## Why this is safe on a public repo

Three layers, none of which depend on the secret being kept out of a log:

1. **Actions secrets are write-only and fork-invisible.** GitHub never renders a secret's
   value back to anyone, including admins — `gh secret list` shows names and timestamps
   only. A `pull_request` from a fork gets a read-only `GITHUB_TOKEN` and **no secrets at
   all**; that is GitHub-enforced and not configurable per workflow. Values are masked as
   `***` in logs. There is no `pull_request_target` anywhere in this directory, which is
   the usual way a public repo leaks secrets to fork-controlled code.
2. **The action refuses non-write actors.** Per `anthropics/claude-code-action`'s
   `docs/security.md`, it only runs for a triggering user with **write access to this
   repo**, checked on issue, PR, comment, and review events. A stranger commenting
   `@claude …` on a public issue does not start the bot.
3. **Bots are named, never `'*'`.** Allowlisted bots are explicitly *not* permission-checked
   and do not need write access or an installation, so `allowed_bots: '*'` is a hole
   straight through layer 2 and stays out. The two review halves name exactly one:
   `github-actions[bot]`, because the fix push arrives under that actor and the incremental
   review of it — and the second fix round — must be able to start. That actor can only
   arise from an action taken with this repository's own token, and every chain producing
   one begins with a write-access human. `claude.yml` and `claude-auto-triage.yml`
   allowlist no bot at all.

Two repo settings finish the job, both under **Settings → Actions → General**: set *Fork
pull request workflows from outside collaborators* to **Require approval for all outside
collaborators**, and leave *Workflow permissions* at **read repository contents**. Neither
is a substitute for the `permissions:` block each workflow already declares.

`ci.yml` and `cancel-stale-runs.yml` need no secret and are unaffected by all of this.

## The `--allowed-tools` footgun

`--allowed-tools` must be **one quoted, comma-separated argument** using `:*` wildcards:

```yaml
claude_args: >-
  --allowed-tools
  "Read,Grep,Bash(gh pr comment:*),Bash(git diff:*)"
```

A list of separately-quoted patterns gets word-split by the action, which shreds every
pattern containing a space (`Bash(git diff *)`, `Bash(gh pr *)`). The agent's `gh` and
`git` calls are then silently denied **while the job still reports success** — a green run
that did nothing. Use `:*`, not a bare `*`, and use the hyphenated flag rather than the
camel-case spelling. `.github/gates/claude-allowlist-shape.sh` enforces all three, so this
is a gate rather than a warning.

## Verify

```bash
bash .github/gates/claude-allowlist-shape.sh
bash .github/gates/claude-fix-resolution.sh
bash .github/gates/claude-fix-rounds.sh
bash .github/gates/workflow-pipefail-grep.sh

bun install --frozen-lockfile
bun run build
bun run typecheck
bun test
git diff --check
```

```bash
claude --plugin-dir . plugin details augenta
```

The plugin surface must be unchanged by anything in this directory: the manifest version,
both skills, every event in `hooks/hooks.json`, and no load errors. The repo's dev
skills live under `.claude/skills/` precisely so they stay out of that surface —
`skills/` at the repo root is asserted to hold exactly the plugin's product skills
(`connect` and `recall`).
