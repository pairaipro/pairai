import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { HubClient } from "./hub.js";

let server: Server;
let port: number;
let lastReq: { method: string; url: string; headers: Record<string, string>; body: string };

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    lastReq = {
      method: req.method!,
      url: req.url!,
      headers: req.headers as Record<string, string>,
      body: Buffer.concat(chunks).toString(),
    };

    if (req.url === "/api/v1/fail") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(() => server.close());

describe("HubClient", () => {
  it("sends GET with auth header", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    const result = await hub.get("/agents/me");
    expect(lastReq.method).toBe("GET");
    expect(lastReq.url).toBe("/api/v1/agents/me");
    expect(lastReq.headers.authorization).toBe("Bearer pak_test");
    expect(result).toEqual({ ok: true });
  });

  it("sends POST with JSON body", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    await hub.post("/tasks", { title: "Test" });
    expect(lastReq.method).toBe("POST");
    expect(lastReq.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(lastReq.body)).toEqual({ title: "Test" });
  });

  it("sends PATCH with JSON body", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    await hub.patch("/tasks/abc", { status: "completed" });
    expect(lastReq.method).toBe("PATCH");
    expect(JSON.parse(lastReq.body)).toEqual({ status: "completed" });
  });

  it("throws on non-OK response", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    await expect(hub.get("/fail")).rejects.toThrow("internal error");
  });
});
