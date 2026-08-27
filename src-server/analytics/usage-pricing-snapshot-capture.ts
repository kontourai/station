import { createHash } from 'node:crypto';
import type { PricingSnapshot } from '@kontourai/station-contracts/usage-rollup';
import type { ModelPricing } from '../providers/llm/bedrock-models.js';

/**
 * The write-time seam for historical pricing. Receipt readers receive only
 * its frozen output; they never consult a provider or a live catalog.
 */
export interface UsagePricingSnapshotCapture {
  capture(input: {
    provider: string;
    model: string;
    observedAt: string;
  }): Promise<PricingSnapshot | undefined>;
}

export interface BedrockPricingCatalogAuthority {
  getModelPricing(region?: string): Promise<ModelPricing[]>;
}

/**
 * Captures only an exact Bedrock catalog row at event ingestion. `ModelPricing`
 * uses per-thousand units; receipts use per-million units so their arithmetic
 * remains integral to the shared usage contract.
 */
export class BedrockUsagePricingSnapshotCapture
  implements UsagePricingSnapshotCapture
{
  constructor(
    private readonly catalog: BedrockPricingCatalogAuthority,
    private readonly region: string,
  ) {}

  async capture(input: {
    provider: string;
    model: string;
    observedAt: string;
  }): Promise<PricingSnapshot | undefined> {
    if (input.provider !== 'bedrock') return undefined;
    const pricing = await this.catalog.getModelPricing(this.region);
    // Never use the fuzzy UI lookup here: a historical receipt must name the
    // exact model/catalog row that was observed, or have no estimate at all.
    const entry = pricing.find(
      (candidate) => candidate.modelId === input.model,
    );
    if (!entry) return undefined;
    const source = `station.bedrock-model-catalog:${this.region}`;
    const inputPerMillion = validRate(entry.inputTokenPrice)
      ? entry.inputTokenPrice * 1_000
      : undefined;
    const outputPerMillion = validRate(entry.outputTokenPrice)
      ? entry.outputTokenPrice * 1_000
      : undefined;
    // A partial catalog is still a real historical observation. The reader
    // marks receipts partial rather than fabricating the absent component.
    if (inputPerMillion === undefined && outputPerMillion === undefined)
      return undefined;
    return Object.freeze({
      id: snapshotId({
        source,
        provider: input.provider,
        model: input.model,
        ...(inputPerMillion !== undefined ? { inputPerMillion } : {}),
        ...(outputPerMillion !== undefined ? { outputPerMillion } : {}),
      }),
      capturedAt: input.observedAt,
      source,
      currency: 'USD',
      provider: input.provider,
      model: input.model,
      ...(inputPerMillion !== undefined ? { inputPerMillion } : {}),
      ...(outputPerMillion !== undefined ? { outputPerMillion } : {}),
    });
  }
}

function snapshotId(value: Record<string, string | number>): string {
  return `pricing:${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

function validRate(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
