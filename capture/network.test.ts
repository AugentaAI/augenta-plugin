/**
 * Tests for network.ts: naming a network that blocks Augenta, from the error
 * shapes Node actually produces and from the answers each host actually gives.
 *
 * Run: bun test capture/network.test.ts
 */
import { describe, expect, test } from "bun:test";
import { classifyNetworkError, diagnoseHosts, DiscoveryError } from "./network";
import { envProxyReexecEnv, nodeHonorsEnvProxy } from "../runtime/node";

/** Exactly what Node 22.21 and 25.2 threw for a CONNECT an allowlisting proxy
 *  refused (measured through a local proxy, not assumed). */
function proxyRefusal(status: number): Error {
  const inner = Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), {
    name: "AbortError",
    code: "UND_ERR_ABORTED",
  });
  const middle = Object.assign(new Error("Request was cancelled.", { cause: inner }), { code: 0 });
  return new TypeError("fetch failed", { cause: middle });
}
const failedWith = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

describe("classifyNetworkError", () => {
  test("a proxy's refused tunnel is found two causes down, with its status", () => {
    expect(classifyNetworkError(proxyRefusal(403))).toEqual({ kind: "proxy_refused", status: 403 });
    expect(classifyNetworkError(proxyRefusal(407))).toEqual({ kind: "proxy_refused", status: 407 });
  });

  test("discovery answered by something other than Augenta is a block; a 404 is not", () => {
    expect(classifyNetworkError(new DiscoveryError(403, "x"))).toEqual({ kind: "proxy_refused", status: 403 });
    expect(classifyNetworkError(new DiscoveryError(404, "x"))).toBeUndefined();
  });

  test("connection-level causes by code", () => {
    expect(classifyNetworkError(failedWith("ENOTFOUND"))).toEqual({ kind: "dns", code: "ENOTFOUND" });
    expect(classifyNetworkError(failedWith("ECONNREFUSED"))).toEqual({ kind: "refused", code: "ECONNREFUSED" });
    expect(classifyNetworkError(failedWith("ECONNRESET"))).toEqual({ kind: "reset", code: "ECONNRESET" });
    expect(classifyNetworkError(failedWith("SELF_SIGNED_CERT_IN_CHAIN"))).toEqual({ kind: "tls", code: "SELF_SIGNED_CERT_IN_CHAIN" });
    expect(classifyNetworkError(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })))
      .toEqual({ kind: "timeout" });
  });

  test("Augenta answering, or anything else, is not a network failure", () => {
    expect(classifyNetworkError(new Error("Augenta rejected the sign-in (403)"))).toBeUndefined();
    expect(classifyNetworkError(new TypeError("fetch failed"))).toBeUndefined();
    expect(classifyNetworkError("a string")).toBeUndefined();
  });
});

describe("diagnoseHosts", () => {
  type Answer = Response | Error;
  const fetcherFor = (answers: Record<string, Answer>) => async (url: string, init: RequestInit) => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const answer = answers[url];
    if (!answer) throw failedWith("ENOTFOUND");
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const augenta = {
    "https://control.example.com/.well-known/augenta.json": () => Response.json({ issuer: "https://auth.example.com", gateway: "https://api.example.com" }),
    "https://auth.example.com/.well-known/openid-configuration": () => Response.json({ issuer: "https://auth.example.com" }),
    "https://api.example.com/v1/me": () => Response.json({ error: "authentication required" }, { status: 401 }),
  };
  const answers = (overrides: Record<string, Answer> = {}) =>
    Object.fromEntries([
      ...Object.entries(augenta).map(([url, make]) => [url, make()]),
      ...Object.entries(overrides),
    ]) as Record<string, Answer>;

  test("every host answering as Augenta does is reachable, hosts taken from discovery", async () => {
    expect(await diagnoseHosts("https://control.example.com", { fetcher: fetcherFor(answers()) })).toEqual([
      { host: "control.example.com", ok: true },
      { host: "auth.example.com", ok: true },
      { host: "api.example.com", ok: true },
    ]);
  });

  test("a proxy's 403 page is not Augenta's 401, and a refused tunnel is named", async () => {
    const hosts = await diagnoseHosts("https://control.example.com", {
      fetcher: fetcherFor(answers({
        "https://api.example.com/v1/me": new Response("<html>blocked</html>", { status: 403 }),
        "https://auth.example.com/.well-known/openid-configuration": proxyRefusal(403),
      })),
    });
    expect(hosts).toEqual([
      { host: "control.example.com", ok: true },
      { host: "auth.example.com", ok: false, reason: "a proxy refused it (403)" },
      { host: "api.example.com", ok: false, reason: "answered 403, not as Augenta does" },
    ]);
  });

  test("discovery blocked on production still names all three production hosts", async () => {
    const hosts = await diagnoseHosts("https://augenta.ai", { fetcher: fetcherFor({}) });
    expect(hosts.map((host) => host.host)).toEqual(["augenta.ai", "auth.augenta.ai", "api.augenta.ai"]);
    expect(hosts.every((host) => !host.ok)).toBe(true);
  });

  test("discovery blocked elsewhere names only what it knows", async () => {
    const hosts = await diagnoseHosts("https://control.example.com", { fetcher: fetcherFor({}) });
    expect(hosts).toEqual([{ host: "control.example.com", ok: false, reason: "the name did not resolve" }]);
  });
});

