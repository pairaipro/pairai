import { readFileSync } from "node:fs";
import yaml from "js-yaml";

export interface BridgeConfig {
  hub_url: string;
  api_key: string;
  key_file: string;
  openrouter_key: string;
  model: string;
  image_model?: string;
  temperature: number;
  max_reply_tokens: number;
  max_history_tokens: number;
  system_prompt: string;
  poll_interval_ms: number;
  log_level: "debug" | "info" | "warn" | "error";
  log_file?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant participating in the PairAI collaboration network. You work on tasks assigned to you by other agents and their users.`;

const DEFAULTS: Partial<BridgeConfig> = {
  hub_url: "https://pairai.pro",
  temperature: 0.7,
  max_reply_tokens: 4096,
  max_history_tokens: 32000,
  system_prompt: DEFAULT_SYSTEM_PROMPT,
  poll_interval_ms: 5000,
  log_level: "info",
};

const ENV_MAP: Record<string, keyof BridgeConfig> = {
  PAIRAI_HUB_URL: "hub_url",
  PAIRAI_AGENT_CRED: "api_key",
  PAIRAI_KEY_FILE: "key_file",
  OPENROUTER_API_KEY: "openrouter_key",
  OPENROUTER_MODEL: "model",
};

export function loadConfig(configPath: string): BridgeConfig {
  let fileContent: string;
  try {
    fileContent = readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = (yaml.load(fileContent) ?? {}) as Record<string, unknown>;

  // Apply env var overrides
  for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
    const val = process.env[envKey];
    if (val !== undefined) {
      raw[configKey] = val;
    }
  }

  // Merge with defaults
  const merged = { ...DEFAULTS, ...raw } as Record<string, unknown>;

  // Validate required fields
  const required: (keyof BridgeConfig)[] = ["hub_url", "api_key", "key_file", "openrouter_key", "model"];
  for (const field of required) {
    if (!merged[field]) {
      throw new Error(`Missing required config field: ${field}`);
    }
  }

  // Validate types and ranges
  if (typeof merged.temperature !== "number" || merged.temperature < 0 || merged.temperature > 2) {
    throw new Error("Invalid config: temperature must be a number between 0 and 2");
  }
  if (typeof merged.max_reply_tokens !== "number" || merged.max_reply_tokens < 1) {
    throw new Error("Invalid config: max_reply_tokens must be a positive number");
  }
  if (typeof merged.max_history_tokens !== "number" || merged.max_history_tokens < 1) {
    throw new Error("Invalid config: max_history_tokens must be a positive number");
  }
  if (typeof merged.poll_interval_ms !== "number" || merged.poll_interval_ms < 1000) {
    throw new Error("Invalid config: poll_interval_ms must be >= 1000");
  }
  const validLogLevels = ["debug", "info", "warn", "error"];
  if (!validLogLevels.includes(merged.log_level as string)) {
    throw new Error(`Invalid config: log_level must be one of: ${validLogLevels.join(", ")}`);
  }

  return merged as BridgeConfig;
}
