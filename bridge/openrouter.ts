export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResult {
  message: ChatMessage;
  finish_reason: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  generationId: string | null;
}

export interface ImageGenerationResult {
  base64: string;
  mimeType: string;
  revisedPrompt?: string;
  generationId: string | null;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const TIMEOUT_MS = 120_000;

export class OpenRouterClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    options: { temperature?: number; max_tokens?: number } = {},
    tools?: ToolDef[],
  ): Promise<ChatCompletionResult> {
    const body: Record<string, unknown> = {
      model,
      messages,
      ...options,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`OpenRouter API error ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as {
      id?: string;
      choices?: Array<{ message: ChatMessage; finish_reason: string; error?: { code: number; message: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      error?: { code: number; message: string };
    };

    // Top-level error (200 status but model failed during processing)
    if (data.error) {
      throw new Error(`OpenRouter model error: ${data.error.message} (code ${data.error.code})`);
    }

    const choice = data.choices?.[0];
    if (!choice) throw new Error(`OpenRouter returned no choices: ${JSON.stringify(data).slice(0, 500)}`);

    // Per-choice error
    if (choice.error) {
      throw new Error(`OpenRouter choice error: ${choice.error.message} (code ${choice.error.code})`);
    }

    return {
      message: choice.message,
      finish_reason: choice.finish_reason,
      usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      generationId: data.id ?? null,
    };
  }

  async imageGeneration(
    model: string,
    prompt: string,
  ): Promise<ImageGenerationResult> {
    // OpenRouter uses chat completions with modalities for image generation
    const body = {
      model,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: prompt }],
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`OpenRouter API error ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as {
      id?: string;
      choices?: Array<{
        message: {
          content: string | null | Array<{ type: string; text?: string; image_url?: { url: string } }>;
          images?: Array<{ type: string; image_url?: { url: string } }>;
        };
        error?: { code: number; message: string };
      }>;
      error?: { code: number; message: string };
    };

    // Top-level error (200 status but model failed)
    if (data.error) {
      throw new Error(`OpenRouter model error: ${data.error.message} (code ${data.error.code})`);
    }

    const choice = data.choices?.[0];
    if (!choice) throw new Error(`OpenRouter returned no choices: ${JSON.stringify(data).slice(0, 500)}`);

    // Per-choice error
    if (choice.error) {
      throw new Error(`OpenRouter choice error: ${choice.error.message} (code ${choice.error.code})`);
    }

    let base64 = "";
    let mimeType = "image/png";
    let textDescription = "";

    // Check message.images[] (OpenRouter's format for image generation models)
    const images = choice.message.images;
    if (Array.isArray(images)) {
      for (const img of images) {
        if (img.image_url?.url) {
          const match = img.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) { mimeType = match[1]!; base64 = match[2]!; break; }
        }
      }
    }

    // Also check content[] (some models return images inline)
    const content = choice.message.content;
    if (!base64 && Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "image_url" && part.image_url?.url) {
          const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) { mimeType = match[1]!; base64 = match[2]!; break; }
        }
      }
    }

    // Extract text description
    if (typeof content === "string" && content) {
      textDescription = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text" && part.text) {
          textDescription += (textDescription ? "\n" : "") + part.text;
        }
      }
    }

    if (!base64) throw new Error("OpenRouter returned no image data in response");

    return { base64, mimeType, revisedPrompt: textDescription || undefined, generationId: data.id ?? null };
  }

  /** Query OpenRouter for the actual cost of a generation. Returns null on failure. */
  async getGenerationCost(generationId: string): Promise<number | null> {
    try {
      const res = await fetch(`${this.baseUrl}/generation?id=${encodeURIComponent(generationId)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: { total_cost?: number } };
      return data.data?.total_cost ?? null;
    } catch {
      return null;
    }
  }
}
