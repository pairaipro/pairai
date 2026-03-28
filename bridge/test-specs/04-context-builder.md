# 04 — Context Builder Tests

**Module:** `bridge/context.ts`
**Complements existing:** `bridge/context.test.ts` (4 tests)

---

### 04-01: System message includes prompt + task context block
**Severity:** High
**Type:** Unit
**Module:** bridge/context.ts
**Spec ref:** Context Building — System message

**Setup:**
- systemPrompt = "You are helpful."
- TaskData with all fields populated

**Steps:**
1. Call `buildMessages(systemPrompt, task, [], "my-agent", 32000)`

**Expected:**
- result[0].role = "system"
- result[0].content starts with "You are helpful."
- Content contains "--- Task Context ---"
- Content contains task ID, title, status, from, encrypted, created

---

### 04-02: Task context contains all fields
**Severity:** High
**Type:** Unit
**Module:** bridge/context.ts
**Spec ref:** Context Building — System message

**Setup:**
- TaskData: id="t-1", title="Fix bug", status="submitted", encrypted=true, createdAt="2026-03-27T00:00:00Z", senderName="Alice", senderDescription="A coder"

**Steps:**
1. Call buildMessages, extract system message content

**Expected:**
- Contains "Task ID: t-1"
- Contains "Title: Fix bug"
- Contains "Status: submitted"
- Contains "From: Alice (A coder)"
- Contains "Encrypted: yes"
- Contains "Created: 2026-03-27T00:00:00Z"

---

### 04-03: Sender capabilities included when present
**Severity:** Medium
**Type:** Unit
**Module:** bridge/context.ts
**Spec ref:** Context Building — System message

**Setup:**
- TaskData with senderCapabilities: ["coding", "scheduling"]

**Steps:**
1. Call buildMessages, extract system message

**Expected:**
- Contains "Capabilities: coding, scheduling"

---

### 04-04: Task description used as first user message
**Severity:** High
**Type:** Unit
**Module:** bridge/context.ts
**Spec ref:** Context Building — Conversation history

**Setup:**
- TaskData with description = "Please review this PR"

**Steps:**
1. Call buildMessages with empty messages array

**Expected:**
- result[1].role = "user"
- result[1].content = "Please review this PR"

---

### 04-05: Falls back to title when description empty
**Severity:** Medium
**Type:** Unit
**Module:** bridge/context.ts
**Spec ref:** Context Building

**Setup:**
- TaskData with description = "", title = "Review PR"

**Steps:**
1. Call buildMessages

**Expected:**
- result[1].content = "Review PR"

---

### 04-06: Messages mapped to user/assistant by sender
**Severity:** Critical
**Type:** Unit
**Module:** bridge/context.ts
**Spec ref:** Context Building — Conversation history

**Setup:**
- 4 messages alternating senderAgentId between "other" and "my-agent"

**Steps:**
1. Call buildMessages with myAgentId = "my-agent"

**Expected:**
- Messages from "other" → role: "user"
- Messages from "my-agent" → role: "assistant"
- Order preserved

---

### 04-07: Token budget truncates oldest messages
**Severity:** High
**Type:** Unit
**Module:** bridge/context.ts
**Spec ref:** Context Building — Token budget enforcement

**Setup:**
- 100 messages, each ~500 tokens (2000 chars)
- maxHistoryTokens = 4000

**Steps:**
1. Call buildMessages

**Expected:**
- Result length < 102 (system + desc + 100 msgs)
- System message present
- Last 2 messages present
- Truncation occurred

---

### 04-08: Truncation marker inserted with correct count
**Severity:** Medium
**Type:** Unit
**Module:** bridge/context.ts
**Spec ref:** Context Building — Token budget enforcement

**Setup:**
- 20 messages, budget allows only 5

**Steps:**
1. Call buildMessages
2. Find message containing "truncated"

**Expected:**
- One message with role "user" contains "[Earlier messages truncated — N messages omitted]"
- N equals the number of omitted messages

---

### 04-09: Always keeps system + description + last 2 messages
**Severity:** Critical
**Type:** Unit
**Module:** bridge/context.ts
**Spec ref:** Context Building — Token budget enforcement

**Setup:**
- 50 messages with huge content (5000 chars each)
- Very small budget (1000 tokens)

**Steps:**
1. Call buildMessages

**Expected:**
- result.length >= 4 (system + description + last 2)
- result[0].role = "system"
- Last 2 messages are the final 2 from input

---

### 04-10: Zero messages produces system + description only
**Severity:** Medium
**Type:** Unit
**Module:** bridge/context.ts
**Spec ref:** Context Building

**Setup:**
- Empty messages array

**Steps:**
1. Call buildMessages

**Expected:**
- result.length = 2
- result[0].role = "system"
- result[1].role = "user" (description)
