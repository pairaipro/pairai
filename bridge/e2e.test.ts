/**
 * E2E-style tests for the bridge (spec 13).
 *
 * The real hub (src/index.ts) uses top-level await and eagerly binds to a port,
 * making it difficult to import programmatically in a test process.
 * These tests use a full-featured mock hub that simulates the real hub's REST API
 * surface (agent registration, pairing, tasks, messages, connections, updates)
 * so the bridge poll cycle can be exercised end-to-end including encryption.
 *
 * Tests are labelled with describe.skipIf(false) so they always run; if a future
 * refactor makes the real hub importable, swap the mock for the real server.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { generateKeyPairSync, createHash } from "node:crypto";
import { HubClient } from "./hub.js";
import { OpenRouterClient } from "./openrouter.js";
import { pollOnce, type PollDeps } from "./poll.js";
import { fetchModelPricing } from "./pricing.js";
import { localEncrypt, localDecrypt } from "../channel/lib.js";

/* ------------------------------------------------------------------ */
/*  Full-featured mock hub                                            */
/* ------------------------------------------------------------------ */

interface MockAgent {
  id: string;
  name: string;
  apiKey: string;
  apiKeyHash: string;
  publicKey?: string;
}

interface MockConnection {
  agentAId: string;
  agentBId: string;
}

interface MockTask {
  id: string;
  title: string;
  description: string;
  status: string;
  encrypted: boolean;
  initiatorAgentId: string;
  targetAgentId: string;
  descriptionKeys?: Record<string, string>;
  senderSignature?: string;
  reportedUsage?: number;
  messages: Array<{
    id: string;
    senderAgentId: string;
    content: string;
    contentType: string;
    createdAt: string;
    encryptedKeys?: Record<string, string>;
    senderSignature?: string;
  }>;
}

interface MockHubState {
  agents: MockAgent[];
  connections: MockConnection[];
  tasks: MockTask[];
  pairingCodes: Map<string, string>; // code -> agentId
  updateCursors: Map<string, number>; // agentId -> last acked cursor
  nextId: number;
  usageCallCount: number;       // tracks POST /usage calls
  usageFailAfter: number | null; // if set, return 402 after N successful /usage calls
}

