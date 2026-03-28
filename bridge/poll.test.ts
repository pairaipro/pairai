import { describe, it, expect, vi } from "vitest";
import { processTask, processUnreadMessages, type PollDeps } from "./poll.js";

function makeDeps(overrides: Partial<PollDeps> = {}): PollDeps {
  return {
    hub: {
      get: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockResolvedValue({ id: "msg-001" }),
      patch: vi.fn().mockResolvedValue({}),
      getRaw: vi.fn(),
    } as any,
    openrouter: {
      chatCompletion: vi.fn().mockResolvedValue({
        message: { role: "assistant", content: "I'll help with that." },
        finish_reason: "stop",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    } as any,
    config: {
      hub_url: "http://localhost:3000",
      api_key: "pak_test",
      key_file: "/tmp/key.pem",
      openrouter_key: "sk-or-test",
      model: "openai/gpt-4o",
      temperature: 0.7,
      max_reply_tokens: 4096,
      max_history_tokens: 32000,
      system_prompt: "You are helpful.",
      poll_interval_ms: 5000,
      log_level: "error" as const,
    },
    agentId: "my-agent",
    privateKey: null,
    myPublicKey: "",
    pubKeys: new Map(),
    log: vi.fn(),
    ...overrides,
  };
}

const TASK_FIXTURE = {
  id: "task-001",
  title: "Test",
  description: "Do stuff",
  status: "submitted",
  encrypted: false,
  initiatorAgentId: "other-agent",
  targetAgentId: "my-agent",
  messages: [],
};

describe("processTask", () => {
  it("sets status to working, calls OpenRouter, sends reply", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path.startsWith("/tasks/")) return { ...TASK_FIXTURE };
      if (path === "/connections") return [{ agentId: "other-agent", name: "Other" }];
      return {};
    });

    await processTask("task-001", deps);

    expect(deps.hub.patch).toHaveBeenCalledWith("/tasks/task-001", { status: "working" });
    expect(deps.openrouter.chatCompletion).toHaveBeenCalled();
    expect(deps.hub.post).toHaveBeenCalledWith("/tasks/task-001/messages", expect.objectContaining({
      content: "I'll help with that.",
      contentType: "text",
    }));
  });

  it("executes tool calls in a loop", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path.startsWith("/tasks/")) return { ...TASK_FIXTURE };
      if (path === "/connections") return [{ agentId: "other-agent", name: "Other" }];
      return {};
    });

    let callCount = 0;
    (deps.openrouter.chatCompletion as any).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "tc-1",
              type: "function",
              function: { name: "list_connections", arguments: "{}" },
            }],
          },
          finish_reason: "tool_calls",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      return {
        message: { role: "assistant", content: "Done! You have 1 connection." },
        finish_reason: "stop",
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    });

    await processTask("task-001", deps);

    expect(deps.openrouter.chatCompletion).toHaveBeenCalledTimes(2);
    expect(deps.hub.post).toHaveBeenCalledWith("/tasks/task-001/messages", expect.objectContaining({
      content: "Done! You have 1 connection.",
    }));
  });

  it("reports error back to task on OpenRouter failure", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path.startsWith("/tasks/")) return { ...TASK_FIXTURE };
      if (path === "/connections") return [{ agentId: "other-agent", name: "Other" }];
      return {};
    });
    (deps.openrouter.chatCompletion as any).mockRejectedValue(new Error("OpenRouter API error 429: rate limited"));

    await processTask("task-001", deps);

    expect(deps.hub.post).toHaveBeenCalledWith("/tasks/task-001/messages", expect.objectContaining({
      content: expect.stringContaining("[Bridge error]"),
    }));
    expect(deps.hub.patch).toHaveBeenCalledWith("/tasks/task-001", { status: "input-required" });
  });

  it("enforces tool call limit", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path.startsWith("/tasks/")) return { ...TASK_FIXTURE };
      if (path === "/connections") return [{ agentId: "other-agent", name: "Other" }];
      return {};
    });

    (deps.openrouter.chatCompletion as any).mockResolvedValue({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "tc-1",
          type: "function",
          function: { name: "list_connections", arguments: "{}" },
        }],
      },
      finish_reason: "tool_calls",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    await processTask("task-001", deps);

    expect((deps.openrouter.chatCompletion as any).mock.calls.length).toBeLessThanOrEqual(11);
    expect(deps.hub.post).toHaveBeenCalledWith("/tasks/task-001/messages", expect.objectContaining({
      content: expect.stringContaining("Tool call limit exceeded"),
    }));
  });
});

describe("processUnreadMessages", () => {
  it("fetches task, calls OpenRouter with history, sends reply", async () => {
    const deps = makeDeps();
    (deps.hub.get as any).mockImplementation((path: string) => {
      if (path.startsWith("/tasks/")) return {
        ...TASK_FIXTURE,
        status: "working",
        messages: [
          { id: "msg-1", senderAgentId: "other-agent", content: "Hi", contentType: "text", createdAt: "2026-03-27T00:00:00Z" },
          { id: "msg-2", senderAgentId: "my-agent", content: "Hello", contentType: "text", createdAt: "2026-03-27T00:01:00Z" },
          { id: "msg-3", senderAgentId: "other-agent", content: "Can you help?", contentType: "text", createdAt: "2026-03-27T00:02:00Z" },
        ],
      };
      if (path === "/connections") return [{ agentId: "other-agent", name: "Other" }];
      return {};
    });

    await processUnreadMessages("task-001", deps);

    expect(deps.openrouter.chatCompletion).toHaveBeenCalled();
    const callArgs = (deps.openrouter.chatCompletion as any).mock.calls[0];
    const messages = callArgs[1];
    // system + description + 3 history messages
    expect(messages.length).toBe(5);
  });
});
