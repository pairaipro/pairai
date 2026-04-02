import type { BridgeConfig } from "./config.js";
import type { HubClient } from "./hub.js";
import type { OpenRouterClient, ChatMessage } from "./openrouter.js";
import { buildMessages, type TaskMessage } from "./context.js";
import { getToolDefs, executeTool, type ToolContext } from "./tools.js";
import { localEncrypt, localDecrypt } from "../channel/lib.js";
import { computeCost } from "./pricing.js";

const MAX_TOOL_CALLS = 10;

interface HubTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  encrypted?: boolean;
  initiatorAgentId: string;
  targetAgentId: string;
  descriptionKeys?: string | Record<string, string>;
  senderSignature?: string;
  approvalStatus?: string;
  createdAt?: string;
  messages: Array<{
    id: string;
    senderAgentId: string;
    content: string;
    contentType: string;
    createdAt: string;
    encryptedKeys?: string | Record<string, string>;
    senderSignature?: string;
  }>;
}

export interface PollDeps {
  hub: HubClient;
  openrouter: OpenRouterClient;
  config: BridgeConfig;
  agentId: string;
  privateKey: string | null;
  myPublicKey: string;
  pubKeys: Map<string, string>;
  log: (msg: string) => void;
}

/** Prefixed logger for a specific task */
function taskLog(deps: PollDeps, taskId: string, phase: string, msg: string) {
  deps.log(`[task:${taskId}] [${phase}] ${msg}`);
}

function otherAgentId(task: HubTask, myId: string): string {
  return task.initiatorAgentId === myId ? task.targetAgentId : task.initiatorAgentId;
}

function decryptMessage(
  msg: { content: string; contentType: string; senderAgentId: string; encryptedKeys?: string | Record<string, string>; senderSignature?: string },
  taskId: string,
  myAgentId: string,
  myPublicKey: string,
  privateKey: string,
  pubKeys: Map<string, string>,
): { content: string; contentType: string } {
  if (msg.contentType !== "encrypted" || !msg.encryptedKeys || !msg.senderSignature) {
    return { content: msg.content, contentType: msg.contentType };
  }
  try {
    const keys = typeof msg.encryptedKeys === "string" ? JSON.parse(msg.encryptedKeys) as Record<string, string> : msg.encryptedKeys;
    const senderPub = msg.senderAgentId === myAgentId ? myPublicKey : pubKeys.get(msg.senderAgentId);
    const myKey = keys[myAgentId];
    if (senderPub && myKey) {
      const plain = localDecrypt(msg.content, msg.senderSignature, taskId, senderPub, myKey, privateKey);
      const envelope = JSON.parse(plain) as { contentType: string; body: string };
      return { content: envelope.body, contentType: envelope.contentType };
    }
  } catch {
    return { content: "[decryption failed]", contentType: "text" };
  }
  return { content: msg.content, contentType: msg.contentType };
}

function decryptTaskDescription(
  task: HubTask,
  myAgentId: string,
  myPublicKey: string,
  privateKey: string,
  pubKeys: Map<string, string>,
): string {
  if (!task.encrypted || !task.description || !task.descriptionKeys || !task.senderSignature) {
    return task.description ?? "";
  }
  try {
    const keys = typeof task.descriptionKeys === "string" ? JSON.parse(task.descriptionKeys) as Record<string, string> : task.descriptionKeys;
    const senderPub = task.initiatorAgentId === myAgentId ? myPublicKey : pubKeys.get(task.initiatorAgentId);
    const myKey = keys[myAgentId];
    if (senderPub && myKey) {
      const plain = localDecrypt(task.description, task.senderSignature, task.id, senderPub, myKey, privateKey);
      const envelope = JSON.parse(plain) as { title: string; description?: string };
      return `${envelope.title}${envelope.description ? "\n\n" + envelope.description : ""}`;
    }
  } catch {
    return "[encrypted task — decryption failed]";
  }
  return task.description ?? "";
}

class ToolCallLimitError extends Error {
  constructor() {
    super(`Model exceeded tool call limit (${MAX_TOOL_CALLS})`);
    this.name = "ToolCallLimitError";
  }
}

