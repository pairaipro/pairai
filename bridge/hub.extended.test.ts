// bridge/hub.extended.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { HubClient } from "./hub.js";

let server: Server;
let port: number;
let lastReq: { method: string; url: string; headers: Record<string, string | undefined>; body: string };

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    lastReq = {
      method: req.method!,
      url: req.url!,
      headers: req.headers as Record<string, string | undefined>,
      body: Buffer.concat(chunks).toString(),
    };
    if (req.url === "/api/v1/html-error") {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<html>Bad Gateway</html>");
      return;
    }
    if (req.url === "/api/v1/raw-data") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "X-Custom": "test" });
      res.end(Buffer.from("binary-data"));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, () => { port = (server.address() as any).port; r(); }));
});

afterAll(() => server.close());

describe("hub client extended (spec 02)", () => {
  it("02-04: POST without body omits Content-Type", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    await hub.post("/pair/generate");
    expect(lastReq.method).toBe("POST");
    expect(lastReq.headers["content-type"]).toBeUndefined();
    expect(lastReq.body).toBe("");
  });

  it("02-05: getRaw returns raw Response object", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    const res = await hub.getRaw("/raw-data");
    expect(res).toBeInstanceOf(Response);
    expect(res.headers.get("x-custom")).toBe("test");
    const buf = await res.arrayBuffer();
    expect(Buffer.from(buf).toString()).toBe("binary-data");
  });

  it("02-07: non-JSON error body throws generic error", async () => {
    const hub = new HubClient(`http://localhost:${port}`, "pak_test");
    await expect(hub.get("/html-error")).rejects.toThrow("502");
  });

  it("02-08: trailing slash in baseUrl stripped", async () => {
    const hub = new HubClient(`http://localhost:${port}/`, "pak_test");
    await hub.get("/agents/me");
    expect(lastReq.url).toBe("/api/v1/agents/me");
  });

  it("02-09: network error (connection refused) throws", async () => {
    const hub = new HubClient("http://localhost:1", "pak_test");
    await expect(hub.get("/anything")).rejects.toThrow();
  });
});
