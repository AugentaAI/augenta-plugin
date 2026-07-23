/**
 * Secret / PII scrub — applied to EVENT TEXT (`events[].text`) before it is
 * buffered. It does NOT cover the envelope's raw `data` channel: those lines
 * are structurally sanitized for opaque reasoning artifacts, but remain
 * secret-unscrubbed under the project's `.augenta/config.json` opt-in (consent
 * for both channels).
 *
 * Agent trajectories contain source code, command output, and env values, so
 * before an event is shipped to the Augenta backend we redact known CREDENTIAL
 * shapes. This is intentionally CONSERVATIVE: it targets high-confidence secret
 * patterns (provider tokens, private-key blocks, JWTs, bearer tokens, URL
 * credentials, and `KEY = secret` assignments) rather than high-entropy
 * guessing, so ordinary code and prose are not mangled. It is the last line of
 * defense, not a substitute for not logging secrets in the first place.
 *
 * Pure and deterministic: same input → same output, no I/O, no model call. Runs
 * in the capture hot path, so it must stay cheap; every pattern is bounded to
 * avoid catastrophic backtracking.
 *
 * File paths are deliberately KEPT — they carry project/signal value and are not
 * secrets. Redacting them is a future opt-in, not a default.
 */

/** The placeholder a redacted span of text is replaced with. */
const MASK = (label: string): string => `[redacted:${label}]`;

/**
 * Negative lookbehind guard on the bare `token` alternative: pagination/sync/CSRF
 * cursor names (`nextPageToken`, `continuationToken`, `syncToken`, `csrfToken`, …)
 * are benign signal, not secrets — masking them destroys tool-result fidelity for
 * no security gain. `access_token` / `refresh_token` / `id_token` / `auth_token` /
 * bare `token` are unaffected since none of these prefixes precede them.
 */
const TOKEN_GUARD =
  "(?<!page[_-]?)(?<!continuation[_-]?)(?<!cursor[_-]?)(?<!sync[_-]?)(?<!csrf[_-]?)(?<!xsrf[_-]?)(?<!anti[_-]?forgery[_-]?)";

/** Sensitive key names for `KEY = value` / `"key": "value"` assignment redaction. */
const SECRET_KEY_NAMES =
  `api[_-]?key|secret|${TOKEN_GUARD}token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|(?<!o)auth`;

/**
 * Ordered redaction rules. Order matters: structural blocks (private keys) and
 * specific token shapes run before the generic assignment rule so the most
 * precise label wins.
 */
export interface ScrubRule {
  label: string;
  pattern: RegExp;
  /** Replacement; a function receives the match + capture groups. */
  replace: string | ((match: string, ...groups: string[]) => string);
}

export const SCRUB_RULES: ScrubRule[] = [
  // PEM private-key blocks — redact the entire block, not just the header.
  {
    label: "private-key",
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    replace: MASK("private-key"),
  },
  // JSON Web Tokens: header.payload.signature, all base64url.
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    replace: MASK("jwt"),
  },
  // Provider/API token prefixes: sk- (Anthropic, OpenAI).
  { label: "token", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: MASK("token") },
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_.
  { label: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: MASK("github-token") },
  // Slack tokens.
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: MASK("slack-token") },
  // Google API keys.
  { label: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: MASK("google-key") },
  // AWS access key ids.
  { label: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: MASK("aws-key") },
  // Bearer tokens in headers / curl.
  {
    label: "bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
    replace: "Bearer " + MASK("bearer"),
  },
  // Credentials embedded in URLs: scheme://user:password@host → keep user, mask password.
  {
    label: "url-credential",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]{1,200})@/gi,
    replace: (_m, prefix: string) => `${prefix}:${MASK("url-credential")}@`,
  },
  // Generic assignment: KEY = value | "key": "value" — keep the key, mask the value.
  // Bounded value length; stops at quote/whitespace/comma so it doesn't eat a line.
  {
    label: "assignment",
    pattern: new RegExp(
      `((?:${SECRET_KEY_NAMES})["']?\\s*[:=]\\s*)(["']?)([^"'\\s,;]{6,200})\\2`,
      "gi",
    ),
    replace: (_m, head: string, quote: string) => `${head}${quote}${MASK("assignment")}${quote}`,
  },
];

/**
 * Redact known credential shapes from `text`. Conservative by design — returns
 * the text unchanged when nothing matches. Safe on empty/whitespace input.
 */
export function scrub(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of SCRUB_RULES) {
    out = out.replace(rule.pattern, rule.replace as never);
  }
  return out;
}
