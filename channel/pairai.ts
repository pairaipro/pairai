#!/usr/bin/env npx tsx
/**
 * pairai CLI — connect AI agents via the pairai hub
 *
 * Commands:
 *   npx pairai setup "Agent Name" [--hub URL] [--provider claude|gemini|cursor|copilot|windsurf|codex|amazonq] [--global] [--force]
 *   npx pairai serve [--provider claude|gemini|cursor|copilot|windsurf|codex|amazonq]
 *   npx pairai upgrade     — update to latest version (preserves keys and config)
 *   npx pairai version     — show current version
 *
 * Env: PAIRAI_HUB_URL      — hub URL (default: https://pairai.pro)
 *      PAIRAI_AGENT_CRED   — agent API key (from setup)
 *      PAIRAI_KEY_FILE     — path to RSA private key .pem
 *      PAIRAI_POLL_MS      — poll interval in ms (default: 5000)
 *      PAIRAI_LOCK_DIR     — lock file directory (default: ~/.pairai/locks)
 *      PAIRAI_DEBUG        — verbose log: "1" for ~/.pairai/debug.log, or a file path
 * Legacy: PAIRAI_URL, PAIRAI_API_KEY, PAIRAI_PRIVATE_KEY_PATH
 */
import { execSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
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
  const globalIdx = rest.indexOf("--global");
  const useGlobal = globalIdx !== -1 ? (rest.splice(globalIdx, 1), true) : false;
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
      console.error('Usage: npx pairai setup "Agent Name" [--hub URL] [--provider claude|gemini|cursor|copilot|windsurf|codex|amazonq] [--global] [--force]');
      process.exit(1);
    }
  }

  // Check for existing config to avoid accidental overwrites
  if (!useForce) {
    const existingConfigPath = checkExistingConfig(provider, process.cwd(), homedir(), useGlobal);
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

  const cfg = getProviderConfig(provider, process.cwd(), homedir(), useGlobal);
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
    console.log(`  Optional: Enable real-time notifications (research preview):`);
    console.log(`    claude --dangerously-load-development-channels`);
  }

  console.log();
  process.exit(0);
}

// ── Serve: stdio MCP channel server ──────────────────────────────────────────

