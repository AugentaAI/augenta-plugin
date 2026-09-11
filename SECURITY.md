# Security policy

## Report a problem privately

Use this repository's
[private security advisory form](https://github.com/AugentaAI/augenta-plugin/security/advisories/new).
Please do not post a suspected security flaw as a public issue.

Include:

- The plugin version, from `claude plugin details augenta` or `codex plugin list`.
- Your coding app, its version, Node version, and operating system.
- Whether the project was connected through browser sign-in or an API key.
- Steps to repeat the problem and what you saw.

**Do not attach transcripts, keys, tokens, `config.json`, or `auth.json`.**
Use examples with private values removed. A file permission, a redacted path,
or an HTTP status code is often enough to explain the issue.

## What this policy covers

This plugin runs on your machine through Claude Code or Codex. It uses eight
hook events and the connect and recall scripts. Reports can cover:

| Area | What should be protected |
| --- | --- |
| Saved sign-in | Tokens stay in `~/.augenta/auth.json`, with file mode `0600` inside a `0700` directory |
| Project config | Browser connections store a profile reference, URLs, organization and destinations, with no sign-in token; only Connector ids route capture, and the server authorizes Workspace reads. API-key connections store the key |
| Local records | The plugin sets `.augenta/` to `0700` on its writes and adds a self-ignoring `.gitignore` |
| Capture | Only connected projects send records, and only to the selected Workspaces |
| Recall | Only the question text is sent as content, with no attached files or transcript, to Workspaces the project already feeds |

Report any breach of these rules. Examples include a leaked sign-in token,
a plugin-created file with wider access than stated, or records sent to an
unselected Workspace.

[What gets captured](README.md#what-gets-captured) explains the data sent.
Activity and project notes have common secret patterns removed. Raw transcript
records have some internal fields removed, but their text is **not
secret-scrubbed** and can contain secrets.

## What to expect

We will acknowledge the report, say whether it is in scope, and explain our
next step. Fixes appear in [CHANGELOG.md](CHANGELOG.md). Tell us if you do not
want to be credited.

There is no promised response time or bug bounty.

## Reports outside this plugin

- **Hosted Augenta API or web app:** use the same private form. We will route
  the report to the right place.
- **Third-party code:** it is in scope if the flaw can be reached through
  this plugin. An unrelated dependency finding is outside this policy.
- **Permissions changed by the user:** the plugin sets `.augenta/` to `0700`
  when it writes there. It cannot fix the permissions of a config file it did
  not write. Whoever creates that file must set its permissions.
- **Claude Code or Codex bugs:** report these to the app's own project.
- **Repeated findings in `dist/`:** bundles can contain copies of the same
  source code. Report the source location when you can, or one bundle
  location if you cannot. There is no need to report each copy separately.
