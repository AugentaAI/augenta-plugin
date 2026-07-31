---
name: review-github-pr
description: >
  Review a GitHub pull request in the augenta-plugin repo: summarize the diff, assess it
  against the AGENTS.md invariants, flag risks, and post a structured review comment.
  Use when: someone says "review PR 42", "review this PR", "look at this pull request",
  "summarize the PR diff", "what does this PR do", "check this PR for issues", or asks
  you to assess changes before merging.
---

# Review GitHub PR

Read a pull request diff, assess it, and post a single structured review comment.

> **This is contributor tooling, not a shipped plugin skill.** It lives under `.claude/`
> on purpose. `skills/` at the repo root is the plugin's *product* surface: both manifests
> declare `"skills": "./skills/"`, `__tests__/contract.test.ts` asserts the skill set is
> exactly `{connect}`, and `ci.yml` greps for a literal `Skills (1)`. A second skill under
> `skills/` fails three gates at once. Never move this file there.

## Prerequisites

- `gh` CLI must be authenticated
- A PR number (or URL) must be provided
- Must be run from within the `AugentaAI/augenta-plugin` repository

## Comment Marker

```
> **👁️ review-agent**
```

Before posting, check whether a review comment with this marker exists. If the PR has
been updated (new commits) since the last review, re-run the review. Otherwise skip.

## Where to spend the review

`ci.yml` already decides "does it work?" deterministically: `bun run typecheck`,
`bun test`, and a real marketplace install into both the `claude` and `codex` CLIs with
assertions on the reported version, skill count, and hook count.

So do **not** spend the review re-deriving what those gates cover. Spend it on the class
of defect they cannot catch: a diff that compiles, passes, installs — and quietly breaks
a privacy, consent, or packaging invariant.

**Read `AGENTS.md` before reviewing.** It is the source of truth for every invariant
below, and it carries the reasoning this file deliberately does not duplicate — a
restatement here would drift out of sync with it. Quote AGENTS.md when a finding cites
an invariant, so the author can check the claim.

## Step 1: Fetch the PR

```bash
gh pr view <number> --json number,title,body,baseRefName,headRefName,files,commits,additions,deletions,author,labels,reviewRequests
gh pr diff <number>
```

Also fetch the related issue if linked:

```bash
# Extract issue number from PR body (look for "Closes #NNN")
gh issue view <issue-number> --json body,labels,comments
```

## Step 2: Understand Intent

Read the PR description carefully. Identify:
- What problem is being solved?
- What approach was chosen and why?
- What is explicitly out of scope?

## Step 3: Assess the invariants, routed by what the diff touches

For each path the diff touches, run the matching checks. A finding here is almost always
**blocking** — these are product decisions encoded as code, not preferences.

### `scripts/connect.ts` — credentials and consent

- **No credential passes through the agent.** The agent is the normal caller of
  `--json` (`--probe`, `--login`, `--await-login`, `--neurospace`). Does the diff add a
  `--json` verb or payload field that could emit an access token, refresh token, or
  device code? Does `--api-key` still refuse `--json` mode?
- **Consent is asked every time, and the answer is the complete destination set.** Is
  `chooseMany` still a separate function from `choose`, with no auto-select knob? Is the
  question still asked when the org has exactly one Neurospace, and when the project is
  already connected? Has anything introduced a default, an inference, a carry-forward, or
  a "keep current" shortcut?
- **Disclosure scales with the destination count.** Before the user answers and again at
  confirmation, are they told each selected Neurospace receives the *full record*, so the
  audience is the union of everyone with access to any of them? With more than one
  selected, does the confirmation still restate that raw transcript records are
  structurally sanitized but not secret-scrubbed?
- **The written set is a subset of the set just confirmed.** A destination that fails to
  link must be reported and omitted. Conversely, writing nothing leaves the previous set
  on disk and still shipping — so no confirmation may claim a destination was dropped
  unless a config was actually written.
- **Dropped destinations are named**, their Neurolinks are left in place and idle (never
  disabled or deleted), and reconnecting never moves an existing Neurolink to a different
  Neurospace.
- **The platform-key path stays single-destination.** `verifyApiKeyConnection` must still
  refuse a key assigned to more than one Neurolink.
- A non-production `environment` must be stated to the user before they answer.

### `capture/` — the shipper and the spool

- **`Outbox.enforceLag` discards data**, so its three guards must all survive:
  it fires only when another destination progressed in the same drain; only after
  `LAG_STRIKES` *consecutive* such drains, with the count carried forward on **every**
  cursor write (drop that and the hysteresis silently never accumulates); and it reports
  through `markDiscarded`, never `markAuthNotice`.
- Lag is measured against the **furthest** destination, not the nearest — two wedged
  destinations must not shield each other while the spool fills.
- Capture stays a **silent no-op** without project config, and
  `AUGENTA_CAPTURE_ENABLED=0` remains a global kill switch.
