# 09 — Error Reporting Tests

**Module:** `bridge/poll.ts`
**Complements existing:** `bridge/poll.test.ts` (partial coverage of 2 scenarios)

These tests verify the spec's 6 error scenarios are all reported back to the originating task.

---

### 09-01: OpenRouter API error → "[Bridge error]" message + input-required
**Severity:** Critical
**Type:** Unit
**Module:** bridge/poll.ts
**Spec ref:** Error Handling — OpenRouter API errors

**Setup:**
- Mock hub returning a valid task
- Mock OpenRouter throwing Error("OpenRouter API error 429: rate limited")

**Steps:**
1. Call `processTask("task-001", deps)`

**Expected:**
- hub.post called with `/tasks/task-001/messages` containing content starting with "[Bridge error]" and including "429"
- hub.patch called with `/tasks/task-001` and `{ status: "input-required" }`

---

### 09-02: OpenRouter timeout → error reported to task
**Severity:** Critical
**Type:** Unit
**Module:** bridge/poll.ts
**Spec ref:** Error Handling — OpenRouter API errors

**Setup:**
- Mock OpenRouter throwing Error("OpenRouter API error: timeout")

**Steps:**
1. Call `processTask("task-001", deps)`

**Expected:**
- Error message posted to task containing "[Bridge error]"
- Status set to "input-required"

---

### 09-03: Decryption failure → error message + failed status
**Severity:** Critical
**Type:** Unit
**Module:** bridge/poll.ts
**Spec ref:** Error Handling — Decryption failures

**Setup:**
- Task with encrypted=true, corrupted description ciphertext
- deps.privateKey set to valid key but mismatched with ciphertext

**Steps:**
1. Call `processTask(taskId, deps)`

**Expected:**
- Description decryption fails gracefully (returns placeholder)
- OpenRouter still called with placeholder text
- Reply sent back (bridge doesn't crash)

Note: Per current implementation, decryption failure in description returns a placeholder string and continues processing. The spec says to reply with error and mark failed, but current code handles it as graceful degradation. Test should match current behavior and flag the gap.

---

### 09-04: Tool call limit exceeded → error message + input-required
**Severity:** Critical
**Type:** Unit
**Module:** bridge/poll.ts
**Spec ref:** Error Handling — Tool call loop limit

**Setup:**
- Mock OpenRouter always returning tool_calls (never a final text response)

**Steps:**
1. Call `processTask("task-001", deps)`

**Expected:**
- OpenRouter called at most 11 times (1 initial + 10 tool rounds)
- hub.post called with message containing "tool call limit" and "possible loop"
- hub.patch called with `{ status: "input-required" }`

---

### 09-05: Model empty response → no empty reply sent
**Severity:** High
**Type:** Unit
**Module:** bridge/poll.ts
**Spec ref:** Error Handling — Model refusal/empty response

**Setup:**
- Mock OpenRouter returning `{ message: { role: "assistant", content: "" }, finish_reason: "stop" }`

**Steps:**
1. Call `processTask("task-001", deps)`

**Expected:**
- hub.post for messages NOT called (empty content skipped by `if (reply)` check)
- No crash

---

### 09-06: Hub API error on reply post → logged locally, not crashed
**Severity:** Critical
**Type:** Unit
**Module:** bridge/poll.ts
**Spec ref:** Error Handling — Hub API errors

**Setup:**
- Mock OpenRouter returning valid reply
- Mock hub.post for /messages throwing Error("POST /tasks/task-001/messages: 500")
- Mock hub.patch also throwing (simulating hub down)

**Steps:**
1. Call `processTask("task-001", deps)`

**Expected:**
- Error caught (no throw from processTask)
- deps.log called with error message
- Poll loop can continue on next cycle

---

### 09-07: Hub API error on status patch → logged locally, not crashed
**Severity:** High
**Type:** Unit
**Module:** bridge/poll.ts
**Spec ref:** Error Handling — Hub API errors

**Setup:**
- Mock OpenRouter throwing error
- hub.post for error message succeeds
- hub.patch for status throws Error("PATCH failed")

**Steps:**
1. Call `processTask("task-001", deps)`

**Expected:**
- Error message still posted to task (hub.post succeeds)
- hub.patch failure caught
- No unhandled exception

---

### 09-08: Multiple errors in one poll cycle don't crash the loop
**Severity:** High
**Type:** Unit
**Module:** bridge/poll.ts
**Spec ref:** Error Handling

**Setup:**
- Mock hub returning 2 pending tasks
- OpenRouter fails for both tasks

**Steps:**
1. Call `pollOnce(deps, seenTasks)`

**Expected:**
- Both tasks attempted
- Errors reported to both tasks
- pollOnce completes (no throw)
- /updates/ack still called
