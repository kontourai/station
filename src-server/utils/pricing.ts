import type { CacheAwareTokenComponents } from '@kontourai/station-shared/usage-fold';
import type {
  BedrockModelCatalog,
  ModelPricing,
} from '../providers/llm/bedrock-models.js';

/**
 * Join an invocation model id to an AWS Price List row.
 *
 * The two sides are different kinds of string and neither is authoritative for
 * the other: `modelId` is a Bedrock invocation id
 * (`anthropic.claude-3-5-sonnet-20240620-v1:0`), while `ModelPricing.modelId`
 * carries the Price List's `attributes.model` product attribute, a
 * human-readable name ("Claude 3.5 Sonnet"). Exact equality between them is
 * essentially never true, so the slug containment below is the join that
 * actually works — it is load-bearing, not a loose fallback, and removing it
 * would leave every Bedrock turn unpriced rather than priced more strictly.
 *
 * Containment is broad enough to match ids it was never meant to describe,
 * which is exactly why {@link findModelPricing} refuses to reach this function
 * for anything but a Bedrock route.
 */
export function bedrockPricingFor(
  entries: readonly ModelPricing[] | undefined,
  modelId: string,
): ModelPricing | undefined {
  return entries?.find(
    (entry) =>
      entry.modelId === modelId ||
      modelId.includes(entry.modelId.toLowerCase().replace(/\s+/g, '-')),
  );
}

/**
 * Bedrock's price list prices Bedrock's routes.
 *
 * The catalog is constructed unconditionally at runtime init, so without
 * `providerType` every provider's turn consulted Amazon's prices and could be
 * shown a figure Amazon quoted for a route Station never billed through
 * Bedrock. An unknown or non-Bedrock route is unpriced, which callers already
 * represent honestly as an absent cost rather than a zero.
 */
export async function findModelPricing(
  catalog: BedrockModelCatalog | undefined,
  modelId: string,
  region: string,
  providerType: string | undefined,
): Promise<ModelPricing | undefined> {
  if (!catalog) return undefined;
  if (providerType !== 'bedrock') return undefined;
  const pricing = await catalog.getModelPricing(region);
  return bedrockPricingFor(pricing, modelId);
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
