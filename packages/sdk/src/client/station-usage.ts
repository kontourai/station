import type { UsageStats } from '@kontourai/station-contracts/usage-stats';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson } from './http';
import { unlessDeadline } from './request-deadline';

export interface StationUsageOverview {
  stationId: string;
  stats: UsageStats;
}

export async function fetchStationUsage(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<StationUsageOverview> {
  const response = await getJson(
    `${apiBase}/api/analytics/station-usage`,
    opts,
  );
  if (!response.ok) {
    throw envelopeError(
      response,
      await response.json().catch(unlessDeadline(() => null)),
      'Station overview unavailable',
    );
  }
  const body = (await response.json()) as {
    success: boolean;
    data?: UsageStats;
    scope?: { kind: string; stationId: string };
  };
  if (
    !body.success ||
    !body.data ||
    body.scope?.kind !== 'station' ||
    typeof body.scope.stationId !== 'string'
  ) {
    throw new Error('Station overview returned no instance scope');
  }
  return { stats: body.data, stationId: body.scope.stationId };
}
