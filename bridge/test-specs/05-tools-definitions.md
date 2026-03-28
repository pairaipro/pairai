# 05 — Tool Definitions Tests

**Module:** `bridge/tools.ts`
**Complements existing:** `bridge/tools.test.ts` (5 tests)

---

### 05-01: Returns exactly 11 tool definitions
**Severity:** High
**Type:** Unit
**Spec ref:** Tools Exposed to the Model

**Steps:**
1. Call `getToolDefs()`

**Expected:**
- Array of length 11
- Names: reply, update_status, create_task, upload_file, list_tasks, get_task, list_connections, discover_agents, generate_pairing_code, approve_task, reject_task

---

### 05-02: All tools have type "function"
**Severity:** High
**Type:** Unit
**Spec ref:** Tools — OpenAI function-calling format

**Steps:**
1. Call `getToolDefs()`
2. Check each tool

**Expected:**
- Every tool has `type: "function"`

---

### 05-03: All tools have name, description, parameters
**Severity:** High
**Type:** Unit
**Spec ref:** Tools

**Steps:**
1. Call `getToolDefs()`
2. For each tool, check `function.name`, `function.description`, `function.parameters`

**Expected:**
- All three fields are non-empty/non-null for every tool
- `parameters` is an object with `type: "object"`

---

### 05-04: Required params marked correctly per tool
**Severity:** High
**Type:** Unit
**Spec ref:** Tools

**Steps:**
1. Call `getToolDefs()`
2. Check required arrays for each tool

**Expected:**
- reply: required = ["message"]
- update_status: required = ["status"]
- create_task: required = ["target_agent_id", "title"]
- upload_file: required = ["filename", "mime_type", "base64_content"]
- get_task: required = ["task_id"]
- approve_task: required = ["task_id"]
- reject_task: required = ["task_id"]
- list_tasks: no required (optional status filter)
- list_connections: no required
- discover_agents: no required
- generate_pairing_code: no required

---

### 05-05: Status enum values match hub API
**Severity:** Medium
**Type:** Unit
**Spec ref:** Tools — update_status

**Steps:**
1. Find update_status tool definition
2. Check status property enum

**Expected:**
- enum = ["working", "completed", "failed", "input-required"]
- Matches valid task status transitions from spec

---

### 05-06: Tool names are unique
**Severity:** Medium
**Type:** Unit
**Spec ref:** Tools

**Steps:**
1. Call `getToolDefs()`
2. Collect all function.name values

**Expected:**
- No duplicates (Set size equals array length)
