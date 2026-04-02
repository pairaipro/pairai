import { describe, it, expect, vi } from "vitest";
import { processTask, pollOnce, type PollDeps } from "./poll.js";

const TASK = {
  id: "task-001", title: "T", description: "D", status: "submitted",
  encrypted: false, initiatorAgentId: "other", targetAgentId: "my-agent", messages: [],
};

function makeDeps(overrides: Partial<PollDeps> = {}): PollDeps {
  return {
    hub: {
      get: vi.fn().mockImplementation((path: string) => {
        if (path === "/connections") return [{ agentId: "other", name: "Other" }];
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

describe("error reporting (spec 09)", () => {
  it("09-02: OpenRouter timeout → error reported to task", async () => {
    const deps = makeDeps();
    (deps.openrouter.chatCompletion as any).mockRejectedValue(new Error("timeout"));
    await processTask("task-001", deps);
    expect(deps.hub.post).toHaveBeenCalledWith("/tasks/task-001/messages",
      expect.objectContaining({ content: expect.stringContaining("[Bridge error]") }));
    expect(deps.hub.patch).toHaveBeenCalledWith("/tasks/task-001", { status: "input-required" });
  });

  it("09-05: model empty response → no empty reply sent", async () => {
    const deps = makeDeps();
    (deps.openrouter.chatCompletion as any).mockResolvedValue({
      message: { role: "assistant", content: "" },
      finish_reason: "stop",
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    });
    await processTask("task-001", deps);
    const msgCalls = (deps.hub.post as any).mock.calls.filter((c: any[]) => c[0].includes("/messages"));
    expect(msgCalls).toHaveLength(0);
  });

  it("09-06: hub error on reply post → logged, not crashed", async () => {
    const deps = makeDeps();
    (deps.openrouter.chatCompletion as any).mockRejectedValue(new Error("OpenRouter down"));
    (deps.hub.post as any).mockRejectedValue(new Error("Hub down"));
    (deps.hub.patch as any).mockRejectedValue(new Error("Hub down"));
    await processTask("task-001", deps);
    expect(deps.log).toHaveBeenCalled();
  });

  it("09-07: hub error on status patch → logged, not crashed", async () => {
    const deps = makeDeps();
    (deps.openrouter.chatCompletion as any).mockRejectedValue(new Error("Model error"));
    let postCount = 0;
    (deps.hub.post as any).mockImplementation(() => { postCount++; return { id: "msg" }; });
    (deps.hub.patch as any).mockRejectedValue(new Error("PATCH failed"));
    await processTask("task-001", deps);
    expect(postCount).toBeGreaterThan(0);
  });

  it("09-08: multiple errors in one poll cycle don't crash", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path === "/connections") return [];
      if (path === "/updates") return {
        hasUpdates: true, pendingTasks: [{ id: "t-1" }, { id: "t-2" }],
        unreadMessages: [], cursor: 5,
      };
      if (path.startsWith("/tasks/")) return { ...TASK };
      return {};
    });
    (deps.openrouter.chatCompletion as any).mockRejectedValue(new Error("Fail"));
    await pollOnce(deps, new Set());
    const msgCalls = (deps.hub.post as any).mock.calls.filter((c: any[]) =>
      typeof c[0] === "string" && c[0].includes("/messages"));
    expect(msgCalls.length).toBe(2);
  });

  it("[REQ-043-04] sanitizes or-prefixed API keys in error messages", async () => {
    const deps = makeDeps();
    (deps.openrouter.chatCompletion as any).mockRejectedValue(
      new Error("Auth failed: or-v1-abc123def456ghi789jkl012mno")
    );
    await processTask("task-001", deps);
    const msgCall = (deps.hub.post as any).mock.calls.find((c: any[]) => c[0].includes("/messages"));
    expect(msgCall).toBeDefined();
    expect(msgCall[1].content).not.toContain("or-v1-abc123def456ghi789jkl012mno");
    expect(msgCall[1].content).toContain("or-***");
  });

  it("[REQ-043-04] sanitizes Bearer tokens in error messages", async () => {
    const deps = makeDeps();
    (deps.openrouter.chatCompletion as any).mockRejectedValue(
      new Error('Header: Bearer pak_a1b2c3d4e5f6g7h8i9j0klmnopqr')
    );
    await processTask("task-001", deps);
    const msgCall = (deps.hub.post as any).mock.calls.find((c: any[]) => c[0].includes("/messages"));
    expect(msgCall).toBeDefined();
    expect(msgCall[1].content).not.toContain("pak_a1b2c3d4e5f6g7h8i9j0klmnopqr");
    expect(msgCall[1].content).toContain("Bearer ***");
  });
});
