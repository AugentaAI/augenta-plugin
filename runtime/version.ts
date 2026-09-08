/**
 * THE plugin version. One constant, imported by everything that reports it.
 *
 * It lives in `runtime/` because that is the only directory both halves of the
 * plugin already depend on — `capture/ship.ts` and `scripts/connect.ts` each
 * import `runtime/node`, so this adds no new edge direction and no cycle. It is
 * a bare string, so every bundle inlines it at zero cost.
 *
 * This replaced two independent literals kept in step by a regex in
 * `__tests__/contract.test.ts`: `PLUGIN_VERSION` here and a hardcoded
 * `version:` in the shipper's OpenTelemetry attribution. A pattern match over
 * source is a weak pin — it silently binds to the FIRST line that looks right,
 * so a second `version:` property anywhere above it would have made the gate
 * assert the wrong literal while telemetry drifted a release behind. An import
 * cannot drift, so the gate now pins ONE place and the compiler does the rest.
 *
 * Still a release surface: bump it with `package.json`, both plugin manifests,
 * and both marketplace metadata and plugin entries (AGENTS.md → Releases). The
 * contract test asserts all of them agree.
 */
export const PLUGIN_VERSION = "0.10.1";
