import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { readStdin } from "../runtime/node";
import { ingestCoworkOtlp, MAX_COWORK_BATCH_BYTES } from "./cowork-otlp";
import { CoworkError, nativeCoworkAllowed } from "./cowork-task";
import { spawnShipper } from "./shipper";

export interface CoworkCommandArgs { mode: "native" | "otlp" | "listen"; projects: string[]; port?: number }
export function parseCoworkCommand(argv: string[]): CoworkCommandArgs {
  const modes = argv.filter(x => ["--cowork-native", "--cowork-otlp", "--cowork-listen"].includes(x));
  if (modes.length !== 1) throw new CoworkError("conflicting_verbs", "Choose exactly one Cowork capture transport command.");
  const mode = modes[0] === "--cowork-native" ? "native" : modes[0] === "--cowork-otlp" ? "otlp" : "listen";
  const projects: string[] = [];
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") {
      if (!argv[i + 1] || argv[i + 1]!.startsWith("--")) throw new CoworkError("project_required", "Every --project requires an explicit connected project directory.");
      try { projects.push(realpathSync(argv[++i]!)); } catch { throw new CoworkError("project_required", "The project directory is unavailable on this runtime."); }
    } else if (argv[i] === "--cowork-listen") {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CoworkError("invalid_port", "Use a valid localhost listener port.");
    } else if (!["--cowork-native", "--cowork-otlp", "--json"].includes(argv[i]!)) {
      throw new CoworkError("unknown_argument", "The Cowork capture command received an unsupported argument.");
    }
  }
  if (!projects.length || (mode === "native" && projects.length !== 1)) throw new CoworkError("project_required", "Native capture needs exactly one explicit project; an OTLP relay needs an explicit project list.");
  return { mode, projects: [...new Set(projects)], ...(port !== undefined ? { port } : {}) };
}

export function coworkCommandFailure(error: unknown): { status: "error"; code: string; message: string } {
  return error instanceof CoworkError
    ? { status: "error", code: error.code, message: error.message }
    : { status: "error", code: "capture_failed", message: "Cowork capture could not complete; no source content or credential is included in this diagnostic." };
}

export async function startCoworkReceiver(projects: string[], port: number, secret: string) {
  if (secret.length < 32) throw new CoworkError("collector_auth_required", "Set a private AUGENTA_COWORK_COLLECTOR_TOKEN of at least 32 characters on the relay. Never paste it into chat.");
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const provided = createHash("sha256").update(request.headers.authorization ?? "").digest();
    if (!timingSafeEqual(expected, provided)) { response.writeHead(401); response.end(JSON.stringify({ error: "collector authentication required" })); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end("{}"); return; }
    // Metrics and traces do not become trajectories. This relay accepts logs only.
    if (["/v1/metrics", "/v1/traces"].includes(request.url ?? "")) { request.resume(); response.end("{}"); return; }
    if (request.url !== "/v1/logs") { response.writeHead(404); response.end("{}"); return; }
    if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "") || request.headers["content-encoding"]) {
      response.writeHead(415); response.end(JSON.stringify({ error: "configure Cowork OTLP as http/json without compression" })); return;
    }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_COWORK_BATCH_BYTES) throw new CoworkError("batch_too_large", "Cowork OTLP batch exceeds the relay limit.");
        chunks.push(Buffer.from(chunk));
      }
      let payload: unknown;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new CoworkError("invalid_otlp", "Expected an OTLP/HTTP JSON logs request."); }
      const result = await ingestCoworkOtlp(projects, payload);
      for (const root of result.projects) spawnShipper(root);
      response.end(JSON.stringify(result.ignored ? { partialSuccess: { rejectedLogRecords: String(result.ignored), errorMessage: "Unbound, disabled, unsupported or pre-binding records were not forwarded." } } : {}));
    } catch (error) {
      const failure = coworkCommandFailure(error);
      response.writeHead(["batch_too_large", "invalid_otlp", "sequence_conflict", "prompt_conflict"].includes(failure.code) ? 400 : 503);
      response.end(JSON.stringify({ error: failure }));
    }
  });
  server.requestTimeout = 10_000;
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", done); });
  return server;
}

/** Returns true only for the long-running, customer-controlled localhost relay. */
export async function runCoworkCommand(argv: string[], native: (payload: any, root: string) => unknown): Promise<boolean> {
  const args = parseCoworkCommand(argv);
  if (args.mode === "listen") {
    const server = await startCoworkReceiver(args.projects, args.port!, process.env.AUGENTA_COWORK_COLLECTOR_TOKEN ?? "");
    console.log(JSON.stringify({ status: "listening", address: "127.0.0.1", port: (server.address() as { port: number }).port, projects: args.projects }));
    return true;
  }
  const input = await readStdin();
  if (Buffer.byteLength(input) > MAX_COWORK_BATCH_BYTES) throw new CoworkError("batch_too_large", "Cowork capture input exceeds the relay limit.");
  let payload: any;
  try { payload = JSON.parse(input); } catch { throw new CoworkError("invalid_payload", "Expected one JSON capture payload on stdin."); }
  if (args.mode === "native") {
    const root = args.projects[0]!;
    if (!nativeCoworkAllowed(root, payload?.session_id, payload?.transcript_path, true)) {
      throw new CoworkError("task_not_bound", "Bind this exact engine session and accessible transcript to the project using the native transport first.");
    }
    console.log(JSON.stringify({ status: "captured", result: native(payload, root) }));
  } else {
    const result = await ingestCoworkOtlp(args.projects, payload);
    for (const root of result.projects) spawnShipper(root);
    console.log(JSON.stringify({ status: "queued", queued: result.queued, duplicates: result.duplicates, ignored: result.ignored }));
  }
  return false;
}
