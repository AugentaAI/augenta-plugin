# Debugging and non-production testing

Contributor notes. Nothing here is user-facing, and `README.md` deliberately does
not link this file: every lever below either points a real project at a
non-production Augenta or rewrites local sign-in state, which is contributor work
and never something to walk a user through.

## Point the plugin at a non-production Augenta

Export the control URL. `augentaOAuthConfig` (`capture/auth.ts:210`) reads
`AUGENTA_CONTROL_URL` on every code path, so this reaches the interactive script,
all four `--json` verbs, and the connect skill alike:

```bash
export AUGENTA_CONTROL_URL=https://dev.augenta.ai
```

The variable selects one environment's **complete** login discovery — issuer,
public client id, and gateway together — by fetching
`<control-url>/.well-known/augenta.json`. `scripts/connect.ts --control-url <url>`
does the same for one invocation and wins over the variable.

Do not use `--endpoint` alone to reach another environment. It moves the gateway
only, leaving the issuer and client id on the previous environment, which fails
later as an unexplained 401 rather than at the point of the mistake.

**The connect skill has no environment flag, on purpose.** `SKILL.md` stays
environment-agnostic and the variable does the work, for two reasons. A user
connecting a project has no environment to choose, so an agent that knows about
one can offer a decision nobody can answer. And a flag would have to be applied
to *every* verb: `--await-login` compares the pending grant's issuer and client id
against fresh discovery and **clears the grant** on mismatch
(`scripts/connect.ts:973`), so one verb missing the flag mid-flow throws away a
sign-in the user already authorized in their browser. A process-wide variable
cannot be applied to only some of the verbs.

Disclosure is unaffected. `environmentLabel` (`scripts/connect.ts:826`) reads the
same variable, so every payload's `environment` field becomes the literal URL
instead of `prod`, and `SKILL.md` requires the agent to state a non-prod
environment in both the Neurospace question and the confirmation. If a skill run
reports `prod` or says nothing, the variable did not reach the harness process.

## Run the working tree instead of an installed copy

Claude Code loads a local checkout directly, so a skill or hook change is
testable without a version bump or a marketplace install:

```bash
AUGENTA_CONTROL_URL=https://dev.augenta.ai \
  claude --plugin-dir /absolute/path/to/augenta-plugin
```

Codex has no equivalent — `codex plugin` only installs from a marketplace
snapshot. Exercising a *changed* skill or hook under Codex needs a real version
bump across every release surface followed by `codex plugin marketplace add` and
`codex plugin add`. Until then Codex runs whatever is in
`~/.codex/plugins/cache/augenta/augenta/<version>/`, not your checkout. Check
which version each harness actually has before reading a result:

```bash
ls -d ~/.codex/plugins/cache/*/augenta/*/ ~/.claude/plugins/cache/*/augenta/*/
```

A directory there does not prove the plugin is installed — an uninstalled
marketplace leaves its cache behind. `claude plugin list` and `codex plugin list`
are the authority.

## The hosted dev loop

```bash
bun scripts/connect.ts \
  --project /absolute/path/to/test-project \
  --control-url https://dev.augenta.ai

bun scripts/dev-e2e.ts \
  --project /absolute/path/to/test-project \
  --control-url https://dev.augenta.ai
```

The connect step needs an interactive terminal: the Neurospace choice goes through
`chooseMany`, which refuses a non-TTY rather than print a menu nobody can answer.
It is a comma-separated multi-select (`1,3`) over every Neurospace, with the
project's current destinations marked `[x]`, and it always asks — there is no
auto-select even for a single Neurospace. **An empty answer connects nothing**, so
the dev loop must type at least one number. This is the positive human OAuth gate described in `AGENTS.md`; GitHub
Actions verifies the platform-key path instead and must never receive a human
access or refresh token.

Once connected, the project's `.augenta/config.json` carries the dev gateway as
`endpoint`, so hooks ship to dev with no variable set at runtime. The environment
selection is a connect-time decision, recorded in the config.

## Local state, and how to reset it

| Path | Written by | Reset effect |
| --- | --- | --- |
| `~/.augenta/auth.json` | completed sign-in | removes every stored profile; all connected projects need a fresh sign-in |
| `~/.augenta/pending-login.json` | `--login` | abandons an in-flight grant |
| `~/.augenta/state/connect-prompted.json` | SessionStart | the one-time connect offer fires again for that project |
| `<project>/.augenta/config.json` | connect | disconnects the project from all destinations; capture returns to a silent no-op |

A stale `pending-login.json` from another environment is self-healing: the next
`--await-login` recognizes the foreign issuer, clears it, and asks for a fresh
`--login`. Deleting it is only a shortcut.

Two different variables relocate the two global roots, and an isolated sandbox
needs **both**:

- `AUGENTA_AUTH_HOME` → `auth.json`, `auth.lock`, `pending-login.json`
  (`capture/auth.ts:79`)
- `AUGENTA_HOME` → `state/connect-prompted.json` (`hooks/session-start.ts:109`)

Setting only one leaves half your state in the real `~/.augenta`, which reads as
a bug in whichever half you were not watching.

## Other runtime overrides

`AUGENTA_API_URL` overrides the gateway base and `AUGENTA_INGEST_URL` redirects
the experiences endpoint. Neither opts a project into capture — capture still
requires `.augenta/config.json`. `AUGENTA_CAPTURE_ENABLED=0` is the global kill
switch.

## Known non-production wrinkle

Prod's issuer is Augenta's own `auth.augenta.ai`, which is what keeps the identity
provider out of every user-facing string. A dev deployment whose issuer is still a
raw vendor hostname discloses that provider in the sign-in URL itself, and the
agent has to print that URL. That is a dev topology gap, not a plugin regression:
do not read a dev transcript as evidence the invariant is broken, and do not
"fix" it in the plugin. The fix is a custom domain on the non-production issuer.

## Before opening a PR

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
git diff --check
claude plugin validate . --strict
claude --plugin-dir . plugin details augenta
```

`plugin details` must report the manifest version, one `connect` skill, every
event in `hooks/hooks.json`, and no load errors. It cannot catch an over-declared
hook timeout — only a real Codex install can. See `AGENTS.md`.
