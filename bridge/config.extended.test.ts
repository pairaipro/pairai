// bridge/config.extended.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "./config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), "bridge-config-ext-" + Date.now());

afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

function writeYaml(content: string): string {
  mkdirSync(TMP, { recursive: true });
  const p = join(TMP, "bridge.yaml");
  writeFileSync(p, content);
  return p;
}

describe("config extended (spec 01)", () => {
  it("01-02: all 5 env var mappings override file values", () => {
    const p = writeYaml(`
hub_url: "file-hub"
api_key: "file-key"
key_file: "file-keyfile"
openrouter_key: "file-or"
model: "file-model"
`);
    const saved = { ...process.env };
    process.env.PAIRAI_HUB_URL = "env-hub";
    process.env.PAIRAI_AGENT_CRED = "env-key";
    process.env.PAIRAI_KEY_FILE = "env-keyfile";
    process.env.OPENROUTER_API_KEY = "env-or";
    process.env.OPENROUTER_MODEL = "env-model";
    try {
      const cfg = loadConfig(p);
      expect(cfg.hub_url).toBe("env-hub");
      expect(cfg.api_key).toBe("env-key");
      expect(cfg.key_file).toBe("env-keyfile");
      expect(cfg.openrouter_key).toBe("env-or");
      expect(cfg.model).toBe("env-model");
    } finally {
      for (const k of ["PAIRAI_HUB_URL", "PAIRAI_AGENT_CRED", "PAIRAI_KEY_FILE", "OPENROUTER_API_KEY", "OPENROUTER_MODEL"]) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });

  it("01-03: resolution order — env > file > defaults", () => {
    const p = writeYaml(`
hub_url: "from-file"
api_key: "pak_test"
key_file: "/tmp/k.pem"
openrouter_key: "sk-test"
model: "file-model"
`);
    const saved = process.env.PAIRAI_HUB_URL;
    process.env.PAIRAI_HUB_URL = "from-env";
    try {
      const cfg = loadConfig(p);
      expect(cfg.hub_url).toBe("from-env");
      expect(cfg.model).toBe("file-model");
      expect(cfg.temperature).toBe(0.7);
    } finally {
      if (saved === undefined) delete process.env.PAIRAI_HUB_URL; else process.env.PAIRAI_HUB_URL = saved;
    }
  });

  it("01-07: invalid YAML syntax gives clear error", () => {
    const p = writeYaml(`hub_url: [unclosed bracket`);
    expect(() => loadConfig(p)).toThrow();
  });

  it("01-08: empty config file validates required fields", () => {
    const p = writeYaml("");
    expect(() => loadConfig(p)).toThrow();
  });
});
