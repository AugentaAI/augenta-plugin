/**
 * Telling "this network blocks Augenta" apart from every other failure.
 *
 * Node's fetch buries the useful part. Measured on Node 22.21 and 25.2, a
 * CONNECT an allowlisting proxy refuses surfaces as `fetch failed`, then
 * `Request was cancelled.`, and only then an `UND_ERR_ABORTED` whose message
 * carries the proxy's status ("Proxy response (403) !== 200 when HTTP
 * Tunneling"). The old one-level unwrap reported the middle line, which names
 * neither the block nor a host, the whole diagnosis a user in a sandboxed
 * session got. So the whole cause chain is
 * walked here, and a failure that could be a block is confirmed by asking each
 * Augenta host for the one answer only Augenta gives.
 *
 * No import of platform.ts or auth.ts (both import this), and every request
 * carries its own deadline.
 */

/** Why a request never got an answer from Augenta itself. */
export type NetworkFailure =
  | { kind: "proxy_refused"; status: number }
  | { kind: "dns" | "refused" | "reset" | "timeout" | "tls"; code?: string };

/** Discovery answered, but not with Augenta's document: a proxy or captive
 *  page speaking for the host (403, 407, an HTML body) rather than Augenta. */
export class DiscoveryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

const TLS_CODES = /^(CERT_|UNABLE_TO_|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_)/;

function* causes(error: unknown): Generator<{ name?: string; code?: unknown; message?: string; status?: number }> {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth++) {
    yield current as { name?: string; code?: unknown; message?: string; status?: number };
    current = (current as { cause?: unknown }).cause;
  }
}

/** The network-level reason for a failure, or undefined when Augenta answered
 *  (an HTTP error from Augenta is not a network failure). */
export function classifyNetworkError(error: unknown): NetworkFailure | undefined {
  for (const link of causes(error)) {
    if (link instanceof DiscoveryError) {
      return link.status === 404 ? undefined : { kind: "proxy_refused", status: link.status };
    }
    const proxy = /^Proxy response \((\d{3})\)/.exec(String(link.message ?? ""));
    if (proxy) return { kind: "proxy_refused", status: Number(proxy[1]) };
    const code = typeof link.code === "string" ? link.code : undefined;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { kind: "dns", code };
    if (code === "ECONNREFUSED") return { kind: "refused", code };
    if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET") return { kind: "reset", code };
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || link.name === "TimeoutError") {
      return { kind: "timeout", ...(code ? { code } : {}) };
    }
    if (code && TLS_CODES.test(code)) return { kind: "tls", code };
  }
  return undefined;
}

export interface HostCheck {
  host: string;
  ok: boolean;
  /** Why not, in a few words; absent when ok. */
  reason?: string;
  /** The same reason as a machine-readable value, so a caller branching on the
   *  failure reads this and never the display text; absent when the host
   *  answered at all (ok, or answered as something other than Augenta). */
  kind?: NetworkFailure["kind"];
}

/** The production hosts, used only when discovery itself cannot be reached. */
const PRODUCTION = { control: "https://augenta.ai", issuer: "https://auth.augenta.ai", gateway: "https://api.augenta.ai" };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

async function check(
  fetcher: Fetch,
  url: string,
  timeoutMs: number,
  isAugenta: (response: Response, body: unknown) => boolean,
): Promise<HostCheck> {
  const host = new URL(url).host;
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json().catch(() => undefined);
    return isAugenta(response, body)
      ? { host, ok: true }
      : { host, ok: false, reason: `answered ${response.status}, not as Augenta does` };
  } catch (error) {
    const failure = classifyNetworkError(error);
    return {
      host,
      ok: false,
      reason: !failure
        ? "no answer"
        : failure.kind === "proxy_refused"
          ? `a proxy refused it (${failure.status})`
          : failure.kind === "dns"
            ? "the name did not resolve"
            : failure.kind === "refused"
              ? "the connection was refused"
              : failure.kind === "reset"
                ? "the connection was cut"
                : failure.kind === "timeout"
                  ? "no answer in time"
                  : "its TLS certificate was not trusted",
      ...(failure ? { kind: failure.kind } : {}),
    };
  }
}

/**
 * Ask each host connect needs for the answer only Augenta gives: discovery's
 * document, the issuer's OpenID configuration, and the gateway's own JSON 401
 * for a request with no token. A proxy's refusal, or its 403 page, fails the
 * check. Hosts come from discovery; the production set stands in only when
 * discovery is unreachable and the control URL is production's. `gateway`
 * replaces discovery's when the run was reaching another one (`--endpoint`):
 * the host to diagnose is the one that failed, not the one it would have used.
 */
export async function diagnoseHosts(
  controlUrl: string,
  options: { timeoutMs?: number; fetcher?: Fetch; gateway?: string } = {},
): Promise<HostCheck[]> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, { ...init, signal: init.signal }));
  const control = controlUrl.replace(/\/+$/, "");
  let issuer: string | undefined;
  let gateway: string | undefined;
  const discovery = await check(fetcher, `${control}/.well-known/augenta.json`, timeoutMs, (response, body) => {
    const document = body as { issuer?: unknown; gateway?: unknown } | undefined;
    if (!response.ok || typeof document?.issuer !== "string") return false;
    issuer = document.issuer;
    gateway = typeof document.gateway === "string" ? document.gateway : undefined;
    return true;
  });
  if (!discovery.ok && control === PRODUCTION.control) {
    issuer = PRODUCTION.issuer;
    gateway = PRODUCTION.gateway;
  }
  if (options.gateway) gateway = options.gateway;
  const rest = await Promise.all([
    issuer
      ? check(fetcher, `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, timeoutMs, (response, body) =>
          response.ok && typeof (body as { issuer?: unknown } | undefined)?.issuer === "string")
      : undefined,
    gateway
      ? check(fetcher, `${gateway.replace(/\/+$/, "")}/v1/me`, timeoutMs, (response, body) =>
          response.status === 401 && typeof (body as { error?: unknown } | undefined)?.error === "string")
      : undefined,
  ]);
  return [discovery, ...rest.filter((item): item is HostCheck => Boolean(item))];
}