function sanitizeError(rawMsg: string): string {
  const truncated = rawMsg.length > 200 ? rawMsg.slice(0, 200) + "..." : rawMsg;
  return truncated
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, "sk-***")
    .replace(/or-[a-zA-Z0-9_-]{10,}/g, "or-***")
    .replace(/Bearer\s+[^\s"]{20,}/g, "Bearer ***");
}

async function callOpenRouterWithTools(
  messages: ChatMessage[],
  deps: PollDeps,
  toolCtx: ToolContext,
): Promise<string> {
  const tools = getToolDefs();
  const currentMessages = [...messages];
  const tid = toolCtx.taskId;

  for (let round = 0; round <= MAX_TOOL_CALLS; round++) {
    taskLog(deps, tid, "model", `round=${round} messages=${currentMessages.length} tools=${tools.length} model=${deps.config.model}`);
    const result = await deps.openrouter.chatCompletion(
      deps.config.model,
      currentMessages,
      { temperature: deps.config.temperature, max_tokens: deps.config.max_reply_tokens },
      tools,
    );

    const msg = result.message;
    const contentLen = (typeof msg.content === "string" ? msg.content?.length : 0) ?? 0;
    taskLog(deps, tid, "model", `finish_reason=${result.finish_reason} tool_calls=${msg.tool_calls?.length ?? 0} content=${contentLen}chars prompt=${result.usage.prompt_tokens} completion=${result.usage.completion_tokens} gen=${result.generationId ?? "none"}`);

    // Report actual cost from OpenRouter generation endpoint (falls back to local estimate)
    if (result.generationId) {
      try {
        const realCost = await deps.openrouter.getGenerationCost(result.generationId);
        const cost = realCost ?? computeCost(deps.config.model, result.usage.prompt_tokens, result.usage.completion_tokens);
        if (cost !== null && cost > 0) {
          await deps.hub.post(`/tasks/${tid}/usage`, { cost });
          taskLog(deps, tid, "usage", `reported $${cost.toFixed(6)} ${realCost !== null ? "(actual from OpenRouter)" : "(estimated from cached pricing)"} gen=${result.generationId}`);
        }
      } catch (err) {
        taskLog(deps, tid, "usage", `FAILED to report cost: ${(err as Error).message}`);
      }
    } else {
      const cost = computeCost(deps.config.model, result.usage.prompt_tokens, result.usage.completion_tokens);
      if (cost !== null && cost > 0) {
        try {
          await deps.hub.post(`/tasks/${tid}/usage`, { cost });
          taskLog(deps, tid, "usage", `reported $${cost.toFixed(6)} (estimated, no generation ID returned)`);
        } catch (err) {
          taskLog(deps, tid, "usage", `FAILED to report cost: ${(err as Error).message}`);
        }
      }
    }

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      taskLog(deps, tid, "model", `final response: ${contentLen} chars (no tool calls)`);
      return msg.content ?? "";
    }

    if (round === MAX_TOOL_CALLS) {
      throw new ToolCallLimitError();
    }

    currentMessages.push(msg);
    for (const tc of msg.tool_calls) {
      const argsPreview = tc.function.arguments.length > 200 ? tc.function.arguments.slice(0, 200) + "..." : tc.function.arguments;
      taskLog(deps, tid, "tool", `calling ${tc.function.name}(${argsPreview})`);
      const toolResult = await executeTool(tc.function.name, tc.function.arguments, toolCtx);
      const resultPreview = toolResult.length > 300 ? toolResult.slice(0, 300) + "..." : toolResult;
      taskLog(deps, tid, "tool", `${tc.function.name} returned ${toolResult.length} chars: ${resultPreview}`);
      currentMessages.push({
        role: "tool",
        content: toolResult,
        tool_call_id: tc.id,
      });
    }
  }

  throw new ToolCallLimitError();
}

function buildTaskData(
  task: HubTask,
  description: string,
  senderName: string,
  senderDescription?: string,
  senderCapabilities?: string[],
) {
  return {
    id: task.id,
    title: task.title,
    description,
    status: task.status,
    encrypted: task.encrypted ?? false,
    createdAt: task.createdAt ?? new Date().toISOString(),
    senderName,
    senderDescription,
    senderCapabilities,
  };
}

