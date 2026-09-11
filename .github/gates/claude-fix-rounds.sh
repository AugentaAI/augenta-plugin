#!/usr/bin/env bash
# Offline contract for the review→fix round counter that gives the autonomous review cycle
# its exit. Fixtures only — no `gh`, no network, no repository state.
#
# The counter decides whether `claude-review-fix.yml` starts ANOTHER fix round, so its two
# failure directions are both expensive: under-count and the review → fix → push → review
# cycle never ends; over-count and the agent stops fixing things a human asked it to fix.
# Every case below pins one of the readings the workflow relies on.
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null)" \
  || REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

COUNTER="$REPO_ROOT/.github/scripts/count-review-fix-rounds.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

fail=0
note() { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1" >&2; fail=$((fail + 1)); }

echo "Claude fix round-cap gate"
echo

# --- fixture builders -----------------------------------------------------------------
# A commit as the PR commits endpoint renders it. `who` is one of:
#   human        a resolved User account (Richard, committing locally)
#   human-web    a resolved User author with GitHub's `web-flow` committer (the web editor)
#   agent        what the fix agent actually lands: claude[bot] as git identity, the
#                noreply address GitHub resolves to the Bot account github-actions[bot]
#   agent-merge  the fix run's merge of origin/main, same identity, two parents
#   other-bot    another Bot-typed account (Copilot, the on-demand claude[bot])
#   unresolved   an author GitHub cannot resolve at all (`author: null`) — the
#                claude-review-agent[bot] identity the workflow configures, or an unlinked email
commit() { # <who> <date> <subject>
  local who="$1" date="$2" subject="$3"
  case "$who" in
    human)
      jq -cn --arg d "$date" --arg s "$subject" '{
        sha: ("h" + ($d | gsub("[^0-9]"; ""))),
        commit: {author: {name: "Richard Ortega", date: $d}, committer: {name: "Richard Ortega", date: $d}, message: $s},
        author: {login: "richardjortega", type: "User"}, committer: {login: "richardjortega", type: "User"},
        parents: [{sha: "p"}]}' ;;
    human-web)
      jq -cn --arg d "$date" --arg s "$subject" '{
        sha: ("w" + ($d | gsub("[^0-9]"; ""))),
        commit: {author: {name: "Richard Ortega", date: $d}, committer: {name: "GitHub", date: $d}, message: $s},
        author: {login: "richardjortega", type: "User"}, committer: {login: "web-flow", type: "User"},
        parents: [{sha: "p"}]}' ;;
    agent)
      jq -cn --arg d "$date" --arg s "$subject" '{
        sha: ("a" + ($d | gsub("[^0-9]"; ""))),
        commit: {author: {name: "claude[bot]", date: $d}, committer: {name: "claude[bot]", date: $d}, message: $s},
        author: {login: "github-actions[bot]", type: "Bot"}, committer: {login: "github-actions[bot]", type: "Bot"},
        parents: [{sha: "p"}]}' ;;
    agent-merge)
      jq -cn --arg d "$date" --arg s "$subject" '{
        sha: ("m" + ($d | gsub("[^0-9]"; ""))),
        commit: {author: {name: "claude[bot]", date: $d}, committer: {name: "claude[bot]", date: $d}, message: $s},
        author: {login: "github-actions[bot]", type: "Bot"}, committer: {login: "github-actions[bot]", type: "Bot"},
        parents: [{sha: "p1"}, {sha: "p2"}]}' ;;
    other-bot)
      jq -cn --arg d "$date" --arg s "$subject" '{
        sha: ("b" + ($d | gsub("[^0-9]"; ""))),
        commit: {author: {name: "Copilot", date: $d}, committer: {name: "Copilot", date: $d}, message: $s},
        author: {login: "Copilot", type: "Bot"}, committer: {login: "Copilot", type: "Bot"},
        parents: [{sha: "p"}]}' ;;
    unresolved)
      jq -cn --arg d "$date" --arg s "$subject" '{
        sha: ("u" + ($d | gsub("[^0-9]"; ""))),
        commit: {author: {name: "claude-review-agent[bot]", date: $d}, committer: {name: "claude-review-agent[bot]", date: $d}, message: $s},
        author: null, committer: null,
        parents: [{sha: "p"}]}' ;;
    *) echo "unknown fixture actor: $who" >&2; exit 1 ;;
  esac
}
comment() { # <date> <body>
  jq -cn --arg d "$1" --arg b "$2" '{created_at: $d, body: $b, user: {login: "github-actions[bot]"}}'
}
# Pages, the way `--paginate --slurp` renders them: an array of arrays.
pages() { jq -cs '[.]' ; }

