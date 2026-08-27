import type {
  UsageCoverage,
  UsageReceipt,
  UsageRollup,
  UsageRollupRow,
} from '@kontourai/station-contracts/usage-rollup';
import { providerPromptCacheInclusivity } from './usage-fold.js';

export const USAGE_ROLLUP_MAX_RECEIPTS = 500;
export const USAGE_ROLLUP_MAX_PAGE_SIZE = 100;

export interface UsageRollupFoldInput {
  from: string;
  to: string;
  receipts: readonly UsageReceipt[];
  /** Full bounded-window material, distinct from the paginated drilldown. */
  aggregateReceipts?: readonly UsageReceipt[];
  coverage: readonly UsageCoverage[];
  groupBy?: 'provider' | 'model' | 'station' | 'conversation' | 'task' | 'day';
  cursor?: string;
  pageSize?: number;
}

function validAmount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function addMeasured(current: number | undefined, next: number | undefined) {
  return validAmount(next) ? (current ?? 0) + next : current;
}

function worstPricingStatus(
  current: UsageRollupRow['pricingStatus'],
  next: UsageReceipt['pricing']['status'],
): UsageRollupRow['pricingStatus'] {
  const rank = { priced: 0, partial: 1, unpriced: 2 } as const;
  return rank[next] > rank[current] ? next : current;
}

function addCostBucket(
  buckets: Array<{ amount: number; currency: string }>,
  cost: UsageReceipt['reportedCost'],
) {
  if (!cost || !validAmount(cost.amount)) return;
  const bucket = buckets.find((item) => item.currency === cost.currency);
  if (bucket) bucket.amount += cost.amount;
  else buckets.push({ ...cost });
}

function keyFor(
  receipt: UsageReceipt,
  groupBy: UsageRollupFoldInput['groupBy'],
) {
  // Rollup windows use Station observation time. Provider-created clocks can
  // be late, early, or skewed and cannot move a Station-observed receipt into
  // a different local reporting day.
  const day = receipt.observedAt?.slice(0, 10);
  const part =
    groupBy === 'model'
      ? receipt.model
      : groupBy === 'station'
        ? receipt.stationId
        : groupBy === 'conversation'
          ? receipt.conversationId
          : groupBy === 'task'
            ? receipt.taskId
            : groupBy === 'day'
              ? day
              : receipt.provider;
  return `${groupBy ?? 'provider'}:${part ?? 'unattributed'}`;
}

/**
 * Pure receipt rollup. It deliberately does not turn absent fields into zero,
 * mix currencies/snapshots, or infer cache-inclusive totals for undeclared
 * providers. The existing provider declaration remains the one authority.
 */
