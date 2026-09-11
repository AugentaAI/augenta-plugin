#!/usr/bin/env bash
# Three pipeline shapes are banned, for the same reason: the status
# the step reports is not the status of the thing that mattered. Credential-free, offline, greps.
#
#   1. piping into `grep -q`      — reports FAILURE when the match succeeds (below)
#   2. piping curl into a shell   — reports SUCCESS when the download failed (further below)
#   3. piping into a consumer that STOPS SHORT, in a shell command substitution (last)
#
# ---------------------------------------------------------------------------- 1. `| grep -q`
#
# `grep -q` exits the instant it matches. That closes the pipe, its producer dies of SIGPIPE
# (141), `set -o pipefail` makes 141 the pipeline's status, and an `if` reads that as NO MATCH.
# The pipeline therefore reports failure exactly when the match SUCCEEDS.
#
# It is volume-dependent, which is what makes it worth a gate rather than a comment: while the
# producer's output is short enough to finish writing before grep matches, everything passes.
#
# It was diagnosed once already in an end-to-end script -- "a volume-dependent flake rather
# than a constant one" -- and the note never reached the two workflows that needed it most.
# Both `claude-code-review.yml` and `claude-review-fix.yml`
# asserted "did the agent post its comment?" with `gh pr view … | grep -q`, so as each PR
# accumulated comments the assert began reporting a silent no-op about a review that HAD
# posted. One PR hit it with nine marker comments
# present: `grep -c` returned 9 while the pipeline returned 141, twice in a row.
#
# The failure direction is the worst available: these steps exist to catch "reported success
# but did nothing", and the bug makes them say exactly that about work that was done.
#
# Banned outright rather than judged per case. A tiny producer makes the race unlikely, not
# absent, and a gate with an exception register is a gate someone will argue their way into.
# `bodies="$(producer)"` then `grep -q … <<<"$bodies"` costs one line and cannot race -- and it
# also separates "the read failed" from "no match", which is what these asserts are FOR.
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

#: What to scan. Overridden ONLY by the self-check below, which points the gate at a fixture of
#: known-bad lines. Its presence is also what stops that check recursing. Normal runs enumerate
#: tracked files, so generated dependencies and ignored build output cannot change the verdict.
SCAN="${AUGENTA_WF_GATE_SCAN:-}"

yaml_files() {
  if [[ -n "$SCAN" ]]; then
    find "$SCAN" -type f \( -name '*.yml' -o -name '*.yaml' \) -print0
  else
    git ls-files -z -- '.github/workflows/*.yml' '.github/workflows/*.yaml'
  fi
}

shell_files() {
  if [[ -n "$SCAN" ]]; then
    find "$SCAN" -type f -name '*.sh' -print0
  else
    git ls-files -z -- '*.sh'
  fi
}

# ------------------------------------------------------------------ the gate checks ITSELF first
#
# Because the first draft of the curl ban DID NOT MATCH THE LINE THAT PROMPTED IT. It allowed only
# `sudo` between the pipe and the shell, so `curl -s … | TAG=v5.9.0 bash` -- the literal `ci.yml`
# step whose silent success sent a green tool install into a red bootstrap -- sailed through a gate
# written specifically to catch it. It passed the real tree, which is what a working gate also does.
#
# So the fixture is not a nicety. A pattern gate has exactly one failure mode, it is silent, and
# `exit 0` cannot distinguish "nothing to find" from "cannot find anything". Every invocation now
# proves the gate can come out RED on known-bad input before its green is worth anything.
if [[ -z "${AUGENTA_WF_GATE_SCAN:-}" ]]; then
  _fx="$(mktemp -d)"
  trap 'rm -rf "$_fx"' EXIT
  cat > "$_fx/probe.yml" <<'PROBE'
      - run: curl -s https://example.com/i.sh | TAG=v5.9.0 bash
      - run: curl -sSL https://example.com/i.sh | sudo bash
      - run: wget -qO- https://example.com/i.sh | sh
      - run: curl -fsSL https://example.com/i.sh | A=1 env sh -s -- --v 1
      - run: curl -sL https://example.com/i.sh | bash -s -- --version 1.2
      - run: gh pr view 1 --json comments | grep -q marker
      # allowed, it is a comment: curl -s https://x/i.sh | bash
      - run: curl -fsSLo /tmp/i.sh https://example.com/i.sh && bash /tmp/i.sh
      - run: cat notes.txt | bash_helper_thing
PROBE
  cat > "$_fx/probe.sh" <<'PROBE'
#!/usr/bin/env bash
first="@D@(producer | head -1)"
second="@D@(producer \
  | head -20)"
