#!/usr/bin/env bash
#
# Claude agent-workflow allowlist shape gate — offline, no credentials, no network.
#
# WHY THIS EXISTS
# The tool allowlist passed to `anthropics/claude-code-action` via `claude_args` must be
# ONE quoted, comma-separated argument. Written as several space-separated quoted args it
# gets word-split, and every `Bash(...)` pattern containing a space arrives shredded
# ("Bash(gh", "pr", "comment:*)") — so the grant silently does not apply. Nothing goes
# red; the agent just quietly cannot run the command it was supposed to run. That failure
# mode already cost one silent no-op review on the platform repository this pipeline came
# from, and left its on-demand workflow running with a degraded allowlist for months while
# two sibling workflows carried comments warning about exactly it.
#
# A comment is not a gate. These are the gates:
#   1. every `--allowed-tools` value is a single quoted argument
#   2. the flag is spelled `--allowed-tools` (one canonical spelling to grep for)
#   3. `Bash(...)` patterns use the `:*` prefix wildcard, not a bare ` *`
#   4. neither review half is granted approve/merge, and the reviewer stays read-only
#   5. the direct reviewer pins Opus 5, stays in agent mode, exposes full output, and
#      returns a typed summary that the workflow itself posts and asserts
#
# Usage: .github/gates/claude-allowlist-shape.sh
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)" \
  || REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

