import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(args: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(`npx tsx bridge/bridge.ts ${args}`, {
      cwd: ROOT, encoding: "utf-8", timeout: 10_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.status ?? 1 };
  }
}

describe("CLI commands (spec 11)", () => {
  it("11-01: version prints correct version", () => {
    const r = run("version");
    expect(r.stdout).toContain("pairai-bridge v");
    expect(r.code).toBe(0);
  });

  it("11-02: --version flag works", () => {
    const r = run("--version");
    expect(r.stdout).toContain("pairai-bridge v");
    expect(r.code).toBe(0);
  });

  it("11-03: setup without name shows usage error", () => {
    const r = run("setup");
    expect(r.stderr).toContain("Usage:");
    expect(r.code).toBe(1);
  });

  it("11-04: pair without code shows usage error", () => {
    const r = run("pair");
    expect(r.stderr).toContain("Usage:");
    expect(r.code).toBe(1);
  });

  it("11-09: serve with missing config exits with error", () => {
    const r = run("serve --config /tmp/nonexistent-bridge-test.yaml");
    expect(r.stderr).toContain("Config file not found");
    expect(r.code).toBe(1);
  });

  it("11-10: unknown command shows usage", () => {
    const r = run("foobar");
    expect(r.stderr).toContain("Unknown command");
    expect(r.code).toBe(1);
  });
});
