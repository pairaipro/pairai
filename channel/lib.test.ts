import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localEncrypt, localDecrypt, detectProvider } from "./lib.js";

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
