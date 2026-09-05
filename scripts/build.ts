/**
 * Builds the six shipped entrypoints into dist/.
 *
 * WHY THIS EXISTS AT ALL: the plugin's users run Node, not Bun. The sources use
 * extensionless relative imports (`moduleResolution: "bundler"`), so Node cannot
 * execute them directly — bundling is what makes the plugin installable on a
 * stock machine. `hooks/hooks.json` and the SKILL.md files under `skills/`
 * invoke the OUTPUT of this script, never the sources.
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
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The Bun version is a build INPUT, not a contributor preference, because dist/
 * is committed and CI byte-compares it.
 *
 * Bun's bundler codegen changes between releases: 1.3.5 emits the older
 * `get: () => mod[key]` ESM-interop shim, while 1.3.14 emits the
 * `__toESMCache_*` / `__accessProp` prelude, and 1.4.1 differs again. One
 * version behind rewrites EVERY bundle, so CI rejects the result and asks
 * for a revert without ever naming the cause.
 *
 * What is NOT a variable is the platform. Measured 2026-09-04 on 1.3.14:
 * darwin-arm64 and linux-x64 produce byte-identical bundles, so a contributor on
 * a Mac needs the pinned Bun and nothing else — no container, no cross-build.
 *
 * setup-bun reads .bun-version in CI. This reads the same file so the number is
 * actually shared rather than merely declared to be.
 */
function readPinnedBun(): string {
  try {
    return readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
  } catch {
    // First statement the build runs, so an unreadable pin is the one input
    // that would otherwise surface as a bare ENOENT stack.
    console.error(
      [
        `Cannot read .bun-version at the repo root.`,
        ``,
        `dist/ is committed and byte-compared in CI, so this build needs the pinned`,
        `Bun version to check itself against. The file holds one bare version and`,
        `nothing else: three dot-separated numbers, no "v" prefix and no range.`,
      ].join("\n"),
    );
    process.exit(1);
  }
}

