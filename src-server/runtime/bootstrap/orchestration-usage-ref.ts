import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import type { OrchestrationUsageRef } from '../../analytics/usage-aggregator.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';

/**
 * The analytics aggregator's view of orchestration usage, resolved per read
 * off the CURRENT service: a runtime reload replaces the service underneath
 * a reused aggregator.
 *
 * Lifetime analytics reads the substrate through the aggregate
 * `listSessionUsage` fold (`stats.json` is a home-global store with no
 * per-user partition; the fold refuses the read outright in hosted mode).
 * The usage rollup reads receipts through the request-scoped
 * `listUsageReceipts`, which applies the caller's own owner set and tenant
 * (#2568): without it every rollup read came back empty.
 */
export function orchestrationUsageRefFor(
  current: () =>
    | Pick<OrchestrationService, 'listSessionUsage' | 'listUsageReceipts'>
    | undefined,
): OrchestrationUsageRef {
  return {
    get: () => {
      const service = current();
      return service
        ? {
            listSessionUsage: () =>
              service.listSessionUsage(INTERNAL_SESSION_READ_SCOPE),
            listUsageReceipts: (authority, stationId, request) =>
              service.listUsageReceipts(authority, stationId, request),
          }
        : undefined;
    },
  };
}
