import type {
  BedrockModelCatalog,
  ModelPricing,
} from '../providers/llm/bedrock-models.js';

/**
 * Find pricing info for a model. Returns the matching ModelPricing entry or undefined.
 */
export async function findModelPricing(
  catalog: BedrockModelCatalog | undefined,
  modelId: string,
  region: string,
): Promise<ModelPricing | undefined> {
  if (!catalog) return undefined;
  const pricing = await catalog.getModelPricing(region);
  return pricing?.find(
    (p) =>
      p.modelId === modelId ||
      modelId.includes(p.modelId.toLowerCase().replace(/\s+/g, '-')),
  );
}

/**
 * Estimate cost in USD from token usage and model pricing.
 * Returns 0 if pricing is unavailable.
 */
export function estimateCost(
  pricing: ModelPricing | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!pricing?.inputTokenPrice || !pricing?.outputTokenPrice) return 0;
  return (
    (inputTokens / 1000) * pricing.inputTokenPrice +
    (outputTokens / 1000) * pricing.outputTokenPrice
  );
}
