import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "./config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), "bridge-config-test-" + Date.now());

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("loadConfig", () => {
  it("loads a YAML config file", () => {
    const configPath = join(TMP, "bridge.yaml");
    writeFileSync(configPath, `
hub_url: "http://localhost:3000"
api_key: "pak_test123"
key_file: "/tmp/key.pem"
openrouter_key: "sk-or-test"
model: "openai/gpt-4o"
temperature: 0.5
max_reply_tokens: 2048
max_history_tokens: 16000
system_prompt: "You are a test bot."
poll_interval_ms: 3000
log_level: "debug"
`);
    const cfg = loadConfig(configPath);
    expect(cfg.hub_url).toBe("http://localhost:3000");
    expect(cfg.api_key).toBe("pak_test123");
    expect(cfg.model).toBe("openai/gpt-4o");
    expect(cfg.temperature).toBe(0.5);
    expect(cfg.max_reply_tokens).toBe(2048);
    expect(cfg.max_history_tokens).toBe(16000);
    expect(cfg.system_prompt).toBe("You are a test bot.");
    expect(cfg.poll_interval_ms).toBe(3000);
    expect(cfg.log_level).toBe("debug");
  });

  it("applies env var overrides", () => {
    const configPath = join(TMP, "bridge.yaml");
    writeFileSync(configPath, `
hub_url: "http://localhost:3000"
api_key: "from_file"
key_file: "/tmp/key.pem"
openrouter_key: "from_file"
model: "from_file"
`);
    const prev = { ...process.env };
    process.env.PAIRAI_AGENT_CRED = "from_env";
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    process.env.OPENROUTER_MODEL = "meta-llama/llama-3-70b";
    try {
      const cfg = loadConfig(configPath);
      expect(cfg.api_key).toBe("from_env");
      expect(cfg.openrouter_key).toBe("sk-or-env");
      expect(cfg.model).toBe("meta-llama/llama-3-70b");
    } finally {
      process.env.PAIRAI_AGENT_CRED = prev.PAIRAI_AGENT_CRED;
      process.env.OPENROUTER_API_KEY = prev.OPENROUTER_API_KEY;
      process.env.OPENROUTER_MODEL = prev.OPENROUTER_MODEL;
    }
  });

  it("uses defaults for missing optional fields", () => {
    const configPath = join(TMP, "bridge.yaml");
    writeFileSync(configPath, `
hub_url: "http://localhost:3000"
api_key: "pak_test"
key_file: "/tmp/key.pem"
openrouter_key: "sk-or-test"
model: "openai/gpt-4o"
`);
    const cfg = loadConfig(configPath);
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.max_reply_tokens).toBe(4096);
    expect(cfg.max_history_tokens).toBe(32000);
    expect(cfg.poll_interval_ms).toBe(5000);
    expect(cfg.log_level).toBe("info");
    expect(cfg.system_prompt).toContain("PairAI");
  });

  it("throws if config file not found", () => {
    expect(() => loadConfig(join(TMP, "nope.yaml"))).toThrow("not found");
  });

  it("throws if required fields missing", () => {
    const configPath = join(TMP, "bridge.yaml");
    writeFileSync(configPath, `hub_url: "http://localhost:3000"`);
    expect(() => loadConfig(configPath)).toThrow();
  });
});