run_counter() { # <name> <commits-jsonl> <comments-jsonl> <expected-rounds>
  local name="$1" expected_rounds="$4"
  printf '%s\n' "$2" | pages > "$tmp_dir/commits.json"
  if [[ -n "$3" ]]; then printf '%s\n' "$3" | pages > "$tmp_dir/comments.json"
  else echo '[[]]' > "$tmp_dir/comments.json"; fi
  local out rc=0
  out="$(bash "$COUNTER" "$tmp_dir/commits.json" "$tmp_dir/comments.json")" || rc=$?
  if (( rc != 0 )); then bad "$name: counter exited $rc"; return; fi
  if [[ "$out" == "rounds=$expected_rounds" ]]; then
    note "$name: $out"
  else
    bad "$name: expected rounds=$expected_rounds, got: $out"
  fi
}

H1='2026-09-02T01:00:00Z'  # human opens the PR
R1='2026-09-02T01:05:00Z'  # review summary of H1
A1='2026-09-02T01:20:00Z'  # fix round 1 (two commits + its comment)
A1b='2026-09-02T01:20:04Z'
C1='2026-09-02T01:21:00Z'
R2='2026-09-02T01:26:00Z'  # review summary of round 1
A2='2026-09-02T01:40:00Z'  # fix round 2
C2='2026-09-02T01:41:00Z'
R3='2026-09-02T01:46:00Z'  # review summary of round 2
H2='2026-09-02T02:00:00Z'  # human pushes again
R4='2026-09-02T02:05:00Z'  # review summary of H2
A3='2026-09-02T02:20:00Z'
C3='2026-09-02T02:21:00Z'

human_open="$(commit human "$H1" 'feat: the change under review')"
agent_r1a="$(commit agent "$A1" 'fix(review): the first finding')"
agent_r1b="$(commit agent "$A1b" 'fix(review): the second finding, same round')"
agent_r1m="$(commit agent-merge "$A1" "Merge remote-tracking branch 'origin/main' into feat/x")"
agent_r2="$(commit agent "$A2" 'fix(review): the finding on the fix')"
human_fix="$(commit human "$H2" 'fix(review): the human applies one by hand')"
agent_r3="$(commit agent "$A3" 'fix(review): round three, after the human')"

fix_c1="$(comment "$C1" $'## 🔧 fix-agent\n- ✅ fixed in a1')"
fix_c2="$(comment "$C2" $'🔧 **fix-agent**\n- ✅ fixed in a2')"
fix_c3="$(comment "$C3" $'🔧 fix-agent\n- ❌ not fixed: lives in workflow YAML')"
review_summary="$(comment "$R1" $'<!-- augenta-code-review -->\nFindings posted inline.')"
review_r2="$(comment "$R2" $'<!-- augenta-code-review -->\nVerification review.')"
review_r3="$(comment "$R3" $'<!-- augenta-code-review -->\nVerification review.')"
review_r4="$(comment "$R4" $'<!-- augenta-code-review -->\nFull review of the human push.')"
summaries="$review_summary"$'\n'"$review_r2"$'\n'"$review_r3"$'\n'"$review_r4"
cap_notice="$(comment "$C2" $'<!-- augenta-review-fix-cap -->\n🛑 **review-fix cap reached**: the fix agent stops here.')"

# 1. A fresh PR: one human commit, nothing from the agent yet.
run_counter "fresh PR, no rounds" \
  "$human_open" "$review_summary" 0

