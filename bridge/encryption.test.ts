import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { processTask, processUnreadMessages, type PollDeps } from "./poll.js";
import { localEncrypt, localDecrypt } from "../channel/lib.js";

function makeKeys() {
  return generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

const initiator = makeKeys();
const bridge = makeKeys();

function encryptDesc(title: string, desc: string, taskId: string) {
  const payload = JSON.stringify({ title, description: desc });
  return localEncrypt(payload, taskId, initiator.privateKey, {
    initiator: initiator.publicKey, bridge: bridge.publicKey,
  });
}

function encryptMsg(body: string, taskId: string) {
  const payload = JSON.stringify({ contentType: "text", body });
  return localEncrypt(payload, taskId, initiator.privateKey, {
    initiator: initiator.publicKey, bridge: bridge.publicKey,
  });
}

function makeDeps(overrides: Partial<PollDeps> = {}): PollDeps {
  return {
    hub: {
      get: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockResolvedValue({ id: "msg-1" }),
      patch: vi.fn().mockResolvedValue({}),
      getRaw: vi.fn(),
    } as any,
    openrouter: {
      chatCompletion: vi.fn().mockResolvedValue({
        message: { role: "assistant", content: "Secret reply" },
        finish_reason: "stop",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    } as any,
    config: {
      hub_url: "http://localhost:3000", api_key: "pak", key_file: "/k.pem",
      openrouter_key: "sk", model: "m", temperature: 0.7, max_reply_tokens: 4096,
      max_history_tokens: 32000, system_prompt: "Sys.", poll_interval_ms: 5000,
      log_level: "error" as const,
    },
    agentId: "bridge",
    privateKey: bridge.privateKey,
    myPublicKey: bridge.publicKey,
    pubKeys: new Map([["initiator", initiator.publicKey]]),
    log: vi.fn(),
    ...overrides,
  };
}

describe("encryption round-trip (spec 08)", () => {
  const taskId = "enc-task-001";

  it("08-01: encrypted task description decrypted correctly", async () => {
    const enc = encryptDesc("Secret Task", "Do secret thing", taskId);
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [{ agentId: "initiator", publicKey: initiator.publicKey }];
      if (path.startsWith("/tasks/")) return {
        id: taskId, title: "Encrypted Task", description: enc.ciphertext,
        status: "submitted", encrypted: true,
        initiatorAgentId: "initiator", targetAgentId: "bridge",
        descriptionKeys: enc.encryptedKeys, senderSignature: enc.signature,
        messages: [],
      };
      return {};
    });
    await processTask(taskId, deps);
    const orCall = (deps.openrouter.chatCompletion as any).mock.calls[0];
    const msgs = orCall[1] as Array<{ role: string; content: string }>;
    // decryptTaskDescription returns "Secret Task\n\nDo secret thing" as description (user msg)
    expect(msgs[1]!.content).toContain("Secret Task");
    expect(msgs[1]!.content).toContain("Do secret thing");
  });

  it("08-02: encrypted messages decrypted in processing", async () => {
    const encMsg = encryptMsg("Hello secret", taskId);
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [{ agentId: "initiator", publicKey: initiator.publicKey }];
      if (path.startsWith("/tasks/")) return {
        id: taskId, title: "Task", description: "Desc", status: "working",
        encrypted: true, initiatorAgentId: "initiator", targetAgentId: "bridge",
        messages: [{
          id: "m-1", senderAgentId: "initiator", content: encMsg.ciphertext,
          contentType: "encrypted", createdAt: "2026-03-27T00:00:00Z",
          encryptedKeys: encMsg.encryptedKeys, senderSignature: encMsg.signature,
        }],
      };
      return {};
    });
    await processUnreadMessages(taskId, deps);
    const orMsgs = (deps.openrouter.chatCompletion as any).mock.calls[0][1];
    expect(orMsgs.find((m: any) => m.content?.includes("Hello secret"))).toBeDefined();
  });

  it("08-03: reply to encrypted task is encrypted with both keys", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [{ agentId: "initiator", publicKey: initiator.publicKey }];
      if (path.startsWith("/tasks/")) return {
        id: taskId, title: "Task", description: "Desc", status: "submitted",
        encrypted: true, initiatorAgentId: "initiator", targetAgentId: "bridge", messages: [],
      };
      return {};
    });
    await processTask(taskId, deps);
    const msgCall = (deps.hub.post as any).mock.calls.find((c: any[]) => c[0].includes("/messages"));
    expect(msgCall).toBeDefined();
    const body = msgCall[1];
    expect(body.contentType).toBe("encrypted");
    expect(body.encryptedKeys.bridge).toBeTruthy();
    expect(body.encryptedKeys.initiator).toBeTruthy();
    expect(body.senderSignature).toBeTruthy();
  });

  it("08-04: encrypted reply envelope has correct structure", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [{ agentId: "initiator", publicKey: initiator.publicKey }];
      if (path.startsWith("/tasks/")) return {
        id: taskId, title: "T", description: "D", status: "submitted",
        encrypted: true, initiatorAgentId: "initiator", targetAgentId: "bridge", messages: [],
      };
      return {};
    });
    await processTask(taskId, deps);
    const msgCall = (deps.hub.post as any).mock.calls.find((c: any[]) => c[0].includes("/messages"));
    const body = msgCall[1];
    const decrypted = localDecrypt(body.content, body.senderSignature, taskId, bridge.publicKey, body.encryptedKeys.initiator, initiator.privateKey);
    expect(JSON.parse(decrypted)).toEqual({ contentType: "text", body: "Secret reply" });
  });

  it("08-05: signature verified during decryption", async () => {
    const encMsg = encryptMsg("Valid signed message", taskId);
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [{ agentId: "initiator", publicKey: initiator.publicKey }];
      if (path.startsWith("/tasks/")) return {
        id: taskId, title: "T", description: "D", status: "working",
        encrypted: true, initiatorAgentId: "initiator", targetAgentId: "bridge",
        messages: [{ id: "m-1", senderAgentId: "initiator", content: encMsg.ciphertext,
          contentType: "encrypted", createdAt: "2026-03-27T00:00:00Z",
          encryptedKeys: encMsg.encryptedKeys, senderSignature: encMsg.signature }],
      };
      return {};
    });
    await processUnreadMessages(taskId, deps);
    const orMsgs = (deps.openrouter.chatCompletion as any).mock.calls[0][1];
    expect(orMsgs.find((m: any) => m.content?.includes("Valid signed message"))).toBeDefined();
  });

  it("08-06: wrong sender public key fails signature verification", async () => {
    const wrongKey = makeKeys();
    const encMsg = encryptMsg("Tampered", taskId);
    const deps = makeDeps();
    deps.pubKeys.set("initiator", wrongKey.publicKey);
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [{ agentId: "initiator", publicKey: wrongKey.publicKey }];
      if (path.startsWith("/tasks/")) return {
        id: taskId, title: "T", description: "D", status: "working",
        encrypted: true, initiatorAgentId: "initiator", targetAgentId: "bridge",
        messages: [{ id: "m-1", senderAgentId: "initiator", content: encMsg.ciphertext,
          contentType: "encrypted", createdAt: "2026-03-27T00:00:00Z",
          encryptedKeys: encMsg.encryptedKeys, senderSignature: encMsg.signature }],
      };
      return {};
    });
    await processUnreadMessages(taskId, deps);
    const orMsgs = (deps.openrouter.chatCompletion as any).mock.calls[0][1];
    expect(orMsgs.find((m: any) => m.content?.includes("[decryption failed]"))).toBeDefined();
  });

  it("08-07: missing encryptedKeys falls back to plaintext", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [];
      if (path.startsWith("/tasks/")) return {
        id: taskId, title: "T", description: "D", status: "working",
        encrypted: false, initiatorAgentId: "initiator", targetAgentId: "bridge",
        messages: [{ id: "m-1", senderAgentId: "initiator", content: "plain text",
          contentType: "text", createdAt: "2026-03-27T00:00:00Z" }],
      };
      return {};
    });
    await processUnreadMessages(taskId, deps);
    const orMsgs = (deps.openrouter.chatCompletion as any).mock.calls[0][1];
    expect(orMsgs.find((m: any) => m.content?.includes("plain text"))).toBeDefined();
  });

  it("08-08: decryption failure returns placeholder", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [{ agentId: "initiator", publicKey: initiator.publicKey }];
      if (path.startsWith("/tasks/")) return {
        id: taskId, title: "T", description: "D", status: "working",
        encrypted: true, initiatorAgentId: "initiator", targetAgentId: "bridge",
        messages: [{ id: "m-1", senderAgentId: "initiator", content: "CORRUPTED",
          contentType: "encrypted", createdAt: "2026-03-27T00:00:00Z",
          encryptedKeys: { bridge: "BAD" }, senderSignature: "BAD" }],
      };
      return {};
    });
    await processUnreadMessages(taskId, deps);
    const orMsgs = (deps.openrouter.chatCompletion as any).mock.calls[0][1];
    expect(orMsgs.find((m: any) => m.content?.includes("[decryption failed]"))).toBeDefined();
  });

  it("08-09: mixed encrypted and plaintext messages", async () => {
    const encMsg = encryptMsg("Encrypted hello", taskId);
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [{ agentId: "initiator", publicKey: initiator.publicKey }];
      if (path.startsWith("/tasks/")) return {
        id: taskId, title: "T", description: "D", status: "working",
        encrypted: true, initiatorAgentId: "initiator", targetAgentId: "bridge",
        messages: [
          { id: "m-1", senderAgentId: "initiator", content: encMsg.ciphertext,
            contentType: "encrypted", createdAt: "2026-03-27T00:00:00Z",
            encryptedKeys: encMsg.encryptedKeys, senderSignature: encMsg.signature },
          { id: "m-2", senderAgentId: "bridge", content: "Plain reply",
            contentType: "text", createdAt: "2026-03-27T00:01:00Z" },
          { id: "m-3", senderAgentId: "initiator", content: "Follow-up",
            contentType: "text", createdAt: "2026-03-27T00:02:00Z" },
        ],
      };
      return {};
    });
    await processUnreadMessages(taskId, deps);
    const orMsgs = (deps.openrouter.chatCompletion as any).mock.calls[0][1];
    const contents = orMsgs.map((m: any) => m.content);
    expect(contents.some((c: string) => c?.includes("Encrypted hello"))).toBe(true);
    expect(contents).toContain("Plain reply"); // assistant message, not wrapped
    expect(contents.some((c: string) => c?.includes("Follow-up"))).toBe(true);
  });

  it("08-10: no private key — encrypted tasks handled gracefully", async () => {
    const deps = makeDeps({ privateKey: null });
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [];
      if (path.startsWith("/tasks/")) return {
        id: taskId, title: "T", description: "ciphertext_blob", status: "submitted",
        encrypted: true, initiatorAgentId: "initiator", targetAgentId: "bridge",
        descriptionKeys: { bridge: "key" }, senderSignature: "sig", messages: [],
      };
      return {};
    });
    await processTask(taskId, deps);
    expect(deps.openrouter.chatCompletion).toHaveBeenCalled();
    const msgCall = (deps.hub.post as any).mock.calls.find((c: any[]) => c[0].includes("/messages"));
    if (msgCall) expect(msgCall[1].contentType).toBe("text");
  });
});