third="@D@(
  producer |
  head -1
)"
fourth=@B@producer | head -1@B@
fifth="@D@(producer | awk '/pat/ {print; exit}')"
sixth="@D@(producer | sed -n '/pat/{p;q}')"
seventh="@D@(producer | read -r line)"
producer | head -20 # allowed display pipeline
producer | awk '/pat/ {print; exit}' # allowed display pipeline
PROBE
  cat > "$_fx/allowed.sh" <<'PROBE'
#!/usr/bin/env bash
# A comment mentioning $(terraform state list) must not open a substitution.
if [[ -n "$(command -v producer)" ]]; then :; fi
value="$(producer)" || rc=$?
case "$(uname)" in *) : ;; esac
producer | head -20 # allowed display pipeline
drains="$(producer | awk '{ print $2 }')"
also="$(producer | sed -n 's/a/b/p')"
PROBE
  sed -e 's/@D@/$/g' -e 's/@B@/`/g' "$_fx/probe.sh" > "$_fx/probe-ready.sh"
  mv "$_fx/probe-ready.sh" "$_fx/probe.sh"
  _hits="$(AUGENTA_WF_GATE_SCAN="$_fx" bash "$0" 2>&1 | grep -c '::error::' || true)"
  if [[ "$_hits" != "13" ]]; then
    echo "SELF-CHECK FAILED: the gate found $_hits of 13 known-bad lines in its own fixture." >&2
    echo "  A pattern gate that cannot match is indistinguishable from a clean tree. Fix the" >&2
    echo "  expressions below before trusting any green from this file." >&2
    exit 1
  fi
  rm -rf "$_fx"; trap - EXIT
fi

fail=0
while IFS= read -r -d '' file; do
  while IFS= read -r hit; do
    # Comments are where the ban is EXPLAINED, so they are the one thing that may name it.
    line="${hit#*:}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    echo "::error::$file:$hit" >&2
    echo "  pipes into 'grep -q': SIGPIPE under pipefail reports failure when the match succeeds." >&2
    echo "  Capture first instead:  x=\"\$(producer)\"  then  grep -q 'pat' <<<\"\$x\"" >&2
    fail=1
  done < <(grep -n '| *grep -q' "$file" || true)
done < <(yaml_files)

# ------------------------------------------------------- 2. `curl … | bash` (and `| sh`, `| sudo`)
#
# GitHub runs `run:` under `bash -e`, NOT `-o pipefail`, so in `curl … | bash` the step's status is
# bash's alone and curl's is discarded. Combined with curl's default of exiting 0 on a 4xx/5xx, and
# bash exiting 0 on empty or HTML stdin, the step goes GREEN having installed nothing — and the run
# dies later, somewhere else, pointing at the wrong thing.
#
# MEASURED, not theorised: a CI cluster-tool install was `curl -s … | TAG=v5.9.0 bash`. On one run
# the step reported success and the bootstrap script failed two steps later with
# `missing required tool`, reading as a broken cluster job rather than a CDN hiccup.
#
# The lesson was already in that same repository TWICE before it reached that line — a sibling
# fetch in the same job carried a comment explaining `-f` exactly, and it still did not propagate.
# That is what makes it a gate rather than a comment, on the same argument as the ban above.
#
# The fix is one line longer and cannot lose a status: fetch to a FILE, then run the file, then
# assert the tool exists.
#   curl -fsSLo /tmp/x.sh --retry 3 --retry-delay 5 --retry-all-errors URL
#   bash /tmp/x.sh
#   thetool version
while IFS= read -r -d '' file; do
  while IFS= read -r hit; do
    # Comments are where the ban is EXPLAINED, so they are the one thing that may name it.
    line="${hit#*:}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    echo "::error::$file:$hit" >&2
    echo "  pipes a download into a shell: the step reports the SHELL's status, not curl's, and" >&2
    echo "  curl exits 0 on a 4xx/5xx by default — so it goes green having installed nothing." >&2
    echo "  Fetch to a file instead, then run it, then assert the tool is there:" >&2
    echo "    curl -fsSLo /tmp/x.sh --retry 3 --retry-delay 5 --retry-all-errors URL" >&2
    echo "    bash /tmp/x.sh && thetool version" >&2
    fail=1
  done < <(grep -nE '(curl|wget)[^|]*\|[[:space:]]*((sudo|env|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*)[[:space:]]+)*(ba)?sh\b' \
             "$file" || true)
# The prefix alternation is the load-bearing part, and the first draft of this gate got it wrong
# in the way that mattered: it allowed only `sudo` before the shell, so it did NOT match
# `curl -s … | TAG=v5.9.0 bash` -- the literal line that broke CI and the reason this check exists.
# Env assignments and `env`/`sudo` may appear in any number before the shell word, so all three are
# allowed for and the loop above is probed against a fixture carrying every form.
done < <(yaml_files)

