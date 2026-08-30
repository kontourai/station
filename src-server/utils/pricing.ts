import type { CacheAwareTokenComponents } from '@kontourai/station-shared/usage-fold';
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
 * Estimate cost in USD from the token components the provider reported.
 * Every reported component must have a finite, non-negative price; otherwise
 * the usage is unpriced and the result stays absent. This is deliberately
 * all-or-nothing: callers have no "partial estimate" signal, so returning the
 * priced subset would present a known underestimate as complete. A valid zero
 * rate or a measured zero-token component is still a real priced result of
 * `0`.
 */
export function estimateCost(
  pricing: ModelPricing | undefined,
  usage: CacheAwareTokenComponents,
): number | undefined {
  const components = [
    [usage.inputTokens, pricing?.inputTokenPrice],
    [usage.outputTokens, pricing?.outputTokenPrice],
    [usage.cacheReadTokens, pricing?.cacheReadTokenPrice],
    [usage.cacheWriteTokens, pricing?.cacheWriteTokenPrice],
  ] as const;
  const reported = components.filter(([tokens]) => tokens !== undefined);
  if (reported.length === 0) return undefined;
  if (
    reported.some(
      ([tokens, rate]) => !validFigure(tokens) || !validFigure(rate),
    )
  ) {
    return undefined;
  }
  return reported.reduce(
    (total, [tokens, rate]) =>
      total + ((tokens as number) / 1000) * (rate as number),
    0,
  );
}

function validFigure(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
