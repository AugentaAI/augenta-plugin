#!/usr/bin/env bash
#
# Resolve only the triaged Claude review conversations that the trusted fix workflow reports
# as fixed. The model never receives `gh api`; this script runs after it, under the workflow's
# pull-requests:write token, and fails closed on an incomplete or mismatched disposition set.
set -euo pipefail

for name in REPO PR EXPECTED_FINDINGS PRE_FIX_SHA FIX_OUTPUT; do
  if [[ -z "${!name:-}" ]]; then
    echo "resolve-fixed-review-threads.sh: $name is required" >&2
    exit 2
  fi
done
for tool in gh jq git; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "resolve-fixed-review-threads.sh: missing required tool: $tool" >&2
    exit 127
  }
done

owner="${REPO%%/*}"
repo_name="${REPO#*/}"
# Exactly one slash, both halves non-empty. NOT `owner != repo_name`: a repository
# named after its owner is a real and valid `X/X`, and rejecting it would abort after
# the fixes are pushed and the report posted.
if [[ "$REPO" != */* || "$repo_name" == */* || -z "$owner" || -z "$repo_name" ]]; then
  echo "resolve-fixed-review-threads.sh: REPO must be owner/name, got: $REPO" >&2
  exit 2
fi

# Triage passes the exact set it rendered into the model prompt. Re-reading comments here
# with only a lower timestamp bound would admit a newer concurrent review; reconstructing
# from a truncated prompt would demand dispositions for findings the model never received.
expected="$(jq -ce '
  select(type == "array")
  | select(length > 0)
  | select(all(.[];
      type == "object" and
      (.url | type == "string" and length > 0) and
      (.path | type == "string" and length > 0)))
  | map({url, path})
  | select((map(.url) | unique | length) == length)
  | sort_by(.url)
' <<<"$EXPECTED_FINDINGS")" || {
  echo "resolve-fixed-review-threads.sh: EXPECTED_FINDINGS must be a non-empty JSON array with unique URLs and non-empty paths" >&2
  exit 1
}

reported="$(jq -ce '
  .findings
  | select(type == "array")
  | map({url, disposition, commit, reason})
  | sort_by(.url)
' <<<"$FIX_OUTPUT")" || {
  echo "resolve-fixed-review-threads.sh: fix agent returned no valid typed findings array" >&2
  exit 1
}

expected_count="$(jq 'length' <<<"$expected")"
reported_count="$(jq 'length' <<<"$reported")"
if [[ "$reported_count" -ne "$expected_count" ]]; then
  echo "resolve-fixed-review-threads.sh: expected $expected_count dispositions, got $reported_count" >&2
  exit 1
fi

if ! jq -e '
  (map(.url) | unique | length) == length and
  all(.[];
    (.url | type == "string" and length > 0) and
    (.disposition == "fixed" or .disposition == "not_fixed") and
    (.commit | type == "string") and
    (.reason | type == "string" and length > 0) and
    (if .disposition == "fixed"
     then (.commit | test("^[0-9a-fA-F]{7,40}$"))
     else .commit == ""
     end))
' <<<"$reported" >/dev/null; then
  echo "resolve-fixed-review-threads.sh: every finding needs one valid URL, disposition, commit, and reason" >&2
  exit 1
fi

expected_urls="$(jq -c 'map(.url)' <<<"$expected")"
reported_urls="$(jq -c 'map(.url)' <<<"$reported")"
if [[ "$reported_urls" != "$expected_urls" ]]; then
  echo "resolve-fixed-review-threads.sh: typed finding URLs do not exactly match this review run" >&2
  echo "expected: $expected_urls" >&2
  echo "reported: $reported_urls" >&2
  exit 1
fi

# A model saying "fixed" is not enough. Each named fixing commit must be on the PR's
# first-parent line after the pre-fix SHA (not merely merged from upstream), and it must
# actually have reached origin. Those are the checks a correct fix can never fail, so they
# abort.
# Whether the commit also touches the path the finding is anchored to is a weaker signal —
# a cross-file fix is honest — so it only costs that one conversation its resolution.
#
# Two conditions are outside the agent's control entirely, and a CORRECT fix can hit either:
# the pre-fix SHA the review ran against is missing from this checkout (a human rebased or
# force-pushed the branch, so the fix job fetched the rewritten line), and the origin lookup
# that decides what landed cannot be completed at all (a transient API or network failure).
# By the time either shows, the fixes are pushed and the `🔧 fix-agent` comment is posted, so
# reddening the run would publish "Code-fix agent failed" over work that landed correctly.
# Both make every claim UNPROVEN rather than wrong, and land where an unproven path lands
# below: no resolution for any finding, all of them reported open, exit 0.
lineage_unproven=""
if ! git rev-parse --verify --quiet "${PRE_FIX_SHA}^{commit}" >/dev/null; then
  lineage_unproven="the pre-fix head $PRE_FIX_SHA is not a known commit in this checkout"
