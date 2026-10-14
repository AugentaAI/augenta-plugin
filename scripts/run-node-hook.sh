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

# A sandbox that allows egress only through a proxy it names in the environment
# (cloud sessions, Cowork's VM) is invisible to Node's fetch unless Node is told
# to use it: without NODE_USE_ENV_PROXY, Node ignores HTTPS_PROXY and connects
# directly, which such a sandbox refuses. Node 22.21+ and 24+ honor it; older
# versions ignore an unknown variable, so exporting it is harmless there.
# NODE_NO_WARNINGS hides 22.x's "EnvHttpProxyAgent is experimental" notice. A
# CA is added only when none is configured, and only from a readable file (Node
# warns on a missing one). Environment variables
# only, never CLI flags, so no Node version can reject them. Everything a hook
# spawns, the detached shipper included, inherits these. runtime/node.ts does
# the same for the CLIs the skills run.
if [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}" ]; then
  if [ -z "${NODE_USE_ENV_PROXY:-}" ]; then
    NODE_USE_ENV_PROXY=1
    export NODE_USE_ENV_PROXY
  fi
  if [ -z "${NODE_NO_WARNINGS:-}" ]; then
    NODE_NO_WARNINGS=1
    export NODE_NO_WARNINGS
  fi
fi
# A sandbox's own proxy CA is trusted whenever the sandbox left it, proxy variable
# or not: a TLS-intercepting proxy can be transparent and name itself nowhere. The
# system bundle is added only alongside a proxy Node was told to use.
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ]; then
  if [ -r /usr/local/share/ca-certificates/mitm-proxy-ca.crt ]; then
    NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/mitm-proxy-ca.crt
    export NODE_EXTRA_CA_CERTS
  elif [ -n "${NODE_USE_ENV_PROXY:-}" ] && [ -r /etc/ssl/certs/ca-certificates.crt ]; then
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
    export NODE_EXTRA_CA_CERTS
  fi
fi

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
# the facts worth having: whether this project ever opted in, and which hook
# event this is. Hooks are a silent no-op without `.augenta/config.json`
# (AGENTS.md → Privacy invariants), and a missing Node is not evidence of
# consent, so a project that never connected gets silence on every fire instead
# of a repeated complaint about a runtime it does not need. A CONNECTED project
# is owed the diagnostic: its capture has stopped.
#
# Shell builtins only, deliberately: the PATH that got us here is the thing
# under suspicion, and a diagnostic that itself needs `sed` on PATH would go
# missing exactly when it is needed.
payload=""
if [ ! -t 0 ]; then
  # `|| [ -n "$line" ]` because a payload with no trailing newline leaves the
  # last — usually only — line in $line with `read` already reporting failure.
  while IFS= read -r line || [ -n "$line" ]; do
    payload="$payload$line"
    line=""
  done
fi

# The string value of the payload key $1, left in $field ("" when absent). A
# quoted key cannot be matched by a suffixed one: `"cwd"` never matches
# `"old_cwd"`, whose leading quote sits elsewhere.
json_string() {
  field=""
  case $payload in
    *"\"$1\""*)
      field=${payload#*"\"$1\""}
      field=${field#*:}
      field=${field#*'"'}
      field=${field%%'"'*}
      ;;
  esac
}

# The harness, decided as hooks/harness.ts `isCodexHarness` decides it from the
# transcript path; __tests__/hook-runner.test.ts holds the two to the same answers.
codex_harness() {
  json_string transcript_path
  [ -n "$field" ] || return 1
  # Claude Code's own layout wins first: a cloud image can set CODEX_HOME to the
  # home directory itself, and every Claude transcript would then read as Codex.
  case $field in */.claude/projects/*) return 1 ;; */.codex/*) return 0 ;; esac
  case $field in
    */*)
      case ${field##*/} in
        [Rr][Oo][Ll][Ll][Oo][Uu][Tt]-*.[Jj][Ss][Oo][Nn][Ll]) return 0 ;;
      esac
      ;;
  esac
  codex_home=${CODEX_HOME-}
  while [ "${codex_home%/}" != "$codex_home" ]; do codex_home=${codex_home%/}; done
  [ -n "$codex_home" ] || return 1
  [ "$field" = "$codex_home" ] && return 0
  case $field in "$codex_home"/*) return 0 ;; esac
  return 1
}

# The one exception to that silence. Without Node, SessionStart's connect prompt
# cannot run either, so a computer with no Node would never hear from the plugin
# at all: installed, its hooks trusted and firing, every one doing nothing.
# Installing the plugin is a signal that the hidden prompt is not, so the first
# SessionStart on a computer says why, ONCE, through the same `additionalContext`
# channel that prompt uses, and every fire after it is silent again. Only
# SessionStart: a notice spent on any other event would be thrown away.
#
# "Once" is a marker beside connect-prompted.json, under the same home
# session-start.ts uses, created exclusively: noclobber makes `>` an O_EXCL open,
# so two sessions starting together still print one notice. A marker that cannot
# be created means silence, as session-start.ts's firstTime() decides — better
# quiet than a notice on every session. A home that is not absolute is refused
# rather than resolved against the hook's cwd, which may be the project.
# `command -p` finds mkdir on the default PATH, not the one under suspicion.
#
# Constant text, so the JSON needs no escaping: keep `"`, `\` and `'` out of it.
# Both harnesses hand it to the model. Ask it to relay the notice, with the
# invocation for that harness, as session-start.ts does.
notify_once() {
  json_string hook_event_name
  [ "$field" = SessionStart ] || return 0
  home=${AUGENTA_HOME-${HOME-}}
  case $home in /*) ;; *) return 0 ;; esac
  command -p mkdir -p "$home/.augenta/state" 2>/dev/null || return 0
  (set -C; : > "$home/.augenta/state/node-missing-notified") 2>/dev/null || return 0
  if codex_harness; then
    printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"When you first reply, tell the user that Augenta is installed but cannot run on this computer: no Node.js 20 or newer was found on the PATH this app gives its hooks. Explain how to install Node.js 20 or newer, or set AUGENTA_NODE to the absolute path of a working node, then start a new session and run $augenta:connect or ask to Connect Augenta. Do not start connecting before Node works or unless the user asks. This notice appears once on this computer."}}'
  else
    printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[Augenta] The Augenta plugin is installed but cannot run on this computer: no Node.js 20 or newer was found on the PATH this app gives its hooks, so none of them can run and this project was never offered a connection. This is the only notice it will give on this computer. Tell the user. The fix is to install Node.js 20 or newer, or to set AUGENTA_NODE to the absolute path of a working node executable, and then start a new session, which offers to connect the project. Do not run the augenta connect skill (/augenta:connect) before then: it needs the same Node.js."}}'
  fi
}

unconnected() {
  notify_once
  exit 0
}

json_string cwd
project=$field
# Mirror the bounded project lookup without requiring Git or Node. Only absolute
# paths are usable here; malformed payload paths must not inspect this shell's cwd.
case $project in /*) ;; *) unconnected ;; esac
# Resolve symlinks before walking parents, matching the Node lookup. Both cd and
# pwd are shell builtins, so this still works with the unusable PATH above.
project=$(CDPATH= cd -P "$project" 2>/dev/null && pwd -P) || unconnected
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
unconnected
