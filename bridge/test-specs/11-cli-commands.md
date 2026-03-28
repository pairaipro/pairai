# 11 — CLI Commands Tests

**Module:** `bridge/bridge.ts`
**No existing tests.**

These tests verify CLI argument parsing and command dispatch. They run the bridge.ts script as a subprocess and check exit codes and output.

---

### 11-01: `version` prints correct version
**Severity:** Low
**Type:** Unit
**Module:** bridge/bridge.ts
**Spec ref:** CLI Commands — version

**Steps:**
1. Run `npx tsx bridge/bridge.ts version`

**Expected:**
- stdout contains "pairai-bridge v"
- Exits with code 0

---

### 11-02: `--version` flag works
**Severity:** Low
**Type:** Unit
**Module:** bridge/bridge.ts
**Spec ref:** CLI Commands — version

**Steps:**
1. Run `npx tsx bridge/bridge.ts --version`

**Expected:**
- stdout contains "pairai-bridge v"
- Exits with code 0

---

### 11-03: `setup` without name shows usage error
**Severity:** Medium
**Type:** Unit
**Module:** bridge/bridge.ts
**Spec ref:** CLI Commands — setup

**Steps:**
1. Run `npx tsx bridge/bridge.ts setup`

**Expected:**
- stderr contains "Usage:" and "setup"
- Exits with code 1

---

### 11-04: `pair` without code shows usage error
**Severity:** Medium
**Type:** Unit
**Module:** bridge/bridge.ts
**Spec ref:** CLI Commands — pair

**Steps:**
1. Run `npx tsx bridge/bridge.ts pair`

**Expected:**
- stderr contains "Usage:" and "pair"
- Exits with code 1

---

### 11-05: `pair` calls POST /pair/connect with code
**Severity:** High
**Type:** Integration
**Module:** bridge/bridge.ts
**Spec ref:** CLI Commands — pair + Pairing Procedure

**Setup:**
- Mock hub server
- Write bridge.yaml config pointing to mock hub

**Steps:**
1. Run `npx tsx bridge/bridge.ts pair BLUE-TIGER-42 --config /path/to/config.yaml`
2. Inspect mock hub request

**Expected:**
- POST to `/pair/connect`
- Body: `{ code: "BLUE-TIGER-42" }`
- stdout contains "Connected to"

---

### 11-06: `pair` failure prints error message
**Severity:** Medium
**Type:** Integration
**Module:** bridge/bridge.ts
**Spec ref:** CLI Commands — pair

**Setup:**
- Mock hub returning 404 `{ error: "Invalid or expired code" }`

**Steps:**
1. Run pair command

**Expected:**
- stderr contains "Pairing failed" and "expired"
- Exits with code 1

---

### 11-07: `invite` calls POST /pair/generate
**Severity:** High
**Type:** Integration
**Module:** bridge/bridge.ts
**Spec ref:** CLI Commands — invite + Pairing Procedure

**Setup:**
- Mock hub server returning `{ code: "RED-FOX-99", expiresAt: "2026-03-27T01:00:00Z" }`

**Steps:**
1. Run `npx tsx bridge/bridge.ts invite --config /path/to/config.yaml`
2. Inspect mock hub request

**Expected:**
- POST to `/pair/generate`
- stdout contains "RED-FOX-99"
- stdout contains expiry info

---

### 11-08: `invite` prints code and expiry
**Severity:** Medium
**Type:** Integration
**Module:** bridge/bridge.ts
**Spec ref:** CLI Commands — invite

**Setup:**
- Mock hub returning code and expiresAt

**Steps:**
1. Run invite command

**Expected:**
- stdout contains "Pairing code:"
- stdout contains the code value
- stdout contains "Expires:" or expiry timestamp
- stdout mentions "10 minutes"

---

### 11-09: `serve` with missing config exits with error
**Severity:** Medium
**Type:** Unit
**Module:** bridge/bridge.ts
**Spec ref:** CLI Commands — serve

**Steps:**
1. Run `npx tsx bridge/bridge.ts serve --config /nonexistent/path.yaml`

**Expected:**
- stderr contains "Config file not found"
- Exits with code 1

---

### 11-10: Unknown command shows usage
**Severity:** Low
**Type:** Unit
**Module:** bridge/bridge.ts
**Spec ref:** CLI Commands

**Steps:**
1. Run `npx tsx bridge/bridge.ts foobar`

**Expected:**
- stderr contains "Unknown command"
- stderr contains "Usage:"
- Exits with code 1
