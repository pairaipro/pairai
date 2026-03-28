import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { HubClient } from "./hub.js";
import { OpenRouterClient } from "./openrouter.js";
import { pollOnce, type PollDeps } from "./poll.js";

let hubServer: Server;
let hubPort: number;
let orServer: Server;
let orPort: number;

let hubState: {
  pendingTasks: any[];
  unreadMessages: any[];
  tasks: Record<string, any>;
  postedMessages: any[];
  patchedTasks: any[];
  connections: any[];
};

let orCallCount: number;
let orHandler: (body: any) => any;

function resetState() {
  hubState = {
    pendingTasks: [], unreadMessages: [], tasks: {},
    postedMessages: [], patchedTasks: [],
    connections: [{ agentId: "other", name: "Other Agent" }],
  };
  orCallCount = 0;
  orHandler = () => ({
    choices: [{ message: { role: "assistant", content: "Default reply" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

beforeAll(async () => {
  resetState();

  hubServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    res.writeHead(200, { "Content-Type": "application/json" });

    if ((req.url === "/updates" || req.url === "/api/v1/updates") && req.method === "GET") {
      res.end(JSON.stringify({
        hasUpdates: hubState.pendingTasks.length > 0 || hubState.unreadMessages.length > 0,
        pendingTasks: hubState.pendingTasks,
        unreadMessages: hubState.unreadMessages,
        cursor: 1,
      }));
      return;
    }
    if (req.url === "/connections" || req.url === "/api/v1/connections") { res.end(JSON.stringify(hubState.connections)); return; }
    if (req.method === "GET" && req.url?.match(/^(?:\/api\/v1)?\/tasks\/[^/]+$/)) {
      const id = req.url.replace(/^\/api\/v1/, "").split("/")[2]!;
      res.end(JSON.stringify(hubState.tasks[id] ?? {
        id, title: "T", description: "D", status: "submitted",
        encrypted: false, initiatorAgentId: "other", targetAgentId: "bridge", messages: [],
      }));
      return;
    }
    if (req.method === "POST" && (req.url?.includes("/messages"))) {
      hubState.postedMessages.push(body);
      res.end(JSON.stringify({ id: "msg-new" }));
      return;
    }
    if (req.method === "PATCH") {
      hubState.patchedTasks.push(body);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/updates/ack" || req.url === "/api/v1/updates/ack") { res.end(JSON.stringify({ acknowledged: true })); return; }
    res.end(JSON.stringify({}));
  });
  await new Promise<void>((r) => hubServer.listen(0, () => { hubPort = (hubServer.address() as any).port; r(); }));

  orServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    orCallCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(orHandler(body)));
  });
  await new Promise<void>((r) => orServer.listen(0, () => { orPort = (orServer.address() as any).port; r(); }));
});

afterAll(() => { hubServer.close(); orServer.close(); });
beforeEach(() => resetState());

function makeDeps(): PollDeps {
  return {
    hub: new HubClient(`http://localhost:${hubPort}`, "pak_test"),
    openrouter: new OpenRouterClient("sk-test", `http://localhost:${orPort}`),
    config: {
      hub_url: `http://localhost:${hubPort}`, api_key: "pak", key_file: "/k.pem",
      openrouter_key: "sk", model: "m", temperature: 0.7, max_reply_tokens: 4096,
      max_history_tokens: 32000, system_prompt: "Sys.", poll_interval_ms: 5000,
      log_level: "error" as const,
    },
    agentId: "bridge", privateKey: null, myPublicKey: "", pubKeys: new Map(),
    log: () => {},
  };
}

describe("integration extended (spec 12)", () => {
  it("12-02: tool call cycle — task -> tool -> final reply", async () => {
    hubState.pendingTasks = [{ id: "t-tool" }];
    let calls = 0;
    orHandler = () => {
      calls++;
      if (calls <= 1) return {
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "list_connections", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      return {
        choices: [{ message: { role: "assistant", content: "You have connections." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    };
    await pollOnce(makeDeps(), new Set());
    expect(calls).toBe(2);
    expect(hubState.postedMessages.some((m: any) => m.content === "You have connections.")).toBe(true);
  });

  it("12-03: unread message triggers new OpenRouter call", async () => {
    hubState.unreadMessages = [{ taskId: "t-unread", count: 1 }];
    hubState.tasks["t-unread"] = {
      id: "t-unread", title: "T", description: "D", status: "working",
      encrypted: false, initiatorAgentId: "other", targetAgentId: "bridge",
      messages: [
        { id: "m1", senderAgentId: "other", content: "First", contentType: "text", createdAt: "2026-03-27T00:00:00Z" },
        { id: "m2", senderAgentId: "bridge", content: "Reply1", contentType: "text", createdAt: "2026-03-27T00:01:00Z" },
        { id: "m3", senderAgentId: "other", content: "Follow-up", contentType: "text", createdAt: "2026-03-27T00:02:00Z" },
      ],
    };
    orHandler = () => ({
      choices: [{ message: { role: "assistant", content: "Got your follow-up" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });
    await pollOnce(makeDeps(), new Set());
    expect(hubState.postedMessages.some((m: any) => m.content === "Got your follow-up")).toBe(true);
  });

  it("12-04: multiple pending tasks processed in sequence", async () => {
    hubState.pendingTasks = [{ id: "t-a" }, { id: "t-b" }];
    let replyIndex = 0;
    const replies = ["Reply A", "Reply B"];
    orHandler = () => ({
      choices: [{ message: { role: "assistant", content: replies[replyIndex++] ?? "extra" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    await pollOnce(makeDeps(), new Set());
    const contents = hubState.postedMessages.map((m: any) => m.content);
    expect(contents).toContain("Reply A");
    expect(contents).toContain("Reply B");
  });

  it("12-05: OpenRouter error reported back to mock hub", async () => {
    hubState.pendingTasks = [{ id: "t-err" }];
    orHandler = () => ({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    await pollOnce(makeDeps(), new Set());
    expect(hubState.postedMessages.some((m: any) => m.content?.includes("[Bridge error]"))).toBe(true);
    expect(hubState.patchedTasks.some((p: any) => p.status === "input-required")).toBe(true);
  });

  it("12-07: tool call limit triggers error", async () => {
    hubState.pendingTasks = [{ id: "t-loop" }];
    orHandler = () => ({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "tc", type: "function", function: { name: "list_connections", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    await pollOnce(makeDeps(), new Set());
    expect(orCallCount).toBeLessThanOrEqual(11);
    expect(hubState.postedMessages.some((m: any) => m.content?.includes("Tool call limit exceeded"))).toBe(true);
  });

  it("12-08: second poll skips already-seen tasks", async () => {
    hubState.pendingTasks = [{ id: "t-seen" }];
    const seen = new Set<string>();
    const deps = makeDeps();
    await pollOnce(deps, seen);
    const firstCount = hubState.postedMessages.length;
    // Reset pendingTasks with same ID
    hubState.pendingTasks = [{ id: "t-seen" }];
    orCallCount = 0;
    await pollOnce(deps, seen);
    expect(hubState.postedMessages.length).toBe(firstCount);
  });
});