# ------------------------------- 3. command substitution piping into a consumer that stops short
# A consumer that closes its input before the producer is done writing sends it SIGPIPE; under
# `pipefail` the assignment has status 141 and `set -e` aborts the script.
# Display pipelines remain allowed: the dangerous distinction here is making the pipeline status
# the variable's fate. Select in the producer, or capture all output and slice it in the shell.
#
# `head` was the whole ban at first. It is not the only consumer that stops short, and the
# omission cost a real run: a bootstrap script resolved a cluster node with
# `node list | awk '''$1 ~ /-server-0$/ {print $1; exit}'''`, and on one run -- a dependabot
# dependency bump, a diff that cannot touch a cluster -- `awk` exited on the first match
# while the producer still had another line to write. Exit 141, before the next step
# had printed its own first line, reading as a broken bootstrap.
# The gate was GREEN on that tree, which is the failure mode this file exists to refuse.
#
# So the check is on the CONSUMER's behaviour, not on one command's name: `head` (no argument
# still means ten lines), `awk` that calls `exit`, `sed` with a `q` command, and `read`. An `awk`
# or `sed` that drains its input is not this bug and is not flagged.
#
# ---- Why this check scans SHELL and check 1 scans WORKFLOWS, which is not symmetry ----
# GitHub runs `run:` under `bash -e {0}` with NO pipefail (no workflow here sets `shell:` or a
# `defaults.run.shell`), so in a workflow `x="$(a | head -1)"` takes `head`'s status and the
# producer's 141 is discarded -- not a bug, and workflow steps legitimately rely on it.
# Scanning yaml here would therefore be false positives. The blocks that opt in with an explicit
# `set -euo pipefail` are the exception, and a line-oriented gate cannot tell which shell a given
# `run:` line belongs to, so it does not guess.
#
# The inverse holds for check 1: `| grep -q` is banned in workflows and NOT scanned in shell
# files, where the surviving sites are mostly `printf '''%s''' "$var" | grep -q` -- a builtin
# flushing a short string -- or sit inside a `bash -c "..."` that has no pipefail of its own.
# Widening it means auditing every one of them and is its own change; it is not folded in here.
while IFS= read -r -d '' file; do
  while IFS= read -r hit; do
    echo "::error::$file:$hit" >&2
    echo "  pipes into a consumer that stops short (head / awk with exit / sed with q / read)," >&2
    echo "  inside a command substitution: it SIGPIPEs its producer and pipefail turns that into a" >&2
    echo "  failed assignment. Capture first, then slice:  x=\"\$(producer)\"  then  awk ... <<<\"\$x\"" >&2
    fail=1
  done < <(awk '
    function active() { return depth > 0 || backtick }
    # A consumer that closes its input before the producer has finished writing. Named by
    # BEHAVIOUR: an awk or sed that drains its input is not this bug.
    function stops_short(s) {
      if (s ~ /^[[:space:]]*head([[:space:]]|$)/) return 1
      if (s ~ /^[[:space:]]*awk([[:space:]]|$)/ && s ~ /exit/) return 1
      if (s ~ /^[[:space:]]*sed([[:space:]]|$)/ && s ~ /(^|[^a-zA-Z])q([^a-zA-Z]|$)/) return 1
      if (s ~ /^[[:space:]]*read([[:space:]]|$)/) return 1
      return 0
    }
    /^[[:space:]]*#/ { next }
    {
      if (pipe_pending && active() && stops_short($0)) {
        print FNR ":" $0
      }
      pipe_pending=0
      single=0
      escaped=0
      for (i=1; i<=length($0); i++) {
        ch=substr($0, i, 1)
        nextch=substr($0, i+1, 1)
        if (escaped) { escaped=0; continue }
        if (ch == "\\") { escaped=1; continue }
        if (ch == "\047") { single=!single; continue }
        if (single) continue
        if (ch == "`") { backtick=!backtick; continue }
        if (ch == "$" && nextch == "(") { depth++; i++; continue }
        if (depth > 0 && ch == "(") { depth++; continue }
        if (depth > 0 && ch == ")") { depth--; continue }
        if (ch == "|" && active()) {
          rest=substr($0, i+1)
          if (stops_short(rest)) {
            print FNR ":" $0
          } else if (rest ~ /^[[:space:]\\]*$/) {
            pipe_pending=1
          }
        }
      }
      if (!active()) pipe_pending=0
    }
  ' "$file")
done < <(shell_files)

[[ "$fail" == "0" ]] || {
  echo "pipeline gate: found a pipeline above that reports the wrong status." >&2
  exit 1
}
echo "Pipeline gate passed (grep -q SIGPIPE, curl-into-shell, command-substitution stop-short)."
