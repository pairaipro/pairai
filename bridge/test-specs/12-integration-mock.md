# 12 — Integration Tests (Mock Hub + Mock OpenRouter)

**Module:** `bridge/poll.ts` + all modules
**Complements existing:** `bridge/integration.test.ts` (1 test)

These tests use mock HTTP servers for both the hub and OpenRouter to test complete poll cycles without external dependencies.

---

### 12-01: Full cycle: new task → working → OpenRouter → reply
**Severity:** Critical
**Type:** Integration
**Module:** bridge/poll.ts
**Spec ref:** Poll Loop — full cycle

**Setup:**
- Mock hub with 1 pending task (status=submitted, no messages)
- Mock OpenRouter returning "I can help with that."

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- Hub receives PATCH to set status "working"
- Hub receives POST with reply message "I can help with that."
- Hub receives POST /updates/ack
- OpenRouter received system prompt with task context

---

### 12-02: Full cycle with tool call: task → tool → final reply
**Severity:** Critical
**Type:** Integration
**Module:** bridge/poll.ts
**Spec ref:** Tools — Tool call execution loop

**Setup:**
- Mock hub with 1 pending task
- Mock OpenRouter: first response has tool_calls [{name: "list_connections"}], second response has text "You have 2 connections."
- Mock hub /connections returns 2 agents

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- OpenRouter called twice
- Second call's messages include tool result from list_connections
- Final reply "You have 2 connections." posted to hub

---

### 12-03: Unread message on existing task triggers new OpenRouter call
**Severity:** High
**Type:** Integration
**Module:** bridge/poll.ts
**Spec ref:** Poll Loop — Process unread messages

**Setup:**
- Mock hub: no pending tasks, 1 unread message group (taskId: "task-001", count: 1)
- Mock hub /tasks/task-001 returns task with 3 messages (history)
- Mock OpenRouter returning reply

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- OpenRouter receives full message history (system + desc + 3 messages)
- Reply posted to hub

---

### 12-04: Multiple pending tasks processed in sequence
**Severity:** High
**Type:** Integration
**Module:** bridge/poll.ts
**Spec ref:** Poll Loop — sequential processing

**Setup:**
- Mock hub with 2 pending tasks: task-001, task-002
- Mock OpenRouter returning different replies per call

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- Both tasks processed (2 OpenRouter calls)
- Replies posted to both tasks
- seenTasks contains both IDs

---

### 12-05: OpenRouter error reported back to mock hub
**Severity:** Critical
**Type:** Integration
**Module:** bridge/poll.ts
**Spec ref:** Error Handling

**Setup:**
- Mock hub with 1 pending task
- Mock OpenRouter returning 500

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- Hub receives error message containing "[Bridge error]"
- Hub receives PATCH with status "input-required"
- /updates/ack still called

---

### 12-06: Encrypted task: decrypt → OpenRouter → encrypt reply
**Severity:** Critical
**Type:** Integration
**Module:** bridge/poll.ts
**Spec ref:** E2E Encryption + Poll Loop

**Setup:**
- Generate 2 RSA-4096 keypairs (initiator + bridge)
- Create encrypted task: localEncrypt description, localEncrypt messages
- Mock hub returns encrypted task
- Mock OpenRouter returns "Decrypted and understood"
- deps.privateKey and pubKeys configured

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- OpenRouter receives DECRYPTED description and messages (plaintext)
- Reply posted to hub is ENCRYPTED (contentType: "encrypted", has encryptedKeys, senderSignature)
- Decrypting the reply yields `{"contentType":"text","body":"Decrypted and understood"}`

---

### 12-07: Tool call limit: 11th call triggers error report
**Severity:** High
**Type:** Integration
**Module:** bridge/poll.ts
**Spec ref:** Error Handling — Tool call loop limit

**Setup:**
- Mock OpenRouter always returning tool_calls

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- OpenRouter called exactly 11 times
- Error message posted containing "tool call limit"
- Status set to "input-required"

---

### 12-08: Second poll cycle skips already-seen tasks
**Severity:** High
**Type:** Integration
**Module:** bridge/poll.ts
**Spec ref:** Poll Loop — Deduplication

**Setup:**
- Mock hub returns same pending task on both calls

**Steps:**
1. Call `pollOnce(deps, seenTasks)` — first time
2. Call `pollOnce(deps, seenTasks)` — second time

**Expected:**
- First call: OpenRouter called, reply posted
- Second call: OpenRouter NOT called for that task
- seenTasks contains the task ID after first call
