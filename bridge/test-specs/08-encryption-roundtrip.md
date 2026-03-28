# 08 — Encryption Round-Trip Tests

**Module:** `bridge/poll.ts` + `channel/lib.ts`
**Complements existing:** `channel/lib.test.ts` (5 tests — crypto primitives only)

These tests verify that the bridge correctly handles encrypted tasks end-to-end: decrypting incoming content and encrypting outgoing replies.

---

### 08-01: Encrypted task description decrypted correctly
**Severity:** Critical
**Type:** Integration
**Spec ref:** Poll Loop — Process pending tasks + E2E Encryption

**Setup:**
- Generate 2 RSA-4096 keypairs (initiator + bridge)
- Create task with encrypted=true, description=localEncrypt('{"title":"Secret Task","description":"Do secret thing"}', taskId, initiatorPrivKey, { initiatorId: initiatorPub, bridgeId: bridgePub })
- Mock hub returning this task
- Mock OpenRouter returning text reply

**Steps:**
1. Set deps.privateKey, deps.myPublicKey, deps.pubKeys with bridge keys
2. Call `processTask(taskId, deps)`
3. Inspect the messages sent to OpenRouter

**Expected:**
- System message contains "Secret Task" (decrypted title)
- Description user message contains "Do secret thing"
- NOT the base64 ciphertext

---

### 08-02: Encrypted messages decrypted in poll processing
**Severity:** Critical
**Type:** Integration
**Spec ref:** Poll Loop + E2E Encryption

**Setup:**
- Encrypted task with 2 encrypted messages
- Each message: localEncrypt('{"contentType":"text","body":"Hello"}', taskId, senderPrivKey, keys)
- Mock hub returns task with these encrypted messages

**Steps:**
1. Call `processUnreadMessages(taskId, deps)`
2. Inspect messages sent to OpenRouter

**Expected:**
- OpenRouter receives decrypted "Hello" messages, not ciphertext
- Messages have role "user" (from other agent)

---

### 08-03: Reply to encrypted task is encrypted with both keys
**Severity:** Critical
**Type:** Integration
**Spec ref:** Poll Loop + E2E Encryption

**Setup:**
- Encrypted task
- deps with bridge keys and other agent's public key in pubKeys
- Mock OpenRouter returning "Secret reply"

**Steps:**
1. Call `processTask(taskId, deps)`
2. Capture the hub.post call for /messages

**Expected:**
- Posted message has contentType: "encrypted"
- Has encryptedKeys with entries for BOTH agent IDs
- Has senderSignature (non-empty)
- Content is base64 ciphertext, NOT "Secret reply"

---

### 08-04: Encrypted reply envelope has correct structure
**Severity:** Critical
**Type:** Integration
**Spec ref:** E2E Encryption

**Setup:**
- Same as 08-03, but decrypt the posted ciphertext

**Steps:**
1. Process encrypted task, capture reply ciphertext
2. Decrypt using other agent's private key + localDecrypt

**Expected:**
- Decrypted text is valid JSON
- Structure: `{ "contentType": "text", "body": "Secret reply" }`

---

### 08-05: Signature verified during decryption
**Severity:** Critical
**Type:** Unit
**Spec ref:** E2E Encryption

**Setup:**
- Encrypted message with valid signature from known sender

**Steps:**
1. Process task with encrypted message
2. Decryption succeeds

**Expected:**
- Message decrypted successfully
- No "[decryption failed]" in output

---

### 08-06: Wrong sender public key fails signature verification
**Severity:** High
**Type:** Unit
**Spec ref:** E2E Encryption

**Setup:**
- Encrypted message signed by key A
- pubKeys map has a DIFFERENT public key for that sender

**Steps:**
1. Process task with mismatched keys

**Expected:**
- Message content becomes "[decryption failed]"
- Does not throw/crash the poll loop
- OpenRouter still called (with decryption failure placeholder)

---

### 08-07: Missing encryptedKeys falls back to plaintext
**Severity:** High
**Type:** Unit
**Spec ref:** E2E Encryption

**Setup:**
- Message with contentType "text" (not "encrypted"), no encryptedKeys

**Steps:**
1. Process task with this message

**Expected:**
- Message passed through as-is (plaintext)
- No decryption attempted

---

### 08-08: Decryption failure returns "[decryption failed]" placeholder
**Severity:** High
**Type:** Unit
**Spec ref:** Error Handling — Decryption failures

**Setup:**
- Message with contentType "encrypted" but corrupted ciphertext

**Steps:**
1. Process task with corrupted message

**Expected:**
- Message content = "[decryption failed]"
- contentType = "text"
- Poll loop continues (no throw)

---

### 08-09: Mixed encrypted and plaintext messages in same task
**Severity:** High
**Type:** Integration
**Spec ref:** Context Building + E2E Encryption

**Setup:**
- Task with messages: [encrypted_msg_1, plaintext_msg_2, encrypted_msg_3]
- encrypted=true on task

**Steps:**
1. Process task

**Expected:**
- Encrypted messages decrypted
- Plaintext message passed through unchanged
- All 3 messages present in OpenRouter context in correct order

---

### 08-10: No private key configured — encrypted tasks handled gracefully
**Severity:** High
**Type:** Unit
**Spec ref:** Error Handling

**Setup:**
- deps.privateKey = null
- Task with encrypted=true

**Steps:**
1. Call processTask

**Expected:**
- Description falls back to raw (possibly ciphertext) value
- Messages not decrypted (passed as-is)
- Reply sent as plaintext (no encryption attempted)
- No crash
