import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { localEncrypt, localDecrypt, detectProvider, solveChallenge, solveHubChallenge } from "./lib.js";

function makeKeyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

describe("localEncrypt / localDecrypt", () => {
  const alice = makeKeyPair();
  const bob = makeKeyPair();
  const taskId = "test-task-001";

  it("encrypts and decrypts a message", () => {
    const plaintext = "Hello from Alice";
    const result = localEncrypt(plaintext, taskId, alice.privateKey, {
      alice: alice.publicKey,
      bob: bob.publicKey,
    });

    expect(result.ciphertext).toBeTruthy();
    expect(result.signature).toBeTruthy();
    expect(result.encryptedKeys.alice).toBeTruthy();
    expect(result.encryptedKeys.bob).toBeTruthy();

    const decrypted = localDecrypt(
      result.ciphertext,
      result.signature,
      taskId,
      alice.publicKey,
      result.encryptedKeys.bob,
      bob.privateKey,
    );
    expect(decrypted).toBe(plaintext);
  });

  it("alice can also decrypt her own message", () => {
    const plaintext = "Self-decrypt test";
    const result = localEncrypt(plaintext, taskId, alice.privateKey, {
      alice: alice.publicKey,
      bob: bob.publicKey,
    });

    const decrypted = localDecrypt(
      result.ciphertext,
      result.signature,
      taskId,
      alice.publicKey,
      result.encryptedKeys.alice,
      alice.privateKey,
    );
    expect(decrypted).toBe(plaintext);
  });

  it("fails with wrong private key", () => {
    const result = localEncrypt("secret", taskId, alice.privateKey, {
      alice: alice.publicKey,
    });

    expect(() =>
      localDecrypt(result.ciphertext, result.signature, taskId, alice.publicKey, result.encryptedKeys.alice, bob.privateKey)
    ).toThrow();
  });

  it("fails with tampered signature", () => {
    const result = localEncrypt("secret", taskId, alice.privateKey, {
      bob: bob.publicKey,
    });

    expect(() =>
      localDecrypt(result.ciphertext, "AAAA" + result.signature.slice(4), taskId, alice.publicKey, result.encryptedKeys.bob, bob.privateKey)
    ).toThrow("Signature verification failed");
  });

  it("fails with wrong taskId (replay attack)", () => {
    const result = localEncrypt("secret", taskId, alice.privateKey, {
      bob: bob.publicKey,
    });

    expect(() =>
      localDecrypt(result.ciphertext, result.signature, "different-task", alice.publicKey, result.encryptedKeys.bob, bob.privateKey)
    ).toThrow("Signature verification failed");
  });
});

describe("detectProvider", () => {
  const testDir = join(tmpdir(), `pairai-detect-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("[REQ-033-01a] returns null when no provider directories exist", () => {
    const original = process.cwd();
    process.chdir(testDir);
    try {
      delete process.env.GEMINI_CLI;
      expect(detectProvider()).toBeNull();
    } finally {
      process.chdir(original);
    }
  });

  it("[REQ-033-01c] returns the single matching provider", () => {
    const original = process.cwd();
    mkdirSync(join(testDir, ".cursor"));
    process.chdir(testDir);
    try {
      delete process.env.GEMINI_CLI;
      expect(detectProvider()).toBe("cursor");
    } finally {
      process.chdir(original);
    }
  });

  it("[REQ-033-01b] returns null when multiple provider directories exist", () => {
    const original = process.cwd();
    mkdirSync(join(testDir, ".cursor"));
    mkdirSync(join(testDir, ".vscode"));
    process.chdir(testDir);
    try {
      delete process.env.GEMINI_CLI;
      expect(detectProvider()).toBeNull();
    } finally {
      process.chdir(original);
    }
  });

  it("[REQ-033-01d] returns gemini when GEMINI_CLI env is set (even with no dirs)", () => {
    const original = process.cwd();
    process.chdir(testDir);
    try {
      process.env.GEMINI_CLI = "1";
      expect(detectProvider()).toBe("gemini");
    } finally {
      delete process.env.GEMINI_CLI;
      process.chdir(original);
    }
  });
});

// ── PoW Tests ─────────────────────────────────────────────────────────────

describe("solveChallenge", () => {
  it("[REQ-060-07m] solveChallenge produces a solution with correct leading zero bits", () => {
    const challenge = "a".repeat(64);
    const difficulty = 4;
    const solution = solveChallenge(challenge, difficulty);
    expect(typeof solution).toBe("string");
    expect(solution).toMatch(/^[0-9a-f]{8}$/);

    // Verify the solution actually satisfies the difficulty
    const hash = createHash("sha256").update(challenge + solution).digest();
    let zeroBits = 0;
    for (const byte of hash) {
      if (byte === 0) { zeroBits += 8; continue; }
      zeroBits += Math.clz32(byte) - 24;
      break;
    }
    expect(zeroBits).toBeGreaterThanOrEqual(difficulty);
  });

  it("[REQ-060-07m] solveChallenge works with difficulty=1", () => {
    const challenge = createHash("sha256").update("test-challenge").digest("hex");
    const solution = solveChallenge(challenge, 1);
    expect(solution).toBeTruthy();

    const hash = createHash("sha256").update(challenge + solution).digest();
    // First bit must be 0 → first byte < 128
    expect(hash[0]! < 128 || hash[0] === undefined).toBe(true);
  });
});

describe("[REQ-060-07m] solveHubChallenge", () => {
  let mockServer: Server;
  let port: number;

  beforeAll(async () => {
    mockServer = createServer((req, res) => {
      if (req.url === "/agents/challenge") {
        const challenge = createHash("sha256").update(Date.now().toString()).digest("hex");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge, difficulty: 1, algorithm: "SHA-256" }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(r => mockServer.listen(0, () => {
      port = (mockServer.address() as { port: number }).port;
      r();
    }));
  });

  afterAll(() => mockServer.close());

  it("[REQ-060-07m] solveHubChallenge fetches challenge from hub and returns {challenge, solution}", async () => {
    const result = await solveHubChallenge(`http://localhost:${port}`);
    expect(result).not.toBeNull();
    expect(result!.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(result!.solution).toMatch(/^[0-9a-f]{8}$/);

    // Verify solution is valid for the challenge
    const hash = createHash("sha256").update(result!.challenge + result!.solution).digest();
    let zeroBits = 0;
    for (const byte of hash) {
      if (byte === 0) { zeroBits += 8; continue; }
      zeroBits += Math.clz32(byte) - 24;
      break;
    }
    expect(zeroBits).toBeGreaterThanOrEqual(1);
  });

  it("[REQ-060-07m] solveHubChallenge returns null when hub returns non-OK status", async () => {
    // Point to a non-existent server
    const result = await solveHubChallenge("http://localhost:1");
    expect(result).toBeNull();
  });
});
