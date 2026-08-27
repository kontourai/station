import type {
  PricingSnapshot,
  UsagePricingStatus,
  UsageReceipt,
} from '@kontourai/station-contracts/usage-rollup';
import { providerPromptCacheInclusivity } from '@kontourai/station-shared/usage-fold';

/**
 * An immutable view over an already-captured Station pricing catalog. It is
 * intentionally synchronous: a receipt writer may only use a snapshot it
 * already has, never turn a usage read into a provider or Datum lookup.
 */
export interface UsagePricingSnapshotReader {
  snapshotFor(provider: string, model: string): PricingSnapshot | undefined;
}

export class CatalogUsagePricingSnapshotReader
  implements UsagePricingSnapshotReader
{
  private readonly snapshots = new Map<string, PricingSnapshot>();

  constructor(snapshots: readonly PricingSnapshot[]) {
    for (const snapshot of snapshots) {
      // The catalog producer owns capture; defensive copies prevent a later
      // refresh mutating values that have already been used in a receipt.
      this.snapshots.set(
        `${snapshot.provider}\u0000${snapshot.model}`,
        Object.freeze({ ...snapshot }),
      );
    }
  }

  snapshotFor(provider: string, model: string): PricingSnapshot | undefined {
    const snapshot = this.snapshots.get(`${provider}\u0000${model}`);
    return snapshot ? { ...snapshot } : undefined;
  }
}

/** Stamp a receipt once. Callers persist the result with the canonical event. */
export function stampUsageReceiptPrice(
  receipt: Omit<UsageReceipt, 'pricing' | 'estimatedCost'>,
  reader: UsagePricingSnapshotReader,
): UsageReceipt {
  if (!receipt.model) return { ...receipt, pricing: { status: 'unpriced' } };
  const snapshot = reader.snapshotFor(receipt.provider, receipt.model);
  // A reader is an adapter boundary. Do not trust a result for a different
  // model/provider, or malformed prompt rates, as pricing provenance.
  if (
    !snapshot ||
    snapshot.provider !== receipt.provider ||
    snapshot.model !== receipt.model
  )
    return { ...receipt, pricing: { status: 'unpriced' } };
  const input = receipt.inputTokens;
  const output = receipt.outputTokens;
  const cacheRead = receipt.cacheReadTokens;
  const cacheWrite = receipt.cacheWriteTokens;
  // Cache components are separately priceable only when shared authority
  // proves them disjoint from prompt tokens. Subset/unverified providers must
  // stay partial: adding would double-count; omitting would hide a fact.
  const cacheIsDisjoint =
    providerPromptCacheInclusivity(receipt.provider) === 'disjoint';
  const inputPriced =
    input === undefined || validRate(snapshot.inputPerMillion);
  const outputPriced =
    output === undefined || validRate(snapshot.outputPerMillion);
  const cacheReadPriced =
    cacheRead === undefined ||
    (cacheIsDisjoint && validRate(snapshot.cacheReadPerMillion));
  const cacheWritePriced =
    cacheWrite === undefined ||
    (cacheIsDisjoint && validRate(snapshot.cacheWritePerMillion));
  const status: UsagePricingStatus =
    inputPriced && outputPriced && cacheReadPriced && cacheWritePriced
      ? 'priced'
      : 'partial';
  const pricing = {
    status,
    pricingSnapshotId: snapshot.id,
    pricingSnapshotCapturedAt: snapshot.capturedAt,
    ...(snapshot.source ? { pricingSnapshotSource: snapshot.source } : {}),
    provider: snapshot.provider,
    model: snapshot.model,
    currency: snapshot.currency,
  } as const;
  if (status !== 'priced') return { ...receipt, pricing };
  const amount =
    ((input ?? 0) * (snapshot.inputPerMillion ?? 0) +
      (output ?? 0) * (snapshot.outputPerMillion ?? 0) +
      (cacheRead ?? 0) * (snapshot.cacheReadPerMillion ?? 0) +
      (cacheWrite ?? 0) * (snapshot.cacheWritePerMillion ?? 0)) /
    1_000_000;
  return {
    ...receipt,
    pricing,
    estimatedCost: {
      amount,
      currency: snapshot.currency,
      pricingSnapshotId: snapshot.id,
      pricingSnapshotObservedAt: snapshot.capturedAt,
      ...(snapshot.source ? { pricingSnapshotSource: snapshot.source } : {}),
    },
  };
}

function validRate(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
