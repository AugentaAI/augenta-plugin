/**
 * Builds the five shipped entrypoints into dist/.
 *
 * WHY THIS EXISTS AT ALL: the plugin's users run Node, not Bun. The sources use
 * extensionless relative imports (`moduleResolution: "bundler"`), so Node cannot
 * execute them directly — bundling is what makes the plugin installable on a
 * stock machine. `hooks/hooks.json` and `skills/connect/SKILL.md` invoke the
 * OUTPUT of this script, never the sources.
 *
 * dist/ is committed. Both marketplaces install a git checkout and run no build
 * step, so these bundles ARE the shipped artifact: anything this script fails to
 * do is something every user runs without. Re-run it and commit the result
 * whenever a shipped source changes — CI fails a PR whose dist/ has drifted.
 *
 * Bun is a build-time tool here, in the same role as a compiler. Nothing it
 * produces may depend on Bun at runtime; the contract test scans dist/ to keep
 * that honest.
 */
import { chmodSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The shipped surface: every file a harness or the connect skill invokes
 * directly. The contract test pins this list against hooks/hooks.json, so an
 * entrypoint added here without a hook wiring (or vice versa) fails the suite.
 */
export const ENTRYPOINTS = [
  "hooks/session-start.ts",
  "hooks/user-prompt.ts",
  "capture/capture.ts",
  "capture/ship.ts",
  "scripts/connect.ts",
] as const;

// Wipe first: a renamed or deleted entrypoint otherwise leaves its old bundle
// behind forever, and a committed orphan still ships to users.
rmSync(join(ROOT, "dist"), { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ENTRYPOINTS.map((e) => join(ROOT, e)),
  outdir: join(ROOT, "dist"),
  // Pinned, never inferred. Bun derives the output layout from the entrypoints'
  // common parent directory, so dropping the two hooks/ entries would silently
  // collapse dist/capture/capture.mjs to dist/capture.mjs and invalidate every
  // path in hooks/hooks.json.
  root: ROOT,
  target: "node",
  format: "esm",
  // .mjs, not .js: a .js bundle parses as ESM only because a package.json with
  // "type": "module" happens to sit at the installed plugin root. Neither
  // manifest declares that file, so it is an observed behavior of today's CLIs
  // rather than a contract. If either ever prunes an install to its declared
  // paths, every hook would die with "Cannot use import statement outside a
  // module" — on stdio: "ignore", for every user. .mjs is self-describing.
  naming: { entry: "[dir]/[name].mjs" },
  sourcemap: "none",
  // Unminified on purpose: a committed dist/ is only reviewable if its diff is.
  // There is no size budget on a local hook.
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const output of result.outputs) {
  const source = await Bun.file(output.path).text();
  // Bun carries a source shebang into the bundle and offers no flag to change
  // it. The sources have none (deliberately — nothing execs them directly), so
  // this only ever ADDS the node line; the strip is belt-and-braces against a
  // shebang creeping back into a source file and shipping a bun requirement.
  const body = source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
  await Bun.write(output.path, `#!/usr/bin/env node\n${body}`);
  chmodSync(output.path, 0o755); // outdir writes 0644
}

console.log(`built ${result.outputs.length} bundles into dist/`);
