import type {
  PricingSnapshot,
  PublishedRateRetailEquivalent,
  UsagePricingStatus,
  UsageReceipt,
} from '@kontourai/station-contracts/usage-rollup';
import { isPublishedTariffBasis } from '@kontourai/station-contracts/usage-rollup';
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
        Object.freeze({
          ...snapshot,
          ...(snapshot.publishedTariff
            ? {
                publishedTariff: Object.freeze({ ...snapshot.publishedTariff }),
              }
            : {}),
        }),
      );
    }
  }

  snapshotFor(provider: string, model: string): PricingSnapshot | undefined {
    const snapshot = this.snapshots.get(`${provider}\u0000${model}`);
    return snapshot
      ? {
          ...snapshot,
          ...(snapshot.publishedTariff
            ? { publishedTariff: { ...snapshot.publishedTariff } }
            : {}),
        }
      : undefined;
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
  const retailEquivalent = publishedRateRetailEquivalent(receipt, snapshot);
  if (snapshot.publishedTariff)
    return { ...receipt, pricing: { status: 'unpriced' }, retailEquivalent };
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
  if (status !== 'priced') return { ...receipt, pricing, retailEquivalent };
  const amount =
    ((input ?? 0) * (snapshot.inputPerMillion ?? 0) +
      (output ?? 0) * (snapshot.outputPerMillion ?? 0) +
      (cacheRead ?? 0) * (snapshot.cacheReadPerMillion ?? 0) +
      (cacheWrite ?? 0) * (snapshot.cacheWritePerMillion ?? 0)) /
    1_000_000;
  return {
    ...receipt,
    pricing,
    retailEquivalent,
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

/** Retail is a separate, route-bound observation; an engine-reported zero never fills it. */
function publishedRateRetailEquivalent(
  receipt: Omit<UsageReceipt, 'pricing' | 'estimatedCost'>,
  snapshot: PricingSnapshot,
): PublishedRateRetailEquivalent {
  const basis = snapshot.publishedTariff;
  if (!isPublishedTariffBasis(basis))
    return { state: 'unavailable', reason: 'price-unavailable' };
  if (
    !receipt.route ||
    receipt.route.id !== basis.routeId ||
    receipt.route.modelRevision !== basis.modelRevision ||
    receipt.route.tariffId !== basis.tariffId ||
    !receipt.route.provenance?.sourceRef ||
    !['provider-reported', 'host-observed'].includes(
      receipt.route.provenance.authority,
    )
  )
    return { state: 'unavailable', reason: 'route-unverified' };
  const when = receipt.occurredAt;
  if (
    !when ||
    !Number.isFinite(Date.parse(when)) ||
    Date.parse(when) < Date.parse(basis.effectiveAt)
  )
    return { state: 'unavailable', reason: 'tariff-not-effective' };
  const input = receipt.inputTokens;
  if (
    input === undefined ||
    receipt.outputTokens === undefined ||
    basis.reasoning === 'unknown' ||
    (basis.reasoning === 'separate' && receipt.reasoningTokens === undefined) ||
    (basis.reasoning === 'included-in-output' &&
      receipt.reasoningTokens !== undefined &&
      receipt.reasoningTokens > receipt.outputTokens)
  )
    return { state: 'unavailable', reason: 'category-unverified' };
  const cacheRead = receipt.cacheReadTokens;
  const cacheWrite = receipt.cacheWriteTokens;
  if (
    basis.cacheInput === 'included' &&
    (cacheRead !== undefined || cacheWrite !== undefined) &&
    (input === undefined || (cacheRead ?? 0) + (cacheWrite ?? 0) > input)
  )
    return { state: 'unavailable', reason: 'category-unverified' };
  const components = [
    [
      input === undefined
        ? undefined
        : input -
          (basis.cacheInput === 'included'
            ? (cacheRead ?? 0) + (cacheWrite ?? 0)
            : 0),
      snapshot.inputPerMillion,
    ],
    [receipt.outputTokens, snapshot.outputPerMillion],
    [cacheRead, snapshot.cacheReadPerMillion],
    [cacheWrite, snapshot.cacheWritePerMillion],
    [
      basis.reasoning === 'included-in-output'
        ? undefined
        : receipt.reasoningTokens,
      basis.reasoning === 'separate' ? basis.reasoningPerMillion : undefined,
    ],
  ] as const;
  const reported = components.filter(([tokens]) => tokens !== undefined);
  if (
    reported.length === 0 ||
    reported.some(([tokens, rate]) => !validRate(tokens) || !validRate(rate))
  )
    return { state: 'unavailable', reason: 'category-unverified' };
  return {
    state:
      Date.parse(when) > Date.parse(basis.validUntil) ? 'stale' : 'available',
    amount: reported.reduce(
      (sum, [tokens, rate]) => sum + (tokens! * rate!) / 1_000_000,
      0,
    ),
    currency: snapshot.currency,
    basis: { ...basis },
  };
}
