/**
 * Pure/testable functions extracted from pairai CLI.
 * Imported by both pairai.ts, bridge, and unit tests.
 */
import { existsSync, readFileSync, statSync, openSync, writeSync, closeSync, unlinkSync, mkdirSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  publicEncrypt, privateDecrypt, sign, verify,
  randomBytes, createCipheriv, createDecipheriv,
  constants as cryptoConstants,
} from "node:crypto";

export type Provider = "claude" | "gemini" | "cursor" | "copilot" | "windsurf" | "codex" | "amazonq";

const VALID_PROVIDERS: Provider[] = ["claude", "gemini", "cursor", "copilot", "windsurf", "codex", "amazonq"];

/**
 * Validate the --provider flag value.
 * Returns the validated provider or throws with a message.
 */
export function validateProvider(value: string): Provider {
  if (!VALID_PROVIDERS.includes(value as Provider)) {
    throw new Error(`Unknown provider "${value}". Must be one of: ${VALID_PROVIDERS.join(", ")}.`);
  }
  return value as Provider;
}

/**
 * Auto-detect provider based on environment and filesystem.
 * Returns null when detection is ambiguous (0 or 2+ matches).
 */
export function detectProvider(): Provider | null {
  if (process.env.GEMINI_CLI) return "gemini";
  const found: Provider[] = [];
  try { if (statSync(".cursor").isDirectory()) found.push("cursor"); } catch {}
  try { if (statSync(".windsurf").isDirectory()) found.push("windsurf"); } catch {}
  try { if (statSync(".vscode").isDirectory()) found.push("copilot"); } catch {}
  try { if (statSync(".codex").isDirectory()) found.push("codex"); } catch {}
  try { if (statSync(".amazonq").isDirectory()) found.push("amazonq"); } catch {}
  try { if (statSync(".gemini").isDirectory()) found.push("gemini"); } catch {}
  return found.length === 1 ? found[0] : null;
}

export interface ProviderConfig {
  /** Config file path (project-level or user-scoped) */
  configPath: string;
  /** MCP server key name in the config */
  mcpKey: string;
  /** Format: "json" or "toml" */
  format: "json" | "toml";
  /** Whether this provider only supports user-scoped config */
  userOnly: boolean;
  /** Post-setup instruction */
  instruction: string;
}

/**
 * Get the config file path, format, and setup instructions for a provider.
 */
export function getProviderConfig(
  provider: Provider,
  cwd: string,
  homeDir: string,
  useUser: boolean,
): ProviderConfig {
  switch (provider) {
    case "claude":
      return useUser
        ? {
            configPath: join(homeDir, ".claude", "settings.json"),
            mcpKey: "pairai-channel",
            format: "json",
            userOnly: false,
            instruction: "Restart Claude Code to activate the pairai MCP server",
          }
        : {
            configPath: join(cwd, ".mcp.json"),
            mcpKey: "pairai-channel",
            format: "json",
            userOnly: false,
            instruction: "Start Claude Code in this directory",
          };
    case "gemini": {
      const dir = useUser ? join(homeDir, ".gemini") : join(cwd, ".gemini");
      return {
        configPath: join(dir, "settings.json"),
        mcpKey: "pairai",
        format: "json",
        userOnly: false,
        instruction: "Restart Gemini CLI to activate the pairai MCP server",
      };
    }
    case "cursor": {
      const dir = useUser ? join(homeDir, ".cursor") : join(cwd, ".cursor");
      return {
        configPath: join(dir, "mcp.json"),
        mcpKey: "pairai",
        format: "json",
        userOnly: false,
        instruction: "Restart Cursor to activate the pairai MCP server",
      };
    }
    case "copilot":
      return {
        configPath: join(cwd, ".vscode", "mcp.json"),
        mcpKey: "pairai",
        format: "json",
        userOnly: false,
        instruction: "Reload VS Code window (Ctrl+Shift+P → Developer: Reload Window)",
      };
    case "windsurf":
      return {
        configPath: join(homeDir, ".codeium", "windsurf", "mcp_config.json"),
        mcpKey: "pairai",
        format: "json",
        userOnly: true,
        instruction: "Restart Windsurf to activate the pairai MCP server",
      };
    case "codex": {
      const dir = useUser ? join(homeDir, ".codex") : join(cwd, ".codex");
      return {
        configPath: join(dir, "config.toml"),
        mcpKey: "pairai",
        format: "toml",
        userOnly: false,
        instruction: "Restart Codex CLI to activate the pairai MCP server",
      };
    }
    case "amazonq": {
      const path = useUser
        ? join(homeDir, ".aws", "amazonq", "default.json")
        : join(cwd, ".amazonq", "default.json");
      return {
        configPath: path,
        mcpKey: "pairai",
        format: "json",
        userOnly: false,
        instruction: "Restart Amazon Q to activate the pairai MCP server",
      };
    }
  }
}

/**
 * Replace any `pairai@x.y.z` version pin in a config string with a new version.
 */
