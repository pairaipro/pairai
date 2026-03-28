# 07 — Poll Loop Tests

**Module:** `bridge/poll.ts`
**Complements existing:** `bridge/poll.test.ts` (5 tests)

---

### 07-01: pollOnce refreshes public keys from /connections
**Severity:** High
**Type:** Unit
**Spec ref:** Poll Loop — step 1

**Setup:**
- Mock hub returning connections with public keys
- PollDeps with empty pubKeys map

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- deps.pubKeys now contains entries from /connections response
- GET /connections was called

---

### 07-02: pollOnce skips processing when hasUpdates=false
**Severity:** Medium
**Type:** Unit
**Spec ref:** Poll Loop — step 1

**Setup:**
- Mock hub returning `{ hasUpdates: false, pendingTasks: [], unreadMessages: [], cursor: 0 }`

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- No calls to hub.post for messages
- No calls to openrouter.chatCompletion
- No /updates/ack call

---

### 07-03: pollOnce processes pending tasks and unread messages
**Severity:** Critical
**Type:** Unit
**Spec ref:** Poll Loop — steps 2 and 3

**Setup:**
- Mock hub returning updates with 1 pending task and 1 unread message group
- Mock OpenRouter returning text reply

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- processTask called for pending task
- processUnreadMessages called for unread message task
- Both result in OpenRouter calls
- Both result in hub.post for messages

---

### 07-04: pollOnce acknowledges cursor after processing
**Severity:** High
**Type:** Unit
**Spec ref:** Poll Loop — step 4

**Setup:**
- Mock hub returning updates with cursor=42

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- POST /updates/ack called with `{ cursor: 42 }`

---

### 07-05: pollOnce skips already-seen task IDs
**Severity:** High
**Type:** Unit
**Spec ref:** Poll Loop — Deduplication

**Setup:**
- Mock hub returning pending task "task-001"
- seenTasks already contains "task-001"

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- No OpenRouter call for task-001
- No reply posted for task-001

---

### 07-06: Seen set GC triggers at >10K entries
**Severity:** Low
**Type:** Unit
**Spec ref:** Poll Loop — Deduplication

**Setup:**
- seenTasks Set with 10,001 entries
- Mock hub returning hasUpdates=true with 1 task

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- seenTasks.size reduced (approximately 5001 + new entries)

---

### 07-07: processTask sets status to working before OpenRouter call
**Severity:** High
**Type:** Unit
**Spec ref:** Poll Loop — Process pending tasks

**Setup:**
- Mock deps with call order tracking

**Steps:**
1. Call `processTask("task-001", deps)`
2. Check call order

**Expected:**
- hub.patch called with status "working" BEFORE openrouter.chatCompletion

---

### 07-08: processTask sends model reply as message
**Severity:** Critical
**Type:** Unit
**Spec ref:** Poll Loop — Process pending tasks

**Setup:**
- Mock OpenRouter returning "I'll help with that."

**Steps:**
1. Call `processTask("task-001", deps)`

**Expected:**
- hub.post called with `/tasks/task-001/messages`
- Body: `{ content: "I'll help with that.", contentType: "text" }`

---

### 07-09: processTask executes multi-step tool call loop
**Severity:** Critical
**Type:** Unit
**Spec ref:** Tools — Tool call execution loop

**Setup:**
- Mock OpenRouter: first call returns tool_calls (list_connections), second call returns text reply

**Steps:**
1. Call `processTask("task-001", deps)`

**Expected:**
- OpenRouter called twice
- First call includes tools parameter
- Second call includes tool result as role="tool" message
- Final reply posted to hub

---

### 07-10: processUnreadMessages fetches full task with history
**Severity:** High
**Type:** Unit
**Spec ref:** Poll Loop — Process unread messages

**Setup:**
- Mock hub returning task with 3 messages

**Steps:**
1. Call `processUnreadMessages("task-001", deps)`

**Expected:**
- hub.get called with `/tasks/task-001`
- OpenRouter receives messages array including all 3 history messages

---

### 07-11: processUnreadMessages maps history to correct roles
**Severity:** High
**Type:** Unit
**Spec ref:** Context Building — Conversation history

**Setup:**
- Task with messages: other->"Hi", me->"Hello", other->"Help?"

**Steps:**
1. Call `processUnreadMessages("task-001", deps)`
2. Inspect messages sent to OpenRouter

**Expected:**
- Messages mapped: user, assistant, user (after system + description)

---

### 07-12: Connection lookup failure falls back to agentId
**Severity:** Medium
**Type:** Unit
**Spec ref:** Poll Loop

**Setup:**
- Mock hub.get("/connections") throws error

**Steps:**
1. Call `processTask("task-001", deps)`

**Expected:**
- Does not throw
- Sender name in system message falls back to agent ID string
- OpenRouter still called, reply still sent