function buildEncryptionContext(
  task: HubTask,
  deps: PollDeps,
  otherId: string,
): { encryptFn: ((plaintext: string, tid: string, keys: Record<string, string>) => { ciphertext: string; signature: string; encryptedKeys: Record<string, string> }) | undefined; pubKeysObj: Record<string, string> | undefined } {
  if (!task.encrypted || !deps.privateKey) {
    return { encryptFn: undefined, pubKeysObj: undefined };
  }

  const pubKeysObj: Record<string, string> = {};
  if (deps.myPublicKey) pubKeysObj[deps.agentId] = deps.myPublicKey;
  const otherPub = deps.pubKeys.get(otherId);
  if (otherPub) pubKeysObj[otherId] = otherPub;

  const encryptFn = (plaintext: string, tid: string, recipientPubKeys: Record<string, string>) =>
    localEncrypt(plaintext, tid, deps.privateKey!, recipientPubKeys);

  return { encryptFn, pubKeysObj };
}

function decryptMessages(task: HubTask, deps: PollDeps): TaskMessage[] {
  return task.messages.map((m) => {
    if (task.encrypted && deps.privateKey) {
      const dec = decryptMessage(m, task.id, deps.agentId, deps.myPublicKey, deps.privateKey, deps.pubKeys);
      return { id: m.id, senderAgentId: m.senderAgentId, content: dec.content, contentType: dec.contentType, createdAt: m.createdAt };
    }
    return { id: m.id, senderAgentId: m.senderAgentId, content: m.content, contentType: m.contentType, createdAt: m.createdAt };
  });
}

async function resolveSender(deps: PollDeps, otherId: string): Promise<{ name: string; description?: string; capabilities?: string[] }> {
  try {
    const conns = (await deps.hub.get("/connections")) as Array<{ agentId: string; name?: string; description?: string; capabilities?: string[] }>;
    const sender = conns.find((c) => c.agentId === otherId);
    if (sender) {
      return { name: sender.name ?? otherId, description: sender.description, capabilities: sender.capabilities };
    }
  } catch {}
  return { name: otherId };
}

async function sendReplyOrError(
  taskId: string,
  reply: string,
  encryptFn: ((plaintext: string, tid: string, keys: Record<string, string>) => { ciphertext: string; signature: string; encryptedKeys: Record<string, string> }) | undefined,
  pubKeysObj: Record<string, string> | undefined,
  deps: PollDeps,
): Promise<void> {
  let body: Record<string, unknown>;
  if (encryptFn && pubKeysObj) {
    const envelope = JSON.stringify({ contentType: "text", body: reply });
    const enc = encryptFn(envelope, taskId, pubKeysObj);
    body = { content: enc.ciphertext, contentType: "encrypted", encryptedKeys: enc.encryptedKeys, senderSignature: enc.signature };
  } else {
    body = { content: reply, contentType: "text" };
  }
  await deps.hub.post(`/tasks/${taskId}/messages`, body);
}

async function fetchTaskWithMessages(taskId: string, deps: PollDeps): Promise<HubTask> {
  const task = (await deps.hub.get(`/tasks/${taskId}`)) as HubTask;
  if (!task.messages) {
    const msgs = (await deps.hub.get(`/tasks/${taskId}/messages`)) as HubTask["messages"];
    task.messages = msgs ?? [];
  }
  return task;
}

