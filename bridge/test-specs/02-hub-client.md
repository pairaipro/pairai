# 02 — Hub Client Tests

**Module:** `bridge/hub.ts`
**Complements existing:** `bridge/hub.test.ts` (4 tests)

---

### 02-01: GET sends Authorization header
**Severity:** High
**Type:** Unit
**Module:** bridge/hub.ts
**Spec ref:** Architecture — Bearer token auth

**Setup:**
- Mock HTTP server

**Steps:**
1. Create `HubClient("http://localhost:PORT", "pak_test123")`
2. Call `hub.get("/agents/me")`

**Expected:**
- Request has header `Authorization: Bearer pak_test123`
- Request method is GET

---

### 02-02: POST sends JSON body with correct Content-Type
**Severity:** High
**Type:** Unit
**Module:** bridge/hub.ts
**Spec ref:** Architecture

**Setup:**
- Mock HTTP server capturing request

**Steps:**
1. Call `hub.post("/tasks", { title: "Test", description: "Do it" })`

**Expected:**
- Method is POST
- Content-Type is "application/json"
- Body is valid JSON matching input object

---

### 02-03: PATCH sends JSON body
**Severity:** High
**Type:** Unit
**Module:** bridge/hub.ts
**Spec ref:** Architecture

**Setup:**
- Mock HTTP server

**Steps:**
1. Call `hub.patch("/tasks/abc", { status: "completed" })`

**Expected:**
- Method is PATCH
- Body is `{"status":"completed"}`
- Has Authorization header

---

### 02-04: POST without body omits Content-Type
**Severity:** Medium
**Type:** Unit
**Module:** bridge/hub.ts
**Spec ref:** Architecture

**Setup:**
- Mock HTTP server

**Steps:**
1. Call `hub.post("/pair/generate")` with no body argument

**Expected:**
- Has Authorization header
- Does NOT have Content-Type header
- Body is empty/undefined

---

### 02-05: getRaw returns raw Response object
**Severity:** Medium
**Type:** Unit
**Module:** bridge/hub.ts
**Spec ref:** Architecture

**Setup:**
- Mock HTTP server returning binary data with custom Content-Type

**Steps:**
1. Call `hub.getRaw("/files/abc")`

**Expected:**
- Returns a Response object (not parsed JSON)
- Response has the original headers
- Body can be read as buffer/stream

---

### 02-06: Non-OK response throws with error message from body
**Severity:** High
**Type:** Unit
**Module:** bridge/hub.ts
**Spec ref:** Error Handling

**Setup:**
- Mock HTTP server returning 400 with `{ "error": "Bad request: missing field" }`

**Steps:**
1. Call `hub.get("/bad-path")`

**Expected:**
- Throws Error containing "Bad request: missing field"

---

### 02-07: Non-OK response with non-JSON body throws generic error
**Severity:** Medium
**Type:** Unit
**Module:** bridge/hub.ts
**Spec ref:** Error Handling

**Setup:**
- Mock HTTP server returning 502 with HTML body

**Steps:**
1. Call `hub.get("/bad-gateway")`

**Expected:**
- Throws Error containing "502" and the path
- Does not crash on JSON parse failure

---

### 02-08: Trailing slash in baseUrl stripped
**Severity:** Low
**Type:** Unit
**Module:** bridge/hub.ts
**Spec ref:** Architecture

**Setup:**
- Mock HTTP server

**Steps:**
1. Create `HubClient("http://localhost:PORT/", "pak_test")`
2. Call `hub.get("/agents/me")`

**Expected:**
- Request URL is `/agents/me`, not `//agents/me`

---

### 02-09: Network error (connection refused) throws
**Severity:** Medium
**Type:** Unit
**Module:** bridge/hub.ts
**Spec ref:** Error Handling

**Steps:**
1. Create `HubClient("http://localhost:1", "pak_test")` (port 1 = nothing listening)
2. Call `hub.get("/anything")`

**Expected:**
- Throws error (fetch failed / connection refused)
- Error is catchable, not unhandled rejection

---

### 02-10: Timeout after 30s throws
**Severity:** Medium
**Type:** Unit
**Module:** bridge/hub.ts
**Spec ref:** Error Handling

**Setup:**
- Mock HTTP server that never responds (hangs)

**Steps:**
1. Call `hub.get("/slow")` — note: 30s is too slow for tests, so this test should verify that AbortSignal.timeout is set correctly (inspect the call or use a shorter mock timeout)

**Expected:**
- Request is made with a timeout signal
- Eventually throws timeout error
- (If testing with real delay is impractical, verify AbortSignal is passed via mock inspection)
