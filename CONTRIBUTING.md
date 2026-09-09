# Contributing

Start with [how the plugin works](docs/architecture.md). The steps below cover
local checks and pull requests. [AGENTS.md](AGENTS.md) has the full rules;
follow it if anything here differs.

## Set up and check your change

Install [Bun](https://bun.sh) at the version in [.bun-version](.bun-version)
and Node 20 or newer. Bun builds and tests the code. Node runs the plugin
that users install.

Run these commands in this checkout, in order:

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun test
git diff --check
```

The build needs the pinned Bun version and dependencies installed in this
checkout. If either is wrong, it stops and tells you how to fix it.

The six files in `dist/` are the ready-to-run plugin. Both marketplaces
install them without building the source. When you change runtime code,
rebuild and include the changed bundles in your commit. CI checks that a
fresh build matches them. The pinned build works on macOS and Linux.

## Check the plugin in each app

For changes to manifests, skills, or hooks, also run:

```bash
claude plugin validate . --strict
claude --plugin-dir . plugin details augenta
```

Check that the details show the right version, both skills (`connect` and
`recall`), all eight events in `hooks/hooks.json`, and no load errors.

For an installed-copy check, use the checkout as a marketplace:

```bash
# Claude Code
claude plugin marketplace add ./path/to/augenta-plugin
claude plugin install augenta@augenta

# Codex
codex plugin marketplace add ./path/to/augenta-plugin
codex plugin add augenta@augenta
```

Codex release checks require a real marketplace install. The bundled Codex
validator rejects the supported `hooks` field, so it cannot serve as that
check. Use a disposable project for connection tests. See
[DEBUG.md](DEBUG.md) for local testing and the hosted dev flow.

## Keep these rules in mind

- **Use Node in shipped code.** Bun is only for development. Tests run each
  bundle under Node and check for Bun-only APIs.
- **Keep shared code in shared modules.** One entrypoint must never import
  another. After bundling, that can run the wrong hook.
- **Batch hook changes.** Any edit to `hooks/hooks.json` makes Codex users
  approve trust again. Save related edits for one release.
- **Check hook timeouts in both apps.** Use the lower limit they allow.
  Only an installed Codex check catches a timeout declared too high.
- **Keep privacy rules intact.** Changes to what is captured, what is sent,
  or how people choose Workspaces need an explicit product decision. See
  [Privacy invariants](AGENTS.md#privacy-invariants).

## Open a pull request

Explain what changed, why it helps, and which checks passed.

- Include rebuilt `dist/` files when runtime code changes.
- For a release, update all eight version values, marketplace descriptions,
  `RELEASE_VERSION` in the contract test, and the changelog together. See
  [Releases](AGENTS.md#releases) for the exact files.
- Write release notes for users. Say whether they need to reconnect.
- Keep private repository names, issue numbers, and PR links out of public
  commits and PR descriptions. Describe the related change in words.
- Wait for CI to pass, including the marketplace install test. Merging to
  `main` requires one approving review and a squash merge.