export function foldUsageReceipts(input: UsageRollupFoldInput): UsageRollup {
  const pageSize = Math.min(
    Math.max(input.pageSize ?? 50, 1),
    USAGE_ROLLUP_MAX_PAGE_SIZE,
  );
  // Receipt identity is stable across local replay and peer pagination. A
  // repeated id is replacement, not another billable event; later observed
  // data wins so delayed corrections cannot double-count.
  const deduplicated = new Map<string, UsageReceipt>();
  for (const receipt of input.aggregateReceipts ?? input.receipts) {
    const current = deduplicated.get(receipt.id);
    if (!current || (receipt.observedAt ?? '') >= (current.observedAt ?? '')) {
      deduplicated.set(receipt.id, receipt);
    }
  }
  // A rollup window is a Station observation window, never an untrusted
  // provider clock window. Legacy rows with no Station clock are deliberately
  // excluded here; a caller that elects to expose their lifetime total must
  // do so through a separately labelled legacy policy, not every date range.
  const aggregateMaterial = [...deduplicated.values()]
    .filter(
      (receipt) =>
        receipt.observedAt !== undefined &&
        receipt.observedAt >= `${input.from}T00:00:00.000Z` &&
        receipt.observedAt <= `${input.to}T23:59:59.999Z`,
    )
    .sort(
      (left, right) =>
        left.observedAt!.localeCompare(right.observedAt!) ||
        left.id.localeCompare(right.id),
    );
  // This is a global cap, so it must be applied only after cross-source
  // replacement/deduplication. The source(s) whose surviving material falls
  // past the cap are explicitly partial rather than silently disappearing.
  const dropped = aggregateMaterial.slice(USAGE_ROLLUP_MAX_RECEIPTS);
  const droppedByStation = new Map<string, number>();
  for (const receipt of dropped) {
    droppedByStation.set(
      receipt.stationId,
      (droppedByStation.get(receipt.stationId) ?? 0) + 1,
    );
  }
  const accepted = aggregateMaterial.slice(0, USAGE_ROLLUP_MAX_RECEIPTS);
  const rows = new Map<string, UsageRollupRow>();
  for (const receipt of accepted) {
    const key = keyFor(receipt, input.groupBy);
    const row = rows.get(key) ?? {
      key,
      stationId: receipt.stationId,
      provider: receipt.provider,
      ...(receipt.model ? { model: receipt.model } : {}),
      ...(receipt.conversationId
        ? { conversationId: receipt.conversationId }
        : {}),
      ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
      ...(receipt.observedAt ? { day: receipt.observedAt.slice(0, 10) } : {}),
      pricingStatus: receipt.pricing?.status ?? 'unpriced',
      receiptCount: 0,
    };
    row.inputTokens = addMeasured(row.inputTokens, receipt.inputTokens);
    row.outputTokens = addMeasured(row.outputTokens, receipt.outputTokens);
    row.cacheReadTokens = addMeasured(
      row.cacheReadTokens,
      receipt.cacheReadTokens,
    );
    row.cacheWriteTokens = addMeasured(
      row.cacheWriteTokens,
      receipt.cacheWriteTokens,
    );
    // This query makes cache semantics explicit. It does not generate an
    // extra total: callers may only use a cache-inclusive label when shared
    // authority says the provider is disjoint.
    providerPromptCacheInclusivity(receipt.provider);
    if (receipt.reportedCost && validAmount(receipt.reportedCost.amount)) {
      row.reportedCostBuckets ??= [];
      addCostBucket(row.reportedCostBuckets, receipt.reportedCost);
      if (!row.reportedCost) row.reportedCost = { ...receipt.reportedCost };
      else if (row.reportedCost.currency === receipt.reportedCost.currency)
        row.reportedCost.amount += receipt.reportedCost.amount;
      else {
        delete row.reportedCost;
      }
    }
    if (receipt.estimatedCost && validAmount(receipt.estimatedCost.amount)) {
      row.estimatedCostBuckets ??= [];
      const bucket = row.estimatedCostBuckets.find(
        (item) =>
          item.currency === receipt.estimatedCost!.currency &&
          item.pricingSnapshotId === receipt.estimatedCost!.pricingSnapshotId &&
          item.pricingSnapshotCapturedAt ===
            receipt.estimatedCost!.pricingSnapshotObservedAt &&
          item.pricingSnapshotSource ===
            receipt.estimatedCost!.pricingSnapshotSource,
      );
      if (bucket) bucket.amount += receipt.estimatedCost.amount;
      else
        row.estimatedCostBuckets.push({
          amount: receipt.estimatedCost.amount,
          currency: receipt.estimatedCost.currency,
          pricingSnapshotId: receipt.estimatedCost.pricingSnapshotId,
          ...(receipt.estimatedCost.pricingSnapshotObservedAt
            ? {
                pricingSnapshotCapturedAt:
                  receipt.estimatedCost.pricingSnapshotObservedAt,
              }
            : {}),
          ...(receipt.estimatedCost.pricingSnapshotSource
            ? {
                pricingSnapshotSource:
                  receipt.estimatedCost.pricingSnapshotSource,
              }
            : {}),
        });
      if (!row.estimatedCost) row.estimatedCost = { ...receipt.estimatedCost };
      else if (
        row.estimatedCost.currency === receipt.estimatedCost.currency &&
        row.estimatedCost.pricingSnapshotId ===
          receipt.estimatedCost.pricingSnapshotId &&
        row.estimatedCost.pricingSnapshotObservedAt ===
          receipt.estimatedCost.pricingSnapshotObservedAt &&
        row.estimatedCost.pricingSnapshotSource ===
          receipt.estimatedCost.pricingSnapshotSource
      )
        row.estimatedCost.amount += receipt.estimatedCost.amount;
      else {
        delete row.estimatedCost;
      }
    }
    // Provider-cost companion receipts have no token estimate of their own;
    // they must not downgrade the status of the paired, snapshot-priced token
    // receipt merely because the provider reported an exact charge instead.
    if (
      receipt.inputTokens !== undefined ||
      receipt.outputTokens !== undefined ||
      receipt.cacheReadTokens !== undefined ||
      receipt.cacheWriteTokens !== undefined
    )
      row.pricingStatus = worstPricingStatus(
        row.pricingStatus,
        receipt.pricing?.status ?? 'unpriced',
      );
    row.receiptCount += 1;
    rows.set(key, row);
  }
  // Source cursors are consumed before this fold. Keeping this function free
  // of a second offset prevents a remote page from being skipped twice.
  // `receipts` has already been selected by its source cursor. Never apply a
  // second offset here; doing so skips an entire page after a remote source
  // has advanced its observed-time/id cursor.
  const receipts = input.receipts
    .filter(
      (receipt) =>
        receipt.observedAt !== undefined &&
        receipt.observedAt >= `${input.from}T00:00:00.000Z` &&
        receipt.observedAt <= `${input.to}T23:59:59.999Z`,
    )
    .sort(
      (left, right) =>
        left.observedAt!.localeCompare(right.observedAt!) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, pageSize);
  return {
    window: { from: input.from, to: input.to },
    rows: [...rows.values()],
    coverage: input.coverage.map((coverage) => {
      const droppedReceiptCount = droppedByStation.get(coverage.stationId);
      return droppedReceiptCount === undefined
        ? coverage
        : {
            ...coverage,
            state: 'partial' as const,
            reason: 'aggregate receipt cap reached',
            droppedReceiptCount,
            droppedReceiptWindow: { from: input.from, to: input.to },
          };
    }),
    receipts,
  };
}
