/**
 * Tests for scrub.ts — the client-side secret redaction applied to `events[].text`.
 *
 * Contract under test: every SCRUB_RULES pattern still masks its target shape
 * (the security bar), and the G10 precision fix means benign pagination/sync/CSRF
 * token-shaped keys (`nextPageToken`, `continuationToken`, `syncToken`,
 * `csrfToken`, `xsrfToken`, an anti-forgery token key, bare `oauth`) pass through
 * UNMASKED — they are tool-result signal, not secrets — while `access_token` /
 * `refresh_token` / `id_token` / `auth_token` / bare `token` / bare `auth` still
 * mask, since none of the guarded prefixes precede them.
 *
 * Run: bun test capture/scrub.test.ts
 */
import { test, expect, describe } from "bun:test";
import { scrub, SCRUB_RULES } from "./scrub";

describe("benign token/auth-shaped keys pass through unmasked (G10)", () => {
  const benign: Array<[string, string]> = [
    ["nextPageToken", `"nextPageToken": "abc123def456"`],
    ["continuationToken", `"continuationToken": "abc123def456"`],
    ["syncToken", `"syncToken": "abc123def456"`],
    ["csrfToken", `"csrfToken": "abc123def456"`],
    ["xsrfToken", `"xsrfToken": "abc123def456"`],
    ["camelCase anti-forgery token", `"antiForgeryToken": "abc123def456"`],
    ["snake_case anti_forgery_token", `"anti_forgery_token": "abc123def456"`],
    ["cursorToken", `"cursorToken": "abc123def456"`],
    ["bare oauth key", `"oauth": "abc123def456"`],
  ];

  for (const [label, input] of benign) {
    test(`${label} is left untouched`, () => {
      expect(scrub(input)).toBe(input);
    });
  }
});

describe("secret-shaped keys still mask (the security bar)", () => {
  const secret: Array<[string, string]> = [
    ["access_token", "access_token: abc123def456"],
    ["refresh_token", "refresh_token: abc123def456"],
    ["id_token", "id_token: abc123def456"],
    ["auth_token", "auth_token: abc123def456"],
    ["bare token", "token: abc123def456"],
    ["bare auth", "auth: abc123def456"],
    ["api_key", "api_key: abc123def456"],
    ["secret", "secret: abc123def456"],
    ["password", "password: abc123def456"],
    ["passwd", "passwd: abc123def456"],
    ["pwd", "pwd: abc123def456"],
    ["access_key", "access_key: abc123def456"],
    ["private_key (assignment form)", "private_key: abc123def456"],
    ["client_secret", "client_secret: abc123def456"],
  ];

  for (const [label, input] of secret) {
    test(`${label} is masked`, () => {
      const out = scrub(input);
      expect(out).not.toBe(input);
      expect(out).toContain("[redacted:assignment]");
      expect(out).not.toContain("abc123def456");
    });
  }
});

describe("one positive case per SCRUB_RULES pattern (locks the security bar)", () => {
  test("private-key: PEM block redacted whole", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----";
    const out = scrub(pem);
    expect(out).toBe("[redacted:private-key]");
  });

  test("jwt: header.payload.signature redacted", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_abcdefghi";
    const out = scrub(`the response carried ${jwt} in its body`);
    expect(out).toContain("[redacted:jwt]");
    expect(out).not.toContain(jwt);
  });

  test("token (sk- prefix): provider API token redacted", () => {
    const key = "sk-abcdefghijklmnopqrstuvwx";
    const out = scrub(`export KEY=${key}`);
    expect(out).toContain("[redacted:token]");
    expect(out).not.toContain(key);
  });

  test("github-token: ghp_ token redacted", () => {
    const tok = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const out = scrub(`token ${tok} done`);
    expect(out).toContain("[redacted:github-token]");
    expect(out).not.toContain(tok);
  });

  test("slack-token: xoxb- token redacted", () => {
    const tok = "xoxb-0123456789-abcdefghij";
    const out = scrub(`slack token ${tok}`);
    expect(out).toContain("[redacted:slack-token]");
    expect(out).not.toContain(tok);
  });

  test("google-key: AIza key redacted", () => {
    const key = "AIza" + "a".repeat(35);
    const out = scrub(`key=${key}`);
    expect(out).toContain("[redacted:google-key]");
    expect(out).not.toContain(key);
  });

  test("aws-key: AKIA access key id redacted", () => {
    const key = "AKIA" + "A".repeat(16);
    const out = scrub(`aws key ${key}`);
    expect(out).toContain("[redacted:aws-key]");
    expect(out).not.toContain(key);
  });

  test("bearer: Bearer header token redacted, scheme kept", () => {
    const out = scrub("Authorization: Bearer abcdefghijklmno123");
    expect(out).toContain("Bearer [redacted:bearer]");
    expect(out).not.toContain("abcdefghijklmno123");
  });

  test("url-credential: password masked, user kept", () => {
    const out = scrub("https://user:hunter2password@example.com/path");
    expect(out).toContain("https://user:[redacted:url-credential]@example.com/path");
    expect(out).not.toContain("hunter2password");
  });

  test("assignment: KEY = value masked", () => {
    const out = scrub(`api_key = "abc123def456"`);
    expect(out).toContain("[redacted:assignment]");
    expect(out).not.toContain("abc123def456");
  });
});

describe("misc", () => {
  test("empty/falsy input passes through unchanged", () => {
    expect(scrub("")).toBe("");
  });

  test("ordinary prose and code are untouched", () => {
    const text = "Ran the tests, all green. Updated src/index.ts to export the new helper.";
    expect(scrub(text)).toBe(text);
  });

  test("lookbehind-guarded patterns compile without throwing (smoke test)", () => {
    for (const rule of SCRUB_RULES) {
      expect(() => "x".match(rule.pattern)).not.toThrow();
    }
  });
});
