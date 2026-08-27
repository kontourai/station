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
    const page = this.usageAggregator.readUsageReceipts(
      this.stationId,
      authority,
      request,
    );
    const aggregate = this.usageAggregator.readUsageReceipts(
      this.stationId,
      authority,
      { from: request.from, to: request.to, pageSize: 500 },
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
    const baseCoverage: UsageCoverage = page?.coverage ?? fallbackCoverage;
    const coverage: UsageCoverage =
      page?.nextCursor && baseCoverage.state === 'complete'
        ? {
            ...baseCoverage,
            state: 'partial',
            reason:
              'receipt drilldown is paged; aggregate remains bounded-window complete',
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
