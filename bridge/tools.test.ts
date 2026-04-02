import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

  it("executes update_status tool (allowed status)", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    const ctx: ToolContext = { hub, taskId: "task-001", agentId: "agent-1", encrypt: undefined };
    lastReqs = [];

    const result = await executeTool("update_status", JSON.stringify({ status: "input-required" }), ctx);
    expect(result).toContain("ok");
    expect(lastReqs[0]!.method).toBe("PATCH");
  });

  it("blocks update_status to completed/failed", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    const ctx: ToolContext = { hub, taskId: "task-001", agentId: "agent-1", encrypt: undefined };

    const result = await executeTool("update_status", JSON.stringify({ status: "completed" }), ctx);
    expect(result).toContain("error");
    expect(result).toContain("Do not set status");
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

  it("[REQ-043-02] upload_file encrypts for encrypted tasks", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    const encryptFn = (plaintext: string, _tid: string, _keys: Record<string, string>) => ({
      ciphertext: "ENCRYPTED:" + plaintext.slice(0, 20),
      signature: "sig",
      encryptedKeys: { "agent-1": "k1", "agent-2": "k2" },
    });
    const ctx: ToolContext = {
      hub,
      taskId: "task-001",
      agentId: "agent-1",
      encrypt: encryptFn,
      pubKeys: { "agent-1": "pub1", "agent-2": "pub2" },
      openrouter: {} as any,
    };
    lastReqs = [];

    // Override hub.get to return encrypted task data
    const origGet = hub.get.bind(hub);
    hub.get = async (path: string) => {
      if (path === "/tasks/task-001") {
        return { encrypted: true, initiatorAgentId: "agent-2", targetAgentId: "agent-1" };
      }
      return origGet(path);
    };

    const result = await executeTool("upload_file", JSON.stringify({
      filename: "secret.pdf",
      mime_type: "application/pdf",
      base64_content: "dGVzdA==",
    }), ctx);

    expect(result).toContain("ok");
    // Verify the upload used encrypted_file filename and has encryption metadata
    const uploadReq = lastReqs.find(r => r.url.includes("/files/json"));
    expect(uploadReq).toBeDefined();
    const body = JSON.parse(uploadReq!.body);
    expect(body.filename).toBe("encrypted_file");
    expect(body.mimeType).toBe("application/octet-stream");
    expect(body.encryptedKeys).toBeDefined();
    expect(body.senderSignature).toBe("sig");
  });

  it("[REQ-043-10] generate_image logs cost reporting failure", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const openrouter = {
      imageGeneration: vi.fn().mockResolvedValue({
        base64: "aWduLmJhc2U2NA==",
        mimeType: "image/png",
        generationId: "gen-123",
      }),
      getGenerationCost: vi.fn().mockResolvedValue(0.005),
    };
    // Make the usage POST fail
    const origPost = hub.post.bind(hub);
    hub.post = async (path: string, body?: unknown) => {
      if (path.includes("/usage")) throw new Error("402 insufficient credits");
      return origPost(path, body);
    };
    const ctx: ToolContext = {
      hub,
      taskId: "task-001",
      agentId: "agent-1",
      encrypt: undefined,
      openrouter: openrouter as any,
      imageModel: "test-model",
    };

    await executeTool("generate_image", JSON.stringify({ prompt: "a logo", filename: "logo.png" }), ctx);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("image cost report failed"));
    stderrSpy.mockRestore();
  });
});
