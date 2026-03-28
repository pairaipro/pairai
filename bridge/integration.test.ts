import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { HubClient } from "./hub.js";
import { OpenRouterClient } from "./openrouter.js";
import { pollOnce, type PollDeps } from "./poll.js";

let mockOpenRouterServer: Server;
let mockOpenRouterPort: number;
let mockHubServer: Server;
let mockHubPort: number;

const hubState = {
  pendingTasks: [{ id: "task-001", title: "Test", fromAgent: "other", createdAt: new Date().toISOString(), status: "submitted" }] as any[],
  unreadMessages: [] as any[],
  task: {
    id: "task-001",
    title: "Test",
    description: "Say hello",
    status: "submitted",
    encrypted: false,
    initiatorAgentId: "other-agent",
    targetAgentId: "bridge-agent",
    messages: [],
  },
  connections: [{ agentId: "other-agent", name: "Other Agent" }],
  postedMessages: [] as any[],
  patchedTasks: [] as any[],
};

beforeAll(async () => {
  mockOpenRouterServer = createServer(async (_req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of _req) chunks.push(chunk as Buffer);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Hello! I'm happy to help." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    }));
  });
  await new Promise<void>((r) => mockOpenRouterServer.listen(0, () => { mockOpenRouterPort = (mockOpenRouterServer.address() as any).port; r(); }));

  mockHubServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : null;

    res.writeHead(200, { "Content-Type": "application/json" });

    if ((req.url === "/updates" || req.url === "/api/v1/updates") && req.method === "GET") {
      res.end(JSON.stringify({
        hasUpdates: hubState.pendingTasks.length > 0,
        pendingTasks: hubState.pendingTasks,
        unreadMessages: hubState.unreadMessages,
        cursor: 1,
      }));
      hubState.pendingTasks = [];
      return;
    }

    if ((req.url === "/connections" || req.url === "/api/v1/connections") && req.method === "GET") {
      res.end(JSON.stringify(hubState.connections));
      return;
    }

    if ((req.url?.startsWith("/tasks/task-001") || req.url?.startsWith("/api/v1/tasks/task-001")) && req.method === "GET") {
      res.end(JSON.stringify(hubState.task));
      return;
    }

    if ((req.url?.startsWith("/tasks/task-001/messages") || req.url?.startsWith("/api/v1/tasks/task-001/messages")) && req.method === "POST") {
      hubState.postedMessages.push(body);
      res.end(JSON.stringify({ id: "msg-new" }));
      return;
    }

    if ((req.url?.startsWith("/tasks/task-001") || req.url?.startsWith("/api/v1/tasks/task-001")) && req.method === "PATCH") {
      hubState.patchedTasks.push(body);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if ((req.url === "/updates/ack" || req.url === "/api/v1/updates/ack") && req.method === "POST") {
      res.end(JSON.stringify({ acknowledged: true }));
      return;
    }

    res.end(JSON.stringify({}));
  });
  await new Promise<void>((r) => mockHubServer.listen(0, () => { mockHubPort = (mockHubServer.address() as any).port; r(); }));
});

afterAll(() => {
  mockOpenRouterServer.close();
  mockHubServer.close();
});

describe("integration: bridge poll cycle", () => {
  it("receives task, calls OpenRouter, sends reply back to hub", async () => {
    const hub = new HubClient(`http://localhost:${mockHubPort}`, "pak_test");
    const openrouter = new OpenRouterClient("sk-or-test", `http://localhost:${mockOpenRouterPort}`);

    const deps: PollDeps = {
      hub,
      openrouter,
      config: {
        hub_url: `http://localhost:${mockHubPort}`,
        api_key: "pak_test",
        key_file: "/dev/null",
        openrouter_key: "sk-or-test",
        model: "openai/gpt-4o",
        temperature: 0.7,
        max_reply_tokens: 4096,
        max_history_tokens: 32000,
        system_prompt: "You are helpful.",
        poll_interval_ms: 5000,
        log_level: "error",
      },
      agentId: "bridge-agent",
      privateKey: null,
      myPublicKey: "",
      pubKeys: new Map(),
      log: () => {},
    };

    const seenTasks = new Set<string>();
    await pollOnce(deps, seenTasks);

    expect(hubState.patchedTasks.some((p: any) => p.status === "working")).toBe(true);
    expect(hubState.postedMessages.length).toBeGreaterThan(0);
    expect(hubState.postedMessages[0].content).toBe("Hello! I'm happy to help.");
    expect(hubState.postedMessages[0].contentType).toBe("text");
  });
});
