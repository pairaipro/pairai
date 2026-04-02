import { nanoid } from "nanoid";
import type { HubClient } from "./hub.js";
import type { ToolDef, OpenRouterClient } from "./openrouter.js";

export interface EncryptFn {
  (plaintext: string, taskId: string, recipientPubKeys: Record<string, string>):
    { ciphertext: string; signature: string; encryptedKeys: Record<string, string> };
}

export interface ToolContext {
  hub: HubClient;
  taskId: string;
  agentId: string;
  encrypt: EncryptFn | undefined;
  pubKeys?: Record<string, string>;
  openrouter: OpenRouterClient;
  imageModel?: string;
}

export function getToolDefs(): ToolDef[] {
  return [
    {
      type: "function",
      function: {
        name: "reply",
        description: "Send a text message to the current task",
        parameters: {
          type: "object",
          properties: { message: { type: "string", description: "The message text" } },
          required: ["message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_status",
        description: "Set task status to input-required when you need more information. Do NOT set completed or failed — the system handles that automatically after your final reply.",
        parameters: {
          type: "object",
          properties: { status: { type: "string", enum: ["working", "input-required"] } },
          required: ["status"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_task",
        description: "Create a new task with a connected agent",
        parameters: {
          type: "object",
          properties: {
            target_agent_id: { type: "string", description: "The agent to assign the task to" },
            title: { type: "string", description: "Short task title" },
            description: { type: "string", description: "Detailed task description" },
          },
          required: ["target_agent_id", "title"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "upload_file",
        description: "Upload a file to the current task (base64-encoded content)",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string" },
            mime_type: { type: "string" },
            base64_content: { type: "string", description: "File content as base64" },
          },
          required: ["filename", "mime_type", "base64_content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_tasks",
        description: "List tasks, optionally filtered by status",
        parameters: {
          type: "object",
          properties: { status: { type: "string", enum: ["submitted", "working", "input-required", "completed", "failed", "cancelled"] } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_task",
        description: "Get full task details and messages",
        parameters: {
          type: "object",
          properties: { task_id: { type: "string" } },
          required: ["task_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_connections",
        description: "List all connected agents and their profiles",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "discover_agents",
        description: "Search the agent directory by capability or name",
        parameters: {
          type: "object",
          properties: {
            capability: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "generate_pairing_code",
        description: "Generate a pairing code for another agent to connect (10-min TTL)",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "approve_task",
        description: "Approve a pending task",
        parameters: {
          type: "object",
          properties: { task_id: { type: "string" } },
          required: ["task_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "reject_task",
        description: "Reject a pending task",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            reason: { type: "string" },
          },
          required: ["task_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "disconnect",
        description: "Disconnect from an agent. Cascades: cancels active tasks, notifies the other agent.",
        parameters: {
          type: "object",
          properties: {
            connection_id: { type: "string", description: "Connection ID to delete" },
          },
          required: ["connection_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "generate_image",
        description: "Generate an image and upload it to the current task as a file attachment. Uses the image generation model configured for this agent.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Detailed description of the image to generate" },
            filename: { type: "string", description: "Output filename (e.g. 'logo-v1.png')" },
          },
          required: ["prompt", "filename"],
        },
      },
    },
  ];
}

export async function executeTool(
  name: string,
  argsJson: string,
  ctx: ToolContext,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: "Invalid tool arguments — malformed JSON" });
  }

  try {
    switch (name) {
      case "reply": {
        const message = args.message as string;
        let body: Record<string, unknown>;
        if (ctx.encrypt && ctx.pubKeys) {
          const envelope = JSON.stringify({ contentType: "text", body: message });
          const enc = ctx.encrypt(envelope, ctx.taskId, ctx.pubKeys);
          body = {
            content: enc.ciphertext,
            contentType: "encrypted",
            encryptedKeys: enc.encryptedKeys,
            senderSignature: enc.signature,
          };
        } else {
          body = { content: message, contentType: "text" };
        }
        const result = await ctx.hub.post(`/tasks/${ctx.taskId}/messages`, body);
        return JSON.stringify(result);
      }

      case "update_status": {
        // Block terminal statuses — the bridge sets these after delivering the reply
        if (args.status === "completed" || args.status === "failed") {
          return JSON.stringify({ error: `Do not set status to "${args.status}" directly. Just provide your final reply — the bridge will complete the task automatically.` });
        }
        const result = await ctx.hub.patch(`/tasks/${ctx.taskId}`, { status: args.status });
        return JSON.stringify(result);
      }

      case "create_task": {
        const targetId = args.target_agent_id as string;
        const title = args.title as string;
        const desc = (args.description as string) ?? "";

        // Auto-encrypt when both agents have public keys
        if (ctx.encrypt && ctx.pubKeys && ctx.pubKeys[targetId] && ctx.pubKeys[ctx.agentId]) {
          const taskId = nanoid();
          const payload = JSON.stringify({ title, description: desc });
          const enc = ctx.encrypt(payload, taskId, {
            [ctx.agentId]: ctx.pubKeys[ctx.agentId]!,
            [targetId]: ctx.pubKeys[targetId]!,
          });
          const result = await ctx.hub.post("/tasks", {
            id: taskId,
            targetAgentId: targetId,
            title: "Encrypted Task",
            description: enc.ciphertext,
            encrypted: true,
            descriptionKeys: enc.encryptedKeys,
            senderSignature: enc.signature,
          });
          return JSON.stringify(result);
        }

        // Fallback: plaintext
        const result = await ctx.hub.post("/tasks", {
          targetAgentId: targetId,
          title,
          description: desc,
        });
        return JSON.stringify(result);
      }

      case "upload_file": {
        // Check if task is encrypted — encrypt file if so (matches generate_image behavior)
        const taskData = (await ctx.hub.get(`/tasks/${ctx.taskId}`)) as { encrypted?: boolean };
        if (taskData.encrypted && ctx.encrypt && ctx.pubKeys) {
          const envelope = JSON.stringify({
            filename: args.filename,
            mimeType: args.mime_type,
            data: args.base64_content,
          });
          const enc = ctx.encrypt(envelope, ctx.taskId, ctx.pubKeys);
          const result = await ctx.hub.post(`/tasks/${ctx.taskId}/files/json`, {
            filename: "encrypted_file",
            mimeType: "application/octet-stream",
            base64Content: enc.ciphertext,
            encryptedKeys: enc.encryptedKeys,
            senderSignature: enc.signature,
          });
          return JSON.stringify(result);
        }
        const result = await ctx.hub.post(`/tasks/${ctx.taskId}/files/json`, {
          filename: args.filename,
          mimeType: args.mime_type,
          base64Content: args.base64_content,
        });
        return JSON.stringify(result);
      }

      case "list_tasks": {
        const query = args.status ? `?status=${args.status}` : "";
        const result = await ctx.hub.get(`/tasks${query}`);
        return JSON.stringify(result);
      }

      case "get_task": {
        const result = await ctx.hub.get(`/tasks/${args.task_id}`);
        return JSON.stringify(result);
      }

      case "list_connections": {
        const result = await ctx.hub.get("/connections");
        return JSON.stringify(result);
      }

      case "discover_agents": {
        const params = new URLSearchParams();
        if (args.capability) params.set("capability", args.capability as string);
        if (args.query) params.set("q", args.query as string);
        if (args.limit) params.set("limit", String(args.limit));
        const qs = params.toString();
        const result = await ctx.hub.get(`/agents/discover${qs ? "?" + qs : ""}`);
        return JSON.stringify(result);
      }

      case "generate_pairing_code": {
        const result = await ctx.hub.post("/pair/generate");
        return JSON.stringify(result);
      }

      case "approve_task": {
        const result = await ctx.hub.post(`/approvals/${args.task_id}/approve`);
        return JSON.stringify(result);
      }

      case "reject_task": {
        const result = await ctx.hub.post(`/approvals/${args.task_id}/reject`, { reason: args.reason });
        return JSON.stringify(result);
      }

      case "disconnect": {
        const result = await ctx.hub.delete(`/connections/${args.connection_id}`);
        return JSON.stringify(result);
      }

      case "generate_image": {
        const { prompt, filename } = args as { prompt: string; filename: string };
        const result = await ctx.openrouter.imageGeneration(ctx.imageModel ?? "google/gemini-3.1-flash-image-preview", prompt);
        const mime = result.mimeType;

        if (ctx.encrypt && ctx.pubKeys) {
          const envelope = JSON.stringify({ filename, mimeType: mime, data: result.base64 });
          const enc = ctx.encrypt(envelope, ctx.taskId, ctx.pubKeys);
          await ctx.hub.post(`/tasks/${ctx.taskId}/files/json`, {
            filename,
            mimeType: mime,
            base64Content: enc.ciphertext,
            encryptedKeys: enc.encryptedKeys,
            senderSignature: enc.signature,
          });
        } else {
          await ctx.hub.post(`/tasks/${ctx.taskId}/files/json`, {
            filename,
            mimeType: mime,
            base64Content: result.base64,
          });
        }

        // Report image generation cost
        if (result.generationId) {
          try {
            const cost = await ctx.openrouter.getGenerationCost(result.generationId);
            if (cost !== null && cost > 0) {
              await ctx.hub.post(`/tasks/${ctx.taskId}/usage`, { cost });
            }
          } catch (err) {
            console.error(`[bridge] image cost report failed for task ${ctx.taskId}: ${(err as Error).message}`);
          }
        }

        return `Image generated and uploaded as "${filename}".${result.revisedPrompt ? ` Revised prompt: ${result.revisedPrompt}` : ""}`;
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}
