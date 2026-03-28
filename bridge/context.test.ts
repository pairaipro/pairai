import { describe, it, expect } from "vitest";
import { buildMessages, type TaskData, type TaskMessage } from "./context.js";

const BASE_SYSTEM = "You are a test bot.";

function makeTask(overrides: Partial<TaskData> = {}): TaskData {
  return {
    id: "task-001",
    title: "Test Task",
    description: "Do the thing",
    status: "submitted",
    encrypted: false,
    createdAt: "2026-03-27T00:00:00Z",
    senderName: "Alice",
    senderDescription: "A helpful agent",
    senderCapabilities: ["coding"],
    ...overrides,
  };
}

function makeMessages(count: number): TaskMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    senderAgentId: i % 2 === 0 ? "other-agent" : "my-agent",
    content: `Message number ${i}`,
    contentType: "text" as const,
    createdAt: new Date(2026, 2, 27, 0, i).toISOString(),
  }));
}

describe("buildMessages", () => {
  it("builds system + user message for a new task", () => {
    const result = buildMessages(BASE_SYSTEM, makeTask(), [], "my-agent", 32000);
    expect(result[0]!.role).toBe("system");
    expect(result[0]!.content).toContain("You are a test bot.");
    expect(result[0]!.content).toContain("Test Task");
    expect(result[0]!.content).toContain("Alice");
    expect(result[1]!.role).toBe("user");
    expect(result[1]!.content).toContain("Do the thing");
  });

  it("maps alternating messages to user/assistant roles", () => {
    const msgs = makeMessages(4);
    const result = buildMessages(BASE_SYSTEM, makeTask(), msgs, "my-agent", 32000);
    expect(result).toHaveLength(6);
    expect(result[2]!.role).toBe("user");
    expect(result[3]!.role).toBe("assistant");
    expect(result[4]!.role).toBe("user");
    expect(result[5]!.role).toBe("assistant");
  });

  it("truncates oldest messages when exceeding token budget", () => {
    const msgs: TaskMessage[] = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i}`,
      senderAgentId: i % 2 === 0 ? "other-agent" : "my-agent",
      content: "x".repeat(2000),
      contentType: "text" as const,
      createdAt: new Date(2026, 2, 27, 0, i).toISOString(),
    }));

    const result = buildMessages(BASE_SYSTEM, makeTask(), msgs, "my-agent", 4000);
    expect(result.length).toBeLessThan(102);
    expect(result[0]!.role).toBe("system");
    const hasMarker = result.some((m) => typeof m.content === "string" && m.content.includes("truncated"));
    expect(hasMarker).toBe(true);
    const lastContent = result[result.length - 1]!.content;
    expect(lastContent).toBe("x".repeat(2000));
  });

  it("always keeps system + description + last 2 messages", () => {
    const msgs: TaskMessage[] = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      senderAgentId: i % 2 === 0 ? "other-agent" : "my-agent",
      content: "y".repeat(5000),
      contentType: "text" as const,
      createdAt: new Date(2026, 2, 27, 0, i).toISOString(),
    }));

    const result = buildMessages(BASE_SYSTEM, makeTask(), msgs, "my-agent", 1000);
    expect(result.length).toBeGreaterThanOrEqual(4);
    expect(result[0]!.role).toBe("system");
  });
});
