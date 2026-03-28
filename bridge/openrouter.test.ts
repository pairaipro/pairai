import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { OpenRouterClient, type ChatMessage, type ToolDef } from "./openrouter.js";

let server: Server;
let port: number;
let lastBody: Record<string, unknown>;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    lastBody = JSON.parse(Buffer.concat(chunks).toString());

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        message: { role: "assistant", content: "Hello back!" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(() => server.close());

describe("OpenRouterClient", () => {
  it("sends chat completion request with correct format", async () => {
    const client = new OpenRouterClient("sk-or-test", `http://localhost:${port}`);
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];

    const result = await client.chatCompletion("openai/gpt-4o", messages, {
      temperature: 0.5,
      max_tokens: 100,
    });

    expect(lastBody.model).toBe("openai/gpt-4o");
    expect(lastBody.messages).toEqual(messages);
    expect(lastBody.temperature).toBe(0.5);
    expect(lastBody.max_tokens).toBe(100);
    expect(result.message.content).toBe("Hello back!");
    expect(result.usage.total_tokens).toBe(15);
  });

  it("includes tools when provided", async () => {
    const client = new OpenRouterClient("sk-or-test", `http://localhost:${port}`);
    const tools: ToolDef[] = [{
      type: "function",
      function: {
        name: "reply",
        description: "Send a reply",
        parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      },
    }];

    await client.chatCompletion("openai/gpt-4o", [{ role: "user", content: "Hi" }], {}, tools);
    expect(lastBody.tools).toEqual(tools);
  });

  it("returns result correctly", async () => {
    const client = new OpenRouterClient("sk-or-test", `http://localhost:${port}`);
    const result = await client.chatCompletion("openai/gpt-4o", [{ role: "user", content: "test" }]);
    expect(result.message.content).toBe("Hello back!");
    expect(result.finish_reason).toBe("stop");
  });
});
