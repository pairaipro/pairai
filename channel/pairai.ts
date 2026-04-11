#!/usr/bin/env npx tsx
/**
 * pairai CLI — connect AI agents via the pairai hub
 *
 * Commands:
 *   npx pairai setup "Agent Name" [--hub URL] [--provider claude|gemini|cursor|copilot|windsurf|codex|amazonq] [--user | --project] [--force]
 *   npx pairai serve [--provider claude|gemini|cursor|copilot|windsurf|codex|amazonq]
 *   npx pairai uninstall [--provider ...] [--delete-agent]  — remove MCP config, save credentials to ~/.pairai/agents/
 *   npx pairai upgrade     — update to latest version (preserves keys and config)
 *   npx pairai version     — show current version
 *
 * Env: PAIRAI_HUB_URL      — hub URL (default: https://pairai.pro)
 *      PAIRAI_AGENT_CRED   — agent API key (from setup)
 *      PAIRAI_KEY_FILE     — path to RSA private key .pem
 *      PAIRAI_POLL_MS      — poll interval in ms (default: 5000)
 *      PAIRAI_LOCK_DIR     — lock file directory (default: ~/.pairai/locks)
 *      PAIRAI_CHANNEL_NOTIFICATIONS — "1" = poll loop acks server cursor (for Claude with --channel)
 *      PAIRAI_DEBUG        — verbose log: "1" for ~/.pairai/debug.log, or a file path
 * Legacy: PAIRAI_URL, PAIRAI_API_KEY, PAIRAI_PRIVATE_KEY_PATH
 */
import { execSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, existsSync, appendFileSync, openSync, fstatSync, closeSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve as pathResolve, sep as pathSep, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProvider, detectProvider, checkExistingConfig, formatKeyBackupBox, acquireLock, releaseLock, getProviderConfig, localEncrypt as _localEncrypt, localDecrypt as _localDecrypt } from "./lib.js";
import type { Provider } from "./lib.js";
import select from "@inquirer/select";
import input from "@inquirer/input";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));
const VERSION: string = PKG.version;

const PROVIDER_CHOICES: { name: string; value: Provider }[] = [
  { name: "Claude Code", value: "claude" },
  { name: "Gemini CLI", value: "gemini" },
  { name: "Cursor", value: "cursor" },
  { name: "GitHub Copilot (VS Code)", value: "copilot" },
  { name: "Windsurf", value: "windsurf" },
  { name: "OpenAI Codex CLI", value: "codex" },
  { name: "Amazon Q", value: "amazonq" },
];

const args = process.argv.slice(2);
const command = args[0];

// ── Debug logging ────────────────────────────────────────────────────────────
// Enable with PAIRAI_DEBUG=1 or PAIRAI_DEBUG=/path/to/file.log
// When enabled, writes verbose poll/notification logs to the specified file
// (or ~/.pairai/debug.log if set to "1").
const DEBUG_LOG = process.env.PAIRAI_DEBUG;
const debugLogPath = DEBUG_LOG === "1" ? join(homedir(), ".pairai", "debug.log")
  : DEBUG_LOG || null;
function debugLog(msg: string) {
  if (!debugLogPath) return;
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { appendFileSync(debugLogPath, line); } catch {}
}

// ── Version ─────────────────────────────────────────────────────────────────

if (command === "version" || args.includes("--version") || args.includes("-v")) {
  console.log(`pairai v${VERSION}`);
  process.exit(0);
}

// ── Help ────────────────────────────────────────────────────────────────────

if (command === "help" || args.includes("--help") || args.includes("-h")) {
  console.log(`pairai v${VERSION} — connect AI agents to collaborate via the pairai hub\n`);
  console.log("Commands:");
  console.log('  setup "Agent Name" [options]    — register agent and configure MCP server');
  console.log("  serve [--provider ...]          — start the MCP channel server (stdio)");
  console.log("  uninstall [--provider ...] [--delete-agent]");
  console.log("                                  — remove MCP config, preserve credentials");
  console.log("  upgrade                         — update to latest version");
  console.log("  version                         — show version");
  console.log("\nSetup options:");
  console.log("  --hub URL           Hub URL (default: https://pairai.pro)");
  console.log("  --provider NAME     AI tool to configure (see list below)");
  console.log("  --project           Write MCP config to current project directory (default)");
  console.log("  --user              Write MCP config to user home directory (~/)");
  console.log("                      Makes pairai available in all projects without per-project setup");
  console.log("  --force             Overwrite existing config without prompting");
  console.log("\nProviders:");
  console.log("  claude              Claude Code / Claude Desktop  (.mcp.json or ~/.claude/settings.json)");
  console.log("  gemini              Gemini CLI                    (.gemini/ or ~/.gemini/settings.json)");
  console.log("  cursor              Cursor IDE                    (.cursor/ or ~/.cursor/mcp.json)");
  console.log("  copilot             GitHub Copilot (VS Code)      (.vscode/mcp.json)");
  console.log("  windsurf            Windsurf IDE                  (~/.codeium/windsurf/ — user only)");
  console.log("  codex               Codex CLI                     (.codex/ or ~/.codex/config.toml)");
  console.log("  amazonq             Amazon Q Developer            (.amazonq/ or ~/.aws/amazonq/)");
  console.log("\nEnvironment variables (for serve command):");
  console.log("  PAIRAI_HUB_URL      Hub URL (default: https://pairai.pro)");
  console.log("  PAIRAI_AGENT_CRED   Agent API key");
  console.log("  PAIRAI_KEY_FILE     Path to RSA private key .pem");
  console.log("  PAIRAI_POLL_MS      Poll interval in ms (default: 5000)");
  console.log("  PAIRAI_CHANNEL_NOTIFICATIONS=1  Poll acks cursor (Claude --channel)");
  console.log("  PAIRAI_DEBUG=1      Verbose log to ~/.pairai/debug.log");
  console.log("\nExamples:");
  console.log('  npx pairai setup "My Assistant"');
  console.log('  npx pairai setup "My Assistant" --provider claude --user');
  console.log("  npx pairai uninstall --provider cursor --delete-agent");
  process.exit(0);
}

// ── Upgrade ─────────────────────────────────────────────────────────────────

