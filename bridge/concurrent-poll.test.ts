import { describe, it, expect, vi } from "vitest";
import { pollOnce, type PollDeps } from "./poll.js";

describe("concurrent poll guard", () => {
  it("processing unread messages during a slow OpenRouter call does not re-trigger for the same task", async () => {
    // Simulate: first poll sees unread messages, OpenRouter takes 3s to reply.
    // During that time a second poll fires and sees the same unread (cursor not yet acked).
    // Without guard: second poll also calls OpenRouter → duplicate reply → loop.
    // With guard: second poll is skipped.

    let openrouterCallCount = 0;
    let hubPostCount = 0;
    const ackCursors: number[] = [];

    const deps: PollDeps = {
      hub: {
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/connections") return [];
          if (path === "/updates") return {
            hasUpdates: true,
            pendingTasks: [],
            unreadMessages: [{ taskId: "task-slow" }],
            cursor: 10,
          };
          if (path === "/tasks/task-slow") return {
            id: "task-slow", title: "T", description: "D", status: "working",
            encrypted: false, initiatorAgentId: "other", targetAgentId: "my-agent",
          };
          if (path === "/tasks/task-slow/messages") return [
            { id: "m-1", senderAgentId: "other", content: "Hi", contentType: "text", createdAt: "2026-03-27T00:00:00Z" },
          ];
          return {};
        }),
        post: vi.fn().mockImplementation((path: string) => {
          if (path === "/updates/ack") {
            const cursor = 10;
            ackCursors.push(cursor);
          }
          hubPostCount++;
          return { id: "msg-new" };
        }),
        patch: vi.fn().mockResolvedValue({}),
        getRaw: vi.fn(),
      } as any,
      openrouter: {
        chatCompletion: vi.fn().mockImplementation(async () => {
          openrouterCallCount++;
          // Simulate slow model response (100ms is enough for the test)
          await new Promise((r) => setTimeout(r, 100));
          return {
            message: { role: "assistant", content: "Reply" },
            finish_reason: "stop",
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        }),
      } as any,
      config: {
        hub_url: "http://localhost:3000", api_key: "pak", key_file: "/k.pem",
        openrouter_key: "sk", model: "m", temperature: 0.7, max_reply_tokens: 4096,
        max_history_tokens: 32000, system_prompt: "Sys.", poll_interval_ms: 5000,
        log_level: "error" as const,
      },
      agentId: "my-agent", privateKey: null, myPublicKey: "", pubKeys: new Map(),
      log: () => {},
    };

    const seenTasks = new Set<string>();

    // Simulate the concurrent poll scenario from bridge.ts:
    // Two polls fired back-to-back (as setInterval would during slow OpenRouter)
    let polling = false;
    const guardedPoll = async () => {
      if (polling) return "skipped";
      polling = true;
      try {
        await pollOnce(deps, seenTasks);
        return "ran";
      } finally {
        polling = false;
      }
    };

    // Fire both concurrently
    const [result1, result2] = await Promise.all([
      guardedPoll(),
      guardedPoll(),
    ]);

    // First poll ran, second was skipped
    expect(result1).toBe("ran");
    expect(result2).toBe("skipped");

    // OpenRouter called only once (not twice)
    expect(openrouterCallCount).toBe(1);
  });

  it("without guard, concurrent polls cause duplicate OpenRouter calls", async () => {
    // This test proves the bug exists when the guard is absent

    let openrouterCallCount = 0;

    const deps: PollDeps = {
      hub: {
        get: vi.fn().mockImplementation((path: string) => {
          if (path === "/connections") return [];
          if (path === "/updates") return {
            hasUpdates: true,
            pendingTasks: [],
            unreadMessages: [{ taskId: "task-dup" }],
            cursor: 10,
          };
          if (path === "/tasks/task-dup") return {
            id: "task-dup", title: "T", description: "D", status: "working",
            encrypted: false, initiatorAgentId: "other", targetAgentId: "my-agent",
          };
          if (path === "/tasks/task-dup/messages") return [
            { id: "m-1", senderAgentId: "other", content: "Hi", contentType: "text", createdAt: "2026-03-27T00:00:00Z" },
          ];
          return {};
        }),
        post: vi.fn().mockResolvedValue({ id: "msg-new" }),
        patch: vi.fn().mockResolvedValue({}),
        getRaw: vi.fn(),
      } as any,
      openrouter: {
        chatCompletion: vi.fn().mockImplementation(async () => {
          openrouterCallCount++;
          await new Promise((r) => setTimeout(r, 50));
          return {
            message: { role: "assistant", content: "Reply" },
            finish_reason: "stop",
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        }),
      } as any,
      config: {
        hub_url: "http://localhost:3000", api_key: "pak", key_file: "/k.pem",
        openrouter_key: "sk", model: "m", temperature: 0.7, max_reply_tokens: 4096,
        max_history_tokens: 32000, system_prompt: "Sys.", poll_interval_ms: 5000,
        log_level: "error" as const,
      },
      agentId: "my-agent", privateKey: null, myPublicKey: "", pubKeys: new Map(),
      log: () => {},
    };

    // Without guard: both polls run concurrently
    const seenTasks = new Set<string>();
    await Promise.all([
      pollOnce(deps, seenTasks),
      pollOnce(deps, seenTasks),
    ]);

    // Both called OpenRouter — this is the bug
    expect(openrouterCallCount).toBe(2);
  });
});
