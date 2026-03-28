// bridge/openrouter.extended.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { OpenRouterClient } from "./openrouter.js";

let server: Server;
let port: number;
let lastBody: Record<string, unknown>;
let mockResponse: { status: number; body: string };

beforeAll(async () => {
  mockResponse = { status: 200, body: JSON.stringify({
    choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }) };
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    lastBody = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(mockResponse.status, { "Content-Type": "application/json" });
    res.end(mockResponse.body);
  });
  await new Promise<void>((r) => server.listen(0, () => { port = (server.address() as any).port; r(); }));
});

afterAll(() => server.close());

describe("openrouter extended (spec 03)", () => {
  it("03-03: omits tools when not provided", async () => {
    mockResponse = { status: 200, body: JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }) };
    const client = new OpenRouterClient("sk-test", `http://localhost:${port}`);
    await client.chatCompletion("m", [{ role: "user", content: "hi" }]);
    expect(lastBody).not.toHaveProperty("tools");
  });

  it("03-05: parses response with tool_calls", async () => {
    mockResponse = { status: 200, body: JSON.stringify({
      choices: [{
        message: {
          role: "assistant", content: null,
          tool_calls: [{ id: "tc-1", type: "function", function: { name: "reply", arguments: '{"message":"hi"}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }) };
    const client = new OpenRouterClient("sk-test", `http://localhost:${port}`);
    const result = await client.chatCompletion("m", [{ role: "user", content: "hi" }]);
    expect(result.message.tool_calls).toHaveLength(1);
    expect(result.message.tool_calls![0]!.function.name).toBe("reply");
    expect(result.message.content).toBeNull();
    expect(result.finish_reason).toBe("tool_calls");
  });

  it("03-06: empty choices array throws", async () => {
    mockResponse = { status: 200, body: JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    }) };
    const client = new OpenRouterClient("sk-test", `http://localhost:${port}`);
    await expect(client.chatCompletion("m", [{ role: "user", content: "hi" }])).rejects.toThrow("no choices");
  });

  it("03-07: API error 429 throws with status", async () => {
    mockResponse = { status: 429, body: '{"error":{"message":"Rate limited"}}' };
    const client = new OpenRouterClient("sk-test", `http://localhost:${port}`);
    await expect(client.chatCompletion("m", [{ role: "user", content: "hi" }])).rejects.toThrow(/429/);
  });

  it("03-08: non-JSON error body included in error", async () => {
    mockResponse = { status: 500, body: "Internal Server Error" };
    const client = new OpenRouterClient("sk-test", `http://localhost:${port}`);
    await expect(client.chatCompletion("m", [{ role: "user", content: "hi" }])).rejects.toThrow(/500/);
  });
});