elif ! git merge-base --is-ancestor "$PRE_FIX_SHA" HEAD; then
  lineage_unproven="the pre-fix head $PRE_FIX_SHA is not in the current PR head"
fi

# Every local check reads LOCAL refs, and local lineage cannot tell a landed fix from one
# that never left the runner. `git push` is all-or-nothing per ref, so a push rejected for
# changing a workflow-definition YAML file under `.github/workflows/`, or for being a
# non-fast-forward behind a concurrent human push, leaves every fix commit in the local HEAD
# and NONE of them on the PR — where
# `$PRE_FIX_SHA..HEAD` and `diff-tree` still answer yes to everything. So ask origin what the
# PR's head branch points at NOW. The branch name comes from the PR itself, because the
# checkout's own refs are exactly what is in doubt. Only worth a network round trip when
# something is actually claimed as fixed.
fixed_count="$(jq '[.[] | select(.disposition == "fixed")] | length' <<<"$reported")"
first_parent_commits=""
pushed_head=""
pr_head_branch=""
if [[ -z "$lineage_unproven" ]] && (( fixed_count > 0 )); then
  first_parent_commits="$(git rev-list --first-parent "$PRE_FIX_SHA..HEAD")"
  pr_head_branch="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.ref')" || pr_head_branch=""
  if [[ -z "$pr_head_branch" || "$pr_head_branch" == "null" ]]; then
    lineage_unproven="the head branch of PR #$PR could not be read, so nothing can be checked against origin"
  elif ! git fetch --no-tags --quiet origin "refs/heads/$pr_head_branch"; then
    lineage_unproven="origin/$pr_head_branch could not be fetched, so nothing can be checked against origin"
  else
    pushed_head="$(git rev-parse --verify --quiet 'FETCH_HEAD^{commit}' || true)"
    if [[ -z "$pushed_head" ]]; then
      lineage_unproven="origin/$pr_head_branch resolved to no commit, so nothing can be checked against origin"
    fi
  fi
fi
if [[ -n "$lineage_unproven" ]]; then
  echo "resolve-fixed-review-threads.sh: leaving every conversation open — $lineage_unproven" >&2
fi

path_unproven=""
while IFS=$'\t' read -r url commit; do
  [[ -n "$lineage_unproven" ]] && break
  [[ -z "$url" ]] && continue
  # Normalise first: the shape check accepts an abbreviated SHA, `git rev-list` prints full
  # object names, and `grep -Fxq` compares whole lines — so without this the first-parent
  # membership test below could only ever pass for a 40-character spelling.
  full_commit="$(git rev-parse --verify --quiet "${commit}^{commit}" || true)"
  if [[ -z "$full_commit" ]]; then
    echo "resolve-fixed-review-threads.sh: $url names unknown fixing commit $commit" >&2
    exit 1
  fi
  commit="$full_commit"
  if ! git merge-base --is-ancestor "$commit" HEAD; then
    echo "resolve-fixed-review-threads.sh: $url names $commit, which is not in the PR head" >&2
    exit 1
  fi
  if git merge-base --is-ancestor "$commit" "$PRE_FIX_SHA"; then
    echo "resolve-fixed-review-threads.sh: $url names $commit, which predates this fix run" >&2
    exit 1
  fi
  if ! grep -Fxq "$commit" <<<"$first_parent_commits"; then
    echo "resolve-fixed-review-threads.sh: $url names $commit, which is not on the post-fix PR branch line" >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "$commit" "$pushed_head"; then
    echo "resolve-fixed-review-threads.sh: $url names $commit, which was never pushed to origin/$pr_head_branch" >&2
    exit 1
  fi
  path="$(jq -r --arg url "$url" '.[] | select(.url == $url) | .path' <<<"$expected")"
  # The reviewed path is a FILENAME, and the `--` argument is a PATHSPEC, so `[`, `*` and
  # `?` in a name are glob magic. What that costs is not the obvious thing, and the
  # difference was measured rather than reasoned: git prefers an exact match, so a
  # glob-shaped pathspec never loses its OWN file — it additionally returns the SIBLING the
  # glob matches, so `a[1].txt` would accept a commit that only touched `a1.txt`.
  #
  # `--literal-pathspecs` and the `grep -Fxq` below each close that on their own, which
  # makes them look like one check too many. They are kept as a pair deliberately: with
  # neither, the over-claim is real and silent, and each is one edit away from being removed
  # as redundant by someone who checked only the other. The gate pins the pair.
  changed_paths="$(git --literal-pathspecs -c core.quotePath=false diff-tree --root --no-commit-id --name-only -r "$commit" -- "$path")"
  if ! grep -Fxq "$path" <<<"$changed_paths"; then
    # Not necessarily an over-claim: a finding on `dapr.ts` is often fixed in `dapr.test.ts`,
    # a "missing test" finding in a brand-new file, a doc-row finding in the script it
    # describes. The claim is simply unproven, and an unproven claim leaves its conversation
    # open — it does not fail a run whose commits the origin check above proved are pushed.
    echo "resolve-fixed-review-threads.sh: $url names $commit, which does not change its reviewed path $path" >&2
    path_unproven+="$url"$'\n'
    continue
  fi