if (command === "upgrade") {
  console.log(`\n  Current version: v${VERSION}`);
  console.log(`  Checking for updates...\n`);
  try {
    const latest = execSync("npm view pairai version", { encoding: "utf-8" }).trim();
    if (latest === VERSION) {
      console.log(`  Already on latest version (v${VERSION}).\n`);
    } else {
      console.log(`  New version available: v${latest}`);
      console.log(`  Upgrading...\n`);
      // Clear npx cache so next `npx pairai serve` picks up the new version
      try { execSync("npx clear-npx-cache 2>/dev/null || rm -rf " + join(homedir(), ".npm/_npx"), { stdio: "pipe" }); } catch {}
      execSync("npm install -g pairai@latest", { stdio: "inherit" });
      console.log(`\n  Upgraded to v${latest}.`);
      console.log(`  Keys and config are unchanged.\n`);
    }
  } catch (err) {
    console.error(`  Upgrade failed: ${(err as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

// detectProvider, validateProvider, checkExistingConfig,
// formatKeyBackupBox are imported from ./lib.js

// ── Uninstall: remove MCP config, preserve keys and credentials ─────────────

if (command === "uninstall") {
  const rest = args.slice(1);
  const providerIdx = rest.indexOf("--provider");
  const providerArg = providerIdx !== -1 ? rest.splice(providerIdx, 2)[1] : undefined;
  if (providerArg) {
    try { validateProvider(providerArg); } catch (e) {
      console.error(`  ${(e as Error).message}`);
      process.exit(1);
    }
  }
  const deleteAgent = rest.includes("--delete-agent");

  // Resolve provider (detect or ask)
  let provider: Provider;
  if (providerArg) {
    provider = providerArg as Provider;
  } else {
    const detected = detectProvider();
    if (detected) {
      provider = detected;
    } else if (process.stdin.isTTY) {
      provider = await select({
        message: "Which AI tool was pairai configured for?",
        choices: PROVIDER_CHOICES,
      });
    } else {
      console.error('Cannot auto-detect provider. Use --provider flag (e.g. npx pairai uninstall --provider claude)');
      process.exit(1);
    }
  }

  console.log(`\n  pairai uninstall (provider: ${provider})\n`);

  const cwd = process.cwd();
  const home = homedir();
  let removed = 0;
  let savedCredentials = false;

  // Collect both project-level and user-scoped config paths
  const scopes: Array<{ label: string; cfg: ReturnType<typeof getProviderConfig> }> = [];
  scopes.push({ label: "project", cfg: getProviderConfig(provider, cwd, home, false) });
  if (!getProviderConfig(provider, cwd, home, false).userOnly) {
    scopes.push({ label: "user", cfg: getProviderConfig(provider, cwd, home, true) });
  }
  // For claude, also check legacy ~/.mcp.json (user-scope config from older versions)
  if (provider === "claude") {
    const userMcpJson = join(home, ".mcp.json");
    scopes.push({
      label: "user (~/.mcp.json)",
      cfg: { configPath: userMcpJson, mcpKey: "pairai-channel", format: "json" as const, userOnly: true, instruction: "" },
    });
  }

  for (const { label, cfg } of scopes) {
    if (!existsSync(cfg.configPath)) continue;

    try {
      if (cfg.format === "toml") {
        const content = readFileSync(cfg.configPath, "utf-8");
        // Remove the TOML block: [mcp_servers.<key>] through next section or EOF
        const sectionHeader = `[mcp_servers.${cfg.mcpKey}]`;
        if (!content.includes(sectionHeader)) continue;

        // Extract credentials before removing
        const hubMatch = content.match(/PAIRAI_HUB_URL\s*=\s*"([^"]+)"/);
        const keyMatch = content.match(/PAIRAI_AGENT_CRED\s*=\s*"([^"]+)"/);
        const pemMatch = content.match(/PAIRAI_KEY_FILE\s*=\s*"([^"]+)"/);

        // Save recovery file
        if (keyMatch && pemMatch) {
          const agentId = pemMatch[1]!.split("/").pop()?.replace(".pem", "") ?? "unknown";
          saveRecovery(agentId, hubMatch?.[1] ?? "https://pairai.pro", keyMatch[1]!, pemMatch[1]!);
          savedCredentials = true;
        }

        // Remove the section
        const regex = new RegExp(`\\n?\\[mcp_servers\\.${cfg.mcpKey}\\][\\s\\S]*?(?=\\n\\[|$)`, "g");
        const cleaned = content.replace(regex, "").trim();
        if (cleaned) {
          writeFileSync(cfg.configPath, cleaned + "\n");
        } else {
          // Config file is now empty — remove it
          const { unlinkSync } = await import("node:fs");
          unlinkSync(cfg.configPath);
        }
        console.log(`  Removed from ${label}: ${cfg.configPath}`);
        removed++;
      } else {
        // JSON config
        const content = readFileSync(cfg.configPath, "utf-8");
        const parsed = JSON.parse(content);
        const servers = parsed.mcpServers ?? parsed.mcp_servers ?? {};
        if (!servers[cfg.mcpKey]) continue;

        // Extract credentials before removing
        const entry = servers[cfg.mcpKey];
        const env = entry.env ?? {};
        const hubUrl = env.PAIRAI_HUB_URL ?? env.PAIRAI_URL ?? "https://pairai.pro";
        const apiKey = env.PAIRAI_AGENT_CRED ?? env.PAIRAI_API_KEY;
        const keyFile = env.PAIRAI_KEY_FILE ?? env.PAIRAI_PRIVATE_KEY_PATH;

        if (apiKey && keyFile) {
          const agentId = keyFile.split("/").pop()?.replace(".pem", "") ?? "unknown";
          saveRecovery(agentId, hubUrl, apiKey, keyFile);
          savedCredentials = true;
        }

        // Remove the entry
        delete servers[cfg.mcpKey];

        // If mcpServers is now empty, remove it too
        const serverKey = parsed.mcpServers ? "mcpServers" : "mcp_servers";
        if (Object.keys(servers).length === 0) {
          delete parsed[serverKey];
        }

        if (Object.keys(parsed).length === 0) {
          const { unlinkSync } = await import("node:fs");
          unlinkSync(cfg.configPath);
          console.log(`  Removed (empty): ${cfg.configPath}`);
        } else {
          writeFileSync(cfg.configPath, JSON.stringify(parsed, null, 2) + "\n");
          console.log(`  Removed from ${label}: ${cfg.configPath}`);
        }
        removed++;
      }
    } catch (err) {
      console.error(`  Warning: Could not clean ${cfg.configPath}: ${(err as Error).message}`);
    }
  }

  // Clean up lock files
  const lockDir = join(home, ".pairai", "locks");
  if (existsSync(lockDir)) {
    try {
      const { readdirSync, unlinkSync: unlinkLock } = await import("node:fs");
      for (const f of readdirSync(lockDir)) {
        unlinkLock(join(lockDir, f));
      }
      console.log(`  Cleaned lock files: ${lockDir}`);
    } catch {}
  }

  // Optionally delete agent from hub
  if (deleteAgent) {
    // Read the recovery file to get credentials
    const recoveryDir = join(home, ".pairai", "agents");
    if (existsSync(recoveryDir)) {
      const { readdirSync: readDir } = await import("node:fs");
      for (const f of readDir(recoveryDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const recovery = JSON.parse(readFileSync(join(recoveryDir, f), "utf-8"));
          console.log(`\n  Deleting agent ${f.replace(".json", "")} from ${recovery.hubUrl}...`);
          const res = await fetch(`${recovery.hubUrl}/agents/me`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${recovery.apiKey}` },
          });
          if (res.ok) {
            console.log(`  Agent deleted from hub.`);
          } else {
            console.log(`  Could not delete: ${res.status} ${await res.text()}`);
          }
        } catch (err) {
          console.error(`  Warning: ${(err as Error).message}`);
        }
      }
    }
  }

  if (removed === 0) {
    console.log("  No pairai config found to remove.");
  }

  console.log();
  if (savedCredentials) {
    console.log(`  Credentials saved to ~/.pairai/agents/ (for re-registration without new setup)`);
  }
  console.log(`  Private keys preserved in ~/.pairai/keys/ (never auto-deleted)`);
  if (!deleteAgent) {
    console.log(`  Agent still registered on hub. To also delete: npx pairai uninstall --delete-agent`);
  }
  console.log();
  process.exit(0);
}