- Tokens stay in the owner-only global `~/.augenta/auth.json`; a connected project stores
  only a profile reference and its Neurolink ids.

### `hooks/hooks.json` — the Codex trust hash

- **Any edit re-prompts every Codex user for hook trust** (Codex content-hashes each hook
  in `~/.codex/config.toml`). Is this change batched into a single deliberate release, or
  is it an incremental hook edit? Flag the latter — it is a real user-facing cost.
- A declared timeout must be the **minimum** the two harnesses allow, expressed in
  seconds. Codex enforces a per-event maximum and caps shutdown-path hooks at 3s; it
  clamps an over-declared value and shows a permanent load issue. `claude plugin
  validate` cannot catch this, so the review has to.
- `CLAUDE_PLUGIN_ROOT` stays quoted, and appears in `hooks/hooks.json` and nowhere else —
  it is not exported to an agent's Bash tool, where it expands to a broken `/scripts/...`.

### Manifests, marketplace, `package.json` — atomicity

- A version change is atomic across **all five**: `package.json`, both plugin manifests,
  and both the marketplace `metadata` and `plugins` entry — including the versioned
  descriptions.
- `.claude-plugin/plugin.json` must **not** declare `hooks` (Claude auto-discovers them);
  `.codex-plugin/plugin.json` **must**.
- No duplication of `skills/` or `hooks/` under `.claude-plugin/` or `.codex-plugin/`.

### Config parsing — `capture/config.ts`

- Stale configs are **reconnected, not migrated**. Widening a field's shape without
  changing its meaning is not migration (a 0.5.x scalar `neurolinkId` still parses as the
  one-element `neurolinkIds` set). A config whose *meaning* changed, or that cannot be
  read, must become session-start's reconnect prompt. The write path emits only the
  plural form.

### Any runtime file — the identity provider

- The IdP's name appears nowhere in runtime code outside a comment; a contract test
  enforces this. Identity keys on Augenta's own `user.id`/`org.id`, not the provider's.

### Portability

- Harness-specific instructional wording stays portable: describe the *current* harness's
  native user-input mechanism, and never add Codex-only tools to Claude `allowed-tools`.

## Step 4: The ordinary dimensions

Alongside the invariants, still assess:

**Correctness** — does the implementation match the stated intent? Unhandled edge cases,
off-by-one errors, null dereferences, type mismatches?

**Security** — input validated at boundaries? Secrets not logged, not committed?

**Performance** — unbounded loops, unbounded reads of a growing spool file?

**Consistency** — does the code match the surrounding comment density, naming, and idiom?
This repo comments the *why* heavily; a change that strips reasoning from a load-bearing
comment loses knowledge the tests do not hold.

**Completeness** — tests added or updated? Is the PR description accurate? If a
contributor-facing lever changed, does `DEBUG.md` or `AGENTS.md` still describe reality?

## Step 5: Classify Findings

- **blocking** — must fix before merge (broken invariant, correctness bug, security issue,
  non-atomic version bump)
- **non-blocking** — should fix but won't block merge (style, naming, minor improvements)
- **nit** — optional polish (formatting, comment wording)
- **praise** — something done well (include at least one if warranted)

## Step 6: Post Review Comment

Post a single structured comment. Everything goes in one comment.

**Resolve the verdict before posting.** Check exactly one box in the Verdict section —
replace its `[ ]` with `[x]` and leave the other two unchecked:
- Any **blocking** finding → `Request changes`
- No blocking findings, but open design questions → `Needs discussion`
- No blocking findings and no open questions → `Approve`

```bash
gh pr comment <number> --body "$(cat <<'EOF'
> **👁️ review-agent**

### PR Review

**PR:** #<number> — <title>
**Author:** @<author>
**Diff:** +<additions> / -<deletions> lines across <N> files
**Surfaces touched:** <capture pipeline | hooks | connect skill | connect script | packaging | CI | docs>

---

#### Summary

[2–3 sentences: what this PR does, whether the approach is sound, overall assessment]

#### Invariant check

[One line per AGENTS.md invariant category the diff touches, each Pass / Fail / N/A with
a reason. Omit categories the diff does not reach.]

---

#### Findings

**Blocking**

- `path/to/file.ts:42` — [description of issue and suggested fix]

**Non-blocking**

- `path/to/file.ts:17` — [description]

**Nits**

- `path/to/file.ts:8` — [description]

**Praise**

- [Something done well]

---

#### Verdict

- [ ] Approve — looks good, no blocking issues
- [ ] Request changes — blocking issues found (listed above)
- [ ] Needs discussion — design questions before merging

*Note: This is an automated review. A human reviewer should approve before merging.*
EOF
)"
```

## Step 7: Human Gate

This skill does **not** formally approve PRs. GitHub PR approval is a human action. The
review comment flags issues and provides a verdict recommendation — a human maintainer
makes the final approval decision, and branch protection enforces it alongside the
required CI check.

Under no circumstances should this skill approve, merge, push commits, or edit code.
