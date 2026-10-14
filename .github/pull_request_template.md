## What this changes

<!-- What a user or contributor would notice. Describe any platform-side change
     in words — this repository is public, so do not cite a private repo's
     issues or PRs. -->

## Why

<!-- The problem, and why this is the fix. If a behavior looks wrong but is
     deliberate, AGENTS.md usually says so — link the invariant. -->

## Verification

```
bun install --frozen-lockfile
bun run build
bun run typecheck
bun test
git diff --check
```

<!-- Paste what you actually ran, and say what is still outstanding. A real
     Codex marketplace install is the only gate that catches an over-declared
     hook timeout, and `claude plugin validate` cannot. -->

## Checklist

- [ ] `dist/` rebuilt and committed, or no shipped source changed.
- [ ] A version change, if any, is atomic across all eight release surfaces,
      plus the `CHANGELOG.md` entry and `RELEASE_VERSION` in the contract test.
- [ ] `hooks/hooks.json` untouched — or the change is deliberately batched,
      knowing it re-prompts every Codex user for hook trust.
- [ ] `bun run audit:public` passes; files, images, branch names, commits, and this
      description contain no private references, ticket identifiers, internal
      terminology, or deployment details. Review comments follow the same rule.
- [ ] No change to telemetry APIs, payloads, consent semantics, or capture
      behavior without an explicit product decision.
