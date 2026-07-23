#!/usr/bin/env node
import { spawn } from "node:child_process";

const [marketplacePath, pluginName = "augenta"] = process.argv.slice(2);

if (!marketplacePath) {
  console.error("Usage: read-codex-plugin.mjs <marketplace-path> [plugin-name]");
  process.exit(2);
}

const appServer = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "inherit"],
});

let output = "";
let requestSent = false;
let finished = false;

function send(message) {
  appServer.stdin.write(`${JSON.stringify(message)}\n`);
}

function finish(exitCode, message) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (message) console.error(message);
  appServer.kill();
  process.exitCode = exitCode;
}

const timeout = setTimeout(() => {
  finish(1, "Timed out waiting for Codex app-server plugin/read response.");
}, 30_000);

appServer.on("error", (error) => {
  finish(1, `Could not start Codex app-server: ${error.message}`);
});

appServer.stdout.setEncoding("utf8");
appServer.stdout.on("data", (chunk) => {
  output += chunk;
  const lines = output.split("\n");
  output = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      finish(1, `Codex app-server returned invalid JSON: ${error.message}`);
      return;
    }

    if (message.id === 0) {
      send({ method: "initialized", params: {} });
      send({
        id: 1,
        method: "plugin/read",
        params: { marketplacePath, pluginName },
      });
      requestSent = true;
      continue;
    }

    if (message.id === 1 && requestSent) {
      if (message.error) {
        finish(1, `Codex plugin/read failed: ${JSON.stringify(message.error)}`);
        return;
      }
      process.stdout.write(`${JSON.stringify(message.result.plugin)}\n`);
      finish(0);
    }
  }
});

appServer.on("exit", (code) => {
  if (!finished) finish(code ?? 1, "Codex app-server exited before plugin/read completed.");
});

send({
  id: 0,
  method: "initialize",
  params: {
    clientInfo: { name: "augenta-plugin-ci", version: "0.2.3" },
    capabilities: { experimentalApi: true },
  },
});
