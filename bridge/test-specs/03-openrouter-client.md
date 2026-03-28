# 03 — OpenRouter Client Tests

**Module:** `bridge/openrouter.ts`
**Complements existing:** `bridge/openrouter.test.ts` (3 tests)

---

### 03-01: Sends model, messages, temperature, max_tokens
**Severity:** High
**Type:** Unit
**Module:** bridge/openrouter.ts
**Spec ref:** Architecture — OpenRouter API

**Setup:**
- Mock HTTP server capturing request body

**Steps:**
1. Call `client.chatCompletion("openai/gpt-4o", messages, { temperature: 0.5, max_tokens: 100 })`

**Expected:**
- Body has model = "openai/gpt-4o"
- Body has messages array matching input
- Body has temperature = 0.5
- Body has max_tokens = 100
- Authorization header = "Bearer sk-or-test"

---

### 03-02: Includes tools array when provided
**Severity:** High
**Type:** Unit
**Module:** bridge/openrouter.ts
**Spec ref:** Tools — Tool definitions

**Setup:**
- Mock HTTP server
- Array of ToolDef objects

**Steps:**
1. Call `client.chatCompletion(model, messages, {}, tools)`

**Expected:**
- Body contains `tools` array matching input
- Each tool has type, function.name, function.description, function.parameters

---

### 03-03: Omits tools when not provided
**Severity:** Medium
**Type:** Unit
**Module:** bridge/openrouter.ts
**Spec ref:** Tools

**Setup:**
- Mock HTTP server

**Steps:**
1. Call `client.chatCompletion(model, messages, {})` without tools argument

**Expected:**
- Body does NOT contain `tools` key

---

### 03-04: Parses successful response with content
**Severity:** High
**Type:** Unit
**Module:** bridge/openrouter.ts
**Spec ref:** Architecture

**Setup:**
- Mock returning `{ choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }`

**Steps:**
1. Call chatCompletion

**Expected:**
- result.message.content = "Hi"
- result.message.role = "assistant"
- result.finish_reason = "stop"
- result.usage.total_tokens = 15

---

### 03-05: Parses response with tool_calls
**Severity:** Critical
**Type:** Unit
**Module:** bridge/openrouter.ts
**Spec ref:** Tools — Tool call execution loop

**Setup:**
- Mock returning response with tool_calls array:
  ```json
  { "choices": [{ "message": { "role": "assistant", "content": null, "tool_calls": [{ "id": "tc-1", "type": "function", "function": { "name": "reply", "arguments": "{\"message\":\"hi\"}" } }] }, "finish_reason": "tool_calls" }], "usage": {} }
  ```

**Steps:**
1. Call chatCompletion

**Expected:**
- result.message.tool_calls is array of length 1
- result.message.tool_calls[0].function.name = "reply"
- result.message.content is null
- result.finish_reason = "tool_calls"

---

### 03-06: Empty choices array throws
**Severity:** High
**Type:** Unit
**Module:** bridge/openrouter.ts
**Spec ref:** Error Handling

**Setup:**
- Mock returning `{ choices: [], usage: {} }`

**Steps:**
1. Call chatCompletion

**Expected:**
- Throws Error containing "no choices"

---

### 03-07: API error (429) throws with status and body
**Severity:** High
**Type:** Unit
**Module:** bridge/openrouter.ts
**Spec ref:** Error Handling — OpenRouter API errors

**Setup:**
- Mock returning 429 with body `{"error": {"message": "Rate limited"}}`

**Steps:**
1. Call chatCompletion

**Expected:**
- Throws Error containing "429"
- Error message includes response body text

---

### 03-08: API error with non-JSON body throws with raw text
**Severity:** Medium
**Type:** Unit
**Module:** bridge/openrouter.ts
**Spec ref:** Error Handling

**Setup:**
- Mock returning 500 with body "Internal Server Error"

**Steps:**
1. Call chatCompletion

**Expected:**
- Throws Error containing "500"
- Error includes "Internal Server Error" text

---

### 03-09: Custom baseUrl used correctly
**Severity:** Low
**Type:** Unit
**Module:** bridge/openrouter.ts
**Spec ref:** Configuration

**Setup:**
- Mock HTTP server on custom port
- Create client with `baseUrl = "http://localhost:PORT"`

**Steps:**
1. Call chatCompletion

**Expected:**
- Request sent to `http://localhost:PORT/chat/completions`
- Not to default openrouter.ai URL
