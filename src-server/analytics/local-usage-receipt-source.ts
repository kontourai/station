import type { UsageCoverage } from '@kontourai/station-contracts/usage-rollup';
import type { UsageAggregator } from './usage-aggregator.js';
import type {
  UsageReceiptSource,
  UsageRollupReadAuthority,
  UsageRollupRequest,
} from './usage-rollup-service.js';

/** Adapter over existing canonical EventStore folds; no second event model. */
export class LocalUsageReceiptSource implements UsageReceiptSource {
  constructor(
    readonly stationId: string,
    private readonly usageAggregator: UsageAggregator,
  ) {}

  async read(
    request: UsageRollupRequest,
    authority: UsageRollupReadAuthority,
    _signal: AbortSignal,
  ) {
    // Both reads narrow inside the bounded selection: filtering after the
    // 500-observation aggregate would let a busy engine or connection crowd
    // a quiet one out of the window and still report it as covered.
    const filter = {
      ...(request.provider ? { provider: request.provider } : {}),
      ...(request.connectionId !== undefined
        ? { connectionId: request.connectionId }
        : {}),
      ...(request.modelConnectionId !== undefined
        ? { modelConnectionId: request.modelConnectionId }
        : {}),
    };
    const page = this.usageAggregator.readUsageReceipts(
      this.stationId,
      authority,
      { ...request, filter },
    );
    const aggregate = this.usageAggregator.readUsageReceipts(
      this.stationId,
      authority,
      {
        from: request.from,
        to: request.to,
        pageSize: 500,
        aggregate: true,
        filter,
      },
    );
    const receipts = page?.receipts;
    const fallbackCoverage: UsageCoverage =
      receipts === undefined
        ? {
            stationId: this.stationId,
            state: 'unknown',
            reason: 'canonical session usage unavailable',
            window: { from: request.from, to: request.to },
          }
        : receipts.length === 0
          ? {
              // An empty response proves neither that the indexed window was
              // scanned nor that every configured provider can report usage.
              stationId: this.stationId,
              state: 'unknown',
              reason: 'no indexed usage observations for this window',
              freshness: 'unknown',
              window: { from: request.from, to: request.to },
            }
          : {
              stationId: this.stationId,
              state: receipts.some((receipt) => !receipt.observedAt)
                ? 'partial'
                : 'complete',
              ...(receipts.some((receipt) => !receipt.observedAt)
                ? {
                    reason:
                      'legacy receipts have no Station-observed ingestion time',
                  }
                : {}),
              window: { from: request.from, to: request.to },
            };
    // Source coverage is authoritative whenever the EventStore projection
    // supplies it. Never let a truthy coverage object enter a boolean
    // ternary and erase complete/partial state or provider details.
    const baseCoverage: UsageCoverage =
      aggregate?.coverage ?? page?.coverage ?? fallbackCoverage;
    const coverage: UsageCoverage =
      (!aggregate || aggregate.nextCursor) && baseCoverage.state === 'complete'
        ? {
            ...baseCoverage,
            state: 'partial',
            reason: aggregate
              ? 'aggregate observation limit reached (500); additional window material is missing'
              : 'canonical aggregate usage unavailable',
          }
        : baseCoverage;
    return {
      receipts: receipts ?? [],
      ...(aggregate ? { aggregateReceipts: aggregate.receipts } : {}),
      coverage,
      ...(page?.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
}
