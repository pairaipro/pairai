import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { runSetup } from "./setup.js";

let server: Server;
let port: number;
let lastReqBody: Record<string, unknown>;

const TMP = join(tmpdir(), "bridge-setup-test-" + Date.now());

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    lastReqBody = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "agent-test-123", apiKey: "pak_test_abc" }));
  });
  await new Promise<void>((r) => server.listen(0, () => { port = (server.address() as any).port; r(); }));
});

afterAll(() => server.close());
afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

// Mock process.exit to prevent test runner from dying
const originalExit = process.exit;
beforeAll(() => { (process as any).exit = ((code?: number) => { throw new Error(`EXIT_${code ?? 0}`); }) as any; });
afterAll(() => { (process as any).exit = originalExit; });

describe("setup command (spec 10)", () => {
  it("10-01: generates RSA-4096 keypair and sends public key to hub", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const configPath = join(TMP, "bridge.yaml");
    try { await runSetup("Test Agent", `http://localhost:${port}`, configPath); } catch (e: any) { if (!e.message.startsWith("EXIT_")) throw e; }
    expect(lastReqBody.publicKey).toBeTruthy();
    expect(String(lastReqBody.publicKey)).toContain("BEGIN PUBLIC KEY");
  });

  it("10-02: registers with hub POST /agents with agent name", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const configPath = join(TMP, "sub/bridge.yaml");
    try { await runSetup("My Bridge", `http://localhost:${port}`, configPath); } catch (e: any) { if (!e.message.startsWith("EXIT_")) throw e; }
    expect(lastReqBody.name).toBe("My Bridge");
  });

  it("10-04: writes valid YAML config with all fields", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test-key";
    const configPath = join(TMP, "cfg/bridge.yaml");
    try { await runSetup("Agent", `http://localhost:${port}`, configPath); } catch (e: any) { if (!e.message.startsWith("EXIT_")) throw e; }
    expect(existsSync(configPath)).toBe(true);
    const parsed = yaml.load(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(parsed.hub_url).toBe(`http://localhost:${port}`);
    expect(parsed.api_key).toBe("pak_test_abc");
    expect(parsed.openrouter_key).toBe("sk-or-test-key");
    expect(parsed.model).toBeTruthy();
    expect(parsed.system_prompt).toBeTruthy();
  });

  it("10-07: creates config directory if it doesn't exist", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const configPath = join(TMP, "deep/nested/dir/bridge.yaml");
    try { await runSetup("Agent", `http://localhost:${port}`, configPath); } catch (e: any) { if (!e.message.startsWith("EXIT_")) throw e; }
    expect(existsSync(configPath)).toBe(true);
  });

  it("10-08: config contains correct hub_url and api_key", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const configPath = join(TMP, "bridge.yaml");
    try { await runSetup("Agent", `http://localhost:${port}`, configPath); } catch (e: any) { if (!e.message.startsWith("EXIT_")) throw e; }
    const parsed = yaml.load(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(parsed.hub_url).toBe(`http://localhost:${port}`);
    expect(parsed.api_key).toBe("pak_test_abc");
  });
});
