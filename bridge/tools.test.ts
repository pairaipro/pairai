import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { HubClient } from "./hub.js";
import { getToolDefs, executeTool, type ToolContext } from "./tools.js";

let server: Server;
let port: number;
let lastReqs: Array<{ method: string; url: string; body: string }>;

beforeAll(async () => {
  lastReqs = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    lastReqs.push({
      method: req.method!,
      url: req.url!,
      body: Buffer.concat(chunks).toString(),
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url?.includes("/connections")) {
      res.end(JSON.stringify([{ agentId: "agent-2", name: "Bob" }]));
    } else {
      res.end(JSON.stringify({ ok: true, id: "msg-001" }));
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(() => server.close());

describe("getToolDefs", () => {
  it("returns an array of tool definitions", () => {
    const defs = getToolDefs();
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      expect(def.type).toBe("function");
      expect(def.function.name).toBeTruthy();
      expect(def.function.description).toBeTruthy();
    }
  });
});

describe("executeTool", () => {
  it("executes reply tool", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    const ctx: ToolContext = { hub, taskId: "task-001", agentId: "agent-1", encrypt: undefined };
    lastReqs = [];

    const result = await executeTool("reply", JSON.stringify({ message: "Hello!" }), ctx);
    expect(result).toContain("ok");
    expect(lastReqs[0]!.method).toBe("POST");
    expect(lastReqs[0]!.url).toBe("/api/v1/tasks/task-001/messages");
  });

  it("executes update_status tool", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    const ctx: ToolContext = { hub, taskId: "task-001", agentId: "agent-1", encrypt: undefined };
    lastReqs = [];

    const result = await executeTool("update_status", JSON.stringify({ status: "completed" }), ctx);
    expect(result).toContain("ok");
    expect(lastReqs[0]!.method).toBe("PATCH");
  });

  it("executes list_connections tool", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    const ctx: ToolContext = { hub, taskId: "task-001", agentId: "agent-1", encrypt: undefined };
    lastReqs = [];

    const result = await executeTool("list_connections", "{}", ctx);
    expect(result).toContain("Bob");
  });

  it("returns error for unknown tool", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    const ctx: ToolContext = { hub, taskId: "task-001", agentId: "agent-1", encrypt: undefined };

    const result = await executeTool("nonexistent", "{}", ctx);
    expect(result).toContain("Unknown tool");
  });
});
