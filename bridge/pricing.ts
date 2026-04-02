export interface ModelPricing {
  promptPerToken: number;
  completionPerToken: number;
}

let pricingCache: Map<string, ModelPricing> | null = null;

const DEFAULT_MODELS_URL = "https://openrouter.ai/api/v1/models";

export async function fetchModelPricing(modelsUrl = DEFAULT_MODELS_URL): Promise<Map<string, ModelPricing>> {
  const res = await fetch(modelsUrl, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const data = (await res.json()) as { data: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }> };

  const map = new Map<string, ModelPricing>();
  for (const model of data.data) {
    const p = model.pricing;
    if (p?.prompt && p?.completion) {
      map.set(model.id, {
        promptPerToken: parseFloat(p.prompt),
        completionPerToken: parseFloat(p.completion),
      });
    }
  }
  pricingCache = map;
  return map;
}

export function computeCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  if (!pricingCache) return null;
  const pricing = pricingCache.get(modelId);
  if (!pricing) return null;
  return (promptTokens * pricing.promptPerToken) + (completionTokens * pricing.completionPerToken);
}
