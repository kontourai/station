import type { UsageReceipt } from './usage-rollup.js';

/** Scope selection only narrows the request's verified read authority. */
export type UsageExportScope = 'individual' | 'personal-account';

export interface UsageExportRequest {
  from: string;
  to: string;
  scope: UsageExportScope;
  pageSize?: number;
  cursor?: string;
}

/** A page of retained canonical facts, not proof of complete provider history. */
export interface UsageExportPage {
  schemaVersion: 1;
  stationId: string;
  streamEpoch: string;
  highWater: number;
  scope: UsageExportScope;
  window: { from: string; to: string; clock: 'station-observed-utc' };
  observations: Array<{ globalSequence: number; receipts: UsageReceipt[] }>;
  nextCursor?: string;
  coverage: {
    state: 'unknown';
    reason: 'retained-observations-do-not-prove-provider-or-deletion-coverage';
  };
}
