# 01 — Config Loading Tests

**Module:** `bridge/config.ts`
**Complements existing:** `bridge/config.test.ts` (5 tests)

---

### 01-01: Valid YAML loads all fields correctly
**Severity:** Medium
**Type:** Unit
**Module:** bridge/config.ts
**Spec ref:** Configuration

**Setup:**
- Write YAML file with all fields: hub_url, api_key, key_file, openrouter_key, model, temperature, max_reply_tokens, max_history_tokens, system_prompt, poll_interval_ms, log_level, log_file

**Steps:**
1. Call `loadConfig(path)`
2. Check every field on returned BridgeConfig

**Expected:**
- All fields match YAML values exactly
- Numeric fields are numbers (not strings)
- Multi-line system_prompt preserved with newlines

---

### 01-02: Env vars override file values (all 5 mappings)
**Severity:** High
**Type:** Unit
**Module:** bridge/config.ts
**Spec ref:** Configuration — Env var overrides

**Setup:**
- Write YAML with values for all 5 overridable fields
- Set all 5 env vars: PAIRAI_HUB_URL, PAIRAI_AGENT_CRED, PAIRAI_KEY_FILE, OPENROUTER_API_KEY, OPENROUTER_MODEL

**Steps:**
1. Call `loadConfig(path)`
2. Check each of the 5 fields

**Expected:**
- hub_url = PAIRAI_HUB_URL value
- api_key = PAIRAI_AGENT_CRED value
- key_file = PAIRAI_KEY_FILE value
- openrouter_key = OPENROUTER_API_KEY value
- model = OPENROUTER_MODEL value
- Non-overridable fields (temperature, etc.) still from file

---

### 01-03: Resolution order: env > file > defaults
**Severity:** High
**Type:** Unit
**Module:** bridge/config.ts
**Spec ref:** Configuration — Resolution order

**Setup:**
- Write YAML with hub_url="from-file"
- Set PAIRAI_HUB_URL="from-env"
- Omit temperature from YAML (should default to 0.7)

**Steps:**
1. Call `loadConfig(path)`

**Expected:**
- hub_url = "from-env" (env wins over file)
- temperature = 0.7 (default wins when file omits)

---

### 01-04: Defaults applied for missing optional fields
**Severity:** Medium
**Type:** Unit
**Module:** bridge/config.ts
**Spec ref:** Configuration

**Setup:**
- Write YAML with only required fields: hub_url, api_key, key_file, openrouter_key, model

**Steps:**
1. Call `loadConfig(path)`

**Expected:**
- temperature = 0.7
- max_reply_tokens = 4096
- max_history_tokens = 32000
- poll_interval_ms = 5000
- log_level = "info"
- system_prompt contains "PairAI"
- log_file = undefined

---

### 01-05: Throws on missing config file
**Severity:** Medium
**Type:** Unit
**Module:** bridge/config.ts
**Spec ref:** Configuration

**Setup:**
- No file at given path

**Steps:**
1. Call `loadConfig("/nonexistent/path.yaml")`

**Expected:**
- Throws Error containing "not found"

---

### 01-06: Throws on missing required fields (each of 5)
**Severity:** High
**Type:** Unit
**Module:** bridge/config.ts
**Spec ref:** Configuration

**Setup:**
- For each required field (hub_url, api_key, key_file, openrouter_key, model): write YAML missing that one field

**Steps:**
1. Call `loadConfig(path)` for each variant

**Expected:**
- Each throws Error mentioning the missing field name

---

### 01-07: Invalid YAML syntax gives clear error
**Severity:** Medium
**Type:** Unit
**Module:** bridge/config.ts
**Spec ref:** Configuration

**Setup:**
- Write file with invalid YAML: `hub_url: [unclosed bracket`

**Steps:**
1. Call `loadConfig(path)`

**Expected:**
- Throws (from js-yaml parser)
- Does not crash with cryptic error

---

### 01-08: Empty config file uses defaults + validates required
**Severity:** Medium
**Type:** Unit
**Module:** bridge/config.ts
**Spec ref:** Configuration

**Setup:**
- Write empty file (0 bytes) or file with only comments

**Steps:**
1. Call `loadConfig(path)`

**Expected:**
- Throws on missing required fields (api_key, etc.)
- Does not crash on null yaml.load result
