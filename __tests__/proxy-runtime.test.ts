import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Outbox } from "../capture/outbox";
import { nodeHonorsEnvProxy } from "../runtime/node";

const ROOT = resolve(import.meta.dir, "..");
const PROXY_CAPABLE = nodeHonorsEnvProxy(execFileSync("node", ["-p", "process.versions.node"], { encoding: "utf8" }).trim());

async function listen(server: Server): Promise<number> {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return (server.address() as { port: number }).port;
}

function childEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (/^(AUGENTA_|HTTPS?_PROXY$|https?_proxy$|NO_PROXY$|no_proxy$|NODE_EXTRA_CA_CERTS$|NODE_USE_ENV_PROXY$|CLAUDE_CODE_REMOTE|CODEX_HOME)/.test(key)) delete env[key];
  }
  return { ...env, HOME: home, AUGENTA_AUTH_HOME: join(home, "auth"), NODE_NO_WARNINGS: "1", ...extra };
}

async function run(home: string, bundle: string, args: string[], extra: Record<string, string> = {}, hook = false) {
  const command = hook
    ? ["sh", join(ROOT, "scripts/run-node-hook.sh"), join(ROOT, "dist", bundle), ...args]
    : ["node", join(ROOT, "dist", bundle), ...args];
  const proc = Bun.spawn(command, { env: childEnv(home, extra), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 20_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  } finally { clearTimeout(timer); }
}

describe("shipped Node network behavior", () => {
  test.skipIf(!PROXY_CAPABLE).each(["--probe", "--login", "--await-login"])("%s reports a denying CONNECT proxy safely", async verb => {
    const home = mkdtempSync(join(tmpdir(), "aug-deny-"));
    const seen: string[] = [];
    const proxy = createServer((_req, res) => { res.writeHead(403); res.end(); });
    proxy.on("connect", (req, socket) => {
      seen.push(req.url!);
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    const port = await listen(proxy);
    try {
      const result = await run(home, "scripts/connect.mjs", ["--project", home, "--harness", "claude-code", "--json", verb], { HTTPS_PROXY: `http://127.0.0.1:${port}` });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({ status: "error", code: "network_blocked" });
      expect(payload.hosts).toEqual(["augenta.ai", "auth.augenta.ai", "api.augenta.ai"].map(host => ({ host, ok: false, reason: "a proxy refused it (403)", kind: "proxy_refused" })));
      expect(seen).toContain("augenta.ai:443");
      expect(payload.message).toContain("admin");
      expect(payload.message).toContain("Allow network egress");
      expect(payload.message).toContain("new");
      expect(result.stdout).not.toMatch(/access_token|refresh_token|device_code|verification_uri|Bearer /i);
    } finally { proxy.closeAllConnections(); proxy.close(); rmSync(home, { recursive: true, force: true }); }
  });

  for (const mode of ["direct", "tunnel", "intercept", "no_proxy"]) {
  test.skipIf(!PROXY_CAPABLE && mode !== "direct")(`connect, ship and recall work over ${mode}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "aug-network-"));
    const keyPath = join(home, "key.pem");
    const certPath = join(home, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
    const requests: { via: string; path: string; body: unknown }[] = [];
    let gateway = "";
    const handler = (via: string) => async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const path = new URL(req.url!, gateway).pathname;
      requests.push({ via, path, body });
      let answer: unknown;
      let status = 200;
      if (path === "/.well-known/augenta.json") answer = { issuer: gateway, clientId: "client_public", gateway };
      else if (path === "/v1/connectors") answer = { connectors: [{ id: "connector_test", orgId: "org_test", workspaceId: "ws_test", status: "active", direction: "inbound" }] };
      else if (path === "/v1/connectors/connector_test") answer = { connector: { id: "connector_test", workspaceId: "ws_test", status: "active", direction: "inbound" } };
      else if (path === "/v1/workspaces") answer = { workspaces: [{ id: "ws_test", name: "Test" }] };
      else if (path === "/v1/recall") answer = { mode: "context", content: [{ type: "engram", text: "proxy test memory" }] };
      else if (path === "/v1/experiences" || path.startsWith("/v1/telemetry/")) { status = 202; answer = {}; }
      else { status = 404; answer = { error: "not found" }; }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    };
    const origin = createHttpsServer(tls, handler("origin"));
    const originPort = await listen(origin);
    gateway = `https://127.0.0.1:${originPort}`;
    const intercept = createHttpsServer(tls, handler("intercept"));
    const interceptPort = await listen(intercept);
    const sockets = new Set<import("node:stream").Duplex>();
    const tunnels: string[] = [];
    const proxy = createServer((_req, res) => { res.writeHead(500); res.end(); });
    proxy.on("connect", (req, socket, head) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      tunnels.push(req.url!);
      if (mode === "no_proxy") { socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); return; }
      {
        const upstream = connect(mode === "intercept" ? interceptPort : originPort, "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        sockets.add(upstream);
        upstream.on("error", () => socket.destroy());
        upstream.on("close", () => sockets.delete(upstream));
        socket.on("close", () => upstream.destroy());
      }
    });
    const proxyPort = await listen(proxy);
    const env: Record<string, string> = { NODE_EXTRA_CA_CERTS: certPath, ...(mode === "direct" ? {} : { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` }), ...(mode === "no_proxy" ? { NO_PROXY: "127.0.0.1" } : {}) };
    try {
      const probe = await run(home, "scripts/connect.mjs", ["--json", "--probe", "--project", home, "--harness", "claude-code", "--control-url", gateway], env);
      expect(probe.exitCode, probe.stderr + probe.stdout).toBe(0);
      expect(JSON.parse(probe.stdout).status).toBe("need_login");
      mkdirSync(join(home, ".augenta"));
      writeFileSync(join(home, ".augenta/config.json"), JSON.stringify({ authMode: "api-key", apiKey: "sk-aug-test.secret", endpoint: gateway, controlUrl: gateway, destinations: [{ connectorId: "connector_test", workspaceId: "ws_test", workspaceName: "Test" }] }));
      const verify = await run(home, "scripts/connect.mjs", ["--verify-only", "--project", home, "--harness", "claude-code"], env);
      expect(verify.exitCode, verify.stdout + verify.stderr).toBe(0);
      expect(verify.stdout).not.toContain("sk-aug-test.secret");
      new Outbox(home).append([{ src: "claude-code", sid: "proxy-session", proj: home, ts: new Date().toISOString(), seq: 0, turn: 1, turn_source: "native", kind: "msg", role: "assistant", text: "proxy test turn" }]);
      const shipped = await run(home, "capture/ship.mjs", [home], env, true);
      expect(shipped.exitCode, shipped.stderr).toBe(0);
      expect(shipped.stdout).toBe("");
      const upload = requests.find(r => r.path === "/v1/experiences");
      expect(upload).toBeDefined();
      expect(upload!.body).toMatchObject({ experiences: [{ type: "trajectory", events: [{ text: "proxy test turn", turn: 1 }] }] });
      const recall = await run(home, "scripts/recall.mjs", ["--json", "--context", "--project", home, "what did the proxy test remember"], env);
      expect(recall.exitCode, recall.stdout + recall.stderr).toBe(0);
      expect(JSON.parse(recall.stdout).status).toBe("answered");
      expect(requests.find(r => r.path === "/v1/recall")!.body).toEqual({ query: "what did the proxy test remember" });
      // The three product flows use Node fetch. Optional SDK observability has
      // its own transport and is not part of this routing assertion.
      expect(requests.filter(r => !r.path.startsWith("/v1/telemetry/")).every(r => r.via === (mode === "intercept" ? "intercept" : "origin"))).toBe(true);
      expect(tunnels.length > 0).toBe(mode === "tunnel" || mode === "intercept");
    } finally {
      for (const socket of sockets) socket.destroy();
      for (const server of [origin, intercept, proxy]) { server.closeAllConnections(); server.close(); }
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
  }
});