export async function processTask(taskId: string, deps: PollDeps): Promise<void> {
  taskLog(deps, taskId, "fetch", "new task received, fetching details from hub");
  const task = await fetchTaskWithMessages(taskId, deps);
  const otherId = otherAgentId(task, deps.agentId);
  taskLog(deps, taskId, "fetch", `title="${task.title}" status=${task.status} encrypted=${!!task.encrypted} from=${task.initiatorAgentId} messages=${task.messages.length}`);

  // Auto-accept: set to working
  try {
    await deps.hub.patch(`/tasks/${taskId}`, { status: "working" });
    taskLog(deps, taskId, "status", "set to working");
  } catch (err) {
    taskLog(deps, taskId, "status", `failed to set working (may already be in another state): ${(err as Error).message}`);
  }

  // Decrypt
  const description = task.encrypted && deps.privateKey
    ? decryptTaskDescription(task, deps.agentId, deps.myPublicKey, deps.privateKey, deps.pubKeys)
    : task.description ?? "";
  if (task.encrypted) {
    taskLog(deps, taskId, "decrypt", deps.privateKey ? `decrypted task description (${description.length} chars)` : "no private key, using raw ciphertext");
  }
  const decryptedMessages = decryptMessages(task, deps);
  taskLog(deps, taskId, "decrypt", `${decryptedMessages.length} message(s) decrypted`);

  // Resolve sender
  const sender = await resolveSender(deps, otherId);
  taskLog(deps, taskId, "context", `sender="${sender.name}" capabilities=${JSON.stringify(sender.capabilities ?? [])}`);
  const taskData = buildTaskData(task, description, sender.name, sender.description, sender.capabilities);

  const messages = buildMessages(
    deps.config.system_prompt,
    taskData,
    decryptedMessages,
    deps.agentId,
    deps.config.max_history_tokens,
  );
  taskLog(deps, taskId, "context", `built ${messages.length} messages for model (max_history_tokens=${deps.config.max_history_tokens})`);

  const { encryptFn, pubKeysObj } = buildEncryptionContext(task, deps, otherId);
  if (encryptFn) taskLog(deps, taskId, "crypto", `encryption enabled, ${Object.keys(pubKeysObj ?? {}).length} public keys`);

  const toolCtx: ToolContext = {
    hub: deps.hub,
    taskId,
    agentId: deps.agentId,
    encrypt: encryptFn,
    pubKeys: pubKeysObj,
    openrouter: deps.openrouter,
    imageModel: deps.config.image_model,
  };

  try {
    taskLog(deps, taskId, "model", `sending to ${deps.config.model} (temp=${deps.config.temperature}, max_tokens=${deps.config.max_reply_tokens})`);
    const reply = await callOpenRouterWithTools(messages, deps, toolCtx);
    if (reply) {
      taskLog(deps, taskId, "reply", `got ${reply.length} chars, delivering to hub${encryptFn ? " (encrypted)" : ""}`);
      await sendReplyOrError(taskId, reply, encryptFn, pubKeysObj, deps);
      taskLog(deps, taskId, "reply", "delivered successfully");
      // Auto-complete: reply delivered successfully → mark task done
      try {
        await deps.hub.patch(`/tasks/${taskId}`, { status: "completed" });
        taskLog(deps, taskId, "status", "set to completed (auto-complete after reply)");
      } catch {
        taskLog(deps, taskId, "status", "failed to set completed (may already be terminal)");
      }
    } else {
      taskLog(deps, taskId, "reply", "WARNING: model returned empty response, no reply sent");
    }
  } catch (err) {
    // Sanitize error messages — strip raw API error bodies that may contain keys
    const rawMsg = (err as Error).message ?? "unknown error";
    const errMsg = err instanceof ToolCallLimitError
      ? `[Bridge error] Tool call limit exceeded — possible loop`
      : `[Bridge error] ${sanitizeError(rawMsg)}`;
    taskLog(deps, taskId, "error", errMsg);

    try {
      taskLog(deps, taskId, "error", `sending error message to hub${encryptFn ? " (encrypted)" : ""}`);
      await sendReplyOrError(taskId, errMsg, encryptFn, pubKeysObj, deps);
      await deps.hub.patch(`/tasks/${taskId}`, { status: "input-required" });
      taskLog(deps, taskId, "error", "error delivered, status set to input-required");
    } catch (reportErr) {
      taskLog(deps, taskId, "error", `FAILED to report error to hub: ${(reportErr as Error).message}`);
    }
  }
}

