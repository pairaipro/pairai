import type { BridgeConfig } from "./config.js";
import type { HubClient } from "./hub.js";
import type { OpenRouterClient, ChatMessage } from "./openrouter.js";
import { buildMessages, type TaskMessage } from "./context.js";
import { getToolDefs, executeTool, type ToolContext } from "./tools.js";
import { localEncrypt, localDecrypt } from "../channel/lib.js";

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

async function callOpenRouterWithTools(
  messages: ChatMessage[],
  deps: PollDeps,
  toolCtx: ToolContext,
): Promise<string> {
  const tools = getToolDefs();
  const currentMessages = [...messages];

  for (let round = 0; round <= MAX_TOOL_CALLS; round++) {
    const result = await deps.openrouter.chatCompletion(
      deps.config.model,
      currentMessages,
      { temperature: deps.config.temperature, max_tokens: deps.config.max_reply_tokens },
      tools,
    );

    const msg = result.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content ?? "";
    }

    if (round === MAX_TOOL_CALLS) {
      throw new ToolCallLimitError();
    }

    currentMessages.push(msg);
    for (const tc of msg.tool_calls) {
      const toolResult = await executeTool(tc.function.name, tc.function.arguments, toolCtx);
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
  deps.log(`Received task ${taskId} — fetching details...`);
  const task = await fetchTaskWithMessages(taskId, deps);
  const otherId = otherAgentId(task, deps.agentId);

  // Auto-accept: set to working
  try {
    await deps.hub.patch(`/tasks/${taskId}`, { status: "working" });
    deps.log(`Task ${taskId} — status set to "working"`);
  } catch {
    // May already be in a different status
  }

  // Decrypt
  const description = task.encrypted && deps.privateKey
    ? decryptTaskDescription(task, deps.agentId, deps.myPublicKey, deps.privateKey, deps.pubKeys)
    : task.description ?? "";
  if (task.encrypted) deps.log(`Task ${taskId} — decrypted${deps.privateKey ? "" : " (no private key, raw)"}`);
  const decryptedMessages = decryptMessages(task, deps);

  // Resolve sender
  const sender = await resolveSender(deps, otherId);
  deps.log(`Task ${taskId} — "${task.title}" from ${sender.name}, ${decryptedMessages.length} message(s)`);
  const taskData = buildTaskData(task, description, sender.name, sender.description, sender.capabilities);

  const messages = buildMessages(
    deps.config.system_prompt,
    taskData,
    decryptedMessages,
    deps.agentId,
    deps.config.max_history_tokens,
  );

  const { encryptFn, pubKeysObj } = buildEncryptionContext(task, deps, otherId);

  const toolCtx: ToolContext = {
    hub: deps.hub,
    taskId,
    agentId: deps.agentId,
    encrypt: encryptFn,
    pubKeys: pubKeysObj,
  };

  try {
    deps.log(`Task ${taskId} — sending to model (${deps.config.model})...`);
    const reply = await callOpenRouterWithTools(messages, deps, toolCtx);
    if (reply) {
      deps.log(`Task ${taskId} — got reply (${reply.length} chars), sending to hub${encryptFn ? " (encrypted)" : ""}...`);
      await sendReplyOrError(taskId, reply, encryptFn, pubKeysObj, deps);
      deps.log(`Task ${taskId} — reply delivered`);
    } else {
      deps.log(`Task ${taskId} — model returned empty response`);
    }
  } catch (err) {
    // Sanitize error messages — strip raw API error bodies that may contain keys
    const rawMsg = (err as Error).message ?? "unknown error";
    const safeMsg = rawMsg.length > 200 ? rawMsg.slice(0, 200) + "..." : rawMsg;
    const errMsg = err instanceof ToolCallLimitError
      ? `[Bridge error] Tool call limit exceeded — possible loop`
      : `[Bridge error] ${safeMsg.replace(/sk-[a-zA-Z0-9_-]+/g, "sk-***")}`;
    deps.log(`Task ${taskId} — ERROR: ${errMsg}`);

    try {
      await deps.hub.post(`/tasks/${taskId}/messages`, { content: errMsg, contentType: "text" });
      await deps.hub.patch(`/tasks/${taskId}`, { status: "input-required" });
      deps.log(`Task ${taskId} — error reported to hub, status set to "input-required"`);
    } catch {
      deps.log(`Task ${taskId} — failed to report error to hub: ${(err as Error).message}`);
    }
  }
}

export async function processUnreadMessages(taskId: string, deps: PollDeps): Promise<void> {
  deps.log(`New message(s) on task ${taskId} — fetching history...`);
  const task = await fetchTaskWithMessages(taskId, deps);

  // Skip if the latest message is from us — nothing new to respond to
  const lastMsg = task.messages[task.messages.length - 1];
  if (lastMsg && lastMsg.senderAgentId === deps.agentId) {
    deps.log(`Task ${taskId} — last message is ours, skipping`);
    return;
  }

  const otherId = otherAgentId(task, deps.agentId);

  const description = task.encrypted && deps.privateKey
    ? decryptTaskDescription(task, deps.agentId, deps.myPublicKey, deps.privateKey, deps.pubKeys)
    : task.description ?? "";
  const decryptedMessages = decryptMessages(task, deps);
  deps.log(`Task ${taskId} — ${decryptedMessages.length} message(s) in history`);

  const sender = await resolveSender(deps, otherId);
  const taskData = buildTaskData(task, description, sender.name, sender.description, sender.capabilities);

  const messages = buildMessages(
    deps.config.system_prompt,
    taskData,
    decryptedMessages,
    deps.agentId,
    deps.config.max_history_tokens,
  );

  const { encryptFn, pubKeysObj } = buildEncryptionContext(task, deps, otherId);

  const toolCtx: ToolContext = {
    hub: deps.hub,
    taskId,
    agentId: deps.agentId,
    encrypt: encryptFn,
    pubKeys: pubKeysObj,
  };

  try {
    deps.log(`Task ${taskId} — sending to model (${deps.config.model})...`);
    const reply = await callOpenRouterWithTools(messages, deps, toolCtx);
    if (reply) {
      deps.log(`Task ${taskId} — got reply (${reply.length} chars), sending to hub${encryptFn ? " (encrypted)" : ""}...`);
      await sendReplyOrError(taskId, reply, encryptFn, pubKeysObj, deps);
      deps.log(`Task ${taskId} — reply delivered`);
    } else {
      deps.log(`Task ${taskId} — model returned empty response`);
    }
  } catch (err) {
    // Sanitize error messages — strip raw API error bodies that may contain keys
    const rawMsg = (err as Error).message ?? "unknown error";
    const safeMsg = rawMsg.length > 200 ? rawMsg.slice(0, 200) + "..." : rawMsg;
    const errMsg = err instanceof ToolCallLimitError
      ? `[Bridge error] Tool call limit exceeded — possible loop`
      : `[Bridge error] ${safeMsg.replace(/sk-[a-zA-Z0-9_-]+/g, "sk-***")}`;
    deps.log(`Task ${taskId} — ERROR: ${errMsg}`);

    try {
      await deps.hub.post(`/tasks/${taskId}/messages`, { content: errMsg, contentType: "text" });
      await deps.hub.patch(`/tasks/${taskId}`, { status: "input-required" });
      deps.log(`Task ${taskId} — error reported to hub, status set to "input-required"`);
    } catch {
      deps.log(`Task ${taskId} — failed to report error to hub: ${(err as Error).message}`);
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

  for (const t of updates.pendingTasks) {
    if (seenTasks.has(t.id)) continue;
    seenTasks.add(t.id);
    deps.log(`Processing new task: ${t.id}`);
    await processTask(t.id, deps);
  }

  for (const u of updates.unreadMessages) {
    deps.log(`Processing unread messages for task: ${u.taskId}`);
    await processUnreadMessages(u.taskId, deps);
  }

  // Do NOT ack the hub here. The seenTasks Set prevents re-processing within
  // this session. The hub's lastSeenRowid should only advance via explicit user
  // action, not automatically — prevents message loss if bridge crashes mid-processing.
  // (See v0.3.2 poll-ack race fix in channel/pairai.ts)

  // GC seen set — delete only excess entries (not bulk 5000)
  if (seenTasks.size > 10_000) {
    const excess = seenTasks.size - 10_000;
    const iter = seenTasks.values();
    for (let i = 0; i < excess; i++) seenTasks.delete(iter.next().value!);
  }
}
