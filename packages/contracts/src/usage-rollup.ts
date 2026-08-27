/**
 * Read-only, provider-observed usage facts. These are not invoices and never
 * grant billing or routing authority (station#4135).
 */
export interface PricingSnapshot {
  id: string;
  /** When this immutable catalog observation was captured, not when read. */
  capturedAt: string;
  /** The catalog authority that produced this observation. */
  source?: string;
  currency: string;
  provider: string;
  model: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

/** The absence of a price is evidence too; never render it as a zero. */
export type UsagePricingStatus = 'priced' | 'partial' | 'unpriced';

export interface UsageReceipt {
  /** Stable receipt identity. Replacement receipts retain this identity. */
  id: string;
  /** The exact canonical event that Station observed. */
  sourceEventId?: string;
  stationId: string;
  provider: string;
  model?: string;
  threadId?: string;
  turnId?: string;
  conversationId?: string;
  taskId?: string;
  occurredAt?: string;
  /** When Station observed this fact. Undefined is an honest legacy gap. */
  observedAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Exact provider amount; it is never recomputed or normalized. */
  reportedCost?: { amount: number; currency: string };
  /** A locally computed estimate under this immutable snapshot only. */
  estimatedCost?: {
    amount: number;
    currency: string;
    pricingSnapshotId: string;
    /** Immutable snapshot observation; absent only on pre-snapshot receipts. */
    pricingSnapshotObservedAt?: string;
    pricingSnapshotSource?: string;
  };
  /** Snapshot provenance for this receipt, including unpriceable receipts. */
  pricing: {
    status: UsagePricingStatus;
    pricingSnapshotId?: string;
    pricingSnapshotCapturedAt?: string;
    pricingSnapshotSource?: string;
    /** Exact catalog identity used for a priced receipt. */
    provider?: string;
    model?: string;
    currency?: string;
  };
}

export type UsageCoverageState =
  | 'complete'
  | 'partial'
  | 'offline'
  | 'stale'
  | 'unknown';

export interface UsageCoverage {
  stationId: string;
  state: UsageCoverageState;
  reason?: string;
  observedAt?: string;
  /** Last Station observation included in this window, if one exists. */
  observedThrough?: string;
  /** Freshness is explicit so an old complete source does not read as live. */
  freshness?: 'fresh' | 'stale' | 'unknown';
  /** What Station observed versus what the provider actually reported. */
  observedTurnCount?: number;
  usageReportedTurnCount?: number;
  /** Provider/window subcoverage; the source state is their weakest result. */
  providers?: UsageProviderCoverage[];
  /** Material omitted after global deduplication exceeded the aggregate cap. */
  droppedReceiptCount?: number;
  /** The requested observation window of the omitted aggregate material. */
  droppedReceiptWindow?: { from: string; to: string };
  window: { from: string; to: string };
}

export interface UsageProviderCoverage {
  provider: string;
  state: UsageCoverageState;
  window: { from: string; to: string };
  observedTurnCount?: number;
  usageReportedTurnCount?: number;
  observedThrough?: string;
  freshness?: 'fresh' | 'stale' | 'unknown';
  reason?: string;
}

export interface UsageRollupRow {
  key: string;
  stationId: string;
  provider: string;
  model?: string;
  conversationId?: string;
  taskId?: string;
  day?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Only values sharing one currency may appear in this total. */
  reportedCost?: { amount: number; currency: string };
  /** Only estimates sharing one immutable snapshot and currency are summed. */
  estimatedCost?: {
    amount: number;
    currency: string;
    pricingSnapshotId: string;
    pricingSnapshotObservedAt?: string;
    pricingSnapshotSource?: string;
  };
  /** The displayed estimate can be incomplete even when a priced bucket exists. */
  pricingStatus: UsagePricingStatus;
  /** Cost buckets preserve mixed currencies/snapshots instead of erasing them. */
  reportedCostBuckets?: Array<{ amount: number; currency: string }>;
  estimatedCostBuckets?: Array<{
    amount: number;
    currency: string;
    pricingSnapshotId: string;
    pricingSnapshotCapturedAt?: string;
    pricingSnapshotSource?: string;
  }>;
  receiptCount: number;
}

export interface UsageRollup {
  window: { from: string; to: string };
  rows: UsageRollupRow[];
  coverage: UsageCoverage[];
  receipts: UsageReceipt[];
  /**
   * Bounded source material used to derive `rows`. This is deliberately
   * separate from the receipt drilldown page: changing a page cursor must
   * never turn a full-window total into a page total. It is an internal
   * source-transfer field and is omitted by the public route.
   */
  aggregateReceipts?: UsageReceipt[];
  nextCursor?: string;
}
