---
name: triage-issue
description: >
  Assess, classify, label, and route a newly filed GitHub issue in the augenta-plugin repo.
  Use when: someone says "triage issue", "triage issue 42", "triage all open issues",
  "classify this issue", "label this issue", "route this issue", or asks you to review
  and categorize incoming GitHub issues.
---

# Triage Issue

Assess a newly filed GitHub issue, classify it, apply labels, and post a structured
triage summary as a comment.

> **This is contributor tooling, not a shipped plugin skill.** It lives under `.claude/`
> on purpose — `skills/` at the repo root is the plugin's product surface and is asserted
> to contain exactly one skill (`connect`). See the same note in
> `.claude/skills/review-github-pr/SKILL.md`.

## Prerequisites

- `gh` CLI must be authenticated
- Must be run from within the `AugentaAI/augenta-plugin` repository

## Comment Marker

All output posted to GitHub uses this marker so it's always clear what generated it:

```
> **📋 triage-agent**
```

Before posting, check whether a comment with this marker already exists. If it does and
no new human comments have been added since, skip re-triaging. If new human comments
exist, re-evaluate and update.

## Step 0: Read the label set FIRST

```bash
gh label list --limit 100
```

**Apply only labels this returns.** `gh issue edit --add-label` fails outright on a label
that does not exist, which would abort the triage mid-run.

This repo has no `type:`/`area:`/`complexity:`/`state:` schema — only GitHub's defaults
plus `codex`. So classification splits in two:

- **What there is a label for** → apply the label.
- **What there is not** → record it in the triage comment as prose. Do not silently drop
  it, and do not invent a label to hold it.

Never create a label to fit your assessment. The label set is a deliberate repo decision;
if you think one is missing, say so in the comment and let a human decide.

## Step 1: Fetch the Issue

```bash
gh issue view <number> --json number,title,body,labels,author,createdAt,comments
```

## Step 2: Analyze the Issue

**Type** — map onto the labels that exist:
- `bug` — something that was working is now broken
- `enhancement` — request for a new capability
- `documentation` — documentation gap or error
- `question` — asking how something works

If the issue is maintenance/cleanup with no fitting label, say so in the comment rather
than forcing one of the above.

**Harness** — apply `codex` when the report is specific to the Codex harness (hook trust
prompts, `.codex-plugin/plugin.json`, `codex plugin` install behavior, a Codex-only
timeout clamp). This repo is one plugin serving two harnesses, so which harness a report
comes from is usually the first thing a fixer needs to know.

**Area** — no label exists; record it in the comment. This repo's surfaces:
- capture pipeline (`capture/`) — shipper, spool/outbox, normalizers, sanitize/scrub
- hooks (`hooks/`) — the eight event handlers and `hooks/hooks.json`
- connect skill (`skills/connect/`) — the shipped, user-facing skill
- connect script (`scripts/connect.ts`) — sign-in, Neurospace selection, config write
- packaging (`.claude-plugin/`, `.codex-plugin/`, marketplace metadata, versions)
- CI (`.github/`)
- docs (`README.md`, `AGENTS.md`, `DEBUG.md`)

**Complexity** — no label exists; record it in the comment as small (clear, well-scoped,
< 1 day), medium (some investigation, 1–3 days), or large (needs a spike first).

**Privacy / consent relevance** — flag it if the issue asks to change telemetry APIs,
payloads, consent semantics, or capture behavior. AGENTS.md requires an explicit product
decision for those; they are not ordinary bug fixes, and a triage comment saying so
early saves a wasted PR.

**Hook-manifest relevance** — flag it if the fix would require editing `hooks/hooks.json`.
Any edit there re-prompts every Codex user for hook trust, so such fixes should be
batched into a single deliberate release rather than shipped incrementally.

**Clarity** — is the issue actionable as written? Missing or unclear reproduction steps,
or an unstated harness and plugin version, should be flagged. If it overlaps an existing
issue, find it and link it.

## Step 3: Check for Duplicates

```bash
gh issue list --state all --json number,title | jq '.[] | select(.title | test("<keyword>"; "i"))'
```

If a duplicate is found, note it in the triage comment and apply `duplicate` if the match
is unambiguous.

## Step 4: Apply Labels

Apply only labels confirmed present in Step 0. Do not remove labels a human has applied.

```bash
gh issue edit <number> --add-label "bug,codex"
```

## Step 5: Post Triage Comment

Post a single structured comment. Everything goes in one comment — do not post follow-ups.

```markdown
> **📋 triage-agent**

### Triage Summary

| Field | Assessment |
|-------|-----------|
| Labels applied | `bug`, `codex` |
| Area | capture pipeline (`capture/`) — *no label exists for this* |
| Complexity | small — *no label exists for this* |
| Harness | Codex / Claude Code / both / unclear |
| Actionable | Yes / No — [reason if no] |
| Duplicate | None / #42 |

**Summary:** One sentence describing what the issue is actually asking for.

**Assessment:** 2–3 sentences on the root cause hypothesis, which surface is likely
involved, and confidence level.

**Reproduction gap (if any):** What information is missing — harness, plugin version,
whether the project was connected, what `gh`/CLI versions.

**Invariant note (if any):** Whether a fix would touch consent/telemetry semantics
(needs an explicit product decision) or `hooks/hooks.json` (re-prompts every Codex user
for trust; batch into one release).

**Suggested next step:**
- If actionable: what a fixer should look at first
- If unclear: request clarification from the author
- If duplicate: close in favor of #<number>
```

## Step 6: Security Handling

If the issue describes a potential vulnerability:

- **Never post exploit detail publicly.** Summarize impact only.
- There is no `topic:security` label in this repo, so flag it prominently at the **top**
  of the triage comment instead — a label would otherwise be the only signal and there
  isn't one.
- Do not propose or attempt a fix in the triage pass.

## Step 7: Human Gate

Triage ends at labels plus one comment. Under no circumstances should this skill:

- Start implementation, or edit any code
- Close the issue (except to note a duplicate recommendation for a human to act on)
- Create a label that does not already exist

A maintainer reads the triage output and decides what happens next.
