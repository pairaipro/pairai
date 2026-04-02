import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenRouterClient } from "./openrouter.js";

describe("imageGeneration", () => {
  let client: OpenRouterClient;

  beforeEach(() => {
    client = new OpenRouterClient("test-key");
  });

  it("extracts image from message.images[] (OpenRouter format)", async () => {
    const mockResponse = {
      choices: [{
        message: {
          content: null,
          images: [
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ=" } },
          ],
        },
      }],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await client.imageGeneration("google/gemini-3.1-flash-image-preview", "a blue logo");

    expect(result.base64).toBe("/9j/4AAQ=");
    expect(result.revisedPrompt).toBeUndefined();

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toContain("/chat/completions");
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe("google/gemini-3.1-flash-image-preview");
    expect(body.modalities).toEqual(["image", "text"]);
  });

  it("extracts image from content[] (inline format)", async () => {
    const mockResponse = {
      choices: [{
        message: {
          content: [
            { type: "text", text: "Here is your logo" },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          ],
        },
      }],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await client.imageGeneration("test-model", "a blue logo");

    expect(result.base64).toBe("iVBORw0KGgo=");
    expect(result.revisedPrompt).toBe("Here is your logo");
  });

  it("throws on API error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("bad request"),
    });

    await expect(client.imageGeneration("test-model", "test")).rejects.toThrow("OpenRouter API error 400");
  });

  it("throws when no image in response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "just text" } }] }),
    });

    await expect(client.imageGeneration("test-model", "test")).rejects.toThrow("no image data");
  });

  it("[REQ-043-01] throws on 200-status model error (data.error)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        error: { code: 503, message: "Model overloaded" },
      }),
    });

    await expect(client.imageGeneration("test-model", "test")).rejects.toThrow("OpenRouter model error: Model overloaded (code 503)");
  });

  it("[REQ-043-01] throws on per-choice error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{
          message: { content: null },
          error: { code: 400, message: "Content policy violation" },
        }],
      }),
    });

    await expect(client.imageGeneration("test-model", "test")).rejects.toThrow("OpenRouter choice error: Content policy violation (code 400)");
  });
});