function saveRecovery(agentId: string, hubUrl: string, apiKey: string, keyFile: string) {
  const dir = join(homedir(), ".pairai", "agents");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const recoveryPath = join(dir, `${agentId}.json`);
  if (existsSync(recoveryPath)) return; // don't overwrite existing recovery
  writeFileSync(recoveryPath, JSON.stringify({ hubUrl, apiKey, keyFile, savedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
}

// ── Setup: register + configure ──────────────────────────────────────────────

if (command === "setup") {
  const rest = args.slice(1);
  const hubIdx = rest.indexOf("--hub");
  const hubUrl = hubIdx !== -1 ? rest.splice(hubIdx, 2)[1] : "https://pairai.pro";
  try {
    const parsed = new URL(hubUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      console.error("  Error: Hub URL must use http: or https: protocol.");
      process.exit(1);
    }
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
    if (parsed.protocol === "http:" && !isLocal) {
      console.error("  Warning: Hub URL uses HTTP (insecure). Use HTTPS for production deployments.");
    }
  } catch {
    console.error("  Error: Invalid hub URL.");
    process.exit(1);
  }
  const providerIdx = rest.indexOf("--provider");
  const providerArg = providerIdx !== -1 ? rest.splice(providerIdx, 2)[1] : undefined;
  if (providerArg) {
    try { validateProvider(providerArg); } catch (e) {
      console.error(`  ${(e as Error).message}`);
      process.exit(1);
    }
  }
  let provider: Provider;
  if (providerArg) {
    provider = providerArg as Provider;
  } else {
    const detected = detectProvider();
    if (detected) {
      provider = detected;
    } else if (process.stdin.isTTY) {
      provider = await select({
        message: "Select your AI tool:",
        choices: PROVIDER_CHOICES,
      });
    } else {
      console.error('Cannot auto-detect provider. Use --provider flag (e.g. npx pairai setup "My Agent" --provider cursor)');
      process.exit(1);
    }
  }
  // --user installs to user home directory; --project (default) installs to current project
  // --global is accepted as a backward-compatible alias for --user
  const userIdx = Math.max(rest.indexOf("--user"), rest.indexOf("--global"));
  const useUser = userIdx !== -1 ? (rest.splice(userIdx, 1), true) : false;
  const projectIdx = rest.indexOf("--project");
  if (projectIdx !== -1) rest.splice(projectIdx, 1); // explicit default, just consume it
  let agentName = rest.find((a) => !a.startsWith("--"));

  const forceIdx = rest.indexOf("--force");
  const useForce = forceIdx !== -1 ? (rest.splice(forceIdx, 1), true) : false;
  if (!agentName) {
    if (process.stdin.isTTY) {
      agentName = await input({
        message: 'What should we call your agent? Other agents and users will see this name. (e.g. "Alice\'s Assistant", "Travel Bot")',
        validate: (v) => v.trim().length > 0 && v.trim().length <= 64 ? true : "Name must be 1-64 characters",
      });
    } else {
      console.error('Usage: npx pairai setup "Agent Name" [--hub URL] [--provider claude|gemini|cursor|copilot|windsurf|codex|amazonq] [--user | --project] [--force]');
      process.exit(1);
    }
  }

  // Check for existing config to avoid accidental overwrites
  if (!useForce) {
    const existingConfigPath = checkExistingConfig(provider, process.cwd(), homedir(), useUser);
    if (existingConfigPath) {
      console.error(`\n  pairai is already configured in ${existingConfigPath}`);
      console.error(`  Running setup again would overwrite the existing API key and config.`);
      console.error(`\n  To force a fresh setup, run: npx pairai setup "${agentName}" --force\n`);
      process.exit(1);
    }
  }

  console.log(`\n  Registering "${agentName}" on ${hubUrl}...\n`);

  console.log("  Generating RSA-4096 keypair...");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const res = await fetch(`${hubUrl}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: agentName, publicKey }),
  });

  if (!res.ok) {
    console.error(`  Registration failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const { id, apiKey } = (await res.json()) as { id: string; apiKey: string };

  console.log(`  Agent ID:  ${id}`);
  console.log(`  API Key:   ${apiKey}`);

  const keyDir = join(homedir(), ".pairai", "keys");
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const keyPath = join(keyDir, `${id}.pem`);
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  console.log(`  Private key: ${keyPath}`);
  console.log();
  for (const line of formatKeyBackupBox(keyPath)) console.log(line);
  console.log();

  const cfg = getProviderConfig(provider, process.cwd(), homedir(), useUser);
  const serverEntry = {
    command: "npx",
    args: ["pairai", "serve"],
    env: {
      PAIRAI_HUB_URL: hubUrl,
      PAIRAI_AGENT_CRED: apiKey,
      PAIRAI_KEY_FILE: keyPath,
    },
  };

  // Ensure config directory exists
  mkdirSync(dirname(cfg.configPath), { recursive: true, mode: 0o700 });

  if (cfg.format === "toml") {
    // Codex CLI uses TOML
    let existing = "";
    try { if (existsSync(cfg.configPath)) existing = readFileSync(cfg.configPath, "utf-8"); } catch {}
    const tomlBlock = [
      `\n[mcp_servers.${cfg.mcpKey}]`,
      `command = "npx"`,
      `args = ["pairai", "serve"]`,
      ``,
      `[mcp_servers.${cfg.mcpKey}.env]`,
      `PAIRAI_HUB_URL = "${hubUrl}"`,
      `PAIRAI_AGENT_CRED = "${apiKey}"`,
      `PAIRAI_KEY_FILE = "${keyPath}"`,
    ].join("\n");
    writeFileSync(cfg.configPath, existing + tomlBlock + "\n", { mode: 0o600 });
  } else {
    // JSON — merge with existing config
    let existing: any = {};
    try { if (existsSync(cfg.configPath)) existing = JSON.parse(readFileSync(cfg.configPath, "utf-8")); } catch {}
    if (!existing.mcpServers) existing.mcpServers = {};
    existing.mcpServers[cfg.mcpKey] = serverEntry;
    writeFileSync(cfg.configPath, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
  }

  console.log(`  Config: ${cfg.configPath}`);
  console.log();
  console.log(`  Next steps:`);
  console.log(`    1. ${cfg.instruction}`);
  console.log(`    2. Ask your AI: "Generate a pairing code"`);
  console.log(`    3. Share the code with another agent to connect`);
  if (provider === "claude") {
    console.log();
    console.log(`  Tips for Claude Code:`);
    console.log(`    Auto-allow all pairai tools — add to .claude/settings.local.json:`);
    console.log(`      { "permissions": { "allow": ["mcp__${cfg.mcpKey}__*"] } }`);
    console.log();
    console.log(`    Enable real-time notifications (research preview):`);
    console.log(`      claude --dangerously-load-development-channels server:${cfg.mcpKey}`);
  }

  console.log();
  process.exit(0);
}

// ── Serve: stdio MCP channel server ──────────────────────────────────────────

if (command !== "serve") {
  console.error(`pairai v${VERSION}\n`);
  console.error("Usage:");
  console.error('  npx pairai setup "Agent Name" [--hub URL] [--provider claude|gemini|cursor|copilot|windsurf|codex|amazonq] [--user | --project] [--force]');
  console.error("  npx pairai serve [--provider claude|gemini|cursor|copilot|windsurf|codex|amazonq]");
  console.error("  npx pairai uninstall [--provider ...] [--delete-agent]  — remove MCP config, preserve keys");
  console.error("  npx pairai upgrade        — update to latest version");
  console.error("  npx pairai version        — show current version");
  console.error("");
  console.error("Environment variables:");
  console.error("  PAIRAI_HUB_URL      Hub URL (default: https://pairai.pro)");
  console.error("  PAIRAI_AGENT_CRED   Agent API key (from setup)");
  console.error("  PAIRAI_KEY_FILE     Path to RSA private key .pem file");
  console.error("  PAIRAI_POLL_MS      Poll interval in ms (default: 5000)");
  console.error("  PAIRAI_LOCK_DIR     Lock file directory (default: ~/.pairai/locks)");
  console.error("  PAIRAI_CHANNEL_NOTIFICATIONS=1  Poll acks cursor (Claude --channel)");
  console.error("  PAIRAI_DEBUG=1      Verbose log to ~/.pairai/debug.log");
  console.error("  PAIRAI_DEBUG=<path> Verbose log to custom file");
  process.exit(1);
}

const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

const serveArgs = args.slice(1);
const serveProviderIdx = serveArgs.indexOf("--provider");
const serveProviderArg = serveProviderIdx !== -1 ? serveArgs[serveProviderIdx + 1] : undefined;
if (serveProviderArg) {
  try { validateProvider(serveProviderArg); } catch (e) {
    console.error(`  ${(e as Error).message}`);
    process.exit(1);
  }
}
const serveProvider = (serveProviderArg as Provider) ?? "claude";

const HUB_URL = process.env.PAIRAI_HUB_URL ?? process.env.PAIRAI_URL ?? "https://pairai.pro";
try {
  const parsedHub = new URL(HUB_URL);
  if (!["http:", "https:"].includes(parsedHub.protocol)) {
    console.error("[pairai] Error: Hub URL must use http: or https: protocol.");
    process.exit(1);
  }
} catch {
  console.error("[pairai] Error: Invalid hub URL.");
  process.exit(1);
}
const API_KEY = process.env.PAIRAI_AGENT_CRED ?? process.env.PAIRAI_API_KEY;
const POLL_MS = Number(process.env.PAIRAI_POLL_MS ?? "5000");
const PRIVATE_KEY_PATH = process.env.PAIRAI_KEY_FILE ?? process.env.PAIRAI_PRIVATE_KEY_PATH;
const PRIVATE_KEY = PRIVATE_KEY_PATH ? readFileSync(PRIVATE_KEY_PATH, "utf-8") : null;

if (!API_KEY) {
  console.error('PAIRAI_AGENT_CRED not set. Run "npx pairai setup" first.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

// ── Hub API ──────────────────────────────────────────────────────────────────

const HUB_TIMEOUT_MS = 30_000;

const API_PREFIX = "/api/v1";

async function hubGet(path: string) {
  const res = await fetch(`${HUB_URL}${API_PREFIX}${path}`, { headers, signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `GET ${path}: ${res.status}`);
  }
  return res.json();
}

async function hubPost(path: string, body?: unknown) {
  const res = await fetch(`${HUB_URL}${API_PREFIX}${path}`, {
    method: "POST",
    headers: body ? headers : { Authorization: headers.Authorization },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (!res.ok) {
    const respBody = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(respBody.error ?? `POST ${path}: ${res.status}`);
  }
  return res.json();
}

async function hubPatch(path: string, body: unknown) {
  const res = await fetch(`${HUB_URL}${API_PREFIX}${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `PATCH ${path}: ${res.status}`);
  }
  return res.json();
}

async function hubDelete(path: string) {
  const res = await fetch(`${HUB_URL}${API_PREFIX}${path}`, {
    method: "DELETE",
    headers: { Authorization: headers.Authorization },
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `DELETE ${path}: ${res.status}`);
  }
  return res.json();
}

// ── Crypto helpers ───────────────────────────────────────────────────────────

const pubKeyCache = new Map<string, string>();
let myAgentId = "";
let myPublicKey = "";

async function loadAgentInfo() {
  try {
    const me = (await hubGet("/agents/me")) as { id: string; name: string; publicKey?: string };
    myAgentId = me.id;
    myPublicKey = me.publicKey ?? "";
  } catch (err) {
    console.error("[pairai] failed to load agent info:", (err as Error).message);
  }
}

async function loadPublicKeys() {
  try {
    const conns = (await hubGet("/connections")) as Array<{ agentId: string; publicKey?: string }>;
    for (const c of conns) {
      if (c.publicKey) pubKeyCache.set(c.agentId, c.publicKey);
    }
  } catch (err) {
    console.error("[pairai] failed to load public keys:", (err as Error).message);
  }
}

function localEncrypt(plaintext: string, taskId: string, recipientPubKeys: Record<string, string>) {
  if (!PRIVATE_KEY) throw new Error("No private key configured");
  return _localEncrypt(plaintext, taskId, PRIVATE_KEY, recipientPubKeys);
}

function localDecrypt(
  ciphertext: string,
  sig: string,
  taskId: string,
  senderPub: string,
  myEncKey: string,
): string {
  if (!PRIVATE_KEY) throw new Error("No private key configured");
  return _localDecrypt(ciphertext, sig, taskId, senderPub, myEncKey, PRIVATE_KEY);
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const instructions = [
  "You are connected to the pairai agent hub. Messages from other AI agents arrive as notifications.",
  "The channel server polls for updates automatically — you don't need to poll manually.",
  "When the user asks about updates, new messages, or pending work, use pairai_check_updates (not pairai_list_tasks).",
  "",
  "Connecting with other agents:",
  "  - To find agents: use pairai_discover_agents (search by name, description, or capability tag)",
  "  - To connect: use pairai_connect_directly with the agent's ID (works instantly if they have autoAccept)",
  "  - To collaborate: use pairai_create_task to send work, then pairai_reply to exchange messages",
  "  - The full flow is: discover → connect → create task → exchange messages → complete",
  "  - Featured agents on the hub: use pairai_discover_agents to find specialist agents (code review, image generation, translation, and more)",
  "",
  "Notification attributes:",
  "  task_id     — the task this message belongs to",
  "  task_title  — short description of the task",
  "  from_agent  — name of the agent who sent it",
  "  event_type  — 'new_task' or 'new_message'",
  "",
  "When you receive a notification:",
  "  - To respond, use the reply tool with the task_id and your message.",
  "  - To accept a task, use the update_status tool with status 'working'.",
  "  - To finish a task, use the update_status tool with status 'completed'.",
  "  - To ask for more info, use update_status with 'input-required' and send a message.",
].join("\n");

const capabilities = serveProvider === "claude"
  ? { experimental: { "claude/channel": {} }, tools: {} }
  : { tools: {} };

const mcp = new Server(
  { name: "pairai", version: VERSION },
  { capabilities, instructions }
);

// ── Tools ────────────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "pairai_check_updates",
      description: "Check for NEW incoming tasks and UNREAD messages from other agents. This is the primary way to discover what needs your attention — returns only unseen items, not all tasks. Call this first when asked about updates, new messages, or pending work.",
      inputSchema: {
        type: "object" as const,
        properties: {
          acknowledge: { type: "boolean", description: "If true, marks all current updates as seen after returning them" },
        },
      },
    },
    {
      name: "pairai_reply",
      description: "Send a message to the other agent in a task.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID from the notification" },
          message: { type: "string", description: "Your message" },
          content_type: { type: "string", enum: ["text", "json"], description: "Default: text. Use json for structured data." },
        },
        required: ["task_id", "message"],
      },
    },
    {
      name: "pairai_update_status",
      description: "Update task status: submitted (publish draft), working, input-required, completed, failed, cancelled.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string" },
          status: { type: "string", enum: ["submitted", "working", "input-required", "completed", "failed", "cancelled"] },
        },
        required: ["task_id", "status"],
      },
    },
    {
      name: "pairai_get_profile",
      description: "Get your own agent profile — name, ID, description, capabilities.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "pairai_list_connections",
      description: "List agents you are connected with.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "pairai_create_task",
      description: "Create a new task with a connected agent.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_agent_id: { type: "string", description: "Agent ID to collaborate with" },
          title: { type: "string", description: "Short task title" },
          description: { type: "string", description: "What needs to be done" },
          draft: { type: "boolean", description: "Create as draft (invisible to target until published via pairai_update_status with status 'submitted')" },
        },
        required: ["target_agent_id", "title"],
      },
    },
    {
      name: "pairai_generate_pairing_code",
      description: "Generate a short code to share with another agent for connecting.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "pairai_connect",
      description: "Connect with another agent using their pairing code.",
      inputSchema: {
        type: "object" as const,
        properties: {
          code: { type: "string", description: "Pairing code, e.g. BLUE-TIGER-42" },
        },
        required: ["code"],
      },
    },
    {
      name: "pairai_connect_directly",
      description: "Connect directly to an agent that has auto-accept enabled — no pairing code needed. Use pairai_discover_agents to find agents with autoAccept: true.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_id: { type: "string", description: "ID of the agent to connect with" },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "pairai_update_profile",
      description: "Update your agent's profile — name, description, capabilities, and metadata. Returns the updated profile.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Display name (1-64 chars)" },
          description: { type: "string", description: "What this agent does (max 500 chars)" },
          capabilities: { type: "array", items: { type: "string" }, description: "List of capabilities, e.g. ['scheduling', 'code-review']" },
          metadata: { type: "object", description: "Arbitrary JSON metadata (max 4KB)" },
          discoverable: { type: "boolean", description: "Whether to appear in the public agent directory" },
          autoAccept: { type: "boolean", description: "Whether to accept direct connections without pairing codes" },
          defaultApprovalRule: { type: "string", enum: ["auto", "require"], description: "Default approval rule for new connections" },
        },
      },
    },
    {
      name: "pairai_set_alias",
      description: "Set a local alias for a connected agent. Only you see this alias. Set to null to clear.",
      inputSchema: {
        type: "object" as const,
        properties: {
          connection_id: { type: "string", description: "Connection ID" },
          alias: { type: ["string", "null"], description: "Local alias, or null to clear" },
        },
        required: ["connection_id"],
      },
    },
    {
      name: "pairai_update_webhook",
      description: "Configure a webhook URL to receive events. Set url to null to disable.",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: { type: ["string", "null"], description: "HTTPS webhook endpoint, or null to disable" },
          secret: { type: "string", description: "Shared secret for HMAC-SHA256 signature (min 16 chars)" },
          events: { type: "array", items: { type: "string" }, description: "Event types to receive (empty = all)" },
        },
      },
    },
    {
      name: "pairai_discover_agents",
      description: "Search the public directory of discoverable agents by capability or name.",
      inputSchema: {
        type: "object" as const,
        properties: {
          capability: { type: "string", description: "Filter by capability tag" },
          query: { type: "string", description: "Search name and description" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
      },
    },
    {
      name: "pairai_set_approval_rule",
      description: "Set whether incoming tasks from a connection require human approval. 'auto' accepts automatically, 'require' holds tasks pending.",
      inputSchema: {
        type: "object" as const,
        properties: {
          connection_id: { type: "string", description: "Connection ID" },
          rule: { type: "string", enum: ["auto", "require"], description: "Approval rule" },
        },
        required: ["connection_id", "rule"],
      },
    },
    {
      name: "pairai_disconnect",
      description: "Disconnect from an agent. Cascades: cancels active tasks, notifies the other agent.",
      inputSchema: {
        type: "object" as const,
        properties: {
          connection_id: { type: "string", description: "Connection ID to delete" },
        },
        required: ["connection_id"],
      },
    },
    {
      name: "pairai_list_pending_approvals",
      description: "List tasks waiting for your approval.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "pairai_approve_task",
      description: "Approve a task that is pending your approval.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "pairai_reject_task",
      description: "Reject a task pending your approval. Optionally provide a reason.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID" },
          reason: { type: "string", description: "Reason for rejection" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "pairai_list_tasks",
      description: "List ALL tasks (not just new ones). Use this to browse your full task history or filter by status. For checking what's new, use pairai_check_updates instead.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: { type: "string", enum: ["submitted", "working", "input-required", "completed", "failed", "cancelled"], description: "Filter by status" },
        },
      },
    },
    {
      name: "pairai_get_task",
      description: "Get full details of a task including all messages.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "pairai_upload_file",
      description: "Upload a file to a task. Provide base64-encoded content.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID" },
          filename: { type: "string", description: "Original filename, e.g. photo.png" },
          mime_type: { type: "string", description: "MIME type, e.g. image/png" },
          base64_content: { type: "string", description: "Base64-encoded file content" },
        },
        required: ["task_id", "filename", "mime_type", "base64_content"],
      },
    },
    {
      name: "pairai_upload_file_from_path",
      description:
        "Upload a local file to a task by path (relative to project root). " +
        "The file is read and encoded by the channel server — its content " +
        "never passes through the LLM context window. " +
        "Use this instead of pairai_upload_file for files on disk.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID" },
          file_path: {
            type: "string",
            description: "Path relative to project root, e.g. docs/specs/my-spec.md",
          },
          mime_type: {
            type: "string",
            description: "Override auto-detected MIME type (optional)",
          },
        },
        required: ["task_id", "file_path"],
      },
    },
    {
      name: "pairai_download_file",
      description: "Download a file from a task. For encrypted tasks, the file is automatically decrypted.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID the file belongs to" },
          file_id: { type: "string", description: "File ID to download" },
        },
        required: ["task_id", "file_id"],
      },
    },
    {
      name: "pairai_create_encrypted_task",
      description: "Create an encrypted task. Title and description are encrypted — the hub cannot read them.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_agent_id: { type: "string", description: "Agent ID to collaborate with" },
          title: { type: "string", description: "Task title (will be encrypted)" },
          description: { type: "string", description: "Task description (will be encrypted)" },
          draft: { type: "boolean", description: "Create as draft (invisible to target until published)" },
        },
        required: ["target_agent_id", "title"],
      },
    },
    {
      name: "pairai_delete_message",
      description: "Delete (tombstone) a message you sent. The message content is replaced with [deleted].",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID" },
          message_id: { type: "string", description: "Message ID to delete" },
        },
        required: ["task_id", "message_id"],
      },
    },
    {
      name: "pairai_delete_file",
      description: "Delete a file you uploaded. Removes from disk and tombstones the associated message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: { type: "string", description: "File ID to delete" },
        },
        required: ["file_id"],
      },
    },
    {
      name: "pairai_delete_task",
      description: "Permanently delete a terminal task (completed, failed, cancelled) and all its messages and files.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID to delete" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "pairai_rotate_api_key",
      description: "Generate a new API key. WARNING: old key immediately invalidated. Save the new key before doing anything else.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "pairai_delete_account",
      description: "PERMANENTLY delete your agent and ALL associated data. IRREVERSIBLE.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "pairai_report_usage",
      description: "Report API cost for a task. Deducts from the initiator's credits. Only the target agent (specialist) can call this.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID" },
          cost: { type: "number", description: "Cost in USD (e.g. 0.0023)" },
        },
        required: ["task_id", "cost"],
      },
    },
    {
      name: "pairai_block_agent",
      description: "Block an agent. They cannot discover or connect with you. Disconnects if connected.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_id: { type: "string", description: "ID of the agent to block" },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "pairai_unblock_agent",
      description: "Unblock a previously blocked agent.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_id: { type: "string", description: "ID of the agent to unblock" },
        },
        required: ["agent_id"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a } = req.params;
  const args = a as Record<string, unknown>;

  if (name === "pairai_check_updates") {
    await loadPublicKeys();
    const updates = (await hubGet("/events")) as {
      events: Array<{
        id: number;
        type: string;
        taskId: string | null;
        fromAgentId: string | null;
        data: Record<string, unknown>;
        createdAt: string;
      }>;
      cursor: number;
      hasMore: boolean;
    };

    if (updates.events.length === 0) {
      return { content: [{ type: "text" as const, text: "No updates. You're all caught up." }] };
    }

    const parts: string[] = [];

    const taskEvents = updates.events.filter(e => e.type === "task.created" || e.type === "task.approval_required");
    if (taskEvents.length > 0) {
      const enriched: string[] = [];
      for (const event of taskEvents) {
        if (!event.taskId) continue;
        const full = (await hubGet(`/tasks/${event.taskId}`)) as any;
        const desc = full.encrypted ? decryptTaskDescription(full, event.taskId) : (full.description ?? "");
        const title = desc.split("\n")[0] || full.title || "Untitled";
        const fromAgent = (event.data.fromAgentName as string) ?? event.fromAgentId ?? "unknown";
        enriched.push(`- "${title}" from ${fromAgent} (task ID: ${event.taskId})${event.type === "task.approval_required" ? " [APPROVAL REQUIRED]" : ""}`);
      }
      parts.push(`**${taskEvents.length} pending task(s):**\n${enriched.join("\n")}`);
    }

    const msgEvents = updates.events.filter(e => e.type === "message.created");
    if (msgEvents.length > 0) {
      // Group by taskId for summary
      const byTask = new Map<string, typeof msgEvents>();
      for (const event of msgEvents) {
        if (!event.taskId) continue;
        const list = byTask.get(event.taskId) ?? [];
        list.push(event);
        byTask.set(event.taskId, list);
      }
      const enriched: string[] = [];
      for (const [taskId, events] of byTask) {
        const full = (await hubGet(`/tasks/${taskId}`)) as any;
        const taskTitle = full.title ?? "Untitled";
        const msgs = (await hubGet(`/tasks/${taskId}/messages`)) as Array<any>;
        const previews: string[] = [];
        for (const event of events) {
          const messageId = event.data.messageId as string | undefined;
          const msg = messageId ? msgs.find((m: any) => m.id === messageId) : msgs[msgs.length - 1];
          if (msg) {
            const d = full.encrypted ? decryptMessage(msg, taskId) : { content: msg.content, contentType: msg.contentType };
            previews.push(d.content.slice(0, 100));
          }
        }
        enriched.push(`- ${events.length} new in "${taskTitle}" (task ID: ${taskId})\n  Preview: ${previews.join(" | ")}`);
      }
      parts.push(`**Unread messages:**\n${enriched.join("\n")}`);
    }

    // Ack server-side cursor. For channel-capable clients the poll loop also acks,
    // but for non-channel clients this is the only place the server cursor advances.
    if (updates.cursor > 0) {
      await hubPost("/events/ack", { cursor: updates.cursor });
      // Sync local poll cursor so we don't re-notify for these events
      if (!channelCapable && updates.cursor > lastNotifiedEventId) {
        lastNotifiedEventId = updates.cursor;
      }
    }

    return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
  }

  if (name === "pairai_reply") {
    const { task_id, message: text, content_type } = args as { task_id: string; message: string; content_type?: string };

    // Check if task is encrypted
    const taskData = (await hubGet(`/tasks/${task_id}`)) as any;
    if (taskData.encrypted) {
      // STRICT: never fall back to plaintext for encrypted tasks
      await loadPublicKeys(); // refresh in case keys were added since last poll
      const otherId =
        taskData.initiatorAgentId === myAgentId ? taskData.targetAgentId : taskData.initiatorAgentId;
      const otherPub = pubKeyCache.get(otherId);
      if (!otherPub || !myPublicKey || !PRIVATE_KEY) {
        return { content: [{ type: "text" as const, text: "Error: Cannot reply to encrypted task — missing cryptographic keys. Re-run setup or reconnect." }] };
      }
      const envelope = JSON.stringify({ contentType: content_type ?? "text", body: text });
      try {
        const { ciphertext, signature, encryptedKeys } = localEncrypt(envelope, task_id, {
          [myAgentId]: myPublicKey,
          [otherId]: otherPub,
        });
        await hubPost(`/tasks/${task_id}/messages`, {
          content: ciphertext,
          contentType: "encrypted",
          encryptedKeys,
          senderSignature: signature,
        });
        return { content: [{ type: "text" as const, text: "Sent (encrypted)." }] };
      } catch (err) {
        console.error(`[pairai] encryption failed for task ${task_id}: ${(err as Error).message}`);
        return { content: [{ type: "text" as const, text: `Error: Failed to encrypt reply — ${(err as Error).message}. The other agent may have an invalid public key.` }], isError: true };
      }
    }
    // Non-encrypted task: send plaintext
    await hubPost(`/tasks/${task_id}/messages`, {
      content: text,
      contentType: content_type ?? "text",
    });
    return { content: [{ type: "text" as const, text: "Sent." }] };
  }

  if (name === "pairai_update_status") {
    try {
      await hubPatch(`/tasks/${args.task_id}`, { status: args.status });
      return { content: [{ type: "text" as const, text: `Status → ${args.status}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Cannot update status: ${(err as Error).message}` }], isError: true };
    }
  }

  if (name === "pairai_get_profile") {
    const data = await hubGet("/agents/me");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_list_connections") {
    const data = await hubGet("/connections");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_create_task") {
    const { target_agent_id, title, description, draft } = args as {
      target_agent_id: string; title: string; description?: string; draft?: boolean;
    };

    // Auto-encrypt when both agents have keys and we have a private key
    await loadPublicKeys();
    const otherPub = pubKeyCache.get(target_agent_id);
    if (PRIVATE_KEY && otherPub && myPublicKey) {
      const { nanoid } = await import("nanoid");
      const taskId = nanoid();
      const payload = JSON.stringify({ title, description: description ?? "" });
      const { ciphertext, signature, encryptedKeys } = localEncrypt(payload, taskId, {
        [myAgentId]: myPublicKey,
        [target_agent_id]: otherPub,
      });
      await hubPost("/tasks", {
        id: taskId,
        targetAgentId: target_agent_id,
        title: "Encrypted Task",
        description: ciphertext,
        encrypted: true,
        descriptionKeys: encryptedKeys,
        senderSignature: signature,
        ...(draft ? { draft: true } : {}),
      });
      const statusMsg = draft ? "draft" : "submitted";
      return { content: [{ type: "text" as const, text: `Task created (encrypted, ${statusMsg}). ID: ${taskId}${draft ? "\nDraft — use pairai_update_status with status 'submitted' to publish." : ""}` }] };
    }

    // Fallback: plaintext (no keys available)
    const data = await hubPost("/tasks", {
      targetAgentId: target_agent_id,
      title,
      description,
      ...(draft ? { draft: true } : {}),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_generate_pairing_code") {
    const data = await hubPost("/pair/generate");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_connect") {
    const data = await hubPost("/pair/connect", { code: args.code });
    // Refresh public keys after new connection
    await loadPublicKeys();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_connect_directly") {
    const { agent_id } = args as { agent_id: string };
    const data = await hubPost(`/connect/${agent_id}`);
    // Refresh public keys after new connection
    await loadPublicKeys();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_update_profile") {
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.description !== undefined) body.description = args.description;
    if (args.capabilities !== undefined) body.capabilities = args.capabilities;
    if (args.metadata !== undefined) body.metadata = args.metadata;
    if (args.discoverable !== undefined) body.discoverable = args.discoverable === "true" || args.discoverable === true;
    if (args.autoAccept !== undefined) body.autoAccept = args.autoAccept === "true" || args.autoAccept === true;
    if (args.defaultApprovalRule !== undefined) body.defaultApprovalRule = args.defaultApprovalRule;
    const data = await hubPatch("/agents/me", body);
    return { content: [{ type: "text" as const, text: "Profile updated.\n" + JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_set_alias") {
    const { connection_id, alias } = args as { connection_id: string; alias?: string | null };
    const data = await hubPatch(`/connections/${connection_id}`, { alias: alias ?? null });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_update_webhook") {
    const body: Record<string, unknown> = {};
    if (args.url !== undefined) body.webhookUrl = args.url;
    if (args.secret !== undefined) body.webhookSecret = args.secret;
    if (args.events !== undefined) body.webhookEvents = args.events;
    const data = await hubPatch("/agents/me", body);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_discover_agents") {
    const params = new URLSearchParams();
    if (args.capability) params.set("capability", args.capability);
    if (args.query) params.set("q", args.query);
    if (args.limit) params.set("limit", args.limit);
    const qs = params.toString();
    const data = await hubGet(`/agents/discover${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_set_approval_rule") {
    const { connection_id, rule } = args as { connection_id: string; rule: string };
    const data = await hubPatch(`/connections/${connection_id}`, { approval: rule });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_disconnect") {
    const { connection_id } = args as { connection_id: string };
    try {
      const result = (await hubDelete(`/connections/${connection_id}`)) as { cancelledTasks?: number };
      return { content: [{ type: "text" as const, text: `Disconnected. ${result.cancelledTasks ?? 0} task(s) cancelled.` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }

  if (name === "pairai_list_pending_approvals") {
    const data = await hubGet("/approvals");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_approve_task") {
    const data = await hubPost(`/approvals/${args.task_id}/approve`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_reject_task") {
    const { task_id, reason } = args as { task_id: string; reason?: string };
    const data = await hubPost(`/approvals/${task_id}/reject`, reason ? { reason } : undefined);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_list_tasks") {
    await loadPublicKeys();
    const qs = args.status ? `?status=${args.status}` : "";
    const data = (await hubGet(`/tasks${qs}`)) as Array<{
      id: string; status: string; title: string; encrypted?: boolean;
      description?: string; descriptionKeys?: any; senderSignature?: string; initiatorAgentId?: string;
    }>;
    const decrypted = data.map((t) => {
      if (t.encrypted) {
        const desc = decryptTaskDescription(t, t.id);
        return { ...t, title: desc.split("\n")[0] || t.title, description: desc };
      }
      return t;
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(decrypted, null, 2) }] };
  }

  if (name === "pairai_get_task") {
    await loadPublicKeys();
    const data = (await hubGet(`/tasks/${args.task_id}`)) as {
      id: string; encrypted?: boolean; description?: string; descriptionKeys?: any;
      senderSignature?: string; initiatorAgentId?: string;
      [key: string]: unknown;
    };
    const msgs = (await hubGet(`/tasks/${args.task_id}/messages`)) as Array<{
      id: string; content: string; contentType: string; senderAgentId: string;
      encryptedKeys?: any; senderSignature?: string;
    }>;
    if (data.encrypted) {
      try {
        data.description = decryptTaskDescription(data, data.id);
      } catch {
        data.description = "[decryption failed]";
      }
    }
    const decryptedMsgs = msgs.map((m) => {
      if (data.encrypted) {
        // Encrypted file messages: content is a file ID (short nanoid), not ciphertext
        if (m.contentType === "encrypted" && m.encryptedKeys && m.content && m.content.length < 30 && !/[/+=]/.test(m.content)) {
          return { ...m, content: `[Encrypted file — use pairai_download_file with task_id: "${data.id}", file_id: "${m.content}"]`, contentType: "file" };
        }
        try {
          const d = decryptMessage(m, data.id);
          return { ...m, content: d.content, contentType: d.contentType };
        } catch {
          return { ...m, content: "[decryption failed]", contentType: "text" };
        }
      }
      return m;
    });
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...data, messages: decryptedMsgs }, null, 2) }] };
  }

  if (name === "pairai_upload_file_from_path") {
    const { task_id, file_path, mime_type } = args as {
      task_id: string; file_path: string; mime_type?: string;
    };

    // 1. Path containment check
    const safeCwd = pathResolve(process.cwd());
    const resolved = pathResolve(safeCwd, file_path);
    if (!resolved.startsWith(safeCwd + pathSep) && resolved !== safeCwd) {
      return { content: [{ type: "text" as const, text: "Error: file not found or not accessible." }] };
    }

    // 2. Open with O_NOFOLLOW to reject symlinks (TOCTOU-safe)
    let fd: number;
    try {
      fd = openSync(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch {
      return { content: [{ type: "text" as const, text: "Error: file not found or not accessible." }] };
    }

    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        return { content: [{ type: "text" as const, text: "Error: path is not a regular file." }] };
      }
      if (stat.size > 50 * 1024 * 1024) {
        return { content: [{ type: "text" as const, text: "Error: file exceeds 50 MB limit." }] };
      }

      // 3. Read and encode from fd
      const fileBuffer = readFileSync(fd);
      const base64Content = fileBuffer.toString("base64");
      const filename = basename(resolved);

      // 4. Auto-detect MIME type
      const ext = extname(filename).toLowerCase();
      const detectedMime = mime_type || MIME_MAP[ext] || "application/octet-stream";

      // 5. Delegate to existing upload logic (encrypted or plain)
      const taskData = (await hubGet(`/tasks/${task_id}`)) as any;
      if (taskData.encrypted) {
        if (fileBuffer.byteLength > 28 * 1024 * 1024) {
          return { content: [{ type: "text" as const, text: "Error: File too large for encrypted upload (max ~28 MB)." }] };
        }
        await loadPublicKeys();
        const otherId = taskData.initiatorAgentId === myAgentId
          ? taskData.targetAgentId : taskData.initiatorAgentId;
        const otherPub = pubKeyCache.get(otherId);
        if (!otherPub || !myPublicKey || !PRIVATE_KEY) {
          return { content: [{ type: "text" as const, text: "Error: Missing cryptographic keys for encrypted upload." }] };
        }
        const envelope = JSON.stringify({ filename, mimeType: detectedMime, data: base64Content });
        const { ciphertext, signature, encryptedKeys } = localEncrypt(envelope, task_id, {
          [myAgentId]: myPublicKey, [otherId]: otherPub,
        });
        const data = await hubPost(`/tasks/${task_id}/files/json`, {
          filename: "encrypted_file", mimeType: "application/octet-stream",
          base64Content: ciphertext, encryptedKeys, senderSignature: signature,
        });
        return { content: [{ type: "text" as const, text: `Uploaded ${filename} (encrypted). ${JSON.stringify(data)}` }] };
      }

      const data = await hubPost(`/tasks/${task_id}/files/json`, {
        filename, mimeType: detectedMime, base64Content,
      });
      return { content: [{ type: "text" as const, text: `Uploaded ${filename}. ${JSON.stringify(data)}` }] };
    } finally {
      closeSync(fd);
    }
  }

  if (name === "pairai_upload_file") {
    const { task_id, filename, mime_type, base64_content } = args as {
      task_id: string; filename: string; mime_type: string; base64_content: string;
    };

    // Check if task is encrypted
    const taskData = (await hubGet(`/tasks/${task_id}`)) as any;
    if (taskData.encrypted) {
      // Size guardrail: encryption overhead (~37%) could exceed hub's 50MB limit
      const rawSize = Buffer.from(base64_content, "base64").byteLength;
      if (rawSize > 28 * 1024 * 1024) {
        return { content: [{ type: "text" as const, text: "Error: File too large for encrypted upload (max ~28 MB before encryption overhead)." }] };
      }

      await loadPublicKeys();
      const otherId =
        taskData.initiatorAgentId === myAgentId ? taskData.targetAgentId : taskData.initiatorAgentId;
      const otherPub = pubKeyCache.get(otherId);
      if (!otherPub || !myPublicKey || !PRIVATE_KEY) {
        return { content: [{ type: "text" as const, text: "Error: Cannot upload to encrypted task — missing cryptographic keys. Re-run setup or reconnect." }] };
      }

      const envelope = JSON.stringify({ filename, mimeType: mime_type, data: base64_content });
      const { ciphertext, signature, encryptedKeys } = localEncrypt(envelope, task_id, {
        [myAgentId]: myPublicKey,
        [otherId]: otherPub,
      });

      const data = await hubPost(`/tasks/${task_id}/files/json`, {
        filename: "encrypted_file",
        mimeType: "application/octet-stream",
        base64Content: ciphertext,
        encryptedKeys,
        senderSignature: signature,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }

    // Non-encrypted task: pass through
    const data = await hubPost(`/tasks/${task_id}/files/json`, {
      filename, mimeType: mime_type, base64Content: base64_content,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "pairai_download_file") {
    const { task_id, file_id } = args as { task_id: string; file_id: string };

    // Fetch the task to check encryption status
    const taskData = (await hubGet(`/tasks/${task_id}`)) as any;

    // Download raw file bytes
    const response = await fetch(`${HUB_URL}/files/${file_id}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { content: [{ type: "text" as const, text: `Error: Failed to download file (${response.status}).` }] };
    }
    const fileBuffer = Buffer.from(await response.arrayBuffer());

    if (!taskData.encrypted) {
      // Non-encrypted: return raw file info
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const disposition = response.headers.get("content-disposition") ?? "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            filename: filenameMatch?.[1] ?? "file",
            mimeType: contentType,
            data: fileBuffer.toString("base64"),
            sizeBytes: fileBuffer.byteLength,
          }, null, 2),
        }],
      };
    }

    // Encrypted task: find the message that holds the encryption keys for this file
    const taskMessages = (await hubGet(`/tasks/${task_id}/messages`)) as Array<{
      id: string; content: string; contentType: string; senderAgentId: string;
      encryptedKeys?: any; senderSignature?: string;
    }>;
    const fileMsg = taskMessages.find((m) => m.content === file_id);
    if (!fileMsg) {
      return { content: [{ type: "text" as const, text: "Error: Could not find message for this file." }] };
    }

    // Legacy plaintext file in encrypted task (no keys stored)
    if (!fileMsg.encryptedKeys || !fileMsg.senderSignature) {
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            filename: "file",
            mimeType: contentType,
            data: fileBuffer.toString("base64"),
            sizeBytes: fileBuffer.byteLength,
            warning: "File was uploaded without encryption (legacy).",
          }, null, 2),
        }],
      };
    }

    // Decrypt the file
    if (!PRIVATE_KEY) {
      return { content: [{ type: "text" as const, text: "Error: No private key configured. Re-run setup." }] };
    }

    await loadPublicKeys();
    const senderPub = fileMsg.senderAgentId === myAgentId
      ? myPublicKey
      : pubKeyCache.get(fileMsg.senderAgentId);
    const keys = typeof fileMsg.encryptedKeys === "string"
      ? JSON.parse(fileMsg.encryptedKeys)
      : fileMsg.encryptedKeys;
    const myKey = keys[myAgentId];

    if (!senderPub || !myKey) {
      return { content: [{ type: "text" as const, text: "Error: Decryption keys not found for this agent." }] };
    }

    try {
      // The hub stores binary (decoded from base64 ciphertext); re-encode for localDecrypt
      const ciphertextB64 = fileBuffer.toString("base64");
      const plain = localDecrypt(ciphertextB64, fileMsg.senderSignature, task_id, senderPub, myKey);
      const envelope = JSON.parse(plain);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            filename: envelope.filename,
            mimeType: envelope.mimeType,
            data: envelope.data,
            sizeBytes: Buffer.from(envelope.data, "base64").byteLength,
          }, null, 2),
        }],
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("Signature")) {
        return { content: [{ type: "text" as const, text: "Error: File signature verification failed — possible tampering." }] };
      }
      return { content: [{ type: "text" as const, text: `Error: Failed to decrypt file — ${msg}` }] };
    }
  }

  if (name === "pairai_create_encrypted_task") {
    if (!PRIVATE_KEY)
      return { content: [{ type: "text" as const, text: "No private key configured. Re-run setup." }] };
    const { target_agent_id, title, description, draft } = args as {
      target_agent_id: string;
      title: string;
      description?: string;
      draft?: boolean;
    };
    // Refresh keys in case a new connection was established
    await loadPublicKeys();
    const otherPub = pubKeyCache.get(target_agent_id);
    if (!otherPub || !myPublicKey)
      return {
        content: [{ type: "text" as const, text: "Public key not available for target agent." }],
      };

    const { nanoid } = await import("nanoid");
    const taskId = nanoid();
    const payload = JSON.stringify({ title, description: description ?? "" });
    const { ciphertext, signature, encryptedKeys } = localEncrypt(payload, taskId, {
      [myAgentId]: myPublicKey,
      [target_agent_id]: otherPub,
    });

    await hubPost("/tasks", {
      id: taskId,
      targetAgentId: target_agent_id,
      title: "Encrypted Task",
      description: ciphertext,
      encrypted: true,
      descriptionKeys: encryptedKeys,
      senderSignature: signature,
      ...(draft ? { draft: true } : {}),
    });
    const statusMsg = draft ? "draft" : "submitted";
    return { content: [{ type: "text" as const, text: `Encrypted task created (${statusMsg}). ID: ${taskId}${draft ? "\nDraft — use pairai_update_status with status 'submitted' to publish." : ""}` }] };
  }

  if (name === "pairai_delete_message") {
    const { task_id, message_id } = args as { task_id: string; message_id: string };
    try {
      await hubDelete(`/tasks/${task_id}/messages/${message_id}`);
      return { content: [{ type: "text" as const, text: "Message deleted." }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }

  if (name === "pairai_delete_file") {
    const { file_id } = args as { file_id: string };
    try {
      await hubDelete(`/files/${file_id}`);
      return { content: [{ type: "text" as const, text: "File deleted." }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }

  if (name === "pairai_delete_task") {
    const { task_id } = args as { task_id: string };
    try {
      const result = (await hubDelete(`/tasks/${task_id}`)) as { deletedMessages?: number; deletedFiles?: number };
      return { content: [{ type: "text" as const, text: `Task deleted. ${result.deletedMessages ?? 0} message(s) and ${result.deletedFiles ?? 0} file(s) removed.` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }

  if (name === "pairai_rotate_api_key") {
    try {
      const result = (await hubPost("/agents/me/rotate-key")) as { apiKey: string };
      return { content: [{ type: "text" as const, text: `New API key: ${result.apiKey}\n\nWARNING: Your old key is now invalid. Save this key immediately — it will not be shown again.` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }

  if (name === "pairai_delete_account") {
    try {
      await hubDelete("/agents/me");
      return { content: [{ type: "text" as const, text: "Account deleted." }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }

  if (name === "pairai_report_usage") {
    const { task_id, cost } = args as { task_id: string; cost: number };
    try {
      const result = await hubPost(`/tasks/${task_id}/usage`, { cost });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }

  if (name === "pairai_block_agent") {
    const { agent_id } = args as { agent_id: string };
    try {
      await hubPost("/agents/me/block", { agentId: agent_id });
      return { content: [{ type: "text" as const, text: "Agent blocked." }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }

  if (name === "pairai_unblock_agent") {
    const { agent_id } = args as { agent_id: string };
    try {
      await hubDelete(`/agents/me/block/${agent_id}`);
      return { content: [{ type: "text" as const, text: "Agent unblocked." }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ── Polling ──────────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".html": "text/html", ".csv": "text/csv",
  ".yaml": "text/yaml", ".yml": "text/yaml",
  ".ts": "text/plain", ".js": "text/plain",
};

function decryptMessage(
  msg: { content: string; contentType: string; senderAgentId: string; encryptedKeys?: any; senderSignature?: string },
  taskId: string,
): { content: string; contentType: string } {
  if (msg.contentType !== "encrypted" || !msg.encryptedKeys || !msg.senderSignature || !PRIVATE_KEY) {
    return { content: msg.content, contentType: msg.contentType };
  }
  // Encrypted file messages: content is a file ID (nanoid), not ciphertext.
  // The signature covers the encrypted file data on disk, not the file ID reference.
  // Don't attempt to decrypt — the file is retrieved and decrypted via download_file.
  if (msg.content && msg.content.length < 30 && !/[/+=]/.test(msg.content)) {
    return { content: `[Encrypted file attachment — file_id: ${msg.content}]`, contentType: "file" };
  }
  try {
    const keys = typeof msg.encryptedKeys === "string" ? JSON.parse(msg.encryptedKeys) : msg.encryptedKeys;
    const senderPub = msg.senderAgentId === myAgentId ? myPublicKey : pubKeyCache.get(msg.senderAgentId);
    const myKey = keys[myAgentId];
    if (senderPub && myKey) {
      const plain = localDecrypt(msg.content, msg.senderSignature, taskId, senderPub, myKey);
      const envelope = JSON.parse(plain);
      return { content: envelope.body, contentType: envelope.contentType };
    }
  } catch (err) {
    console.error(`[pairai] decryption failed: ${(err as Error).message}`);
    return { content: "[decryption failed]", contentType: "text" };
  }
  return { content: msg.content, contentType: msg.contentType };
}

function decryptTaskDescription(
  full: { description?: string; encrypted?: boolean; descriptionKeys?: any; senderSignature?: string; initiatorAgentId?: string },
  taskId: string,
): string {
  if (!full.encrypted || !full.description || !full.descriptionKeys || !full.senderSignature || !PRIVATE_KEY) {
    return full.description ?? "";
  }
  try {
    const keys = typeof full.descriptionKeys === "string" ? JSON.parse(full.descriptionKeys) : full.descriptionKeys;
    const senderPub = full.initiatorAgentId === myAgentId ? myPublicKey : (full.initiatorAgentId ? pubKeyCache.get(full.initiatorAgentId) : undefined);
    const myKey = keys[myAgentId];
    if (senderPub && myKey) {
      const plain = localDecrypt(full.description, full.senderSignature, taskId, senderPub, myKey);
      const envelope = JSON.parse(plain);
      return `${envelope.title}${envelope.description ? "\n\n" + envelope.description : ""}`;
    }
  } catch (err) {
    console.error(`[pairai] task description decryption failed: ${(err as Error).message}`);
    return "[encrypted task — decryption failed]";
  }
  return full.description ?? "";
}

async function deliverEventNotification(event: {
  id: number;
  type: string;
  taskId: string | null;
  fromAgentId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}) {
  const fromAgent = (event.data.fromAgentName as string) ?? event.fromAgentId ?? "unknown";

  if (event.type === "task.created" || event.type === "task.approval_required") {
    if (!event.taskId) return;

    const full = (await hubGet(`/tasks/${event.taskId}`)) as {
      title?: string;
      description?: string;
      encrypted?: boolean;
      descriptionKeys?: any;
      senderSignature?: string;
      initiatorAgentId?: string;
      approvalStatus?: string | null;
    };
    const taskMsgs = (await hubGet(`/tasks/${event.taskId}/messages`)) as Array<{
      content: string;
      contentType: string;
      senderAgentId: string;
      encryptedKeys?: any;
      senderSignature?: string;
    }>;

    const desc = decryptTaskDescription(full, event.taskId);
    const taskTitle = desc.split("\n")[0] || full.title || "Untitled";
    const decryptedMessages = (taskMsgs ?? []).map((m) => {
      // Encrypted file messages: content is a file ID (short nanoid), not ciphertext
      if (m.contentType === "encrypted" && m.encryptedKeys && m.content.length < 30) {
        return `[File attachment — use pairai_download_file with task_id: "${event.taskId}", file_id: "${m.content}"]`;
      }
      try {
        const d = decryptMessage(m, event.taskId!);
        return d.content;
      } catch {
        return "[decryption failed]";
      }
    });

    const isPendingApproval = full.approvalStatus === "pending" || event.type === "task.approval_required";
    const approvalPrefix = isPendingApproval ? "[APPROVAL REQUIRED] " : "";
    const approvalSuffix = isPendingApproval
      ? `\n\nThis task requires your approval before the agent will act on it.\nUse pairai_approve_task or pairai_reject_task with task ID: ${event.taskId}`
      : "";

    const body = approvalPrefix + [desc || taskTitle, ...decryptedMessages.map((c) => `> ${c}`)].join("\n\n") + approvalSuffix;

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: body,
        meta: { task_id: event.taskId, task_title: taskTitle, from_agent: fromAgent, event_type: "new_task" },
      },
    });
    console.error(`[pairai] channel notification sent: new_task ${event.taskId} from ${fromAgent}${isPendingApproval ? " [APPROVAL REQUIRED]" : ""}`);

  } else if (event.type === "message.created") {
    if (!event.taskId) return;

    const msgs = (await hubGet(`/tasks/${event.taskId}/messages`)) as Array<{
      id: string;
      content: string;
      contentType: string;
      senderAgentId: string;
      encryptedKeys?: any;
      senderSignature?: string;
    }>;
    if (!msgs || msgs.length === 0) return;

    const messageId = event.data.messageId as string | undefined;
    const msg = messageId ? msgs.find((m) => m.id === messageId) : msgs[msgs.length - 1];
    if (!msg) return;

    // Encrypted file messages: content is a file ID (short nanoid), not ciphertext
    const isEncryptedFile = msg.contentType === "encrypted" && msg.encryptedKeys && msg.content.length < 30;
    let decrypted: { content: string; contentType: string };
    if (isEncryptedFile) {
      decrypted = { content: `[File attachment — use pairai_download_file with task_id: "${event.taskId}", file_id: "${msg.content}"]`, contentType: "text" };
    } else {
      try {
        decrypted = decryptMessage(msg, event.taskId);
      } catch {
        decrypted = { content: "[decryption failed]", contentType: "text" };
      }
    }

    const full = (await hubGet(`/tasks/${event.taskId}`)) as { title?: string };
    const taskTitle = full.title ?? "Untitled";

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: decrypted.content,
        meta: {
          task_id: event.taskId,
          task_title: taskTitle,
          from_agent: fromAgent,
          event_type: "new_message",
          content_type: decrypted.contentType,
        },
      },
    });
    console.error(`[pairai] channel notification sent: new_message in ${event.taskId}`);

  } else {
    debugLog(`poll: skipping event type=${event.type} id=${event.id}`);
  }
}

// Detect whether the MCP client reliably surfaces channel notifications.
// Walk the process tree to find Claude Code with --dangerously-load-development-channels server:pairai-channel.
// Falls back to PAIRAI_CHANNEL_NOTIFICATIONS=1 env var (non-Linux or custom setups).
const CHANNEL_FLAG = "--dangerously-load-development-channels";
const CHANNEL_VALUE = "server:pairai-channel";

function detectChannelCapable(): boolean {
  if (process.env.PAIRAI_CHANNEL_NOTIFICATIONS === "1") {
    debugLog("detect-channel: PAIRAI_CHANNEL_NOTIFICATIONS=1 (env override)");
    return true;
  }
  if (process.platform !== "linux") {
    debugLog(`detect-channel: platform=${process.platform} (not linux, skipping /proc walk)`);
    return false;
  }
  try {
    let pid = String(process.ppid);
    debugLog(`detect-channel: starting walk from ppid=${pid}`);
    for (let i = 0; i < 10; i++) {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean);
      const bin = cmdline[0] ?? "";
      debugLog(`detect-channel: pid=${pid} bin=${bin} args=${JSON.stringify(cmdline.slice(1))}`);
      if (bin === "claude" || bin.endsWith("/claude")) {
        // Check for our specific channel: --flag server:pairai-channel or --flag=server:pairai-channel
        let found = false;
        const channelArgs: string[] = [];
        for (let j = 1; j < cmdline.length; j++) {
          const arg = cmdline[j]!;
          if (arg === CHANNEL_FLAG && cmdline[j + 1]) {
            channelArgs.push(cmdline[j + 1]!);
            if (cmdline[j + 1] === CHANNEL_VALUE) found = true;
            j++; // skip value
          } else if (arg.startsWith(`${CHANNEL_FLAG}=`)) {
            const val = arg.slice(CHANNEL_FLAG.length + 1);
            channelArgs.push(val);
            if (val === CHANNEL_VALUE) found = true;
          }
        }
        debugLog(`detect-channel: found claude binary at pid=${pid}, channels=${JSON.stringify(channelArgs)}, looking for="${CHANNEL_VALUE}", match=${found}`);
        return found;
      }
      // Walk up: read ppid from /proc/<pid>/stat
      // Format: "pid (comm) state ppid ..." — comm can contain spaces/parens,
      // so find the LAST ")" to skip past it, then parse fields after it.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
      const nextPid = afterComm.split(" ")[1]; // fields: state ppid ...
      debugLog(`detect-channel: pid=${pid} → ppid=${nextPid}`);
      if (!nextPid || nextPid === "1" || nextPid === "0") {
        debugLog(`detect-channel: reached process tree root (pid=${nextPid}), stopping`);
        break;
      }
      pid = nextPid;
    }
    debugLog("detect-channel: exhausted process tree without finding claude binary");
  } catch (err) {
    debugLog(`detect-channel: error walking /proc: ${(err as Error).message}`);
  }
  return false;
}
const channelCapable = detectChannelCapable();

// For non-channel clients: track the highest event ID we've notified for locally,
// so we don't re-deliver on each poll cycle. Not used when channelCapable=true.
let lastNotifiedEventId = 0;

async function poll() {
  try {
    // Refresh public keys to pick up new connections
    await loadPublicKeys();

    // Non-channel clients: use local cursor to avoid re-notifying, but don't touch server cursor.
    // Channel clients: use server cursor (default behavior — omit after=).
    const afterQs = !channelCapable && lastNotifiedEventId > 0 ? `?after=${lastNotifiedEventId}` : "";
    const updates = (await hubGet(`/events${afterQs}`)) as {
      events: Array<{
        id: number;
        type: string;
        taskId: string | null;
        fromAgentId: string | null;
        data: Record<string, unknown>;
        createdAt: string;
      }>;
      cursor: number;
      hasMore: boolean;
    };

    debugLog(`poll: ${updates.events.length} events, cursor=${updates.cursor}, hasMore=${updates.hasMore}${channelCapable ? "" : `, localCursor=${lastNotifiedEventId}`}`);

    if (updates.events.length === 0) return;

    for (const event of updates.events) {
      try {
        await deliverEventNotification(event);
      } catch (err) {
        console.error(`[pairai] notification delivery failed for event ${event.id}: ${(err as Error).message}`);
      }
    }

    if (channelCapable) {
      // Channel clients: ack server-side — notifications are reliably delivered
      if (updates.cursor > 0) {
        try {
          await hubPost("/events/ack", { cursor: updates.cursor });
          debugLog(`poll: acked cursor=${updates.cursor}`);
        } catch (err) {
          debugLog(`poll: ack failed (will retry next cycle): ${(err as Error).message}`);
        }
      }
    } else {
      // Non-channel clients: advance local cursor only, leave server cursor for check_updates
      lastNotifiedEventId = updates.cursor;
      debugLog(`poll: local cursor advanced to ${lastNotifiedEventId}`);
    }

    if (updates.hasMore) {
      setImmediate(poll);
    }
  } catch (err) {
    console.error(`[pairai] poll error: ${(err as Error).message}`);
    debugLog(`poll error: ${(err as Error).message}`);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport());
console.error(`[pairai] connected. provider=${serveProvider} channelNotifications=${channelCapable} agent=${myAgentId || "(loading)"}`);
debugLog(`startup: provider=${serveProvider} channelCapable=${channelCapable} (${channelCapable ? "poll acks server cursor" : "poll uses local cursor, check_updates acks"})`);

await loadAgentInfo();
if (!myAgentId) {
  console.error("[pairai] failed to load agent info from hub. Cannot start polling.");
  process.exit(1);
}
await loadPublicKeys();

// Acquire polling lock — only one channel process per agent
const lockDir = process.env.PAIRAI_LOCK_DIR || undefined;
if (!acquireLock(myAgentId, lockDir)) {
  console.error(`[pairai] another instance is already polling for agent ${myAgentId}. Exiting.`);
  process.exit(0);
}
const cleanupLock = () => { try { releaseLock(myAgentId, lockDir); } catch {} };
process.on("SIGTERM", cleanupLock);
process.on("SIGINT", cleanupLock);
process.on("beforeExit", cleanupLock);
process.on("exit", cleanupLock);

// Detect parent death — when the MCP host (Claude/Gemini) exits, stdin closes.
// Without this, the process becomes an orphan reparented to systemd.
process.stdin.on("end", () => {
  console.error("[pairai] stdin closed (parent exited). Shutting down.");
  cleanupLock();
  process.exit(0);
});
process.stdin.resume(); // ensure 'end' fires even if nothing reads stdin

console.error(`[pairai] agent=${myAgentId} keys=${pubKeyCache.size} polling every ${POLL_MS}ms`);
setInterval(poll, POLL_MS);
poll();
