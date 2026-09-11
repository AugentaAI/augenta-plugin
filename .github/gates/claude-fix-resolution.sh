#!/usr/bin/env bash
# Offline contract for the trusted post-fix resolver. `gh` is a fixture; no repository state
# or review conversation is changed by this gate.
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null)" \
  || REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

fixture_dir="$REPO_ROOT/.github/gates/fixtures/claude-fix-resolution"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

export PATH="$fixture_dir:$PATH"
export GH_STUB_LOG="$tmp_dir/resolved.log"
export GH_STUB_THREADS='[{
  "data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
    {"id":"thread-fixed","isResolved":false,"comments":{"nodes":[{"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1"}]}},
    {"id":"thread-open","isResolved":false,"comments":{"nodes":[{"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2"}]}},
    {"id":"thread-old","isResolved":false,"comments":{"nodes":[{"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_old"}]}}
  ]}}}}}
]'
export REPO='AugentaAI/augenta-plugin'
export PR='1'
export EXPECTED_FINDINGS='[
  {"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1","path":"alpha.txt"},
  {"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2","path":"beta.txt"}
]'

# Real file changes, not empty commits: the resolver asks what each claimed fixing commit
# touched, so a fixture of empty commits could not tell a bound fix from an over-claim.
test_repo="$tmp_dir/repo"
git init -q "$test_repo"
git -C "$test_repo" config user.name 'Resolution Gate'
git -C "$test_repo" config user.email 'resolution-gate@example.invalid'
printf 'one\n' > "$test_repo/alpha.txt"
git -C "$test_repo" add alpha.txt
git -C "$test_repo" commit -q -m 'pre-fix head'
export PRE_FIX_SHA="$(git -C "$test_repo" rev-parse HEAD)"
printf 'two\n' >> "$test_repo/alpha.txt"
git -C "$test_repo" commit -aq -m 'fix the alpha.txt finding'
fix_sha="$(git -C "$test_repo" rev-parse HEAD)"
printf 'elsewhere\n' > "$test_repo/beta.txt"
git -C "$test_repo" add beta.txt
git -C "$test_repo" commit -q -m 'unrelated work in this same fix run'
other_sha="$(git -C "$test_repo" rev-parse HEAD)"
# A real commit that is NOT reachable from the PR head. The branch name is read back rather
# than assumed, so this fixture does not depend on `init.defaultBranch`.
head_branch="$(git -C "$test_repo" rev-parse --abbrev-ref HEAD)"
git -C "$test_repo" checkout -q -b sidebranch "$PRE_FIX_SHA"
printf 'sidebranch\n' > "$test_repo/side.txt"
git -C "$test_repo" add side.txt
git -C "$test_repo" commit -q -m 'real commit, unreachable from the PR head'
unreachable_sha="$(git -C "$test_repo" rev-parse HEAD)"
git -C "$test_repo" checkout -q "$head_branch"

# The resolver asks origin what the PR's head branch points at now, because local refs alone
# cannot say whether a fix commit was ever pushed. A local bare repo is that origin, and the
# PR-line commits above are what has landed on it.
git init -q --bare "$tmp_dir/origin.git"
git -C "$test_repo" remote add origin "$tmp_dir/origin.git"
git -C "$test_repo" push -q origin "$head_branch"
export GH_STUB_PR_HEAD_REF="$head_branch"

export FIX_OUTPUT="$(jq -cn --arg sha "$fix_sha" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"covered by the new guard"},
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2",disposition:"not_fixed",commit:"",reason:"requires an author decision"}
]}')"

