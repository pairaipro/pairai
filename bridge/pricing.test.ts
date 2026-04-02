import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeCost, fetchModelPricing } from "./pricing.js";

describe("computeCost", () => {
  it("[REQ-043-12] returns null when pricing cache is empty", () => {
    expect(computeCost("some-model", 100, 50)).toBeNull();
  });
});

describe("fetchModelPricing", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("[REQ-043-11] fetches model pricing from OpenRouter /models API", async () => {
    // Mock the OpenRouter API response
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "test/model-a", pricing: { prompt: "0.000001", completion: "0.000002" } },
          { id: "test/model-b", pricing: { prompt: "0.0000005", completion: "0.000001" } },
          { id: "test/no-pricing" }, // no pricing field
        ],
      }),
    });

    const pricing = await fetchModelPricing();
    expect(pricing.size).toBe(2);
    expect(pricing.get("test/model-a")).toEqual({
      promptPerToken: 0.000001,
      completionPerToken: 0.000002,
    });
    expect(pricing.get("test/model-b")).toEqual({
      promptPerToken: 0.0000005,
      completionPerToken: 0.000001,
    });
    expect(pricing.has("test/no-pricing")).toBe(false);

    // After fetching, computeCost should work
    const cost = computeCost("test/model-a", 1000, 500);
    expect(cost).toBeCloseTo(0.002, 6); // 1000*0.000001 + 500*0.000002
  });

  it("[REQ-043-11] throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchModelPricing()).rejects.toThrow("OpenRouter /models returned 500");
  });
});