# 2. One round that pushed TWO commits and posted ONE comment is ONE round — counting
#    commits would have said two, and capped a round early on the shape a real round has.
run_counter "one round, two commits, one comment" \
  "$human_open"$'\n'"$agent_r1a"$'\n'"$agent_r1b" "$review_summary"$'\n'"$fix_c1" 1

# 3. Two rounds: this is where MAX_FIX_ROUNDS=2 stops the cycle.
run_counter "two rounds" \
  "$human_open"$'\n'"$agent_r1a"$'\n'"$agent_r2" "$summaries"$'\n'"$fix_c1"$'\n'"$fix_c2" 2

# 4. THE BUDGET DOES NOT RESET. A human push after two rounds — even one whose subject is
#    `fix(review):` — leaves the count at two. More fixes after that are a person's to make
#    or to ask for by hand.
run_counter "a human push does not reset the budget" \
  "$human_open"$'\n'"$agent_r1a"$'\n'"$agent_r2"$'\n'"$human_fix" "$summaries"$'\n'"$fix_c1"$'\n'"$fix_c2" 2
human_web="$(commit human-web "$H2" 'docs: fixed in the web editor')"
run_counter "nor does a web-editor commit" \
  "$human_open"$'\n'"$agent_r1a"$'\n'"$agent_r2"$'\n'"$human_web" "$summaries"$'\n'"$fix_c1"$'\n'"$fix_c2" 2

# 5. Neither the workflow's review summary nor the cap notice itself is a round. The cap
#    notice in particular must never match, or posting it would spend a round.
run_counter "only fix-agent comments are rounds" \
  "$human_open"$'\n'"$agent_r1a"$'\n'"$agent_r2" \
  "$review_summary"$'\n'"$fix_c1"$'\n'"$cap_notice"$'\n'"$review_r2"$'\n'"$fix_c2" 2

# 6. Any author's labelled comment is a round — a human typing `🔧 fix-agent` spends one.
#    That is the documented trade-off (the comment is posted under whichever token the
#    action holds, and a cap that silently never fires because the login changed would be
#    worse), pinned here so a future "only bots count" change has to change this line too.
human_label="$(jq -cn --arg d "$C2" '{created_at: $d, body: "🔧 fix-agent — a person wrote this", user: {login: "richardjortega", type: "User"}}')"
run_counter "a labelled comment counts whoever posted it" \
  "$human_open"$'\n'"$agent_r1a" "$review_summary"$'\n'"$fix_c1"$'\n'"$human_label" 2

# 7. THE PUSH FLOOR. The push is what turns the cycle; a round whose comment never landed
#    (timeout between push and comment, a label drift) still spent a round. Pushes are
#    bucketed by the review summaries, not by wall clock: two rounds of agent commits with
#    NO fix-agent comments count 2, and the two commits pushed four seconds apart in one
#    round are one bucket.
run_counter "pushes with no comment still count, one per round" \
  "$human_open"$'\n'"$agent_r1a"$'\n'"$agent_r1b"$'\n'"$agent_r2" "$summaries" 2
run_counter "one round's two commits are one push" \
  "$human_open"$'\n'"$agent_r1a"$'\n'"$agent_r1b" "$review_summary" 1
# ...and the floor never lowers a comment count: one push, two comments, is two rounds.
run_counter "the floor is a floor, not a replacement" \
  "$human_open"$'\n'"$agent_r1a" "$review_summary"$'\n'"$fix_c1"$'\n'"$fix_c2" 2
# A round merges origin/main FIRST, then applies, then runs the gates, then commits — so its
# merge commit and its fix commit can be a full verify run apart. Merges are not fix pushes
# and are excluded; the fix commit lands in the round's bucket however long the gates took.
agent_slow_merge="$(commit agent-merge "$R1" "Merge remote-tracking branch 'origin/main' into feat/x")"
agent_slow_fix="$(commit agent '2026-09-02T01:24:00Z' 'fix(review): committed after a long verify run')"
run_counter "a round's merge and its fix commit a verify-run apart are one round" \
  "$human_open"$'\n'"$agent_slow_merge"$'\n'"$agent_slow_fix" "$review_summary"$'\n'"$fix_c1" 1