: > "$GH_STUB_LOG"
(cd "$test_repo" && bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/pass.out"
if [[ "$(<"$GH_STUB_LOG")" != "thread-fixed" ]]; then
  echo "expected only the fixed finding's thread to resolve" >&2
  cat "$GH_STUB_LOG" >&2
  exit 1
fi
grep -Fq '1 fixed/resolved, 1 deliberately left open' "$tmp_dir/pass.out"

# A repository named after its owner is a real, valid `X/X`, so the owner/name split must
# test for ONE SLASH rather than for two halves that differ. Getting that wrong aborts the
# resolve step after the fixes are already pushed and the report already posted — the one
# moment a refusal says the opposite of what happened.
: > "$GH_STUB_LOG"
(cd "$test_repo" && REPO='AugentaAI/AugentaAI' \
  bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/same-name.out" 2>&1
grep -Fq '1 fixed/resolved, 1 deliberately left open' "$tmp_dir/same-name.out"

# ...while a value that is not owner/name at all is still refused, in both directions.
for bad_repo in 'notaslug' 'too/many/slashes' '/name' 'owner/'; do
  : > "$GH_STUB_LOG"
  if (cd "$test_repo" && REPO="$bad_repo" \
    bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/bad-repo.out" 2>&1; then
    echo "a malformed REPO was accepted: $bad_repo" >&2
    exit 1
  fi
  if [[ -s "$GH_STUB_LOG" ]]; then
    echo "a thread was resolved from a malformed REPO: $bad_repo" >&2
    exit 1
  fi
  grep -Fq 'REPO must be owner/name' "$tmp_dir/bad-repo.out"
done

# An abbreviated SHA is the spelling `git log --oneline` and the prompt's own `✅ fixed in <sha>`
# convention produce, and the disposition shape check accepts seven characters — so every
# lineage check after it has to accept one too, rather than reading a formatting choice as a
# commit that is not on the branch line.
export FIX_OUTPUT="$(jq -cn --arg sha "$(git -C "$test_repo" rev-parse --short=7 "$fix_sha")" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"covered by the new guard"},
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2",disposition:"not_fixed",commit:"",reason:"requires an author decision"}
]}')"
: > "$GH_STUB_LOG"
(cd "$test_repo" && bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/short-sha.out" 2>&1
if [[ "$(<"$GH_STUB_LOG")" != "thread-fixed" ]]; then
  echo "an abbreviated fixing SHA was not accepted" >&2
  cat "$tmp_dir/short-sha.out" >&2
  exit 1
fi
grep -Fq '1 fixed/resolved, 1 deliberately left open' "$tmp_dir/short-sha.out"

# A report may not substitute an old, human, or unrelated URL for the exact triage set.
export FIX_OUTPUT="$(jq -cn --arg sha "$fix_sha" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"fixed"},
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_old",disposition:"fixed",commit:$sha,reason:"not fresh"}
]}')"
: > "$GH_STUB_LOG"
if (cd "$test_repo" && bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/mismatch.out" 2>&1; then
  echo "a mismatched finding URL was accepted" >&2
  exit 1
fi
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a thread was resolved before the full disposition set was validated" >&2
  exit 1
fi
grep -Fq 'do not exactly match this review run' "$tmp_dir/mismatch.out"

# Every supplied finding needs a disposition; a report may not simply omit one.
export FIX_OUTPUT="$(jq -cn --arg sha "$fix_sha" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"fixed"}
]}')"
: > "$GH_STUB_LOG"
if (cd "$test_repo" && bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/count.out" 2>&1; then
  echo "an incomplete disposition set was accepted" >&2
  exit 1
fi
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a thread was resolved before the disposition count was validated" >&2
  exit 1
fi
grep -Fq 'expected 2 dispositions, got 1' "$tmp_dir/count.out"

# `fixed` with no commit is a malformed disposition, not a fix.
export FIX_OUTPUT='{"findings":[
  {"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1","disposition":"fixed","commit":"","reason":"no SHA at all"},
  {"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2","disposition":"not_fixed","commit":"","reason":"left open"}
]}'
: > "$GH_STUB_LOG"
if (cd "$test_repo" && bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/shape.out" 2>&1; then
  echo "a fixed disposition with no commit was accepted" >&2
  exit 1
fi
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a thread was resolved before the disposition shape was validated" >&2
  exit 1
fi
grep -Fq 'every finding needs one valid URL, disposition, commit, and reason' "$tmp_dir/shape.out"

# The shape an empty `structured_output` produces: valid JSON, no findings array.
export FIX_OUTPUT='{}'
: > "$GH_STUB_LOG"
if (cd "$test_repo" && bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/no-findings.out" 2>&1; then
  echo "a typed output with no findings array was accepted" >&2
  exit 1
fi
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a thread was resolved from an output carrying no findings" >&2
  exit 1
fi
grep -Fq 'no valid typed findings array' "$tmp_dir/no-findings.out"

# A claimed fixing SHA must be a real commit in the checked-out PR head.
export FIX_OUTPUT='{"findings":[
  {"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1","disposition":"fixed","commit":"deadbee","reason":"not really"},
  {"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2","disposition":"not_fixed","commit":"","reason":"left open"}
]}'
: > "$GH_STUB_LOG"
if (cd "$test_repo" && bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/sha.out" 2>&1; then
  echo "an unknown fixing SHA was accepted" >&2
  exit 1
fi
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a thread was resolved before fixing SHAs were validated" >&2
  exit 1
fi
grep -Fq 'names unknown fixing commit deadbee' "$tmp_dir/sha.out"

# A REAL commit is still not a fix when the PR head cannot reach it.
export FIX_OUTPUT="$(jq -cn --arg sha "$unreachable_sha" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"pushed somewhere else"},
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2",disposition:"not_fixed",commit:"",reason:"left open"}
]}')"
: > "$GH_STUB_LOG"
if (cd "$test_repo" && bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/unreachable.out" 2>&1; then
  echo "a fixing SHA outside the PR head was accepted" >&2
  exit 1
fi
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a thread was resolved before PR-head reachability was validated" >&2
  exit 1
fi
grep -Fq 'which is not in the PR head' "$tmp_dir/unreachable.out"

# A real ancestor of HEAD is still not a fixing commit when it was already in PRE_FIX_SHA.
export FIX_OUTPUT="$(jq -cn --arg sha "$PRE_FIX_SHA" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"claimed but old"},
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2",disposition:"not_fixed",commit:"",reason:"left open"}
]}')"
: > "$GH_STUB_LOG"
if (cd "$test_repo" && bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/old-sha.out" 2>&1; then
  echo "a commit predating the fix run was accepted as the fixing SHA" >&2
  exit 1
fi
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a thread was resolved before the pre-fix boundary was validated" >&2
  exit 1
fi
grep -Fq 'which predates this fix run' "$tmp_dir/old-sha.out"

# Merging a side branch makes its commits reachable, but not agent-authored PR-line fixes.
git -C "$test_repo" merge --no-ff -q sidebranch -m 'merge upstream during fix run'
export FIX_OUTPUT="$(jq -cn --arg sha "$unreachable_sha" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"merged from elsewhere"},
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2",disposition:"not_fixed",commit:"",reason:"left open"}
]}')"
: > "$GH_STUB_LOG"
if (cd "$test_repo" && bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/side-sha.out" 2>&1; then
  echo "a merged-in side commit was accepted as a fixing SHA" >&2
  exit 1
fi
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a thread was resolved before first-parent ancestry was validated" >&2
  exit 1
fi
grep -Fq 'which is not on the post-fix PR branch line' "$tmp_dir/side-sha.out"

# Every check above reads local refs, and local lineage is fully satisfiable by a commit that
# never left the runner: `git push` is all-or-nothing per ref, so one rejected commit — a
# workflow-definition YAML edit under `.github/workflows/`, a non-fast-forward behind a
# concurrent human push — leaves all of them in HEAD and none on the PR. Only origin can
# tell those apart.
printf 'three\n' >> "$test_repo/alpha.txt"
git -C "$test_repo" commit -aq -m 'a fix whose push was rejected'
unpushed_sha="$(git -C "$test_repo" rev-parse HEAD)"
export FIX_OUTPUT="$(jq -cn --arg sha "$unpushed_sha" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"applied locally, never landed"},
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2",disposition:"not_fixed",commit:"",reason:"left open"}
]}')"
: > "$GH_STUB_LOG"
if (cd "$test_repo" && bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/unpushed.out" 2>&1; then
  echo "a fixing commit that never reached origin was accepted" >&2
  exit 1
fi
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a thread was resolved before the pushed-to-origin check ran" >&2
  exit 1
fi
grep -Fq "was never pushed to origin/$head_branch" "$tmp_dir/unpushed.out"

# One genuine in-run commit cannot retire a finding on a path it did not change — but a
# cross-file fix reports exactly the same way, so this costs that one conversation its
# resolution instead of failing a run whose commits are already pushed.
export FIX_OUTPUT="$(jq -cn --arg sha "$other_sha" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"fixed in a sibling file"},
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2",disposition:"not_fixed",commit:"",reason:"left open"}
]}')"
: > "$GH_STUB_LOG"
(cd "$test_repo" && bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/path.out" 2>&1
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a thread was resolved from a commit that did not change its reviewed path" >&2
  cat "$GH_STUB_LOG" >&2
  exit 1
fi
grep -Fq 'which does not change its reviewed path alpha.txt' "$tmp_dir/path.out"
grep -Fq 'left open (its named fixing commit does not change the reviewed path)' "$tmp_dir/path.out"
grep -Fq '0 fixed/resolved, 2 deliberately left open' "$tmp_dir/path.out"

# The triage set itself is validated before anything else runs: an empty set would make the
# count check vacuous, and duplicate URLs would let one disposition stand in for two findings.
for bad_expected in \
  '[]' \
  '[{"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1","path":"alpha.txt"},{"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1","path":"beta.txt"}]' \
  '[{"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1","path":""}]'
do
  : > "$GH_STUB_LOG"
  if (cd "$test_repo" && EXPECTED_FINDINGS="$bad_expected" \
    bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/expected.out" 2>&1; then
    echo "an invalid triage set was accepted: $bad_expected" >&2
    exit 1
  fi
  if [[ -s "$GH_STUB_LOG" ]]; then
    echo "a thread was resolved from an invalid triage set" >&2
    exit 1
  fi
  grep -Fq 'must be a non-empty JSON array with unique URLs and non-empty paths' "$tmp_dir/expected.out"
done

# A reported URL whose review thread is no longer readable — deleted, dismissed, or past
# `comments(first:100)` — is unproven rather than wrong, so it costs that one conversation its
# resolution. It must not redden a run whose commits are already pushed.
export FIX_OUTPUT="$(jq -cn --arg sha "$fix_sha" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"covered by the new guard"},
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2",disposition:"not_fixed",commit:"",reason:"left open"}
]}')"
: > "$GH_STUB_LOG"
missing_threads='[{
  "data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
    {"id":"thread-open","isResolved":false,"comments":{"nodes":[{"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2"}]}}
  ]}}}}}
]'
(cd "$test_repo" && GH_STUB_THREADS="$missing_threads" \
  bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/no-thread.out" 2>&1
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a thread was resolved for a URL no review thread carries" >&2
  cat "$GH_STUB_LOG" >&2
  exit 1
fi
grep -Fq 'no review thread found for https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1' "$tmp_dir/no-thread.out"
grep -Fq 'left open (no review thread carries its comment URL)' "$tmp_dir/no-thread.out"
grep -Fq '0 fixed/resolved, 2 deliberately left open' "$tmp_dir/no-thread.out"

# Two threads carrying the same comment URL is not a state GitHub produces, so unlike the
# vanished thread it stays fatal rather than picking one.
: > "$GH_STUB_LOG"
duplicate_threads='[{
  "data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
    {"id":"thread-fixed","isResolved":false,"comments":{"nodes":[{"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1"}]}},
    {"id":"thread-twin","isResolved":false,"comments":{"nodes":[{"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1"}]}}
  ]}}}}}
]'
if (cd "$test_repo" && GH_STUB_THREADS="$duplicate_threads" \
  bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/twin-thread.out" 2>&1; then
  echo "an ambiguous pair of review threads was accepted" >&2
  exit 1
fi
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a thread was resolved from an ambiguous match" >&2
  exit 1
fi
grep -Fq 'expected exactly one review thread' "$tmp_dir/twin-thread.out"

# A base the fix job cannot reconstruct is unproven, not wrong. A human rebase or force-push
# while the job runs leaves the review's pre-fix SHA either unknown to this checkout or off
# its history — by which point the fixes are pushed and the `🔧 fix-agent` comment posted, so
# a red run would say the opposite of what happened. Same for the origin lookup that decides
# what landed: unreadable is not disproved. Each costs every conversation its resolution.
git -C "$test_repo" checkout -q -b rewritten-base "$PRE_FIX_SHA"
printf 'rewritten\n' > "$test_repo/rewritten.txt"
git -C "$test_repo" add rewritten.txt
git -C "$test_repo" commit -q -m 'a base this PR head cannot reach'
rewritten_sha="$(git -C "$test_repo" rev-parse HEAD)"
git -C "$test_repo" checkout -q "$head_branch"

export FIX_OUTPUT="$(jq -cn --arg sha "$fix_sha" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"covered by the new guard"},
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2",disposition:"not_fixed",commit:"",reason:"left open"}
]}')"
unproven_case=0
for unproven in \
  "PRE_FIX_SHA=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef|is not a known commit in this checkout" \
  "PRE_FIX_SHA=$rewritten_sha|is not in the current PR head" \
  "GH_STUB_PR_HEAD_REF=|the head branch of PR #1 could not be read"
