#!/bin/sh
# Invoked as `sh "<path>"` from hooks/hooks.json, never directly: a marketplace
# install is a file copy and the executable bit is not something to depend on
# surviving it. The shebang is kept only so a contributor can run this by hand.
#
# Resolve a working Node runtime for hooks. Desktop harnesses can inherit a
# smaller PATH than the user's terminal, and the first `node` on that PATH may
# be a stale package-manager shim or a binary with missing shared libraries.
#
#
# Cost, since PostToolUse pays it per tool call and SessionEnd pays it inside a
# 3s Codex-capped budget: one `sh`, plus ONE extra Node startup for the version
# probe of the first candidate that is executable. Candidates that do not exist
# cost a `[ -x ]` test and spawn nothing, so a host with no version manager
# probes exactly once — a hook fire is two Node startups rather than one.
# `AUGENTA_NODE` skips the search entirely and still pays its one probe.
#
# Nothing is cached deliberately. A cache would have to live on disk, shared by
# every project and every harness, and a stale entry pointing at the runtime a
# user just replaced is precisely the broken-Node failure this file exists to
# fix — traded for a saving of one process startup.

set -u

if [ "$#" -lt 1 ]; then
  echo "Augenta hook: missing bundle path" >&2
  exit 1
fi

target=$1
shift

try_node() {
  candidate=$1
  shift
  # The probe reads no input, but stdin is the hook PAYLOAD: a non-Node
  # executable named `node` would consume it here and the real bundle would
  # then see an empty stream — the silent stdin-then-exit-0 failure this
  # runner exists to prevent. Redirect it away from every probe.
  if [ -x "$candidate" ] &&
    "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
      </dev/null >/dev/null 2>&1
  then
    exec "$candidate" "$target" "$@"
  fi
  return 1
}

# An explicit override is authoritative. It is useful when diagnosing a host
# whose normal shell and hook subprocess expose different runtimes.
if [ -n "${AUGENTA_NODE:-}" ]; then
  if ! try_node "$AUGENTA_NODE" "$@"; then
    echo "Augenta hook: AUGENTA_NODE is not a working Node.js 20+ executable" >&2
    exit 1
  fi
fi

# Version managers commonly initialize only in an interactive shell. Probe
# their install locations before PATH so a broken system Node cannot eclipse a
# healthy runtime the user already has. Unmatched globs simply fail the -x test.
if [ -n "${FNM_MULTISHELL_PATH:-}" ]; then
  # Guarded: unset, `"${FNM_MULTISHELL_PATH:-}/bin/node"` is `/bin/node`, which
  # would probe the SYSTEM Node ahead of every version manager below it — the
  # opposite of this ordering's purpose.
  try_node "$FNM_MULTISHELL_PATH/bin/node" "$@" || true
fi
for candidate in \
  "${HOME:-}"/.local/state/fnm_multishells/*/bin/node \
  "${HOME:-}"/.local/share/fnm/node-versions/*/installation/bin/node \
  "${HOME:-}"/.nvm/versions/node/*/bin/node \
  "${HOME:-}"/.volta/bin/node \
  "${HOME:-}"/.asdf/shims/node \
  "${HOME:-}"/.cache/codex-runtimes/*/dependencies/node/bin/node
do
  try_node "$candidate" "$@" || true
done

saved_ifs=$IFS
IFS=:
for directory in ${PATH:-}; do
  [ -n "$directory" ] || continue
  try_node "$directory/node" "$@" || true
done
IFS=$saved_ifs

# Nothing can be exec'd now, so consuming the payload is free — and it carries
# the one fact worth having: whether this project ever opted in. Hooks are a
# silent no-op without `.augenta/config.json` (AGENTS.md → Privacy invariants),
# and a missing Node is not evidence of consent, so a project that never
# connected gets silence on every fire instead of a repeated complaint about a
# runtime it does not need. A CONNECTED project is owed the diagnostic: its
# capture has stopped.
#
# Shell builtins only, deliberately: the PATH that got us here is the thing
# under suspicion, and a diagnostic that itself needs `sed` on PATH would go
# missing exactly when it is needed. `"cwd"` cannot be matched by a suffixed key
# like `"old_cwd"`, whose leading quote sits elsewhere.
payload=""
if [ ! -t 0 ]; then
  # `|| [ -n "$line" ]` because a payload with no trailing newline leaves the
  # last — usually only — line in $line with `read` already reporting failure.
  while IFS= read -r line || [ -n "$line" ]; do
    payload="$payload$line"
    line=""
  done
fi
project=""
case $payload in
  *'"cwd"'*)
    rest=${payload#*'"cwd"'}
    rest=${rest#*:}
    rest=${rest#*'"'}
    project=${rest%%'"'*}
    ;;
esac
# Mirror the bounded project lookup without requiring Git or Node. Only absolute
# paths are usable here; malformed payload paths must not inspect this shell's cwd.
case $project in /*) ;; *) exit 0 ;; esac
# Resolve symlinks before walking parents, matching the Node lookup. Both cd and
# pwd are shell builtins, so this still works with the unusable PATH above.
project=$(CDPATH= cd -P "$project" 2>/dev/null && pwd -P) || exit 0
while [ -n "$project" ]; do
  if [ -f "$project/.augenta/config.json" ]; then
    echo "Augenta hook: Node.js 20 or newer was not found; install or repair Node.js, or set AUGENTA_NODE to a working executable" >&2
    exit 1
  fi
  [ -e "$project/.git" ] && break
  [ "$project" = / ] && break
  project=${project%/*}
  [ -n "$project" ] || project=/
done
exit 0
