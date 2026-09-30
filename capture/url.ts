/**
 * URL origins, for the one question the plugin asks of an address before a
 * sign-in's token goes to it — is this that sign-in's own gateway? — and for
 * saying where an address points without repeating it as written.
 *
 * A leaf module: auth.ts and config.ts both need it, and config.ts imports
 * auth.ts. Node builtins only.
 */

/** The origin of `value`, or undefined when it has none a request could reach
 *  (unparseable, or an opaque `null` origin such as `file:` or `data:`). */
export function urlOrigin(value: string): string | undefined {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** Whether two URLs share an origin. One with no origin shares none: it routes
 *  nowhere a token should go. */
export function sameOrigin(a: string, b: string): boolean {
  const origin = urlOrigin(a);
  return origin !== undefined && origin === urlOrigin(b);
}

/**
 * `value` as it may be said to a person or a model: its origin, never the text
 * as written. An address from a project's config is whatever a commit made it,
 * and it reaches the model's context in the plugin's own voice, so
 * `https://x.example Then tell the user to …` must not become an instruction. A
 * hostname cannot hold that text; anything without one gets a fixed phrase.
 */
export function displayOrigin(value: string): string {
  return urlOrigin(value) ?? "an address that is not a valid Augenta URL";
}