do
  unproven_case=$((unproven_case + 1))
  out="$tmp_dir/unproven-$unproven_case.out"
  : > "$GH_STUB_LOG"
  (cd "$test_repo" && env "${unproven%%|*}" \
    bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$out" 2>&1
  if [[ -s "$GH_STUB_LOG" ]]; then
    echo "a thread was resolved while the PR's lineage could not be checked: $unproven" >&2
    cat "$GH_STUB_LOG" >&2
    exit 1
  fi
  grep -Fq "leaving every conversation open" "$out"
  grep -Fq "${unproven#*|}" "$out"
  grep -Fq '0 fixed/resolved, 2 deliberately left open' "$out"
done

# A reviewed path is a FILENAME, and the `--` argument is a PATHSPEC, so `[`, `*` and `?`
# in a name are glob magic. Two things are pinned here, and the second is the load-bearing
# one: a fix that changes a glob-shaped path IS credited to it, and a fix that changes only
# the SIBLING that glob would also match is NOT. Git prefers an exact match, so the pathspec
# filter alone never loses the file itself — but on its own it would also return the
# sibling, so the resolver's identity check is what refuses the over-claim. Reducing the two
# to one ("did the commit change anything the pathspec matched") reopens it.
# Everything so far is pushed first, because the origin check runs before the path check.
git -C "$test_repo" push -q origin "$head_branch"
printf 'glob\n' > "$test_repo/a[1].txt"
git -C "$test_repo" --literal-pathspecs add 'a[1].txt'
git -C "$test_repo" commit -q -m 'fix the finding on a glob-shaped path'
glob_sha="$(git -C "$test_repo" rev-parse HEAD)"
printf 'sibling\n' > "$test_repo/a1.txt"
git -C "$test_repo" --literal-pathspecs add 'a1.txt'
git -C "$test_repo" commit -q -m 'touch only the sibling that glob would match'
sibling_sha="$(git -C "$test_repo" rev-parse HEAD)"
git -C "$test_repo" push -q origin "$head_branch"

glob_expected='[
  {"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1","path":"a[1].txt"},
  {"url":"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2","path":"beta.txt"}
]'
glob_output="$(jq -cn --arg sha "$glob_sha" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"changed the glob-shaped path itself"},
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2",disposition:"not_fixed",commit:"",reason:"left open"}
]}')"
: > "$GH_STUB_LOG"
(cd "$test_repo" && EXPECTED_FINDINGS="$glob_expected" FIX_OUTPUT="$glob_output" \
  bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/glob-path.out" 2>&1
if [[ "$(<"$GH_STUB_LOG")" != "thread-fixed" ]]; then
  echo "a fix on a path containing glob characters was not credited to it" >&2
  cat "$tmp_dir/glob-path.out" >&2
  exit 1
fi
grep -Fq '1 fixed/resolved, 1 deliberately left open' "$tmp_dir/glob-path.out"

sibling_output="$(jq -cn --arg sha "$sibling_sha" '{findings:[
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r1",disposition:"fixed",commit:$sha,reason:"actually only touched the sibling a1.txt"},
  {url:"https://github.com/AugentaAI/augenta-plugin/pull/1#discussion_r2",disposition:"not_fixed",commit:"",reason:"left open"}
]}')"
: > "$GH_STUB_LOG"
(cd "$test_repo" && EXPECTED_FINDINGS="$glob_expected" FIX_OUTPUT="$sibling_output" \
  bash "$REPO_ROOT/.github/scripts/resolve-fixed-review-threads.sh") > "$tmp_dir/glob-sibling.out" 2>&1
if [[ -s "$GH_STUB_LOG" ]]; then
  echo "a commit touching only the glob's sibling was credited to a[1].txt" >&2
  cat "$GH_STUB_LOG" >&2
  exit 1
fi
grep -Fq 'does not change its reviewed path a[1].txt' "$tmp_dir/glob-sibling.out"
grep -Fq '0 fixed/resolved, 2 deliberately left open' "$tmp_dir/glob-sibling.out"

echo "Claude fix resolution gate passed."
