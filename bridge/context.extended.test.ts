// bridge/context.extended.test.ts
import { describe, it, expect } from "vitest";
import { buildMessages, type TaskData } from "./context.js";

function makeTask(overrides: Partial<TaskData> = {}): TaskData {
  return {
    id: "t-1", title: "Fix bug", description: "Fix the login bug",
    status: "submitted", encrypted: true, createdAt: "2026-03-27T00:00:00Z",
    senderName: "Alice", senderDescription: "A coder",
    senderCapabilities: ["coding", "scheduling"],
    ...overrides,
  };
}

describe("context builder extended (spec 04)", () => {
  it("04-01: system message includes prompt + task context block", () => {
    const result = buildMessages("You are helpful.", makeTask(), [], "me", 32000);
    const sys = result[0]!.content!;
    expect(sys).toMatch(/^You are helpful\./);
    expect(sys).toContain("--- Task Context ---");
  });

  it("04-02: task context contains all fields", () => {
    const result = buildMessages("Sys.", makeTask(), [], "me", 32000);
    const sys = result[0]!.content!;
    expect(sys).toContain("Task ID: t-1");
    expect(sys).toContain("Title: Fix bug");
    expect(sys).toContain("Status: submitted");
    expect(sys).toContain("From: Alice (A coder)");
    expect(sys).toContain("Encrypted: yes");
    expect(sys).toContain("Created: 2026-03-27T00:00:00Z");
  });

  it("04-03: sender capabilities included", () => {
    const result = buildMessages("Sys.", makeTask(), [], "me", 32000);
    expect(result[0]!.content!).toContain("Capabilities: coding, scheduling");
  });

  it("04-05: falls back to title when description empty", () => {
    const result = buildMessages("Sys.", makeTask({ description: "" }), [], "me", 32000);
    expect(result[1]!.content).toBe("<task_content>\nFix bug\n</task_content>");
  });

  it("04-08: truncation marker has correct count", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      id: `m-${i}`, senderAgentId: i % 2 === 0 ? "other" : "me",
      content: "x".repeat(2000), contentType: "text",
      createdAt: new Date(2026, 2, 27, 0, i).toISOString(),
    }));
    const result = buildMessages("Sys.", makeTask(), msgs, "me", 2000);
    const marker = result.find((m) => m.content?.includes("truncated"));
    expect(marker).toBeDefined();
    const match = marker!.content!.match(/(\d+) messages omitted/);
    expect(match).toBeTruthy();
    expect(parseInt(match![1]!, 10)).toBeGreaterThan(0);
  });

  it("04-10: zero messages produces system + description only", () => {
    const result = buildMessages("Sys.", makeTask(), [], "me", 32000);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("system");
    expect(result[1]!.role).toBe("user");
  });
});