done < <(jq -r '.[] | select(.disposition == "fixed") | [.url, .commit] | @tsv' <<<"$reported")

threads=""
rc=0
threads="$(gh api graphql --paginate --slurp \
  -f query='query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){nodes{id isResolved comments(first:100){nodes{url}}}pageInfo{hasNextPage endCursor}}}}}' \
  -F owner="$owner" -F repo="$repo_name" -F number="$PR")" || rc=$?
if (( rc != 0 )); then
  echo "resolve-fixed-review-threads.sh: could not read PR #$PR review threads (gh exit $rc)" >&2
  exit 1
fi

fixed=0
left_open=0
while IFS=$'\t' read -r url disposition; do
  if [[ "$disposition" != "fixed" ]]; then
    left_open=$((left_open + 1))
    echo "left open: $url"
    continue
  fi
  if [[ -n "$lineage_unproven" ]]; then
    left_open=$((left_open + 1))
    echo "left open ($lineage_unproven): $url"
    continue
  fi
  if grep -Fxq "$url" <<<"$path_unproven"; then
    left_open=$((left_open + 1))
    echo "left open (its named fixing commit does not change the reviewed path): $url"
    continue
  fi

  matches="$(jq -c --arg url "$url" '
    [ .[].data.repository.pullRequest.reviewThreads.nodes[]
      | select(any(.comments.nodes[]; .url == $url))
      | {id, isResolved} ]
  ' <<<"$threads")"
  match_count="$(jq 'length' <<<"$matches")"
  if [[ "$match_count" -eq 0 ]]; then
    # Not in the class of "a correct fix can never fail this": a human can delete or dismiss
    # the comment while the fix job runs, and a thread carrying more comments than
    # `comments(first:100)` returns never yields its anchoring one. So it lands where the
    # path-unproven branch lands — that one conversation stays open rather than reddening a
    # run whose commits are already on origin. More than one match is still fatal.
    echo "resolve-fixed-review-threads.sh: no review thread found for $url" >&2
    left_open=$((left_open + 1))
    echo "left open (no review thread carries its comment URL): $url"
    continue
  fi
  if [[ "$match_count" -ne 1 ]]; then
    echo "resolve-fixed-review-threads.sh: expected exactly one review thread for $url" >&2
    exit 1
  fi

  thread_id="$(jq -r '.[0].id' <<<"$matches")"
  if [[ "$(jq -r '.[0].isResolved' <<<"$matches")" == "true" ]]; then
    echo "already resolved: $url"
    fixed=$((fixed + 1))
    continue
  fi

  result="$(gh api graphql \
    -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}' \
    -F threadId="$thread_id")"
  if ! jq -e '.data.resolveReviewThread.thread.isResolved == true' <<<"$result" >/dev/null; then
    echo "resolve-fixed-review-threads.sh: GitHub did not resolve $url" >&2
    exit 1
  fi
  echo "resolved: $url"
  fixed=$((fixed + 1))
done < <(jq -r '.[] | [.url, .disposition] | @tsv' <<<"$reported")

echo "Review conversations: $fixed fixed/resolved, $left_open deliberately left open."
