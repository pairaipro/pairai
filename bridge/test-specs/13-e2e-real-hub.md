# 13 — E2E Tests (Real Hub Server)

**Module:** Full stack — `bridge/` + `src/` (hub)
**No existing tests.**

These tests start the real PairAI hub server, register agents, and verify the bridge's behavior end-to-end. They follow the project's existing e2e pattern (see `e2e/` directory).

**Test infrastructure:**
- Start real hub server on a random port (like existing e2e tests)
- Register 2 agents: "initiator" (simulates another AI) and "bridge" (the bridge agent)
- Connect them via pairing
- Use a mock OpenRouter server for the AI model responses
- Bridge poll loop runs directly via `pollOnce()` (not as a subprocess)

---

### 13-01: Bridge registers, polls, receives task, sends reply
**Severity:** Critical
**Type:** E2E
**Module:** bridge/poll.ts
**Spec ref:** Full lifecycle

**Setup:**
- Start real hub
- Register initiator agent and bridge agent via POST /agents
- Pair them via generate + connect
- Start mock OpenRouter returning "Task received and working on it"

**Steps:**
1. Initiator creates task: POST /tasks targeting bridge agent
2. Call `pollOnce(bridgeDeps, seenTasks)`
3. Initiator checks task: GET /tasks/:id

**Expected:**
- Task status changed to "working"
- Task has a message from bridge agent: "Task received and working on it"
- Message stored in real database

---

### 13-02: Bridge handles multi-turn conversation
**Severity:** Critical
**Type:** E2E
**Module:** bridge/poll.ts
**Spec ref:** Poll Loop — Process unread messages

**Setup:**
- Same as 13-01, task already created and first reply sent

**Steps:**
1. Initiator sends follow-up message: POST /tasks/:id/messages
2. Call `pollOnce(bridgeDeps, seenTasks)` again
3. Check task messages

**Expected:**
- Bridge receives the follow-up (OpenRouter called with full history)
- New reply posted
- Task now has 4 messages: initial desc (implicit), bridge reply 1, initiator follow-up, bridge reply 2

---

### 13-03: Bridge pair command creates connection
**Severity:** High
**Type:** E2E
**Module:** bridge/bridge.ts
**Spec ref:** Pairing Procedure

**Setup:**
- Start real hub
- Register bridge agent
- Register another agent who generates a pairing code

**Steps:**
1. Other agent: POST /pair/generate → code
2. Bridge: HubClient.post("/pair/connect", { code })
3. Both agents: GET /connections

**Expected:**
- Both agents see each other in their connections list
- Connection includes public keys (if registered with them)

---

### 13-04: Bridge invite command generates valid code
**Severity:** High
**Type:** E2E
**Module:** bridge/bridge.ts
**Spec ref:** Pairing Procedure

**Setup:**
- Start real hub
- Register bridge agent

**Steps:**
1. Bridge: HubClient.post("/pair/generate")
2. Other agent: POST /pair/connect with the code

**Expected:**
- Code returned is valid string (e.g., WORD-WORD-NN format)
- Connection established successfully
- Both agents see each other in connections

---

### 13-05: Bridge reports OpenRouter error to real hub task
**Severity:** Critical
**Type:** E2E
**Module:** bridge/poll.ts
**Spec ref:** Error Handling

**Setup:**
- Start real hub
- Register and pair agents
- Mock OpenRouter returning 500

**Steps:**
1. Initiator creates task
2. Call `pollOnce(bridgeDeps, seenTasks)`
3. Initiator fetches task

**Expected:**
- Task has a message containing "[Bridge error]"
- Task status is "input-required"
- Error message stored in real database

---

### 13-06: Bridge decrypts encrypted task and sends encrypted reply
**Severity:** Critical
**Type:** E2E
**Module:** bridge/poll.ts
**Spec ref:** E2E Encryption + Poll Loop

**Setup:**
- Start real hub
- Register both agents WITH public keys
- Pair them
- Generate RSA keypairs, use localEncrypt for task creation
- Mock OpenRouter returning "Understood the secret"

**Steps:**
1. Initiator creates encrypted task: POST /tasks with encrypted=true, encrypted description, descriptionKeys, senderSignature
2. Call `pollOnce(bridgeDeps, seenTasks)`
3. Initiator fetches task and messages

**Expected:**
- Bridge's reply message has contentType "encrypted"
- Reply has encryptedKeys for both agents
- Reply has senderSignature
- Initiator can decrypt the reply using their private key
- Decrypted content = `{"contentType":"text","body":"Understood the secret"}`
- Hub never stored plaintext (verify raw DB or message content is ciphertext)
