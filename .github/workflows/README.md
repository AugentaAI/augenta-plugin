# GitHub workflows — augenta-plugin

Four workflows, built around one principle: **"does it work?" is decided by a
deterministic check, not by an LLM's opinion** — and every forward gate (formal approval,
merge) stays human-owned.

| Workflow | Trigger | What it does | Can it change code? |
|----------|---------|--------------|---------------------|
| `ci.yml` | every PR + push to `main` | the deterministic gate: typecheck · test · a real marketplace install into both the `claude` and `codex` CLIs | no (`contents: read`) |
| `claude-auto-triage.yml` | issue **opened** | classifies and labels for documentation, then stops — the only step with no human in the loop | no (`contents: read`) |
| `claude-code-review.yml` | PR opened / ready / reopened | autonomous review via `.claude/skills/review-github-pr/SKILL.md`, posting one resolved verdict | no (`contents: read`) |
| `claude.yml` | `@claude …` on an issue/PR/review | the on-demand bot: runs dev/test commands, can edit code and open/update PRs | **yes** (`contents: write`) |

## Prerequisite

All three Claude workflows need a repo secret:

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo AugentaAI/augenta-plugin
```

Without it the jobs run and do nothing. This is a *repo-level* secret on the platform
repo too, not an org secret, so it has to be set here separately.

## `ci.yml` — the deterministic gate

Two jobs, `contents: read` only, superseded runs cancelled:

1. **`typecheck + test`** — `bun install --frozen-lockfile` (fails on lockfile drift),
   `bun run typecheck`, `bun test`.
2. **`Claude + Codex marketplace install smoke test`** — installs the plugin into the real
   `claude` and `codex` CLIs and asserts the reported version, exactly one `connect` skill,
   and the hook count. Every expected value is *derived* from `package.json` /
   `hooks/hooks.json`, never hardcoded — a hardcoded version silently rotted through a
   release once already.

This is the single source of truth for "this branch is green."

## The autonomous edges

`claude-auto-triage.yml` labels a freshly opened **issue** and stops. This repo has no
`type:`/`area:`/`complexity:` label schema — only GitHub's defaults plus `codex` — so the
agent reads `gh label list` first and applies **only** labels that already exist. Area and
complexity are recorded in the triage comment as prose instead of being dropped, and there
is no `topic:security` label, so a security-sensitive report is flagged at the top of the
comment body.

It used to carry a second `triage-pr` job that labelled newly opened PRs. That was dropped:
it labelled PRs the maintainers opened themselves, against a label schema this repo does
not have, and `claude-code-review.yml` already reports the PR's intent and the surface its
diff touches. It cost a run per PR to restate the review's opening paragraph.

`claude-code-review.yml` runs the repo's own review skill on a non-draft PR and posts a
resolved Approve / Request-changes / Needs-discussion verdict. It **comments only** — it
never edits, approves, or merges.

The review deliberately does not re-derive what `ci.yml` proves. It exists for the class of
defect that compiles, passes, and installs while breaking an `AGENTS.md` invariant: a
credential reachable through the agent, consent defaulted or carried forward, a
non-atomic version bump, a hook timeout over-declared past what Codex accepts. The skill
points at `AGENTS.md` rather than restating it, so the two cannot drift apart.

## `claude.yml` — the on-demand `@claude` bot

Triggered when a teammate writes `@claude …` on an issue, PR, or review (works from the
GitHub mobile app too). It runs with `contents: write` and its allowlist includes
`Edit`/`Write`, `git commit`, and `git push` — so it **can** alter code and open PRs.

What it cannot do is **merge**. `gh pr`, `gh issue`, and `gh label` are enumerated by
subcommand rather than wildcarded, specifically to withhold `gh pr merge` and every
`delete`. That matters more here than in the platform repo: **`main` is not currently
branch-protected**, so the allowlist is the only merge gate. A `gh pr *` wildcard plus
`contents: write` would let a prompt-injected issue comment talk the bot into merging its
own unreviewed work.

The `claude` and `codex` CLIs are deliberately not installed in this job; the
marketplace-install check lives in `ci.yml` and runs on any PR the bot opens.

### Recommended one-time admin setup

Not required for the workflows to run, but it turns the merge gate into something GitHub
enforces rather than something an allowlist withholds:

- **Settings → Branches → add rule for `main`:**
  - Require status checks to pass → select **`CI / typecheck + test`** and
    **`CI / Claude + Codex marketplace install smoke test`**.
  - Require a pull request before merging → require **at least 1 approval**.

With that in place, a broken or injected PR cannot merge even if a bot is tricked into
trying — the green check and human approval become hard gates.

## Two activation facts that cause confusion

- **`issues` and `issue_comment` events read the workflow from the DEFAULT branch.** So
  issue triage and `@claude` go live only after the workflow is merged to `main` — they
  cannot be tested from a PR.
- **`pull_request` events read it from the PR head.** So `claude-code-review.yml` is the
  only Claude workflow that runs at all before a merge.
- **A PR that edits a Claude workflow gets a green check that reviewed nothing.** The
  action refuses to run when the file differs from the default branch — `Skipping action
  due to workflow validation` — and reports that skip as **passing**, in about 11 seconds.
  So the automatic path can never test a change to itself, and a fast green here means
  "skipped", not "approved". Use the manual trigger below to get a real review.

## Running a review on demand

`claude-code-review.yml` takes a `workflow_dispatch` with a PR number:

```bash
gh workflow run claude-code-review.yml -f pr_number=42
```

A dispatch runs from the default branch, so the file always matches its own copy and the
validation skip cannot fire. This is the only reliable way to exercise the review — after
changing the workflow, after setting the token, or against a draft. The draft filter is
deliberately bypassed on this path: a dispatch is explicitly human-invoked.

Fork PRs get a read-only token and no secrets, so none of these jobs run for them — the
safe default.

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
3. **No bot bypass.** Allowlisted bots are explicitly *not* permission-checked and do not
   need write access or an installation. `allowed_bots: '*'` was therefore the one hole in
   layer 2 and has been removed; the default allows no bots. If a bot ever needs to trigger
   a job, name it — never `'*'`.

Two repo settings finish the job, both under **Settings → Actions → General**: set *Fork
pull request workflows from outside collaborators* to **Require approval for all outside
collaborators**, and leave *Workflow permissions* at **read repository contents**. Neither
is a substitute for the `permissions:` block each workflow already declares.

`ci.yml` needs no secret and is unaffected by all of this.

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
that did nothing. Use `:*`, not a bare `*`, and note the flag is `--allowed-tools`, not
`--allowedTools`.

## Verify

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
git diff --check
```

```bash
claude --plugin-dir . plugin details augenta
```

The plugin surface must be unchanged by anything in this directory: the manifest version,
one `connect` skill, every event in `hooks/hooks.json`, and no load errors. The repo's dev
skills live under `.claude/skills/` precisely so they stay out of that surface —
`skills/` at the repo root is asserted to hold exactly one skill.
