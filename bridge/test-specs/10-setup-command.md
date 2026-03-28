# 10 — Setup Command Tests

**Module:** `bridge/setup.ts`
**No existing tests.**

---

### 10-01: Generates RSA-4096 keypair
**Severity:** Critical
**Type:** Unit
**Module:** bridge/setup.ts
**Spec ref:** CLI Commands — setup flow — step 2

**Setup:**
- Mock hub server accepting POST /agents
- Set OPENROUTER_API_KEY env var
- Temp directory for config/key output

**Steps:**
1. Call `runSetup("Test Agent", "http://localhost:PORT", configPath)`
2. Read the written private key file

**Expected:**
- Private key file exists
- Content starts with "-----BEGIN PRIVATE KEY-----"
- Key is 4096-bit RSA (verifiable by importing it)

---

### 10-02: Registers with hub POST /agents
**Severity:** Critical
**Type:** Integration
**Module:** bridge/setup.ts
**Spec ref:** CLI Commands — setup flow — step 3

**Setup:**
- Mock hub server capturing POST /agents request

**Steps:**
1. Call `runSetup("My Agent", hubUrl, configPath)`
2. Inspect captured request

**Expected:**
- POST to /agents
- Body has `name: "My Agent"`
- Body has `publicKey` field (PEM format, starts with "-----BEGIN PUBLIC KEY-----")

---

### 10-03: Writes private key with mode 0600
**Severity:** Critical
**Type:** Unit
**Module:** bridge/setup.ts
**Spec ref:** CLI Commands — setup flow — step 5

**Setup:**
- Mock hub, temp directory

**Steps:**
1. Call runSetup
2. stat the private key file

**Expected:**
- File mode is 0600 (owner read+write only)
- File is at ~/.pairai/bridge_private.pem (or mocked path)

---

### 10-04: Writes valid YAML config with all fields
**Severity:** High
**Type:** Unit
**Module:** bridge/setup.ts
**Spec ref:** CLI Commands — setup flow — step 4

**Setup:**
- Mock hub returning `{ id: "agent-123", apiKey: "pak_abc" }`

**Steps:**
1. Call runSetup
2. Read and parse the written YAML config file

**Expected:**
- Valid YAML (parseable by js-yaml)
- Contains hub_url matching input
- Contains api_key = "pak_abc"
- Contains key_file path
- Contains openrouter_key from env
- Contains model default
- Contains system_prompt
- Contains poll_interval_ms

---

### 10-05: Missing OPENROUTER_API_KEY exits with clear error
**Severity:** High
**Type:** Unit
**Module:** bridge/setup.ts
**Spec ref:** CLI Commands — setup flow — step 1

**Setup:**
- Unset OPENROUTER_API_KEY env var
- Mock process.exit

**Steps:**
1. Call runSetup without OPENROUTER_API_KEY

**Expected:**
- process.exit(1) called
- stderr output contains "OPENROUTER_API_KEY" and "required"

---

### 10-06: Hub registration failure exits with error message
**Severity:** High
**Type:** Unit
**Module:** bridge/setup.ts
**Spec ref:** CLI Commands — setup flow — step 3

**Setup:**
- Mock hub returning 409 with `{ error: "Agent name already taken" }`

**Steps:**
1. Call runSetup

**Expected:**
- process.exit(1) called
- stderr output contains "Registration failed" and "already taken"

---

### 10-07: Creates config directory if it doesn't exist
**Severity:** Medium
**Type:** Unit
**Module:** bridge/setup.ts
**Spec ref:** CLI Commands — setup flow — step 4

**Setup:**
- configPath in a non-existent directory: `/tmp/test-bridge-XXXX/subdir/bridge.yaml`

**Steps:**
1. Call runSetup

**Expected:**
- Directory created
- Config file written successfully

---

### 10-08: Config contains correct hub_url and api_key from registration
**Severity:** High
**Type:** Unit
**Module:** bridge/setup.ts
**Spec ref:** CLI Commands — setup flow — step 4

**Setup:**
- Mock hub returning specific apiKey "pak_xyz789"
- hubUrl = "http://custom.hub:4000"

**Steps:**
1. Call runSetup with custom hub URL
2. Parse written config

**Expected:**
- hub_url = "http://custom.hub:4000"
- api_key = "pak_xyz789"
