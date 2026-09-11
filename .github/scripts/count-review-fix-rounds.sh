#!/usr/bin/env bash
#
# Count the automated fix rounds already spent on a pull request. `claude-review-fix.yml`
# runs this before starting the fix agent and refuses to start it once the count reaches
# `MAX_FIX_ROUNDS` — a PR gets that many automated fix rounds in its lifetime, no more. The
# budget does not reset: a person who wants more fixes after it is spent makes them, or asks
# for them, by hand.
#
# WHY THERE IS A BUDGET. The fix agent's push is a `pull_request: synchronize` event like any
# other, so it starts a fresh `Claude Code Review`. That was measured, not assumed: every
# `fix(review):` push created a review run with triggering actor `github-actions[bot]`. Reviews
# after the first are incremental and a clean one ends the cycle, but the budget is what
# ends it when they are not: two rounds, then the remaining findings are a human's.
#
# HOW A ROUND IS COUNTED. Every fix run posts exactly one comment whose first line carries
# the `🔧 fix-agent` label (the workflow asserts it), so the labelled comments on the PR are
# the rounds. Counting comments rather than commits is deliberate: one round may push two
# commits (one observed round pushed two, four seconds apart), and a round that pushed
# nothing still spent a review.
#
# But the PUSH is what turns the cycle, and a round can push without its comment landing —
# the job timeout falling between `git push` and `gh pr comment`, or the label drifting out
# of the pattern (both asserts share one pattern, so they would fail together, red every
# turn and still unbounded). So the count is floored by the pushes, bucketed by ROUND: every
# fix round follows a review, and every review posts a `<!-- augenta-code-review -->`
# summary, so the summaries partition time into rounds. A non-human, non-merge commit is
# charged to the bucket of the last summary before it; the number of non-empty buckets is
# the pushes. Bucket 0 — the stretch before any review — is never a fix round, which is what
# keeps a PR's own implementation commits from being charged (an agent-authored PR has no
# human commit at all, and they are still not rounds). Merges are excluded because a merge is
# never itself a fix push, and the round's merge of origin/main can sit a full verify run
# before its fix commit. `rounds` is the larger of comments and pushes. A review that posted
# no summary folds its round into the next bucket, which under-counts the floor by one and
# leaves the comment count to carry it.
#
# "Non-human" means the commit's author does not resolve to a real User account
# (`author.type == "User"`). Subjects and git names are never read — an agent's reworded
# subject is still not a person, and a person's `fix(review):` commit is still not a round.
# An author GitHub cannot resolve is treated as non-human, which can only charge a round
# that a real fix round also produced a summary for; it cannot invent one.
#
# Usage: count-review-fix-rounds.sh <commits.json> <comments.json>
#   commits.json   `gh api --paginate --slurp repos/O/R/pulls/N/commits`   (array of pages)
#   comments.json  `gh api --paginate --slurp repos/O/R/issues/N/comments` (array of pages)
#   A flat array is accepted for either.
# Prints `rounds=<n>` and exits 0. Exits 2 on a malformed input, so the caller can refuse to
# start another round on an unknown count.
set -euo pipefail

if (( $# != 2 )); then
  echo "count-review-fix-rounds.sh: usage: $0 <commits.json> <comments.json>" >&2
  exit 2
fi
commits_file="$1"
comments_file="$2"
for f in "$commits_file" "$comments_file"; do
  if [[ ! -r "$f" ]]; then
    echo "count-review-fix-rounds.sh: cannot read $f" >&2
    exit 2
  fi
done
command -v jq >/dev/null 2>&1 || {
  echo "count-review-fix-rounds.sh: missing required tool: jq" >&2
  exit 127
}

# One page or many: `--slurp` over `--paginate` yields an array of pages, a single call a
# flat array. Flatten one level only, so a page's elements are never themselves flattened.
flatten='if type != "array" then error("expected a JSON array")
         else [ .[] | if type == "array" then .[] else . end ] end'

# The label check tolerates the markdown the prompt allows around it (`🔧 **fix-agent**`,
# `## 🔧 fix-agent`) — the same tolerance as the workflow's own assert. Any author counts:
# the comment is posted under whichever token the action holds, and a cap that silently
# never fires because the login changed would be worse than a human able to spend a round
# by typing the label.
commented="$(jq -er "$flatten"'
  | map(select(type == "object"))
  | [ .[] | select((.body // "") | test("🔧[[:space:]*_]*fix-agent")) ]
  | length
' "$comments_file")" || {
  echo "count-review-fix-rounds.sh: $comments_file is not a JSON array of issue comments" >&2
  exit 2
}

# The push floor. Partition points are the review summaries; a commit is charged to the
# bucket of the last summary before it, and bucket 0 (before any review) is not a round.
# Dates compare as epoch seconds; a commit with no parseable date is dropped from the floor
# rather than guessed at — the comment count still carries that round.
points="$(jq -ec "$flatten"'
  | map(select(type == "object"))
  | [ .[]
      | select((.user.login // "") == "github-actions[bot]")
      | select((.body // "") | contains("<!-- augenta-code-review -->"))
      | (.created_at // "")
      | (try fromdateiso8601 catch empty) ]
  | sort
' "$comments_file")" || {
  echo "count-review-fix-rounds.sh: $comments_file is not a JSON array of issue comments" >&2
  exit 2
}

pushed="$(jq -er --argjson points "$points" "$flatten"'
  | map(select(type == "object"))
  | [ .[]
      | select(((.author | type) == "object" and .author.type == "User") | not)
      | select(((.parents // []) | length) <= 1)
      | (.commit.committer.date // .commit.author.date // "")
      | (try fromdateiso8601 catch empty) as $t
      | ([ $points[] | select(. <= $t) ] | length)
      | select(. > 0) ]
  | unique
  | length
' "$commits_file")" || {
  echo "count-review-fix-rounds.sh: $commits_file is not a JSON array of PR commits" >&2
  exit 2
}

rounds="$commented"
if (( pushed > rounds )); then rounds="$pushed"; fi

echo "rounds=$rounds"