export async function processUnreadMessages(taskId: string, deps: PollDeps): Promise<void> {
  taskLog(deps, taskId, "fetch", "new message(s) received, fetching history from hub");
  const task = await fetchTaskWithMessages(taskId, deps);

  // Skip if the latest message is from us — nothing new to respond to
  const lastMsg = task.messages[task.messages.length - 1];
  if (lastMsg && lastMsg.senderAgentId === deps.agentId) {
    taskLog(deps, taskId, "skip", "last message is ours, nothing to respond to");
    return;
  }

  const otherId = otherAgentId(task, deps.agentId);
  taskLog(deps, taskId, "fetch", `title="${task.title}" status=${task.status} encrypted=${!!task.encrypted} messages=${task.messages.length}`);

  const description = task.encrypted && deps.privateKey
    ? decryptTaskDescription(task, deps.agentId, deps.myPublicKey, deps.privateKey, deps.pubKeys)
    : task.description ?? "";
  const decryptedMessages = decryptMessages(task, deps);
  taskLog(deps, taskId, "decrypt", `${decryptedMessages.length} message(s) in history`);

  const sender = await resolveSender(deps, otherId);
  taskLog(deps, taskId, "context", `sender="${sender.name}"`);
  const taskData = buildTaskData(task, description, sender.name, sender.description, sender.capabilities);

  const messages = buildMessages(
    deps.config.system_prompt,
    taskData,
    decryptedMessages,
    deps.agentId,
    deps.config.max_history_tokens,
  );
  taskLog(deps, taskId, "context", `built ${messages.length} messages for model`);

  const { encryptFn, pubKeysObj } = buildEncryptionContext(task, deps, otherId);

  const toolCtx: ToolContext = {
    hub: deps.hub,
    taskId,
    agentId: deps.agentId,
    encrypt: encryptFn,
    pubKeys: pubKeysObj,
    openrouter: deps.openrouter,
    imageModel: deps.config.image_model,
  };

  try {
    taskLog(deps, taskId, "model", `sending to ${deps.config.model}`);
    const reply = await callOpenRouterWithTools(messages, deps, toolCtx);
    if (reply) {
      taskLog(deps, taskId, "reply", `got ${reply.length} chars, delivering to hub${encryptFn ? " (encrypted)" : ""}`);
      await sendReplyOrError(taskId, reply, encryptFn, pubKeysObj, deps);
      taskLog(deps, taskId, "reply", "delivered successfully");
    } else {
      taskLog(deps, taskId, "reply", "WARNING: model returned empty response, no reply sent");
    }
  } catch (err) {
    // Sanitize error messages — strip raw API error bodies that may contain keys
    const rawMsg = (err as Error).message ?? "unknown error";
    const errMsg = err instanceof ToolCallLimitError
      ? `[Bridge error] Tool call limit exceeded — possible loop`
      : `[Bridge error] ${sanitizeError(rawMsg)}`;
    taskLog(deps, taskId, "error", errMsg);

    try {
      taskLog(deps, taskId, "error", `sending error message to hub${encryptFn ? " (encrypted)" : ""}`);
      await sendReplyOrError(taskId, errMsg, encryptFn, pubKeysObj, deps);
      await deps.hub.patch(`/tasks/${taskId}`, { status: "input-required" });
      taskLog(deps, taskId, "error", "error delivered, status set to input-required");
    } catch (reportErr) {
      taskLog(deps, taskId, "error", `FAILED to report error to hub: ${(reportErr as Error).message}`);
    }
  }
}

export async function pollOnce(deps: PollDeps, seenTasks: Set<string>): Promise<void> {
  // Refresh public keys
  try {
    const conns = (await deps.hub.get("/connections")) as Array<{ agentId: string; publicKey?: string }>;
    for (const c of conns) {
      if (c.publicKey) deps.pubKeys.set(c.agentId, c.publicKey);
    }
  } catch {}

  const updates = (await deps.hub.get("/updates")) as {
    hasUpdates: boolean;
    pendingTasks: Array<{ id: string }>;
    unreadMessages: Array<{ taskId: string }>;
    cursor: number;
  };

  if (!updates.hasUpdates) return;

  deps.log(`[poll] ${updates.pendingTasks.length} pending task(s), ${updates.unreadMessages.length} unread message(s)`);

  for (const t of updates.pendingTasks) {
    if (seenTasks.has(t.id)) continue;
    seenTasks.add(t.id);
    deps.log(`[poll] dispatching new task ${t.id}`);
    await processTask(t.id, deps);
  }

  for (const u of updates.unreadMessages) {
    deps.log(`[poll] dispatching unread messages for task ${u.taskId}`);
    await processUnreadMessages(u.taskId, deps);
  }

  // Ack the hub cursor so it stops re-delivering the same updates.
  // The bridge processes synchronously — if it crashes mid-processing, it hasn't
  // acked yet, so the hub will re-deliver on next poll. Safe to ack after processing.
  try {
    await deps.hub.post("/updates/ack", { cursor: updates.cursor });
  } catch {
    // Non-fatal — worst case is re-delivery on next poll
  }

  // GC seen set — delete only excess entries (not bulk 5000)
  if (seenTasks.size > 10_000) {
    const excess = seenTasks.size - 10_000;
    const iter = seenTasks.values();
    for (let i = 0; i < excess; i++) seenTasks.delete(iter.next().value!);
  }
}