const PINNED_BUN = readPinnedBun();
if (Bun.version !== PINNED_BUN && process.env.AUGENTA_ALLOW_BUN_MISMATCH !== "1") {
  console.error(
    [
      `Refusing to build: dist/ is committed and byte-compared in CI, so it has`,
      `to be built on the pinned Bun.`,
      ``,
      `  .bun-version: ${PINNED_BUN}`,
      `  running:      ${Bun.version}`,
      ``,
      `Install the pinned version, then re-run this build:`,
      ``,
      `  curl -fsSL https://bun.sh/install | bash -s "bun-v${PINNED_BUN}"`,
      ``,
      `(\`bun upgrade\` moves to latest and will not pin.) To BUMP the pin`,
      `deliberately, edit .bun-version to the version you are running and commit`,
      `the rebuilt dist/ in the same change. AUGENTA_ALLOW_BUN_MISMATCH=1 skips`,
      `this check for local experiments — never commit its output.`,
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * The shipped surface: every file a harness or a skill invokes directly. The
 * contract test pins this list against hooks/hooks.json and the skills, so an
 * entrypoint added here that nothing wires up — or a hook or skill pointing at a
 * bundle nobody builds — fails the suite.
 *
 * Two of these are CLIs rather than hooks: `scripts/connect.ts` writes a
 * project's routing decision and `scripts/recall.ts` reads back what its
 * Workspaces remember. Each is invoked by its own SKILL.md, never by hooks.json.
 */
export const ENTRYPOINTS = [
  "hooks/session-start.ts",
  "hooks/user-prompt.ts",
  "capture/capture.ts",
  "capture/ship.ts",
  "scripts/connect.ts",
  "scripts/recall.ts",
] as const;

/**
 * The second reproducibility input is WHERE dependencies resolve from. Bun
 * labels every bundled module with its path relative to the build root, so a
 * checkout that resolves a dependency from an ancestor directory bakes
 * `../../../node_modules/...` into the bytes — every dependency line in the
 * affected bundle rewrites, on the pinned Bun, for a build that is otherwise
 * correct.
 *
 * A git worktree is the easy way in: `.claude/worktrees/` is gitignored, so a
 * worktree starts with no node_modules, and one created before a dependency was
 * added keeps resolving that dependency from the parent checkout forever.
 *
 * Check the CAUSE — a dependency this checkout does not have — rather than the
 * symptom in the emitted bytes, and check it BEFORE the wipe below for the same
 * reason the Bun pin is checked there: a refusal must not cost the contributor
 * the dist/ they already had.
 */
const { devDependencies = {} } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const uninstalled = Object.keys(devDependencies).filter(
  (dep) => !existsSync(join(ROOT, "node_modules", dep)),
);
if (uninstalled.length > 0) {
  console.error(
    [
      `Refusing to build: ${uninstalled.length} of ${Object.keys(devDependencies).length} declared`,
      `dependencies are not installed in THIS checkout, so Bun would resolve them`,
      `from an ancestor directory and bake the wrong paths into dist/.`,
      ``,
      ...uninstalled.slice(0, 3).map((dep) => `  missing: node_modules/${dep}`),
      ``,
      `Install into this directory and rebuild:`,
      ``,
      `  bun install --frozen-lockfile`,
      `  bun run build`,
    ].join("\n"),
  );
  process.exit(1);
}

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

/**
 * Post-process in memory first, validate, and only then write. The second
 * reproducibility input is WHERE dependencies resolved from, and it has to be
 * checked on the finished text.
 */
const finished: { path: string; body: string }[] = [];
for (const output of result.outputs) {
  const source = await Bun.file(output.path).text();
  // Bun carries a source shebang into the bundle and offers no flag to change
  // it. The sources have none (deliberately — nothing execs them directly), so
  // this only ever ADDS the node line; the strip is belt-and-braces against a
  // shebang creeping back into a source file and shipping a bun requirement.
  const body = source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
  // Some bundled OpenTelemetry diagnostics contain template-literal continuation
  // lines indented with spaces followed by a tab. Preserve their visible
  // indentation using spaces so the committed artifact passes git diff --check.
  const cleanBody = body
    .replace(/^([ ]+)\t/gm, "$1  ")
    // sdk-metrics 2.11.0 compiles its wildcard predicate with String.replace,
    // which escapes only the first wildcard and is flagged by CodeQL in the
    // shipped bundle. The plugin never configures wildcard views, but dist/ is
    // still executable code: harden every bundled copy until upstream does.
    .replaceAll('.replace("*", ".*")', '.replace(/\\*/g, ".*")');
  finished.push({ path: output.path, body: cleanBody });
}

/**
 * Byte-level postcondition on the same property the pre-build check enforces.
 * It earns its keep by covering what that check cannot see: a TRANSITIVE
 * dependency absent from this checkout but present in an ancestor's, which no
 * package.json key names.
 *
 * These labels exist only because `minify: false` above keeps them. A check
 * whose evidence can silently disappear proves nothing, so this one fails when
 * it finds no labels at all rather than passing by default.
 */
const MODULE_LABEL = /^\/\/ (?:\.\.\/)*node_modules\/.*$/gm;
const labels = finished.flatMap(({ path, body }) =>
  (body.match(MODULE_LABEL) ?? []).map((line) => ({ path, line })),
);
const escaped = labels.filter(({ line }) => line.startsWith("// ../"));
if (escaped.length > 0) {
  console.error(
    [
      `Refusing to write: ${escaped.length} of ${labels.length} bundled dependency`,
      `modules resolved from OUTSIDE this checkout, which bakes the wrong paths`,
      `into dist/. Every dependency the manifest names IS installed here, so this`,
      `is a transitive dependency resolving to an ancestor's node_modules.`,
      ``,
      ...escaped.slice(0, 3).map(({ path, line }) => `  ${relative(ROOT, path)}: ${line}`),
      ``,
      `Reinstall into this directory and rebuild:`,
      ``,
      `  bun install --frozen-lockfile`,
      `  bun run build`,
      ``,
      `dist/ has already been rewritten by the bundler — 'git checkout -- dist'`,
      `restores it if you want a clean tree first.`,
    ].join("\n"),
  );
  process.exit(1);
}
if (labels.length === 0) {
  // Not pedantry: the bundles DO depend on node_modules, so zero labels means
  // the emission this check reads has changed (minify, a bundler upgrade) and
  // the check above has quietly stopped checking anything.
  console.error(
    [
      `Refusing to write: no bundled module labels found, so the dependency-path`,
      `check above cannot prove anything.`,
      ``,
      `It reads the "// node_modules/..." comments Bun emits for each bundled`,
      `module, which exist only while this build stays unminified. If that`,
      `changed deliberately, replace the check rather than deleting it.`,
    ].join("\n"),
  );
  process.exit(1);
}

for (const { path, body } of finished) {
  await Bun.write(path, `#!/usr/bin/env node\n${body}`);
  chmodSync(path, 0o755); // outdir writes 0644
}

console.log(`built ${result.outputs.length} bundles into dist/`);