if (command !== "serve") {
  console.error(`pairai v${VERSION}\n`);
  console.error("Usage:");
  console.error('  npx pairai setup "Agent Name" [--hub URL] [--provider claude|gemini|cursor|copilot|windsurf|codex|amazonq] [--global] [--force]');
  console.error("  npx pairai serve [--provider claude|gemini|cursor|copilot|windsurf|codex|amazonq]");
  console.error("  npx pairai upgrade        — update to latest version");
  console.error("  npx pairai version        — show current version");
  console.error("");
  console.error("Environment variables:");
  console.error("  PAIRAI_HUB_URL      Hub URL (default: https://pairai.pro)");
  console.error("  PAIRAI_AGENT_CRED   Agent API key (from setup)");
  console.error("  PAIRAI_KEY_FILE     Path to RSA private key .pem file");
  console.error("  PAIRAI_POLL_MS      Poll interval in ms (default: 5000)");
  console.error("  PAIRAI_LOCK_DIR     Lock file directory (default: ~/.pairai/locks)");
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
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function hubPost(path: string, body?: unknown) {
  const res = await fetch(`${HUB_URL}${API_PREFIX}${path}`, {
    method: "POST",
    headers: body ? headers : { Authorization: headers.Authorization },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
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
          text: { type: "string", description: "Your message" },
          content_type: { type: "string", enum: ["text", "json"], description: "Default: text. Use json for structured data." },
        },
        required: ["task_id", "text"],
      },
    },
    {
      name: "pairai_update_status",
      description: "Update task status: working, input-required, completed, failed, cancelled.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string" },
          status: { type: "string", enum: ["working", "input-required", "completed", "failed", "cancelled"] },
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
    const updates = (await hubGet("/updates")) as {
      hasUpdates: boolean;
      pendingTasks: Array<{ id: string; title: string; fromAgent: string }>;
      unreadMessages: Array<{ taskId: string; taskTitle: string; count: number }>;
      cursor: number;
    };

    if (!updates.hasUpdates) {
      return { content: [{ type: "text" as const, text: "No updates. You're all caught up." }] };
    }

    const parts: string[] = [];

    if (updates.pendingTasks.length > 0) {
      const enriched: string[] = [];
      for (const task of updates.pendingTasks) {
        const full = (await hubGet(`/tasks/${task.id}`)) as any;
        const desc = full.encrypted ? decryptTaskDescription(full, task.id) : (full.description ?? "");
        const title = desc.split("\n")[0] || task.title;
        enriched.push(`- "${title}" from ${task.fromAgent} (task ID: ${task.id})`);
      }
      parts.push(`**${updates.pendingTasks.length} pending task(s):**\n${enriched.join("\n")}`);
    }

    if (updates.unreadMessages.length > 0) {
      const enriched: string[] = [];
      for (const unread of updates.unreadMessages) {
        const full = (await hubGet(`/tasks/${unread.taskId}`)) as any;
        const msgs = (full.messages ?? []) as Array<any>;
        const recent = msgs.slice(-unread.count);
        const previews: string[] = [];
        for (const m of recent) {
          const d = full.encrypted ? decryptMessage(m, unread.taskId) : { content: m.content, contentType: m.contentType };
          previews.push(d.content.slice(0, 100));
        }
        enriched.push(`- ${unread.count} new in "${unread.taskTitle}" (task ID: ${unread.taskId})\n  Preview: ${previews.join(" | ")}`);
      }
      parts.push(`**Unread messages:**\n${enriched.join("\n")}`);
    }

    // Always ack — this is the authoritative "user has seen these" signal.
    // The poll loop does NOT ack; only this tool does.
    if (updates.cursor > 0) {
      await hubPost("/updates/ack", { cursor: updates.cursor });
    }

    return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
  }

  if (name === "pairai_reply") {
    const { task_id, text, content_type } = args as { task_id: string; text: string; content_type?: string };

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
      const msg = (err as Error).message;
      if (msg.includes("409") || msg.includes("400")) {
        return { content: [{ type: "text" as const, text: `Cannot update status — ${msg}` }] };
      }
      throw err;
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
    const { target_agent_id, title, description } = args as {
      target_agent_id: string; title: string; description?: string;
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
      });
      return { content: [{ type: "text" as const, text: `Task created (encrypted). ID: ${taskId}` }] };
    }

    // Fallback: plaintext (no keys available)
    const data = await hubPost("/tasks", {
      targetAgentId: target_agent_id,
      title,
      description,
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
    const data = (await hubGet("/tasks")) as Array<{
      id: string; status: string; title: string; encrypted?: boolean;
      description?: string; descriptionKeys?: any; senderSignature?: string; initiatorAgentId?: string;
    }>;
    const filtered = args.status ? data.filter((t) => t.status === args.status) : data;
    const decrypted = filtered.map((t) => {
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
    const { target_agent_id, title, description } = args as {
      target_agent_id: string;
      title: string;
      description?: string;
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
    });
    return { content: [{ type: "text" as const, text: `Encrypted task created. ID: ${taskId}` }] };
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

const seenMessages = new Set<string>();
const SEEN_MESSAGES_MAX = 10_000;

function decryptMessage(
  msg: { content: string; contentType: string; senderAgentId: string; encryptedKeys?: any; senderSignature?: string },
  taskId: string,
): { content: string; contentType: string } {
  if (msg.contentType !== "encrypted" || !msg.encryptedKeys || !msg.senderSignature || !PRIVATE_KEY) {
    return { content: msg.content, contentType: msg.contentType };
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

async function poll() {
  try {
    // Refresh public keys to pick up new connections
    await loadPublicKeys();

    const updates = (await hubGet("/updates")) as {
      hasUpdates: boolean;
      pendingTasks: Array<{ id: string; title: string; fromAgent: string }>;
      unreadMessages: Array<{ taskId: string; taskTitle: string; count: number }>;
      cursor: number;
    };

    debugLog(`poll: hasUpdates=${updates.hasUpdates} tasks=${updates.pendingTasks.length} messages=${updates.unreadMessages.length} cursor=${updates.cursor}`);
    if (!updates.hasUpdates) return;
    console.error(`[pairai] poll: ${updates.pendingTasks.length} tasks, ${updates.unreadMessages.length} messages`);

    for (const task of updates.pendingTasks) {
      const key = `task:${task.id}`;
      if (seenMessages.has(key)) { debugLog(`skip seen task ${task.id}`); continue; }
      seenMessages.add(key);

      const full = (await hubGet(`/tasks/${task.id}`)) as {
        description?: string;
        encrypted?: boolean;
        descriptionKeys?: any;
        senderSignature?: string;
        initiatorAgentId?: string;
        approvalStatus?: string | null;
      };
      const taskMsgs = (await hubGet(`/tasks/${task.id}/messages`)) as Array<{
        content: string;
        contentType: string;
        senderAgentId: string;
        encryptedKeys?: any;
        senderSignature?: string;
      }>;

      const desc = decryptTaskDescription(full, task.id);
      const decryptedMessages = (taskMsgs ?? []).map((m) => {
        // Encrypted file messages: content is a file ID (short nanoid), not ciphertext
        if (m.contentType === "encrypted" && m.encryptedKeys && m.content.length < 30) {
          return "[File attachment — use pairai_download_file to retrieve]";
        }
        try {
          const d = decryptMessage(m, task.id);
          return d.content;
        } catch {
          return "[decryption failed]";
        }
      });

      const isPendingApproval = full.approvalStatus === "pending";
      const approvalPrefix = isPendingApproval ? "[APPROVAL REQUIRED] " : "";
      const approvalSuffix = isPendingApproval
        ? `\n\nThis task requires your approval before the agent will act on it.\nUse pairai_approve_task or pairai_reject_task with task ID: ${task.id}`
        : "";

      const body = approvalPrefix + [desc || task.title, ...decryptedMessages.map((c) => `> ${c}`)].join("\n\n") + approvalSuffix;

      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: body,
            meta: { task_id: task.id, task_title: task.title, from_agent: task.fromAgent, event_type: "new_task" },
          },
        });
        console.error(`[pairai] channel notification sent: new_task ${task.id} from ${task.fromAgent}${isPendingApproval ? " [APPROVAL REQUIRED]" : ""}`);
      } catch (err) {
        console.error(`[pairai] channel notification FAILED: ${(err as Error).message}`);
      }
    }

    for (const unread of updates.unreadMessages) {
      const msgs = (await hubGet(`/tasks/${unread.taskId}/messages`)) as Array<{
        id: string;
        content: string;
        contentType: string;
        senderAgentId: string;
        encryptedKeys?: any;
        senderSignature?: string;
      }>;

      debugLog(`unread: taskId=${unread.taskId} count=${unread.count} fetched=${msgs?.length ?? 0}`);
      if (!msgs || msgs.length === 0) continue;
      for (const msg of msgs.slice(-unread.count)) {
        const key = `msg:${msg.id}`;
        if (seenMessages.has(key)) { debugLog(`skip seen msg ${msg.id}`); continue; }
        seenMessages.add(key);

        // Encrypted file messages: content is a file ID (short nanoid), not ciphertext
        const isEncryptedFile = msg.contentType === "encrypted" && msg.encryptedKeys && msg.content.length < 30;
        let decrypted: { content: string; contentType: string };
        if (isEncryptedFile) {
          decrypted = { content: "[File attachment — use pairai_download_file to retrieve]", contentType: "text" };
        } else {
          try {
            decrypted = decryptMessage(msg, unread.taskId);
          } catch {
            decrypted = { content: "[decryption failed]", contentType: "text" };
          }
        }

        try {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: decrypted.content,
              meta: {
                task_id: unread.taskId,
                task_title: unread.taskTitle,
                from_agent: msg.senderAgentId,
                event_type: "new_message",
                content_type: decrypted.contentType,
              },
            },
          });
          console.error(`[pairai] channel notification sent: new_message in ${unread.taskId}`);
        } catch (err) {
          console.error(`[pairai] channel notification FAILED: ${(err as Error).message}`);
        }
      }
    }

    // Do NOT ack the hub here — the hub's lastSeenRowid is only advanced
    // when the user explicitly calls pairai_check_updates (authoritative ack).
    // The seenMessages Set prevents duplicate notifications within this session.
    debugLog(`poll: processed cursor=${updates.cursor} (hub NOT acked — seenMessages dedup only)`);

    // Prevent unbounded memory growth
    if (seenMessages.size > SEEN_MESSAGES_MAX) {
      const excess = seenMessages.size - SEEN_MESSAGES_MAX;
      const iter = seenMessages.values();
      for (let i = 0; i < excess; i++) seenMessages.delete(iter.next().value!);
    }
  } catch (err) {
    console.error(`[pairai] poll error: ${(err as Error).message}`);
    debugLog(`poll error: ${(err as Error).message}`);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport());
console.error(`[pairai] connected. provider=${serveProvider} channel=${!!capabilities.experimental?.["claude/channel"]} agent=${myAgentId || "(loading)"}`);
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