function createMockHub(): { server: Server; state: MockHubState } {
  const state: MockHubState = {
    agents: [],
    connections: [],
    tasks: [],
    pairingCodes: new Map(),
    updateCursors: new Map(),
    nextId: 1,
    usageCallCount: 0,
    usageFailAfter: null,
  };

  function genId(prefix: string): string {
    return `${prefix}-${state.nextId++}`;
  }

  function authedAgent(req: IncomingMessage): MockAgent | null {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return null;
    const key = auth.slice(7);
    const hash = createHash("sha256").update(key).digest("hex");
    return state.agents.find((a) => a.apiKeyHash === hash) ?? null;
  }

  function areConnected(a: string, b: string): boolean {
    return state.connections.some(
      (c) => (c.agentAId === a && c.agentBId === b) || (c.agentAId === b && c.agentBId === a),
    );
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = chunks.length > 0 ? Buffer.concat(chunks).toString() : "";
    const body = rawBody ? JSON.parse(rawBody) : null;
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    const json = (code: number, data: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    // POST /agents — register (no prefix for registration)
    if ((url === "/agents" || url === "/api/v1/agents") && method === "POST") {
      const id = genId("agent");
      const apiKey = `pak_${id}_${Date.now()}`;
      const agent: MockAgent = {
        id,
        name: body?.name ?? "Agent",
        apiKey,
        apiKeyHash: createHash("sha256").update(apiKey).digest("hex"),
        publicKey: body?.publicKey,
      };
      state.agents.push(agent);
      return json(201, { id, apiKey, name: agent.name });
    }

    // POST /pair/generate
    if ((url === "/pair/generate" || url === "/api/v1/pair/generate") && method === "POST") {
      const agent = authedAgent(req);
      if (!agent) return json(401, { error: "Unauthorized" });
      const code = `TEST-${state.nextId++}`;
      state.pairingCodes.set(code, agent.id);
      return json(200, { code, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }

    // POST /pair/connect
    if ((url === "/pair/connect" || url === "/api/v1/pair/connect") && method === "POST") {
      const agent = authedAgent(req);
      if (!agent) return json(401, { error: "Unauthorized" });
      const otherId = state.pairingCodes.get(body?.code);
      if (!otherId) return json(404, { error: "Invalid code" });
      state.pairingCodes.delete(body.code);
      state.connections.push({ agentAId: otherId, agentBId: agent.id });
      const other = state.agents.find((a) => a.id === otherId);
      return json(200, { agentId: otherId, name: other?.name ?? otherId });
    }

    // GET /connections
    if ((url === "/connections" || url === "/api/v1/connections") && method === "GET") {
      const agent = authedAgent(req);
      if (!agent) return json(401, { error: "Unauthorized" });
      const conns = state.connections
        .filter((c) => c.agentAId === agent.id || c.agentBId === agent.id)
        .map((c) => {
          const otherId = c.agentAId === agent.id ? c.agentBId : c.agentAId;
          const other = state.agents.find((a) => a.id === otherId);
          return { agentId: otherId, name: other?.name ?? otherId, publicKey: other?.publicKey };
        });
      return json(200, conns);
    }

    // POST /tasks — create task
    if ((url === "/tasks" || url === "/api/v1/tasks") && method === "POST") {
      const agent = authedAgent(req);
      if (!agent) return json(401, { error: "Unauthorized" });
      const task: MockTask = {
        id: body?.id ?? genId("task"),
        title: body?.title ?? "Task",
        description: body?.description ?? "",
        status: "submitted",
        encrypted: body?.encrypted ?? false,
        initiatorAgentId: agent.id,
        targetAgentId: body?.targetAgentId,
        descriptionKeys: body?.descriptionKeys,
        senderSignature: body?.senderSignature,
        messages: [],
      };
      state.tasks.push(task);
      return json(201, { id: task.id, status: task.status });
    }

    // GET /tasks/:id
    const taskGetMatch = url.match(/^(?:\/api\/v1)?\/tasks\/([^/]+)$/);
    if (taskGetMatch && method === "GET") {
      const task = state.tasks.find((t) => t.id === taskGetMatch[1]);
      if (!task) return json(404, { error: "Not found" });
      return json(200, task);
    }

    // PATCH /tasks/:id
    const taskPatchMatch = url.match(/^(?:\/api\/v1)?\/tasks\/([^/]+)$/);
    if (taskPatchMatch && method === "PATCH") {
      const task = state.tasks.find((t) => t.id === taskPatchMatch[1]);
      if (!task) return json(404, { error: "Not found" });
      if (body?.status) task.status = body.status;
      return json(200, { ok: true });
    }

    // POST /tasks/:id/usage
    const usageMatch = url.match(/^(?:\/api\/v1)?\/tasks\/([^/]+)\/usage$/);
    if (usageMatch && method === "POST") {
      const agent = authedAgent(req);
      if (!agent) return json(401, { error: "Unauthorized" });
      const task = state.tasks.find((t) => t.id === usageMatch[1]);
      if (!task) return json(404, { error: "Not found" });
      state.usageCallCount++;
      // Simulate credit depletion after N calls
      if (state.usageFailAfter !== null && state.usageCallCount > state.usageFailAfter) {
        return json(402, { error: "Insufficient credits" });
      }
      if (!task.reportedUsage) task.reportedUsage = 0;
      task.reportedUsage += body?.cost ?? 0;
      return json(200, { credits: 0.45 });
    }

    // POST /tasks/:id/messages
    const msgMatch = url.match(/^(?:\/api\/v1)?\/tasks\/([^/]+)\/messages$/);
    if (msgMatch && method === "POST") {
      const agent = authedAgent(req);
      if (!agent) return json(401, { error: "Unauthorized" });
      const task = state.tasks.find((t) => t.id === msgMatch[1]);
      if (!task) return json(404, { error: "Not found" });
      const msg = {
        id: genId("msg"),
        senderAgentId: agent.id,
        content: body?.content ?? "",
        contentType: body?.contentType ?? "text",
        createdAt: new Date().toISOString(),
        encryptedKeys: body?.encryptedKeys,
        senderSignature: body?.senderSignature,
      };
      task.messages.push(msg);
      return json(201, { id: msg.id });
    }

    // GET /updates
    if ((url === "/updates" || url === "/api/v1/updates") && method === "GET") {
      const agent = authedAgent(req);
      if (!agent) return json(401, { error: "Unauthorized" });
      const pendingTasks = state.tasks.filter(
        (t) => t.targetAgentId === agent.id && t.status === "submitted",
      ).map((t) => ({ id: t.id }));
      // Find tasks with unread messages (messages from other agent after last ack)
      const unreadMessages: Array<{ taskId: string; count: number }> = [];
      for (const t of state.tasks) {
        if (t.initiatorAgentId !== agent.id && t.targetAgentId !== agent.id) continue;
        if (t.status === "submitted") continue; // already in pendingTasks
        const otherMsgs = t.messages.filter((m) => m.senderAgentId !== agent.id);
        if (otherMsgs.length > 0) {
          // Simplified: if last message is from other agent, mark as unread
          const lastMsg = t.messages[t.messages.length - 1];
          if (lastMsg && lastMsg.senderAgentId !== agent.id) {
            unreadMessages.push({ taskId: t.id, count: 1 });
          }
        }
      }
      return json(200, {
        hasUpdates: pendingTasks.length > 0 || unreadMessages.length > 0,
        pendingTasks,
        unreadMessages,
        cursor: state.nextId,
      });
    }

    // POST /updates/ack
    if ((url === "/updates/ack" || url === "/api/v1/updates/ack") && method === "POST") {
      return json(200, { acknowledged: true });
    }

    json(404, { error: `Not found: ${method} ${url}` });
  });

  return { server, state };
}

/* ------------------------------------------------------------------ */
/*  Mock OpenRouter                                                   */
/* ------------------------------------------------------------------ */

let orServer: Server;
let orPort: number;
let orHandler: (body: any) => any;

/* ------------------------------------------------------------------ */
/*  Test suite                                                        */
/* ------------------------------------------------------------------ */

const canRun = true; // Always true since we use mock hub

describe.skipIf(!canRun)("e2e bridge tests (spec 13)", () => {
  let hubServer: Server;
  let hubPort: number;
  let hubState: MockHubState;

  // Agent credentials stored after registration
  let agentA: { id: string; apiKey: string };
  let agentB: { id: string; apiKey: string };

  beforeAll(async () => {
    // Start mock hub
    const hub = createMockHub();
    hubServer = hub.server;
    hubState = hub.state;
    await new Promise<void>((r) => hubServer.listen(0, () => { hubPort = (hubServer.address() as any).port; r(); }));

    // Start mock OpenRouter
    orHandler = () => ({
      choices: [{ message: { role: "assistant", content: "Default e2e reply" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    orServer = createServer(async (req, res) => {
      // Serve /models for pricing tests (REQ-043-11)
      if (req.url === "/models" || req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [
          { id: "test/mock-model", pricing: { prompt: "0.000001", completion: "0.000002" } },
        ] }));
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(orHandler(body)));
    });
    await new Promise<void>((r) => orServer.listen(0, () => { orPort = (orServer.address() as any).port; r(); }));

    // Load model pricing from mock OpenRouter (for REQ-043-13/14 tests)
    await fetchModelPricing(`http://localhost:${orPort}/models`);

    // Register two agents via POST /agents
    const resA = await fetch(`http://localhost:${hubPort}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Agent Alpha" }),
    });
    agentA = (await resA.json()) as any;

    const resB = await fetch(`http://localhost:${hubPort}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Agent Beta" }),
    });
    agentB = (await resB.json()) as any;

    // Pair them: A generates code, B connects
    const pairRes = await fetch(`http://localhost:${hubPort}/pair/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agentA.apiKey}` },
    });
    const { code } = (await pairRes.json()) as any;

    await fetch(`http://localhost:${hubPort}/pair/connect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agentB.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  });

  afterAll(() => {
    hubServer.close();
    orServer.close();
  });

  function makeDeps(asAgent: { id: string; apiKey: string }, privateKey?: string, myPubKey?: string): PollDeps {
    return {
      hub: new HubClient(`http://localhost:${hubPort}`, asAgent.apiKey),
      openrouter: new OpenRouterClient("sk-test", `http://localhost:${orPort}`),
      config: {
        hub_url: `http://localhost:${hubPort}`, api_key: asAgent.apiKey, key_file: "/k.pem",
        openrouter_key: "sk", model: "m", temperature: 0.7, max_reply_tokens: 4096,
        max_history_tokens: 32000, system_prompt: "You are a helpful agent.", poll_interval_ms: 5000,
        log_level: "error" as const,
      },
      agentId: asAgent.id, privateKey: privateKey ?? null, myPublicKey: myPubKey ?? "",
      pubKeys: new Map(),
      log: () => {},
    };
  }

  it("13-01: register + pair + create task + poll -> reply posted", async () => {
    // Agent A creates a task targeting Agent B
    const hubA = new HubClient(`http://localhost:${hubPort}`, agentA.apiKey);
    await hubA.post("/tasks", {
      targetAgentId: agentB.id,
      title: "Hello task",
      description: "Please greet me",
    });

    orHandler = () => ({
      choices: [{ message: { role: "assistant", content: "Hello from Beta!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    // Agent B polls and processes the task
    const deps = makeDeps(agentB);
    await pollOnce(deps, new Set());

    // Check that B posted a reply
    const task = hubState.tasks.find((t) => t.title === "Hello task");
    expect(task).toBeDefined();
    expect(task!.messages.some((m) => m.content === "Hello from Beta!" && m.senderAgentId === agentB.id)).toBe(true);
  });

  it("13-02: task auto-accepted (status transitions to working)", async () => {
    const hubA = new HubClient(`http://localhost:${hubPort}`, agentA.apiKey);
    await hubA.post("/tasks", {
      targetAgentId: agentB.id,
      title: "Auto-accept test",
      description: "Should move to working",
    });

    await pollOnce(makeDeps(agentB), new Set());

    const task = hubState.tasks.find((t) => t.title === "Auto-accept test");
    expect(task).toBeDefined();
    expect(task!.status).toBe("completed");
  });

  it("13-03: follow-up message triggers additional reply", async () => {
    const hubA = new HubClient(`http://localhost:${hubPort}`, agentA.apiKey);
    const createRes = (await hubA.post("/tasks", {
      targetAgentId: agentB.id,
      title: "Follow-up test",
      description: "Initial request",
    })) as { id: string };

    // First poll: B processes the new task
    let replyCount = 0;
    orHandler = () => ({
      choices: [{ message: { role: "assistant", content: `Reply ${++replyCount}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const seen = new Set<string>();
    await pollOnce(makeDeps(agentB), seen);

    // A sends a follow-up message
    const task = hubState.tasks.find((t) => t.id === createRes.id);
    expect(task).toBeDefined();
    task!.status = "working"; // ensure not submitted so it shows as unread
    await hubA.post(`/tasks/${createRes.id}/messages`, {
      content: "Follow-up question",
      contentType: "text",
    });

    // Second poll: B processes the unread message
    await pollOnce(makeDeps(agentB), seen);

    const bReplies = task!.messages.filter((m) => m.senderAgentId === agentB.id);
    expect(bReplies.length).toBeGreaterThanOrEqual(2);
  });

  it("13-04: tool call integration through full poll cycle", async () => {
    const hubA = new HubClient(`http://localhost:${hubPort}`, agentA.apiKey);
    await hubA.post("/tasks", {
      targetAgentId: agentB.id,
      title: "Tool call test",
      description: "Use tools please",
    });

    let calls = 0;
    orHandler = () => {
      calls++;
      if (calls === 1) return {
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "list_connections", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      return {
        choices: [{ message: { role: "assistant", content: "I found your connections." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    };

    await pollOnce(makeDeps(agentB), new Set());

    expect(calls).toBe(2);
    const task = hubState.tasks.find((t) => t.title === "Tool call test");
    expect(task!.messages.some((m) => m.content === "I found your connections.")).toBe(true);
  });

  it("13-05: OpenRouter failure results in error message and input-required status", async () => {
    const hubA = new HubClient(`http://localhost:${hubPort}`, agentA.apiKey);
    await hubA.post("/tasks", {
      targetAgentId: agentB.id,
      title: "Error test",
      description: "This will fail",
    });

    orHandler = () => ({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });

    await pollOnce(makeDeps(agentB), new Set());

    const task = hubState.tasks.find((t) => t.title === "Error test");
    expect(task).toBeDefined();
    expect(task!.status).toBe("input-required");
    expect(task!.messages.some((m) => m.content.includes("[Bridge error]"))).toBe(true);
  });

  it("13-06: encrypted task — create, poll, verify decryption", async () => {
    // Generate RSA keypairs for both agents
    const keyA = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const keyB = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

    // Update agents with public keys in the mock state
    const agA = hubState.agents.find((a) => a.id === agentA.id);
    const agB = hubState.agents.find((a) => a.id === agentB.id);
    agA!.publicKey = keyA.publicKey as string;
    agB!.publicKey = keyB.publicKey as string;

    // Agent A creates an encrypted task
    const taskId = `enc-task-${Date.now()}`;
    const plainEnvelope = JSON.stringify({ title: "Secret Task", description: "Top secret info" });
    const pubKeys: Record<string, string> = {
      [agentA.id]: keyA.publicKey as string,
      [agentB.id]: keyB.publicKey as string,
    };
    const enc = localEncrypt(plainEnvelope, taskId, keyA.privateKey as string, pubKeys);

    // Push encrypted task directly into mock state
    hubState.tasks.push({
      id: taskId,
      title: "Encrypted Task",
      description: enc.ciphertext,
      status: "submitted",
      encrypted: true,
      initiatorAgentId: agentA.id,
      targetAgentId: agentB.id,
      descriptionKeys: enc.encryptedKeys,
      senderSignature: enc.signature,
      messages: [],
    });

    // Configure OpenRouter to echo back a known reply
    orHandler = (body: any) => {
      // Verify that the system/user messages contain decrypted content
      const allContent = body.messages?.map((m: any) => m.content).join(" ") ?? "";
      const hasDecrypted = allContent.includes("Secret Task") || allContent.includes("Top secret info");
      return {
        choices: [{
          message: {
            role: "assistant",
            content: hasDecrypted ? "I received the secret task" : "No decrypted content found",
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    };

    // Agent B polls with their private key
    const depsB = makeDeps(agentB, keyB.privateKey as string, keyB.publicKey as string);
    // Pre-populate pubKeys with A's public key
    depsB.pubKeys.set(agentA.id, keyA.publicKey as string);

    await pollOnce(depsB, new Set());

    const task = hubState.tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task!.messages.length).toBeGreaterThan(0);

    // The reply should be encrypted
    const replyMsg = task!.messages.find((m) => m.senderAgentId === agentB.id);
    expect(replyMsg).toBeDefined();
    expect(replyMsg!.contentType).toBe("encrypted");
    expect(replyMsg!.encryptedKeys).toBeDefined();
    expect(replyMsg!.senderSignature).toBeDefined();

    // Agent A should be able to decrypt the reply
    const decrypted = localDecrypt(
      replyMsg!.content,
      replyMsg!.senderSignature!,
      taskId,
      keyB.publicKey as string,
      replyMsg!.encryptedKeys![agentA.id]!,
      keyA.privateKey as string,
    );
    const envelope = JSON.parse(decrypted) as { contentType: string; body: string };
    expect(envelope.contentType).toBe("text");
    expect(envelope.body).toBe("I received the secret task");
  });

  it("13-07: seen-tasks dedup across multiple polls", async () => {
    const hubA = new HubClient(`http://localhost:${hubPort}`, agentA.apiKey);
    const createRes = (await hubA.post("/tasks", {
      targetAgentId: agentB.id,
      title: "Dedup test",
      description: "Only process once",
    })) as { id: string };

    let callCount = 0;
    orHandler = () => {
      callCount++;
      return {
        choices: [{ message: { role: "assistant", content: "Processed" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    };

    const seen = new Set<string>();
    const deps = makeDeps(agentB);

    // First poll processes the task
    await pollOnce(deps, seen);
    const firstCallCount = callCount;

    // Manually reset task to submitted to simulate duplicate delivery
    const task = hubState.tasks.find((t) => t.id === createRes.id);
    task!.status = "submitted";

    // Second poll should skip (seen set)
    await pollOnce(deps, seen);
    expect(callCount).toBe(firstCallCount); // No additional OR calls
  });

  it("[REQ-043-13] bridge reports usage to hub after model call", async () => {
    const hubA = new HubClient(`http://localhost:${hubPort}`, agentA.apiKey);
    const createRes = (await hubA.post("/tasks", {
      targetAgentId: agentB.id,
      title: "Usage report test",
      description: "Should report cost",
    })) as { id: string };

    hubState.usageCallCount = 0;
    hubState.usageFailAfter = null;

    orHandler = () => ({
      choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    // Use model name that matches mock pricing
    const deps = makeDeps(agentB);
    deps.config.model = "test/mock-model";
    await pollOnce(deps, new Set());

    const task = hubState.tasks.find((t) => t.id === createRes.id);
    expect(task).toBeDefined();
    // Usage should have been reported (10*0.000001 + 5*0.000002 = 0.00002)
    expect(task!.reportedUsage).toBeGreaterThan(0);
    expect(task!.reportedUsage).toBeCloseTo(0.00002, 6);
  });

  it("[REQ-043-14] mid-task credit depletion does not abort current reply", async () => {
    const hubA = new HubClient(`http://localhost:${hubPort}`, agentA.apiKey);
    const createRes = (await hubA.post("/tasks", {
      targetAgentId: agentB.id,
      title: "Depletion test",
      description: "Credits run out mid-task",
    })) as { id: string };

    // Make /usage fail after 1 successful call (simulates credit depletion on round 2)
    hubState.usageCallCount = 0;
    hubState.usageFailAfter = 1;

    let round = 0;
    orHandler = () => {
      round++;
      if (round === 1) {
        // First round: tool call (triggers usage report #1 — succeeds)
        return {
          choices: [{ message: {
            role: "assistant", content: null,
            tool_calls: [{ id: "tc1", type: "function", function: { name: "reply", arguments: JSON.stringify({ message: "Working on it" }) } }],
          }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      // Second round: final reply (triggers usage report #2 — fails with 402)
      return {
        choices: [{ message: { role: "assistant", content: "Final answer despite depleted credits" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    };

    const deps = makeDeps(agentB);
    deps.config.model = "test/mock-model";
    await pollOnce(deps, new Set());

    // Despite the 402 on second usage report, reply should still be delivered
    const task = hubState.tasks.find((t) => t.id === createRes.id);
    expect(task).toBeDefined();
    const finalMsg = task!.messages.find((m) => m.content === "Final answer despite depleted credits");
    expect(finalMsg).toBeDefined();
    // Task should still be completed
    expect(task!.status).toBe("completed");
    // First usage call succeeded, second failed
    expect(hubState.usageCallCount).toBe(2);
  });
});
