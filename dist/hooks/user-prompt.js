#!/usr/bin/env bun

// capture/turn-cursor.ts
import { join as join2, dirname } from "node:path";
import { mkdirSync as mkdirSync2, existsSync as existsSync2, readFileSync, writeFileSync as writeFileSync2, renameSync } from "node:fs";

// capture/augenta-dir.ts
import { join } from "node:path";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
function ensureAugentaDir(projectRoot) {
  const dir = join(projectRoot, ".augenta");
  try {
    mkdirSync(dir, { recursive: true, mode: 448 });
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore))
      writeFileSync(ignore, `*
`);
  } catch {}
  return dir;
}

// capture/turn-cursor.ts
class TurnState {
  path;
  projectRoot;
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.path = join2(projectRoot, ".augenta", "state", "turn.json");
  }
  readAll() {
    if (!existsSync2(this.path))
      return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  writeAll(all) {
    ensureAugentaDir(this.projectRoot);
    mkdirSync2(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync2(tmp, JSON.stringify(all));
    renameSync(tmp, this.path);
  }
  get(transcriptPath) {
    const v = this.readAll()[transcriptPath];
    return typeof v === "number" && v >= 0 ? v : 0;
  }
  bump(transcriptPath) {
    const all = this.readAll();
    const cur = typeof all[transcriptPath] === "number" && all[transcriptPath] >= 0 ? all[transcriptPath] : 0;
    all[transcriptPath] = cur + 1;
    this.writeAll(all);
    return cur + 1;
  }
}

// capture/config.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
var DEFAULT_GATEWAY = "https://apim-aug-platform-prod-utyom2a4bdhti.azure-api.net";
function parseNeurolinkIds(value) {
  const raw = Array.isArray(value.neurolinkIds) ? value.neurolinkIds : typeof value.neurolinkId === "string" ? [value.neurolinkId] : [];
  const ids = [];
  for (const item of raw) {
    if (typeof item !== "string")
      return [];
    const id = item.trim();
    if (!id)
      return [];
    if (!ids.includes(id))
      ids.push(id);
  }
  return ids;
}
function configPath(projectRoot) {
  return join3(projectRoot, ".augenta", "config.json");
}
function resolveProjectRoot(cwd) {
  if (!cwd)
    return;
  let dir = cwd;
  for (let i = 0;i < 30; i++) {
    if (existsSync3(configPath(dir)))
      return dir;
    const parent = dirname2(dir);
    if (parent === dir)
      return;
    dir = parent;
  }
  return;
}
function loadProjectConfig(projectRoot) {
  try {
    const value = JSON.parse(readFileSync2(configPath(projectRoot), "utf8"));
    const endpoint = typeof value.endpoint === "string" && value.endpoint.trim() ? value.endpoint.trim() : undefined;
    if (value.authMode === "oauth") {
      const profileId = typeof value.profileId === "string" ? value.profileId.trim() : "";
      const neurolinkIds = parseNeurolinkIds(value);
      if (!profileId || neurolinkIds.length === 0)
        return;
      return {
        authMode: "oauth",
        profileId,
        neurolinkIds,
        ...endpoint ? { endpoint } : {},
        projectRoot
      };
    }
    if (value.authMode === "api-key") {
      const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
      if (!apiKey)
        return;
      return {
        authMode: "api-key",
        apiKey,
        ...endpoint ? { endpoint } : {},
        projectRoot
      };
    }
    return;
  } catch {
    return;
  }
}
function projectConfig(cwd) {
  const root = resolveProjectRoot(cwd);
  return root ? loadProjectConfig(root) : undefined;
}
function gatewayBase(cfg) {
  return (process.env.AUGENTA_API_URL || cfg?.endpoint || DEFAULT_GATEWAY).replace(/\/+$/, "");
}
function experiencesUrl(cfg) {
  return process.env.AUGENTA_INGEST_URL || `${gatewayBase(cfg)}/v1/experiences`;
}
function captureKilled() {
  const value = process.env.AUGENTA_CAPTURE_ENABLED;
  return value === "0" || value === "false";
}
function captureEnabled(cfg) {
  if (!cfg || captureKilled())
    return false;
  return cfg.authMode === "oauth" ? Boolean(cfg.profileId) && (cfg.neurolinkIds?.length ?? 0) > 0 : Boolean(cfg.apiKey);
}

// runtime/node.ts
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function isMain(metaUrl) {
  const entry = process.argv[1];
  return Boolean(entry) && fileURLToPath(metaUrl) === entry;
}
function openBrowser(command) {
  spawnSync(command[0], command.slice(1), { stdio: "ignore" });
}

// hooks/user-prompt.ts
var transcriptPath;
var cwd;
try {
  const payload = JSON.parse(await readStdin());
  if (typeof payload.transcript_path === "string")
    transcriptPath = payload.transcript_path;
  if (typeof payload.cwd === "string")
    cwd = payload.cwd;
} catch {}
try {
  const cfg = projectConfig(cwd);
  if (transcriptPath && cfg && captureEnabled(cfg)) {
    new TurnState(cfg.projectRoot).bump(transcriptPath);
  }
} catch {}
process.exit(0);
