import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { HubClient } from "./hub.js";
import { executeTool, type ToolContext } from "./tools.js";
import { localEncrypt, localDecrypt } from "../channel/lib.js";

let server: Server;
let port: number;
let lastReqs: Array<{ method: string; url: string; body: string }>;

beforeAll(async () => {
  lastReqs = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    lastReqs.push({ method: req.method!, url: req.url!, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url?.includes("/connections")) res.end(JSON.stringify([{ agentId: "a2", name: "Bob" }]));
    else if (req.url?.includes("/discover")) res.end(JSON.stringify({ total: 1, agents: [{ id: "a3" }] }));
    else res.end(JSON.stringify({ ok: true, id: "new-1" }));
  });
  await new Promise<void>((r) => server.listen(0, () => { port = (server.address() as any).port; r(); }));
});

afterAll(() => server.close());

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { hub: new HubClient(`http://localhost:${port}`, "pak_test"), taskId: "task-001", agentId: "agent-1", encrypt: undefined, ...overrides };
}

describe("tool executor extended (spec 06)", () => {
  it("06-02: reply encrypts when encrypt + pubKeys provided", async () => {
    const alice = generateKeyPairSync("rsa", { modulusLength: 4096, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const bob = generateKeyPairSync("rsa", { modulusLength: 4096, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const ctx = makeCtx({
      encrypt: (plaintext, taskId, keys) => localEncrypt(plaintext, taskId, alice.privateKey, keys),
      pubKeys: { "agent-1": alice.publicKey, "agent-2": bob.publicKey },
    });
    lastReqs = [];
    await executeTool("reply", JSON.stringify({ message: "secret" }), ctx);
    const body = JSON.parse(lastReqs[0]!.body);
    expect(body.contentType).toBe("encrypted");
    expect(body.encryptedKeys["agent-1"]).toBeTruthy();
    expect(body.encryptedKeys["agent-2"]).toBeTruthy();
    expect(body.senderSignature).toBeTruthy();
    expect(body.content).not.toContain("secret");
  });

  it("06-03: encrypted reply envelope has correct structure", async () => {
    const alice = generateKeyPairSync("rsa", { modulusLength: 4096, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const bob = generateKeyPairSync("rsa", { modulusLength: 4096, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const ctx = makeCtx({
      encrypt: (plaintext, taskId, keys) => localEncrypt(plaintext, taskId, alice.privateKey, keys),
      pubKeys: { "agent-1": alice.publicKey, "agent-2": bob.publicKey },
    });
    lastReqs = [];
    await executeTool("reply", JSON.stringify({ message: "secret msg" }), ctx);
    const body = JSON.parse(lastReqs[0]!.body);
    const decrypted = localDecrypt(body.content, body.senderSignature, "task-001", alice.publicKey, body.encryptedKeys["agent-2"], bob.privateKey);
    expect(JSON.parse(decrypted)).toEqual({ contentType: "text", body: "secret msg" });
  });

  it("06-05: create_task POSTs with correct fields", async () => {
    lastReqs = [];
    await executeTool("create_task", JSON.stringify({ target_agent_id: "a2", title: "Review", description: "PR #5" }), makeCtx());
    expect(lastReqs[0]!.url).toBe("/api/v1/tasks");
    expect(JSON.parse(lastReqs[0]!.body)).toEqual({ targetAgentId: "a2", title: "Review", description: "PR #5" });
  });

  it("06-06: create_task defaults description to empty", async () => {
    lastReqs = [];
    await executeTool("create_task", JSON.stringify({ target_agent_id: "a2", title: "Review" }), makeCtx());
    expect(JSON.parse(lastReqs[0]!.body).description).toBe("");
  });

  it("06-07: upload_file POSTs to files/json", async () => {
    lastReqs = [];
    await executeTool("upload_file", JSON.stringify({ filename: "t.txt", mime_type: "text/plain", base64_content: "SGVsbG8=" }), makeCtx());
    expect(lastReqs[0]!.url).toBe("/api/v1/tasks/task-001/files/json");
    expect(JSON.parse(lastReqs[0]!.body)).toEqual({ filename: "t.txt", mimeType: "text/plain", base64Content: "SGVsbG8=" });
  });

  it("06-08: list_tasks with status query", async () => {
    lastReqs = [];
    await executeTool("list_tasks", JSON.stringify({ status: "working" }), makeCtx());
    expect(lastReqs[0]!.url).toBe("/api/v1/tasks?status=working");
  });

  it("06-09: list_tasks without status has no query", async () => {
    lastReqs = [];
    await executeTool("list_tasks", JSON.stringify({}), makeCtx());
    expect(lastReqs[0]!.url).toBe("/api/v1/tasks");
  });

  it("06-10: get_task GETs correct path", async () => {
    lastReqs = [];
    await executeTool("get_task", JSON.stringify({ task_id: "task-xyz" }), makeCtx());
    expect(lastReqs[0]!.url).toBe("/api/v1/tasks/task-xyz");
  });

  it("06-11: discover_agents builds query string", async () => {
    lastReqs = [];
    await executeTool("discover_agents", JSON.stringify({ capability: "coding", query: "alice", limit: 5 }), makeCtx());
    expect(lastReqs[0]!.url).toContain("capability=coding");
    expect(lastReqs[0]!.url).toContain("q=alice");
    expect(lastReqs[0]!.url).toContain("limit=5");
  });

  it("06-12: generate_pairing_code POSTs correctly", async () => {
    lastReqs = [];
    await executeTool("generate_pairing_code", JSON.stringify({}), makeCtx());
    expect(lastReqs[0]!.method).toBe("POST");
    expect(lastReqs[0]!.url).toBe("/api/v1/pair/generate");
  });

  it("06-13: approve_task POSTs to correct endpoint", async () => {
    lastReqs = [];
    await executeTool("approve_task", JSON.stringify({ task_id: "task-abc" }), makeCtx());
    expect(lastReqs[0]!.url).toBe("/api/v1/approvals/task-abc/approve");
  });

  it("06-14: reject_task POSTs with reason", async () => {
    lastReqs = [];
    await executeTool("reject_task", JSON.stringify({ task_id: "task-abc", reason: "Not relevant" }), makeCtx());
    expect(JSON.parse(lastReqs[0]!.body).reason).toBe("Not relevant");
  });

  it("06-16: hub API error caught and returned as error JSON", async () => {
    const deadHub = new HubClient("http://localhost:1", "pak_test");
    const errResult = await executeTool("list_connections", "{}", { ...makeCtx(), hub: deadHub });
    const parsed = JSON.parse(errResult);
    expect(parsed.error).toBeTruthy();
  });
});
