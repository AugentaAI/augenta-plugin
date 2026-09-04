# Contributing

`AGENTS.md` is the contributor guide and the authority on every invariant this
repository holds itself to. This file is the short version: what to install, what
to run, and what a pull request is expected to carry. Where the two appear to
disagree, `AGENTS.md` is right.

## Prerequisites

- **[Bun](https://bun.sh)** — the development toolchain: tests, typecheck, and
  bundling. Pinned in `.bun-version`.
- **Node 20+** — what the plugin actually runs on.

## Verify

Every change runs the same five commands:

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun test
git diff --check
```

For a change to the plugin manifests, skills, or hooks, also run the harness
checks:

```bash
claude plugin validate . --strict
claude --plugin-dir . plugin details augenta
```

`plugin details` must report the manifest version, one `connect` skill, every
event in `hooks/hooks.json`, and no load errors. To exercise an installed copy,
add the checkout as a marketplace:

```bash
# Claude Code
claude plugin marketplace add ./path/to/augenta-plugin
claude plugin install augenta@augenta

# Codex
codex plugin marketplace add ./path/to/augenta-plugin
codex plugin add augenta@augenta
```

## Bun builds, Node ships

Bun is a build-time tool here, in the same role as a compiler; nothing that
reaches a user may depend on it. What ships is `dist/` — five Node ESM bundles,
**committed**, because both marketplaces install a git checkout and run no build
step. Run `bun run build` and commit the result whenever a shipped source
changes; CI fails a pull request whose `dist/` has drifted.

The asymmetry worth internalizing: contributors exercise *sources under Bun*
while users exercise *bundles under Node*, so a Bun-only API can enter runtime
code and fail only in the field. `AGENTS.md` → "The runtime boundary" explains
the three gates that close that, and the entrypoint rule that goes with it.

Use the Bun version in `.bun-version`: the committed bundles are byte-compared in
CI, and Bun's bundler output changes between releases, so `bun run build` refuses
to run on any other version and prints the install command. Run `bun install` in
the checkout you build from — where dependencies resolve from is baked into the
bundles too. Any platform works; the pinned Bun produces the same bytes on macOS
and Linux.

## Where things live

- `hooks/` — lifecycle entrypoints for the supported coding agents
- `capture/` — normalization, scrubbing, durable buffering, and delivery
- `runtime/` — the Node shims and `PLUGIN_VERSION`
- `scripts/connect.ts` — sign-in, destination selection, project config, and the
  agent-driven `--json` verbs
- `skills/connect/` — the guided connection flow
- `__tests__/contract.test.ts` — the structural invariants, including the ones
  that live in prose

## Editing `hooks/hooks.json` costs every Codex user a prompt

Codex trust-pins each hook by content hash, so **any** edit to that file
re-prompts every Codex user for trust. Batch hook changes into a single
deliberate release; never ship them incrementally. A declared timeout must also
be the *minimum* the two harnesses allow, because one manifest serves both — and
only a real Codex install can catch an over-declared one.

## Pull requests

- `dist/` rebuilt and committed if any shipped source changed.
- A version change is **atomic** across all eight values `AGENTS.md` → Releases
  lists, plus the `CHANGELOG.md` entry and `RELEASE_VERSION` in the contract
  test. Partial bumps are the failure mode that gate exists for.
- `hooks/hooks.json` untouched, or the change deliberately batched.
- **No references to private repositories** in commits or the description. This
  repository is public; describe the platform-side change in words.
- Telemetry APIs, payloads, consent semantics, and capture behavior do not change
  without an explicit product decision. `AGENTS.md` → "Privacy invariants" is the
  list, and it is written as invariants because that is what they are.
- CI must be green — `typecheck + test` and the marketplace install smoke test —
  and `main` requires one approving review and a squash merge.
