import { describe, it, expect } from "vitest";
import { getToolDefs } from "./tools.js";

describe("tool definitions (spec 05)", () => {
  const defs = getToolDefs();

  it("05-01: returns exactly 11 tool definitions", () => {
    expect(defs).toHaveLength(12);
  });

  it("05-02: all tools have type function", () => {
    for (const d of defs) expect(d.type).toBe("function");
  });

  it("05-03: all tools have name, description, parameters", () => {
    for (const d of defs) {
      expect(d.function.name).toBeTruthy();
      expect(d.function.description).toBeTruthy();
      expect(d.function.parameters).toBeDefined();
      expect((d.function.parameters as any).type).toBe("object");
    }
  });

  it("05-04: required params marked correctly per tool", () => {
    const byName = Object.fromEntries(defs.map((d) => [d.function.name, d.function.parameters as any]));
    expect(byName.reply.required).toEqual(["message"]);
    expect(byName.update_status.required).toEqual(["status"]);
    expect(byName.create_task.required).toEqual(["target_agent_id", "title"]);
    expect(byName.upload_file.required).toEqual(["filename", "mime_type", "base64_content"]);
    expect(byName.get_task.required).toEqual(["task_id"]);
    expect(byName.approve_task.required).toEqual(["task_id"]);
    expect(byName.reject_task.required).toEqual(["task_id"]);
    expect(byName.list_tasks.required).toBeUndefined();
    expect(byName.list_connections.required).toBeUndefined();
    expect(byName.discover_agents.required).toBeUndefined();
    expect(byName.generate_pairing_code.required).toBeUndefined();
  });

  it("05-05: update_status enum values match hub API", () => {
    const statusTool = defs.find((d) => d.function.name === "update_status")!;
    const statusEnum = (statusTool.function.parameters as any).properties.status.enum;
    expect(statusEnum).toEqual(["working", "completed", "failed", "input-required"]);
  });

  it("05-06: tool names are unique", () => {
    const names = defs.map((d) => d.function.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
