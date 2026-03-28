# 06 — Tool Executor Tests

**Module:** `bridge/tools.ts` — `executeTool()`
**Complements existing:** `bridge/tools.test.ts` (5 tests)

---

### 06-01: reply — sends plaintext message to correct endpoint
**Severity:** High
**Type:** Unit
**Spec ref:** Tools — Core actions — reply

**Setup:**
- Mock hub server
- ToolContext with encrypt=undefined

**Steps:**
1. Call `executeTool("reply", '{"message":"Hello!"}', ctx)`

**Expected:**
- POST to `/tasks/task-001/messages`
- Body: `{ content: "Hello!", contentType: "text" }`

---

### 06-02: reply — encrypts when encrypt + pubKeys provided
**Severity:** Critical
**Type:** Unit
**Spec ref:** Tools + E2E Encryption

**Setup:**
- Mock hub server
- Generate RSA-4096 keypair for sender and recipient
- ToolContext with encrypt = localEncrypt wrapper, pubKeys = { myId: myPub, otherId: otherPub }

**Steps:**
1. Call `executeTool("reply", '{"message":"secret"}', ctx)`

**Expected:**
- POST to `/tasks/task-001/messages`
- Body has contentType: "encrypted"
- Body has encryptedKeys object with keys for both agents
- Body has senderSignature (non-empty string)
- Content is base64 ciphertext (not plaintext "secret")

---

### 06-03: reply — encrypted envelope has correct structure
**Severity:** Critical
**Type:** Unit
**Spec ref:** E2E Encryption

**Setup:**
- Same as 06-02 but capture the ciphertext and decrypt it

**Steps:**
1. Call executeTool with encryption
2. Capture the POST body
3. Decrypt ciphertext using recipient's private key

**Expected:**
- Decrypted plaintext is JSON: `{ "contentType": "text", "body": "secret" }`
- Envelope structure matches channel client format

---

### 06-04: update_status — PATCHes task with status
**Severity:** High
**Type:** Unit
**Spec ref:** Tools — Core actions — update_status

**Setup:**
- Mock hub server

**Steps:**
1. Call `executeTool("update_status", '{"status":"completed"}', ctx)`

**Expected:**
- PATCH to `/tasks/task-001`
- Body: `{ status: "completed" }`

---

### 06-05: create_task — POSTs with targetAgentId, title, description
**Severity:** High
**Type:** Unit
**Spec ref:** Tools — Core actions — create_task

**Setup:**
- Mock hub server

**Steps:**
1. Call `executeTool("create_task", '{"target_agent_id":"agent-2","title":"Review","description":"Please review PR"}', ctx)`

**Expected:**
- POST to `/tasks`
- Body: `{ targetAgentId: "agent-2", title: "Review", description: "Please review PR" }`

---

### 06-06: create_task — defaults description to empty string
**Severity:** Medium
**Type:** Unit
**Spec ref:** Tools — create_task

**Setup:**
- Mock hub server

**Steps:**
1. Call `executeTool("create_task", '{"target_agent_id":"agent-2","title":"Review"}', ctx)`

**Expected:**
- Body has `description: ""`

---

### 06-07: upload_file — POSTs to files/json endpoint
**Severity:** High
**Type:** Unit
**Spec ref:** Tools — Core actions — upload_file

**Setup:**
- Mock hub server

**Steps:**
1. Call `executeTool("upload_file", '{"filename":"test.txt","mime_type":"text/plain","base64_content":"SGVsbG8="}', ctx)`

**Expected:**
- POST to `/tasks/task-001/files/json`
- Body: `{ filename: "test.txt", mimeType: "text/plain", base64Content: "SGVsbG8=" }`

---

### 06-08: list_tasks — GETs with status query param
**Severity:** Medium
**Type:** Unit
**Spec ref:** Tools — Information gathering — list_tasks

**Setup:**
- Mock hub server

**Steps:**
1. Call `executeTool("list_tasks", '{"status":"working"}', ctx)`

**Expected:**
- GET to `/tasks?status=working`

---

### 06-09: list_tasks — GETs without query when no status
**Severity:** Medium
**Type:** Unit
**Spec ref:** Tools — list_tasks

**Steps:**
1. Call `executeTool("list_tasks", '{}', ctx)`

**Expected:**
- GET to `/tasks` (no query string)

---

### 06-10: get_task — GETs correct task path
**Severity:** Medium
**Type:** Unit
**Spec ref:** Tools — Information gathering — get_task

**Steps:**
1. Call `executeTool("get_task", '{"task_id":"task-xyz"}', ctx)`

**Expected:**
- GET to `/tasks/task-xyz`

---

### 06-11: discover_agents — builds query string from params
**Severity:** Medium
**Type:** Unit
**Spec ref:** Tools — Information gathering — discover_agents

**Steps:**
1. Call `executeTool("discover_agents", '{"capability":"coding","query":"alice","limit":5}', ctx)`

**Expected:**
- GET to `/agents/discover?capability=coding&query=alice&limit=5`

---

### 06-12: generate_pairing_code — POSTs to pair/generate
**Severity:** Medium
**Type:** Unit
**Spec ref:** Tools — Connection management — generate_pairing_code

**Steps:**
1. Call `executeTool("generate_pairing_code", '{}', ctx)`

**Expected:**
- POST to `/pair/generate`

---

### 06-13: approve_task — POSTs to correct endpoint
**Severity:** Medium
**Type:** Unit
**Spec ref:** Tools — Connection management — approve_task

**Steps:**
1. Call `executeTool("approve_task", '{"task_id":"task-abc"}', ctx)`

**Expected:**
- POST to `/tasks/task-abc/approve`

---

### 06-14: reject_task — POSTs with reason
**Severity:** Medium
**Type:** Unit
**Spec ref:** Tools — Connection management — reject_task

**Steps:**
1. Call `executeTool("reject_task", '{"task_id":"task-abc","reason":"Not relevant"}', ctx)`

**Expected:**
- POST to `/tasks/task-abc/reject`
- Body: `{ reason: "Not relevant" }`

---

### 06-15: Unknown tool returns error JSON
**Severity:** High
**Type:** Unit
**Spec ref:** Tools

**Steps:**
1. Call `executeTool("nonexistent_tool", '{}', ctx)`

**Expected:**
- Returns JSON string containing `"error"` and `"Unknown tool"`

---

### 06-16: Hub API error caught and returned as error JSON
**Severity:** High
**Type:** Unit
**Spec ref:** Error Handling

**Setup:**
- Mock hub server returning 500

**Steps:**
1. Call `executeTool("reply", '{"message":"hi"}', ctx)`

**Expected:**
- Returns JSON string containing `"error"` key
- Does NOT throw — error is caught and serialized
