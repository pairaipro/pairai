#!/usr/bin/env npx tsx
/**
 * pairai-bridge — headless AI agent daemon backed by OpenRouter
 *
 * Commands:
 *   npx pairai-bridge setup "Agent Name" [--hub URL] [--config path]
 *   npx pairai-bridge serve [--config path]
 *   npx pairai-bridge pair <CODE> [--config path]
 *   npx pairai-bridge invite [--config path]
 *   npx pairai-bridge version
 *
 * Env: PAIRAI_HUB_URL, PAIRAI_AGENT_CRED, PAIRAI_KEY_FILE,
 *      OPENROUTER_API_KEY, OPENROUTER_MODEL
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { HubClient } from "./hub.js";
import { OpenRouterClient } from "./openrouter.js";
import { acquireLock, releaseLock, localDecrypt } from "../channel/lib.js";
import { pollOnce, processTask, processUnreadMessages, type PollDeps } from "./poll.js";
import { runSetup } from "./setup.js";
import { fetchModelPricing } from "./pricing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));
const VERSION: string = PKG.version;

const args = process.argv.slice(2);
const command = args[0];

function getConfigPath(): string {
  const cfgIdx = args.indexOf("--config");
  return cfgIdx !== -1 && args[cfgIdx + 1] ? args[cfgIdx + 1]! : join(homedir(), ".pairai", "bridge.yaml");
}

// ── Version ─────────────────────────────────────────────────────────────────

if (command === "version" || args.includes("--version") || args.includes("-v")) {
  console.log(`pairai-bridge v${VERSION}`);
  process.exit(0);
}

// ── Help ────────────────────────────────────────────────────────────────────

if (command === "help" || args.includes("--help") || args.includes("-h")) {
  console.log(`pairai-bridge v${VERSION}\n`);
  console.log("Commands:");
  console.log('  setup "Agent Name" [--hub URL] [--config path]  — register a new agent');
  console.log("  serve [--config path]                           — start the bridge daemon");
  console.log("  pair <CODE> [--config path]                     — connect with another agent");
  console.log("  invite [--config path]                          — generate a pairing code");
  console.log("  version                                         — show version");
  console.log("\nEnvironment variables:");
  console.log("  OPENROUTER_API_KEY    OpenRouter API key (required for setup)");
  console.log("  OPENROUTER_MODEL      Override model from config");
  console.log("  PAIRAI_HUB_URL        Hub URL override");
  console.log("  PAIRAI_AGENT_CRED     Agent API key override");
  console.log("  PAIRAI_KEY_FILE       Private key path override");
  process.exit(0);
}

// ── Setup ───────────────────────────────────────────────────────────────────

if (command === "setup") {
  const rest = args.slice(1);
  const hubIdx = rest.indexOf("--hub");
  const hubUrl = hubIdx !== -1 ? rest.splice(hubIdx, 2)[1] ?? "https://pairai.pro" : "https://pairai.pro";
  const cfgIdx = rest.indexOf("--config");
  const configPath = cfgIdx !== -1 ? rest.splice(cfgIdx, 2)[1] ?? join(homedir(), ".pairai", "bridge.yaml") : join(homedir(), ".pairai", "bridge.yaml");
  const agentName = rest[0];

  if (!agentName) {
    console.error('Usage: pairai-bridge setup "Agent Name" [--hub URL] [--config path]');
    process.exit(1);
  }

  await runSetup(agentName, hubUrl, configPath);
  process.exit(0);

// ── Serve ───────────────────────────────────────────────────────────────────

} else if (command === "serve") {
  console.log(`[bridge] Starting pairai-bridge v${VERSION} (pid=${process.pid}, node=${process.version}, tty=${!!process.stdin.isTTY})`);
  const configPath = getConfigPath();
  const config = loadConfig(configPath);
  const privateKey = readFileSync(config.key_file.replace(/^~/, homedir()), "utf-8");

  const hub = new HubClient(config.hub_url, config.api_key);
  const openrouter = new OpenRouterClient(config.openrouter_key);

  const me = (await hub.get("/agents/me")) as { id: string; name: string; publicKey?: string };
  if (!me.id) {
    console.error("  Failed to load agent info. Check your API key.");
    process.exit(1);
  }
  const agentId = me.id;
  const myPublicKey = me.publicKey ?? "";

  if (!acquireLock(agentId)) {
    console.error(`  Another bridge instance is already running for agent ${agentId}. Exiting.`);
    process.exit(0);
  }

  try {
    const pricing = await fetchModelPricing(); // URL param available for testing
    console.error(`[pairai-bridge] Loaded pricing for ${pricing.size} models`);
  } catch (err) {
    console.error(`[pairai-bridge] Warning: could not fetch model pricing: ${(err as Error).message}`);
  }

  const pubKeys = new Map<string, string>();
  const seenTasks = new Set<string>();

  const logFn = (msg: string) => {
    if (config.log_level === "debug" || config.log_level === "info") {
      console.error(`[pairai-bridge] ${new Date().toISOString()} ${msg}`);
    }
  };

  const deps: PollDeps = {
    hub,
    openrouter,
    config,
    agentId,
    privateKey,
    myPublicKey,
    pubKeys,
    log: logFn,
  };

  const shutdown = () => {
    console.error("[pairai-bridge] Shutting down...");
    releaseLock(agentId);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.error(`[pairai-bridge] agent=${agentId} model=${config.model} polling every ${config.poll_interval_ms}ms`);
  console.error(`[pairai-bridge] Type a command (help for list) or Ctrl+C to quit.`);

  let polling = false;
  const runPoll = async () => {
    if (polling) return; // prevent concurrent polls
    polling = true;
    try {
      await pollOnce(deps, seenTasks);
    } catch (err) {
      logFn(`Poll error: ${(err as Error).message}`);
    } finally {
      polling = false;
    }
  };

  setInterval(runPoll, config.poll_interval_ms);
  await runPoll();

  // ── Console command loop (only when running interactively) ──────────────
  if (!process.stdin.isTTY) {
    // Non-interactive / daemon mode — keep alive via poll interval.
    // stdin may not exist (Docker, k8s) so don't depend on it.
    logFn("Running in daemon mode (non-interactive). Poll interval: " + config.poll_interval_ms + "ms");
    await new Promise(() => {});
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "bridge> " });
  rl.prompt();

  rl.on("line", async (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    if (!cmd) { rl.prompt(); return; }

    try {
      switch (cmd) {
        case "help":
          console.log(`
  Available commands:
    invite                        — generate a pairing code
    pair <CODE>                   — connect with another agent
    list_connections              — show connected agents
    discover_agents [query]       — search agent directory
    list_tasks [status]           — list tasks (optionally by status)
    get_task <task_id>            — show task details + messages
    check_updates                 — poll for new tasks/messages now
    reprocess <task_id>           — re-send a task to the model
    get_profile                   — show this agent's profile
    update_profile <json>         — update profile fields
    set_alias <agent_id> <alias>  — set alias for a connection
    list_pending_approvals        — show tasks awaiting approval
    approve_task <task_id>        — approve a pending task
    reject_task <task_id> [reason]— reject a pending task
    status                        — show bridge status
    quit                          — shut down
`);
          break;

        case "invite": {
          const result = (await hub.post("/pair/generate")) as { code: string; expiresAt: string };
          console.log(`  Pairing code: ${result.code}  (expires ${result.expiresAt})`);
          break;
        }

        case "pair": {
          const code = parts[1];
          if (!code) { console.log("  Usage: pair <CODE>"); break; }
          const result = (await hub.post("/pair/connect", { code })) as { connectionId: string; agentId: string; agentName: string };
          console.log(`  Connected to "${result.agentName}" (${result.agentId})`);
          break;
        }

        case "list_connections": {
          const conns = (await hub.get("/connections")) as Array<{ agentId: string; name?: string; description?: string }>;
          if (conns.length === 0) { console.log("  No connections."); break; }
          for (const c of conns) console.log(`  ${c.name ?? c.agentId} — ${c.description ?? "(no description)"}`);
          break;
        }

        case "discover_agents": {
          const query = parts.slice(1).join(" ");
          const qs = query ? `?query=${encodeURIComponent(query)}` : "";
          const result = (await hub.get(`/agents/discover${qs}`)) as { total: number; agents: Array<{ name: string; id: string; description?: string }> };
          console.log(`  ${result.total} agent(s) found:`);
          for (const a of result.agents) console.log(`  ${a.name} (${a.id}) — ${a.description ?? ""}`);
          break;
        }

        case "list_tasks": {
          const statusFilter = parts[1];
          const qs = statusFilter ? `?status=${statusFilter}` : "";
          const result = (await hub.get(`/tasks${qs}`)) as Array<{ id: string; title: string; status: string }>;
          if (result.length === 0) { console.log("  No tasks."); break; }
          for (const t of result) console.log(`  [${t.status}] ${t.title} (${t.id})`);
          break;
        }

        case "get_task": {
          const tid = parts[1];
          if (!tid) { console.log("  Usage: get_task <task_id>"); break; }
          const task = (await hub.get(`/tasks/${tid}`)) as {
            id: string; title: string; status: string; description?: string; encrypted?: boolean;
            initiatorAgentId?: string; descriptionKeys?: string | Record<string, string>;
            senderSignature?: string;
          };
          let desc = task.description ?? "";
          if (task.encrypted && task.descriptionKeys && task.senderSignature && privateKey) {
            try {
              const keys = typeof task.descriptionKeys === "string" ? JSON.parse(task.descriptionKeys) as Record<string, string> : task.descriptionKeys;
              const senderPub = pubKeys.get(task.initiatorAgentId ?? "") ?? "";
              const myKey = keys[agentId];
              if (senderPub && myKey) {
                const plain = localDecrypt(desc, task.senderSignature, tid, senderPub, myKey, privateKey);
                const envelope = JSON.parse(plain) as { title: string; description?: string };
                desc = `${envelope.title}${envelope.description ? "\n  " + envelope.description : ""}`;
              }
            } catch { desc = "[decryption failed]"; }
          }
          console.log(`  ${task.title} [${task.status}]${task.encrypted ? " (encrypted)" : ""}`);
          console.log(`  ${desc}`);
          const msgs = (await hub.get(`/tasks/${tid}/messages`)) as Array<{
            senderAgentId: string; content: string; contentType: string; createdAt: string;
            encryptedKeys?: string | Record<string, string>; senderSignature?: string;
          }>;
          for (const m of msgs) {
            let content = m.content;
            if (m.contentType === "encrypted" && m.encryptedKeys && m.senderSignature && privateKey) {
              try {
                const keys = typeof m.encryptedKeys === "string" ? JSON.parse(m.encryptedKeys) as Record<string, string> : m.encryptedKeys;
                const senderPub = m.senderAgentId === agentId ? myPublicKey : (pubKeys.get(m.senderAgentId) ?? "");
                const myKey = keys[agentId];
                if (senderPub && myKey) {
                  const plain = localDecrypt(content, m.senderSignature, tid, senderPub, myKey, privateKey);
                  const envelope = JSON.parse(plain) as { body: string; contentType: string };
                  content = envelope.body;
                }
              } catch { content = "[decryption failed]"; }
            }
            console.log(`  [${m.createdAt}] ${m.senderAgentId}: ${content.slice(0, 300)}`);
          }
          break;
        }

        case "reprocess": {
          const tid = parts[1];
          if (!tid) { console.log("  Usage: reprocess <task_id>"); break; }
          seenTasks.delete(tid);
          console.log(`  Reprocessing task ${tid}...`);
          await processTask(tid, deps);
          console.log("  Done.");
          break;
        }

        case "check_updates": {
          await runPoll();
          console.log("  Poll complete.");
          break;
        }

        case "get_profile": {
          const profile = (await hub.get("/agents/me")) as { id: string; name: string; description?: string; capabilities?: string[] };
          console.log(`  Name: ${profile.name}`);
          console.log(`  ID: ${profile.id}`);
          if (profile.description) console.log(`  Description: ${profile.description}`);
          if (profile.capabilities?.length) console.log(`  Capabilities: ${profile.capabilities.join(", ")}`);
          break;
        }

        case "update_profile": {
          const json = parts.slice(1).join(" ");
          if (!json) { console.log("  Usage: update_profile {\"description\":\"...\"}"); break; }
          const body = JSON.parse(json);
          await hub.patch("/agents/me", body);
          console.log("  Profile updated.");
          break;
        }

        case "set_alias": {
          const connId = parts[1];
          const alias = parts.slice(2).join(" ");
          if (!connId || !alias) { console.log("  Usage: set_alias <connection_id> <alias>"); break; }
          await hub.patch(`/connections/${connId}`, { alias });
          console.log(`  Alias set for connection ${connId}: ${alias}`);
          break;
        }

        case "list_pending_approvals": {
          const pending = (await hub.get("/approvals")) as Array<{ id: string; title: string; initiatorAgentId: string }>;
          if (pending.length === 0) { console.log("  No pending approvals."); break; }
          for (const t of pending) console.log(`  ${t.title} from ${t.initiatorAgentId} (${t.id})`);
          break;
        }

        case "approve_task": {
          const tid = parts[1];
          if (!tid) { console.log("  Usage: approve_task <task_id>"); break; }
          await hub.post(`/approvals/${tid}/approve`);
          console.log(`  Task ${tid} approved.`);
          break;
        }

        case "reject_task": {
          const tid = parts[1];
          const reason = parts.slice(2).join(" ") || undefined;
          if (!tid) { console.log("  Usage: reject_task <task_id> [reason]"); break; }
          await hub.post(`/approvals/${tid}/reject`, reason ? { reason } : undefined);
          console.log(`  Task ${tid} rejected.`);
          break;
        }

        case "disconnect": {
          const connId = parts[1];
          if (!connId) { console.log("  Usage: disconnect <connection_id>"); break; }
          const result = (await hub.delete(`/connections/${connId}`)) as { cancelledTasks?: number };
          console.log(`  Disconnected. ${result.cancelledTasks ?? 0} task(s) cancelled.`);
          break;
        }

        case "status":
          console.log(`  Agent: ${agentId}`);
          console.log(`  Hub: ${config.hub_url}`);
          console.log(`  Model: ${config.model}`);
          console.log(`  Connections (cached keys): ${pubKeys.size}`);
          console.log(`  Seen tasks: ${seenTasks.size}`);
          break;

        case "quit":
        case "exit":
          shutdown();
          break;

        default:
          console.log(`  Unknown command: ${cmd} — type "help" for list`);
      }
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`);
    }
    rl.prompt();
  });

  rl.on("close", shutdown);

// ── Pair ────────────────────────────────────────────────────────────────────

} else if (command === "pair") {
  const code = args[1];
  if (!code) {
    console.error("Usage: pairai-bridge pair <CODE> [--config path]");
    process.exit(1);
  }
  const configPath = getConfigPath();
  const config = loadConfig(configPath);
  const hub = new HubClient(config.hub_url, config.api_key);

  try {
    const result = (await hub.post("/pair/connect", { code })) as { connectionId: string; agentId: string; agentName: string };
    console.log(`\n  Connected to "${result.agentName}" (${result.agentId})\n`);
  } catch (err) {
    console.error(`  Pairing failed: ${(err as Error).message}`);
    process.exit(1);
  }
  process.exit(0);

// ── Invite ──────────────────────────────────────────────────────────────────

} else if (command === "invite") {
  const configPath = getConfigPath();
  const config = loadConfig(configPath);
  const hub = new HubClient(config.hub_url, config.api_key);

  try {
    const result = (await hub.post("/pair/generate")) as { code: string; expiresAt: string };
    console.log(`\n  Pairing code: ${result.code}`);
    console.log(`  Expires: ${result.expiresAt}`);
    console.log(`\n  Share this code with the other agent. They have 10 minutes.\n`);
  } catch (err) {
    console.error(`  Failed to generate code: ${(err as Error).message}`);
    process.exit(1);
  }
  process.exit(0);

// ── Unknown ─────────────────────────────────────────────────────────────────

} else {
  console.error(`Unknown command: ${command ?? "(none)"}`);
  console.error("Usage: pairai-bridge <setup|serve|pair|invite|version>");
  process.exit(1);
}
