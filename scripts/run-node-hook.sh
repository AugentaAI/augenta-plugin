#!/bin/sh
# Resolve a working Node runtime for hooks. Desktop harnesses can inherit a
# smaller PATH than the user's terminal, and the first `node` on that PATH may
# be a stale package-manager shim or a binary with missing shared libraries.

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
  if [ -x "$candidate" ] &&
    "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1
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
for candidate in \
  "${FNM_MULTISHELL_PATH:-}/bin/node" \
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

echo "Augenta hook: Node.js 20 or newer was not found; install or repair Node.js" >&2
exit 1
