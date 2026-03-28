import { describe, it, expect, vi } from "vitest";
import { pollOnce, processTask, type PollDeps } from "./poll.js";

const TASK = {
  id: "task-001", title: "Test", description: "Do stuff", status: "submitted",
  encrypted: false, initiatorAgentId: "other", targetAgentId: "my-agent",
  createdAt: "2026-03-27T00:00:00Z", messages: [],
};

function makeDeps(overrides: Partial<PollDeps> = {}): PollDeps {
  return {
    hub: {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/connections") return [{ agentId: "other", publicKey: "PUB_KEY", name: "Other" }];
        if (path === "/updates") return { hasUpdates: false, pendingTasks: [], unreadMessages: [], cursor: 0 };
        if (path.startsWith("/tasks/")) return { ...TASK };
        return {};
      }),
      post: vi.fn().mockResolvedValue({ id: "msg-1" }),
      patch: vi.fn().mockResolvedValue({}),
      getRaw: vi.fn(),
    } as any,
    openrouter: {
      chatCompletion: vi.fn().mockResolvedValue({
        message: { role: "assistant", content: "Reply" },
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
    agentId: "my-agent", privateKey: null, myPublicKey: "", pubKeys: new Map(),
    log: vi.fn(),
    ...overrides,
  };
}

describe("poll extended (spec 07)", () => {
  it("07-01: pollOnce refreshes public keys from /connections", async () => {
    const deps = makeDeps();
    await pollOnce(deps, new Set());
    expect(deps.pubKeys.get("other")).toBe("PUB_KEY");
  });

  it("07-02: pollOnce skips processing when hasUpdates=false", async () => {
    const deps = makeDeps();
    await pollOnce(deps, new Set());
    expect(deps.openrouter.chatCompletion).not.toHaveBeenCalled();
    expect(deps.hub.post).not.toHaveBeenCalled();
  });

  it("07-04: pollOnce does NOT ack cursor (v0.3.2 poll-ack race fix)", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [];
      if (path === "/updates") return { hasUpdates: true, pendingTasks: [{ id: "t-1" }], unreadMessages: [], cursor: 42 };
      if (path.startsWith("/tasks/")) return { ...TASK, id: "t-1" };
      return {};
    });
    await pollOnce(deps, new Set());
    expect(deps.hub.post).not.toHaveBeenCalledWith("/updates/ack", expect.anything());
  });

  it("07-05: pollOnce skips already-seen task IDs", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [];
      if (path === "/updates") return { hasUpdates: true, pendingTasks: [{ id: "t-1" }], unreadMessages: [], cursor: 1 };
      return { ...TASK };
    });
    const seen = new Set(["t-1"]);
    await pollOnce(deps, seen);
    expect(deps.openrouter.chatCompletion).not.toHaveBeenCalled();
  });

  it("07-06: seen set GC triggers at >10K entries", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [];
      if (path === "/updates") return { hasUpdates: true, pendingTasks: [{ id: "new-task" }], unreadMessages: [], cursor: 1 };
      if (path.startsWith("/tasks/")) return { ...TASK, id: "new-task" };
      return {};
    });
    const seen = new Set<string>();
    for (let i = 0; i < 10_001; i++) seen.add(`old-${i}`);
    await pollOnce(deps, seen);
    expect(seen.size).toBeLessThan(10_002);
  });

  it("07-12: connection lookup failure falls back to agentId", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") throw new Error("Network error");
      if (path.startsWith("/tasks/")) return { ...TASK };
      return {};
    });
    await processTask("task-001", deps);
    expect(deps.openrouter.chatCompletion).toHaveBeenCalled();
  });
});
