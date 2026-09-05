# Security policy

## Scope

This repository is the Augenta plugin: eight lifecycle hooks, a connect script,
and a recall script, all of which run **on the user's own machine** under Claude
Code or Codex. What that code touches is the useful boundary for a report:

- **`~/.augenta/auth.json`** — the global, owner-only sign-in file. Rotating
  OAuth access and refresh tokens live here and nowhere else, mode `0600` inside
  a `0700` directory.
- **`<project>/.augenta/config.json`** — a connected project's routing decision:
  a profile reference and its Connector ids, or a platform key. No token. The
  plugin narrows the directory to `0700` on every write it makes under it and
  adds a self-ignoring `.gitignore`.
- **What leaves the machine, and to where** — README's
  [What gets captured](README.md#what-gets-captured) is the authoritative
  description. Three channels: normalized events scrubbed client-side for common
  credential patterns; raw transcript records that are structurally sanitized
  but **not** secret-scrubbed; and, only when a user or their agent asks for it,
  a recall question — the query text alone, sent to the Workspaces the project
  already feeds, with no transcript or file content attached.

Anything that breaks one of those — a token reaching a place it should not, a
file created wider than stated, capture running for a project that never opted
in, a record routed to a destination the user did not select — is in scope
regardless of how it is triggered.

## Reporting

Open a **private security advisory** on this repository's
[Security tab](https://github.com/AugentaAI/augenta-plugin/security/advisories/new).
Please do not open a public issue for a suspected vulnerability.

Useful in a report:

- the plugin version — `claude plugin details augenta` or `codex plugin list`
- which harness, and its version
- whether the project was connected, and in which mode (`oauth` or `api-key`)
- Node version and OS
- what you did and what you observed, in enough detail to reproduce

**Do not attach transcripts, tokens, or the contents of `config.json` or
`auth.json`.** Describe the shape of what you saw instead — a redacted path, a
file mode, an HTTP status. A report is not worth creating a second copy of the
thing it is about.

## What to expect

We will acknowledge the report, tell you whether we consider it in scope, and
say what we intend to do. A fix ships as a normal release and is named in
[`CHANGELOG.md`](CHANGELOG.md); tell us if you would rather not be credited.

There is no service-level agreement here and no bug bounty. This is a small
project and the honest answer is that response time depends on the week.

## Out of scope

- **The hosted Augenta platform** — the API, the web app, the gateway. Use the
  same advisory form; we will route it rather than turn you away.
- **Third-party dependencies** with no path through this plugin. If you can
  reach one *through* the plugin, that is in scope and worth reporting.
- **Permissions a user widened themselves.** The plugin narrows `.augenta/` to
  `0700` on every write it makes under it, whoever created the directory — that
  mode is the real barrier, since reading the config needs search permission on
  the directory. It cannot chmod a config *file* it did not write; that file's
  permissions remain the responsibility of whoever created it.
- **Bugs in Claude Code or Codex themselves.** Those belong to their own
  projects; report them there.
- **Findings from scanning `dist/`.** Those bundles inline their whole import
  graph, so one source line becomes one finding per bundle. Report the source
  location — a bundle copy of a real issue is welcome, a duplicate set is noise.