# An agent's reworded subject, another bot's commit, and an author GitHub cannot resolve are
# all non-human — charged to their bucket like any fix push, never read as a person.
agent_odd="$(commit agent "$A1" 'Apply review feedback')"
other_bot="$(commit other-bot "$A2" 'chore: another bot pushed something')"
unresolved="$(commit unresolved "$A2" 'fix(review): committed under the name the workflow configures')"
run_counter "a reworded agent subject is still a push" \
  "$human_open"$'\n'"$agent_odd" "$review_summary" 1
run_counter "another bot's commit after a review is a push" \
  "$human_open"$'\n'"$agent_r1a"$'\n'"$other_bot" "$summaries" 2
run_counter "an unresolvable author after a review is a push" \
  "$human_open"$'\n'"$agent_r1a"$'\n'"$unresolved" "$summaries" 2
# A PR's own implementation commits sit before the first review and are never charged —
# including on an agent-authored PR (on-demand claude[bot], Copilot, the action's own
# noreply identity), which has no human commit at all.
bot_open="$(commit other-bot '2026-09-02T00:40:00Z' 'feat: an agent opened this PR')"
bot_more="$(commit other-bot "$H1" 'feat: and pushed more before anyone reviewed it')"
run_counter "an agent-authored PR arrives with no rounds spent" \
  "$bot_open"$'\n'"$bot_more" "" 0
run_counter "an agent-authored PR: the PR's own commits are not rounds, the fix round is" \
  "$bot_open"$'\n'"$bot_more"$'\n'"$agent_r1a" "$review_summary" 1
# A review that posted no summary folds its round into the next bucket: the floor
# under-counts by one rather than guessing, and the comment count carries it.
run_counter "a missing review summary under-counts the floor, never over-counts it" \
  "$human_open"$'\n'"$agent_r1a"$'\n'"$agent_r2" "$review_summary" 1

# 8. A flat (single-call) array is accepted alongside the paginated shape.
printf '[%s,%s]' "$human_open" "$agent_r1a" > "$tmp_dir/commits.json"
printf '[%s,%s]' "$review_summary" "$fix_c1" > "$tmp_dir/comments.json"
out="$(bash "$COUNTER" "$tmp_dir/commits.json" "$tmp_dir/comments.json")" || out="exit $?"
if [[ "$out" == 'rounds=1' ]]; then
  note "flat arrays are read the same as paginated pages"
else
  bad "flat arrays: unexpected output: $out"
fi

# 9. Malformed input is a refusal, not a zero: the workflow must not read "unknown" as
#    "no rounds yet" and start another one.
for bad_input in 'not json' '{"a":1}' '"string"'; do
  printf '%s' "$bad_input" > "$tmp_dir/commits.json"
  echo '[[]]' > "$tmp_dir/comments.json"
  rc=0
  bash "$COUNTER" "$tmp_dir/commits.json" "$tmp_dir/comments.json" >/dev/null 2>&1 || rc=$?
  if (( rc == 2 )); then note "malformed commits input ($bad_input) exits 2"
  else bad "malformed commits input ($bad_input) exited $rc, expected 2"; fi
done
printf '[%s]' "$human_open" > "$tmp_dir/commits.json"
printf 'nope' > "$tmp_dir/comments.json"
rc=0
bash "$COUNTER" "$tmp_dir/commits.json" "$tmp_dir/comments.json" >/dev/null 2>&1 || rc=$?
if (( rc == 2 )); then note "malformed comments input exits 2"
else bad "malformed comments input exited $rc, expected 2"; fi

rc=0
bash "$COUNTER" "$tmp_dir/commits.json" >/dev/null 2>&1 || rc=$?
if (( rc == 2 )); then note "a missing argument exits 2"
else bad "a missing argument exited $rc, expected 2"; fi

echo
if (( fail > 0 )); then
  echo "❌ $fail check(s) failed" >&2
  exit 1
fi
echo "✅ round counter behaves"