describe("the CLI re-run for a proxied sandbox", () => {
  test("Node honors NODE_USE_ENV_PROXY from 22.21 and 24.0", () => {
    for (const version of ["22.21.0", "22.21.1", "24.0.0", "25.2.1"]) expect(nodeHonorsEnvProxy(version), version).toBe(true);
    for (const version of ["20.19.5", "22.20.0", "23.11.0"]) expect(nodeHonorsEnvProxy(version), version).toBe(false);
  });

  test("re-runs only with a proxy, on a Node that honors it, never twice, never under Bun", () => {
    const proxied = { HTTPS_PROXY: "http://127.0.0.1:3128" };
    const none = () => false;
    expect(envProxyReexecEnv(proxied, "22.21.1", false, none)).toMatchObject({
      NODE_USE_ENV_PROXY: "1",
      AUGENTA_PROXY_REEXEC: "1",
      NODE_NO_WARNINGS: "1",
    });
    expect(envProxyReexecEnv({}, "22.21.1", false, none)).toBeUndefined();
    expect(envProxyReexecEnv(proxied, "20.19.5", false, none)).toBeUndefined();
    expect(envProxyReexecEnv({ ...proxied, AUGENTA_PROXY_REEXEC: "1" }, "22.21.1", false, none)).toBeUndefined();
    expect(envProxyReexecEnv({ ...proxied, NODE_USE_ENV_PROXY: "1" }, "22.21.1", false, none)).toBeUndefined();
    expect(envProxyReexecEnv(proxied, "22.21.1", true, none)).toBeUndefined();
  });

  test("a CA is added only from a readable file, and never over one already chosen", () => {
    const proxied = { https_proxy: "http://127.0.0.1:3128" };
    const mitm = (path: string) => path.includes("mitm-proxy-ca");
    expect(envProxyReexecEnv(proxied, "24.0.0", false, mitm)?.NODE_EXTRA_CA_CERTS)
      .toBe("/usr/local/share/ca-certificates/mitm-proxy-ca.crt");
    expect(envProxyReexecEnv(proxied, "24.0.0", false, () => false)?.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(envProxyReexecEnv({ ...proxied, NODE_EXTRA_CA_CERTS: "/mine.pem" }, "24.0.0", false, () => true)?.NODE_EXTRA_CA_CERTS)
      .toBe("/mine.pem");
  });

  test("a transparent proxy's CA is trusted with no proxy variable; the system bundle is not", () => {
    // The sandbox's own CA is its own signal: a transparent interceptor names no proxy.
    expect(envProxyReexecEnv({}, "20.19.5", false, (path) => path.includes("mitm-proxy-ca")))
      .toEqual({ AUGENTA_PROXY_REEXEC: "1", NODE_EXTRA_CA_CERTS: "/usr/local/share/ca-certificates/mitm-proxy-ca.crt" });
    // Without a proxy in use, the system bundle alone is no reason to re-run.
    expect(envProxyReexecEnv({}, "24.0.0", false, (path) => path.includes("ca-certificates.crt"))).toBeUndefined();
  });
});