export function updateVersionInConfig(content: string, latest: string): string {
  return content.replace(/pairai@\d+\.\d+\.\d+/g, `pairai@${latest}`);
}

/**
 * Check if pairai is already configured in a config file.
 * Returns the path if config exists with a pairai entry, null otherwise.
 */
export function checkExistingConfig(
  provider: Provider,
  cwd: string,
  homeDir: string,
  useUser: boolean,
): string | null {
  const cfg = getProviderConfig(provider, cwd, homeDir, useUser);
  if (!existsSync(cfg.configPath)) return null;

  if (cfg.format === "toml") {
    try {
      const content = readFileSync(cfg.configPath, "utf-8");
      if (content.includes(`[mcp_servers.${cfg.mcpKey}]`)) return cfg.configPath;
    } catch {}
    return null;
  }

  try {
    const existing = JSON.parse(readFileSync(cfg.configPath, "utf-8"));
    const servers = existing.mcpServers ?? {};
    if (servers[cfg.mcpKey]) return cfg.configPath;
  } catch {}
  return null;
}

/**
 * Build the dynamic-width box for the private key backup warning.
 */
export function formatKeyBackupBox(keyPath: string): string[] {
  const lines = [
    "BACK UP YOUR PRIVATE KEY",
    "",
    keyPath,
    "",
    "This key is stored only on your machine.",
    "The hub never sees it. If lost, you must re-register",
    "and re-pair \u2014 all encrypted history becomes unreadable.",
    "",
    "Copy it to a password manager or secure backup now.",
  ];
  const w = Math.max(...lines.map((l) => l.length)) + 2;
  const out: string[] = [];
  out.push(`  \u250C${"\u2500".repeat(w + 2)}\u2510`);
  for (const l of lines) out.push(`  \u2502  ${l.padEnd(w)}\u2502`);
  out.push(`  \u2514${"\u2500".repeat(w + 2)}\u2518`);
  return out;
}

// ── Polling lock ─────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 60_000; // 60 seconds

function lockPath(agentId: string, lockDir?: string): string {
  const dir = lockDir ?? join(homedir(), ".pairai", "locks");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${agentId}.lock`);
}

/**
 * Try to acquire an exclusive lock for this agent.
 * Uses atomic O_CREAT|O_EXCL file creation + stale lock detection.
 * Returns true if lock acquired, false if another live process holds it.
 */
export function acquireLock(agentId: string, lockDir?: string): boolean {
  const path = lockPath(agentId, lockDir);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;

      // Lock file exists — check if holder is alive and not stale
      try {
        const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
        const stat = statSync(path);
        const age = Date.now() - stat.mtimeMs;

        // If PID is alive and lock is fresh, we can't acquire
        if (!isNaN(pid) && age < STALE_THRESHOLD_MS) {
          try {
            process.kill(pid, 0); // signal 0 = check if alive
            return false; // process is alive, lock is valid
          } catch {
            // process is dead — reclaim
          }
        }

        // Stale or dead process — remove and retry
        unlinkSync(path);
      } catch {
        // Can't read/stat lock file — try to remove and retry
        try { unlinkSync(path); } catch {}
      }
    }
  }
  return false;
}

/**
 * Release the lock for this agent. Safe to call multiple times.
 */
export function releaseLock(agentId: string, lockDir?: string): void {
  const path = lockPath(agentId, lockDir);
  try { unlinkSync(path); } catch {}
}

// ── Crypto ──────────────────────────────────────────────────────────────────

/**
 * Encrypt plaintext with AES-256-GCM, wrap key with RSA-OAEP for each recipient,
 * sign (taskId + ciphertext) with RSA-PSS.
 */
export function localEncrypt(
  plaintext: string,
  taskId: string,
  senderPrivateKey: string,
  recipientPubKeys: Record<string, string>,
): { ciphertext: string; signature: string; encryptedKeys: Record<string, string> } {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([iv, encrypted, tag]).toString("base64");

  const signature = sign(null, Buffer.from(taskId + ciphertext), {
    key: senderPrivateKey,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString("base64");

  const encryptedKeys: Record<string, string> = {};
  for (const [id, pub] of Object.entries(recipientPubKeys)) {
    encryptedKeys[id] = publicEncrypt(
      { key: pub, oaepHash: "sha256", padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING },
      key,
    ).toString("base64");
  }

  return { ciphertext, signature, encryptedKeys };
}

/**
 * Verify signature, unwrap AES key with own private key, decrypt AES-256-GCM.
 */
export function localDecrypt(
  ciphertext: string,
  sig: string,
  taskId: string,
  senderPub: string,
  myEncKey: string,
  myPrivateKey: string,
): string {
  const valid = verify(null, Buffer.from(taskId + ciphertext), {
    key: senderPub,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }, Buffer.from(sig, "base64"));
  if (!valid) throw new Error("Signature verification failed");

  const aesKey = privateDecrypt(
    { key: myPrivateKey, oaepHash: "sha256", padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(myEncKey, "base64"),
  );
  const data = Buffer.from(ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", aesKey, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString("utf8");
}