fail=0
note() { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1" >&2; fail=$((fail + 1)); }

echo "Claude allowlist shape gate"
echo

# Extract each `--allowed-tools` VALUE from a workflow, \034-separated (a file may pass
# the flag once per job). Everything downstream must inspect these values and never the
# raw file: a comment naming a deliberately-withheld tool is prose, not a grant, and
# grepping the whole file mistakes one for the other.
allowlist_values() {
  awk '
    /--allowed-tools[[:space:]]*$/ { collecting = 1; print "\034"; next }
    collecting {
      if ($1 ~ /^--/ || $0 ~ /^[[:space:]]*[a-zA-Z_-]+:/ || $0 ~ /^[[:space:]]*$/) {
        collecting = 0; next
      }
      print
    }
  ' "$1"
}

# ---------------------------------------------------------------------------
# 2. Canonical spelling. `--allowedTools` is the same flag, but allowing both
#    spellings means a future reader greps for one and misses the other.
# ---------------------------------------------------------------------------
if grep -rn -- '--allowedTools' .github/workflows/ >/dev/null 2>&1; then
  grep -rn -- '--allowedTools' .github/workflows/ >&2
  bad "use the canonical --allowed-tools spelling (found --allowedTools above)"
else
  note "every workflow uses the canonical --allowed-tools spelling"
fi

# ---------------------------------------------------------------------------
# 1 + 3. Shape of each allowlist value.
# ---------------------------------------------------------------------------
# Workflow definitions only. README.md documents this flag — including, eventually, the
# malformed form this gate exists to refuse — and shape rules applied to prose would
# redden CI on its own explanation. The canonical-spelling grep above still reads it.
mapfile -t files < <(grep -rl --include='*.yml' --include='*.yaml' -- '--allowed-tools' .github/workflows/ 2>/dev/null | sort)
if [[ "${#files[@]}" -eq 0 ]]; then
  bad "no workflow passes --allowed-tools at all — did the flag get dropped?"
fi

# A workflow may pass --allowed-tools more than once (claude-auto-triage.yml has two
# jobs). Each occurrence is checked on its own — concatenating them would report a
# perfectly-shaped pair of allowlists as one malformed four-quote value.
for f in "${files[@]}"; do
  occurrences="$(allowlist_values "$f")"

  n=0
  while IFS= read -r -d $'\034' value || [[ -n "$value" ]]; do
    [[ -z "${value//[[:space:]]/}" ]] && continue
    n=$((n + 1))
    label="$f (allowlist #$n)"

    # Exactly one quoted argument: exactly two double quotes, and no `" "` boundary —
    # the signature of a space-separated multi-arg list.
    quotes="$(printf '%s' "$value" | tr -cd '"' | wc -c | tr -d ' ')"
    if [[ "$quotes" -ne 2 ]]; then
      bad "$label: value has $quotes double quotes; expected exactly 2 (ONE quoted arg)"
    elif printf '%s' "$value" | grep -qE '"[[:space:]]+"'; then
      bad "$label: several space-separated quoted args — the action will word-split them"
    else
      note "$label: single quoted argument"
    fi

    # A bare ` *)` inside Bash(...) means someone wrote `Bash(git diff *)` where the
    # prefix wildcard `Bash(git diff:*)` was meant. A `*` inside a URL is legitimate.
    offenders="$(printf '%s' "$value" | grep -oE 'Bash\([^)]*\)' | grep -v '://' | grep -E '[[:space:]]\*\)' || true)"
    if [[ -n "$offenders" ]]; then
      printf '%s\n' "$offenders" >&2
      bad "$label: Bash(...) patterns above use a bare ' *' — use the ':*' prefix wildcard"
    else
      note "$label: Bash(...) patterns use the ':*' prefix wildcard"
    fi
  done <<< "$occurrences"

  [[ "$n" -eq 0 ]] && bad "$f: --allowed-tools has no value on the following line(s)"
done

# ---------------------------------------------------------------------------
# 4. The fix half has contents: write and pushes commits. Both halves must still be
#    structurally unable to approve or land their own work — a prompt saying "never
#    approve" is a request; withholding the tool is a guarantee.
# ---------------------------------------------------------------------------
# BOTH halves of the split are checked. The fix workflow is the one that actually holds
# `contents: write`, so exempting it would aim this gate at the harmless half.
for REVIEW in .github/workflows/claude-code-review.yml .github/workflows/claude-review-fix.yml; do
  if [[ -f "$REVIEW" ]]; then
    review_grants="$(allowlist_values "$REVIEW")"
    granted=0
    for forbidden in 'gh pr review' 'gh pr merge' 'gh api'; do
      if printf '%s' "$review_grants" | grep -q "Bash($forbidden"; then
        bad "$REVIEW grants Bash(${forbidden}...) — the review agent must not be able to approve, merge, or reach the API directly"
        granted=1
      fi
    done
    [[ "$granted" -eq 0 ]] && note "$REVIEW withholds approve/merge/api from the review agent"
  else
    bad "$REVIEW is missing"
  fi
done

# The read-only half must STAY read-only: a write tool here would silently undo the split.
RO=.github/workflows/claude-code-review.yml
if [[ -f "$RO" ]]; then
  ro_grants="$(allowlist_values "$RO")"
  ro_bad=0
  for w in 'Edit' 'Write' 'Bash(git push' 'Bash(git commit' 'Bash(git merge'; do
    if printf '%s' "$ro_grants" | grep -q -- "$w"; then
      bad "$RO grants ${w} — the reviewer is the read-only half; writes belong in claude-review-fix.yml"
      ro_bad=1
    fi
  done
  [[ "$ro_bad" -eq 0 ]] && note "$RO grants no write tool — the read-only half is still read-only"
fi

# ---------------------------------------------------------------------------
# 5. The reviewer uses the direct action flow installed by Claude Code, not the stock
#    multi-agent plugin. Measured once: that plugin ran 15 turns across three model tiers,
#    recorded 14 permission denials that the default log mode hid, and exited green
#    without posting a review. Keep the direct flow observable and deterministic:
#    Opus 5, agent mode on the checked-out merge ref, full SDK output in the Actions
#    log, typed summary output, and the exact read/comment tools the prompt says
#    it will use. A formatted but incomplete grant otherwise exits green after permission
#    denials without posting a review.
# ---------------------------------------------------------------------------
if [[ -f "$RO" ]]; then
  ro_grants="$(allowlist_values "$RO")"
  required_review_tools=(
    'mcp__github_inline_comment__create_inline_comment'
    'Bash(gh pr diff:*)'
    'Bash(gh pr view:*)'
    'Read'
    'Glob'
    'Grep'
  )
  missing=0
  for tool in "${required_review_tools[@]}"; do
    if ! printf '%s' "$ro_grants" | grep -qF "$tool"; then
      bad "$RO is missing required direct-review tool '$tool' — the action can exit green without completing the review"
      missing=1
    fi
  done
  [[ "$missing" -eq 0 ]] && note "$RO grants every read/comment tool required by the direct review prompt"

  if grep -q -- '--model' "$RO" && grep -q '"claude-opus-5"' "$RO"; then
    note "$RO pins the direct reviewer to claude-opus-5"
  else
    bad "$RO must pin the direct reviewer with --model \"claude-opus-5\""
  fi

  if grep -q '^[[:space:]]*track_progress:[[:space:]]*true' "$RO"; then
    bad "$RO must not set track_progress: true — it forces tag mode, re-checks out the head through the action's stricter branch validator, and exposes the marker-stripping progress-comment tool"
  else
    note "$RO stays in agent mode on the already-checked-out merge ref"
  fi

  if grep -q '^[[:space:]]*show_full_output:[[:space:]]*true' "$RO"; then
    note "$RO exposes the SDK message stream in the Actions log"
  else
    bad "$RO must set show_full_output: true so reasoning and permission failures are visible"
  fi

  if grep -qE '^[[:space:]]*(plugins|plugin_marketplaces):' "$RO"; then
    bad "$RO must use the direct review flow, not the multi-agent code-review plugin"
  else
    note "$RO does not install the multi-agent code-review plugin"
  fi

  if printf '%s' "$ro_grants" | grep -qF 'Bash(gh pr comment:'; then
    bad "$RO grants the model gh pr comment — the workflow must publish typed output itself"
  else
    note "$RO withholds top-level comment posting from the model"
  fi

  if grep -q -- '--json-schema' "$RO" &&
     grep -q 'REVIEW_OUTPUT:.*steps.claude-review.outputs.structured_output' "$RO" &&
     grep -q 'name: Post the review summary' "$RO" &&
     grep -q 'gh pr comment.*--body-file' "$RO" &&
     grep -q 'issues:[[:space:]]*write' "$RO" &&
     grep -q 'select(.user.login == "github-actions\[bot\]")' "$RO" &&
     grep -q '<!-- augenta-code-review -->' "$RO" &&
     grep -q 'name: Assert the review summary was posted' "$RO"; then
    note "$RO posts typed output as github-actions[bot] and fails a real run with no marked summary"
  else
    bad "$RO must request typed output, post it as github-actions[bot] with the <!-- augenta-code-review --> marker, and assert the artifact"
  fi
fi

# The first review is full; every later one is INCREMENTAL — scoped to the commits since the
# head the previous summary recorded, plus verification of any fix report posted since. A
# whole-PR review asked to look again nearly always finds something, which is how the fix
# cycle once turned seven times in three hours. The mode step reads the recorded head back, the post
# step writes it, the brief it renders is what the prompt opens with, and the reviewer needs
# history plus the read-only git commands. Every piece is asserted because dropping any one
# of them silently restores the old loop.
if grep -q 'name: Decide the review mode' "$RO" &&
   grep -q 'augenta-code-review-head: (?<sha>\[0-9a-f\]{40}) -->' "$RO" &&
   grep -q 'echo "<!-- augenta-code-review-head: \$HEAD_SHA -->"' "$RO" &&
   grep -q 'git merge-base --is-ancestor "\$reviewed_head" "\$HEAD_SHA"' "$RO" &&
   grep -q 'mode=incremental' "$RO" &&
   grep -q 'mode=full' "$RO" &&
   grep -q 'INCREMENTAL REVIEW, not a review of the whole pull request.' "$RO" &&
   grep -q 'BEGIN FIX REPORT' "$RO" &&
   grep -q 'Do NOT' "$RO" &&
   grep -q '\${{ steps.mode.outputs.brief }}' "$RO" &&
   grep -qE '^[[:space:]]*fetch-depth:[[:space:]]*0[[:space:]]*$' "$RO" &&
   printf '%s' "$ro_grants" | grep -qF 'Bash(git show:*)' &&
   printf '%s' "$ro_grants" | grep -qF 'Bash(git diff:*)'; then
  note "$RO reviews incrementally from the recorded head and verifies the fix report instead of re-reviewing the whole PR"
else
  bad "$RO must record the reviewed head in its summary, read it back to scope the next review, hand over the fix report, open the prompt with the rendered brief, check out history, and grant git show/diff — otherwise every push restarts a whole-PR review"
fi

# A pull request gets a fixed number of AUTOMATIC reviews in its lifetime; after that a push
# starts nothing, and a person runs the workflow by hand (workflow_dispatch, which ignores
# the budget because a person asked). The budget is counted from the summaries already on
# the PR, the model step is skipped at the cap, and a distinct-marker notice says so once.
if grep -qE '^  MAX_AUTOMATED_REVIEWS:[[:space:]]*[1-9][0-9]*[[:space:]]*$' "$RO" &&
   grep -q '^  workflow_dispatch:' "$RO" &&
   grep -q 'reviews_done >= MAX_AUTOMATED_REVIEWS' "$RO" &&
   grep -q 'mode=skip' "$RO" &&
   grep -q "if: steps.mode.outputs.mode != 'skip'" "$RO" &&
   grep -q 'name: Note the spent review budget' "$RO" &&
   grep -q '<!-- augenta-code-review-budget -->' "$RO"; then
  note "$RO stops automatic reviews at MAX_AUTOMATED_REVIEWS and leaves a manual workflow_dispatch path"
else
  bad "$RO must budget automatic reviews (MAX_AUTOMATED_REVIEWS, a skip mode gating the model step, the budget notice) and keep workflow_dispatch as the manual path — otherwise every push starts a review forever"
fi

# The writer must remain a trusted workflow_run, but its state must be visible beside the
# PR's ordinary checks. The custom check is attached to the reviewed head SHA, not main.
FIX=.github/workflows/claude-review-fix.yml
if grep -q 'Claude Code Review / fix' "$FIX" &&
   grep -q 'github.event.workflow_run.head_sha' "$FIX" &&
   grep -q 'checks: write' "$FIX" &&
   grep -q 'name: Publish the fix result to the PR checks' "$FIX"; then
  note "$FIX mirrors the trusted fix lifecycle into the PR head check suite"
else
  bad "$FIX must publish a Claude Code Review / fix check against workflow_run.head_sha"
fi

# The model remains structurally unable to call `gh api`. Its typed, one-to-one finding
# dispositions are handed to a trusted workflow step, which resolves only `fixed` findings.
# The path ban is prompt-enforced, while the job token's push boundary covers workflow
# definition YAML — not every file in the directory. Keep the prompt aligned with that real
# limit and keep the workflow README explicitly fixable.
if grep -q 'id: claude-fix' "$FIX" &&
   grep -q -- '--json-schema' "$FIX" &&
   grep -q 'FIX_OUTPUT:.*steps.claude-fix.outputs.structured_output' "$FIX" &&
   grep -q 'EXPECTED_FINDINGS:.*needs.triage.outputs.expected_findings' "$FIX" &&
   grep -q 'PRE_FIX_SHA:.*github.event.workflow_run.head_sha' "$FIX" &&
   grep -q 'name: Resolve the fixed review conversations' "$FIX" &&
   grep -q 'TRUSTED_SHA:.*github.workflow_sha' "$FIX" &&
   grep -q 'contents/.github/scripts/resolve-fixed-review-threads.sh?ref=\$TRUSTED_SHA' "$FIX" &&
   grep -q 'bash "\$resolver"' "$FIX"; then
  note "$FIX hands typed finding dispositions to the trusted conversation resolver"
else
  bad "$FIX must return typed per-finding dispositions and run the resolver from the trusted workflow SHA, never the PR checkout"
fi

# The fix push re-enters the review (`pull_request: synchronize` fires for it — measured, not
# assumed), so review → fix → push → review has no natural exit. The exit is a round cap the
# trusted triage job enforces BEFORE starting the fix agent, with the counter fetched at the
# trusted workflow SHA rather than read from the PR checkout, which could otherwise supply
# the script that decides whether it gets another round. A workflow that drops any piece of
# this quietly reopens the cycle, so every piece is asserted.
if grep -qE '^  MAX_FIX_ROUNDS:[[:space:]]*[1-9][0-9]*[[:space:]]*$' "$FIX" &&
   grep -q 'contents/.github/scripts/count-review-fix-rounds.sh?ref=\$TRUSTED_SHA' "$FIX" &&
   grep -q 'bash "\$counter"' "$FIX" &&
   grep -q 'rounds >= MAX_FIX_ROUNDS' "$FIX" &&
   grep -q 'capped: \${{ steps.findings.outputs.capped }}' "$FIX" &&
   grep -q 'CAPPED: \${{ needs.triage.outputs.capped }}' "$FIX" &&
   grep -q 'name: Post the round-cap notice' "$FIX" &&
   grep -q '<!-- augenta-review-fix-cap -->' "$FIX" &&
   [[ -x .github/scripts/count-review-fix-rounds.sh ]]; then
  note "$FIX caps consecutive fix rounds with a counter run from the trusted workflow SHA"
else
  bad "$FIX must cap consecutive fix rounds (MAX_FIX_ROUNDS, count-review-fix-rounds.sh at \$TRUSTED_SHA, a capped output, and the round-cap notice) — without it the fix push re-enters the review forever"
fi

# The notice must not read as a round to the counter, or posting it spends the budget it
# reports on. The counter matches `🔧` followed by `fix-agent`; the notice may say neither.
# Bounded to THAT step: from its `name:` to the next step's `- name:`, not to end of file, so a
# step appended after it that legitimately mentions the label cannot turn this red.
notice_block="$(awk '/^[[:space:]]*- name: Post the round-cap notice/{on=1; print; next}
                     on && /^[[:space:]]*- name: /{exit}
                     on' "$FIX")"
if [[ -n "$notice_block" ]] && ! grep -qE '🔧[[:space:]*_]*fix-agent' <<<"$notice_block"; then
  note "$FIX: the round-cap notice does not carry the fix-agent label"
else
  bad "$FIX: the round-cap notice must not contain the '🔧 fix-agent' label the round counter matches"
fi

if grep -q 'never modify a' "$FIX" &&
   grep -Fq 'workflow definition: any `.yml` or `.yaml` file under `.github/workflows/`' "$FIX" &&
   grep -q 'rejects workflow-definition changes' "$FIX" &&
   grep -q 'Other files' "$FIX" &&
   grep -Fq 'including `.github/workflows/README.md`, are permitted' "$FIX" &&
   grep -q 'needs a human-authored commit' "$FIX"; then
  note "$FIX states the workflow-definition limit while keeping its README fixable"
else
  bad "$FIX must forbid workflow-definition YAML edits without banning other workflow-directory files"
fi

echo
if [[ "$fail" -ne 0 ]]; then
  echo "$fail allowlist shape check(s) failed." >&2
  exit 1
fi
echo "Claude allowlist shape gate passed."
