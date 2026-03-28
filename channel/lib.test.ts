import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { localEncrypt, localDecrypt } from "./lib.js";

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
