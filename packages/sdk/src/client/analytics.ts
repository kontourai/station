/**
 * Canonical usage/achievements analytics fetchers (#167 Wave 1). No CLI verb
 * exists for these today (per the audit's §2 gap note — adding one is out
 * of scope for this refactor-only issue); this is a 2-way SDK+station-control
 * dedupe only, between the UI's analytics dashboard (no shared fetcher layer
 * today) and `station-control-operations-tools.ts`'s `get_usage`/
 * `get_achievements` tools.
 *
 * `buildAnalyticsUsagePath`'s query-string-building logic (previously a
 * separate exported helper in `station-control-shared.ts`) moves in here
 * alongside the fetch itself, per the #167 plan.
 *
 * These two fetchers return the raw parsed JSON envelope untouched (no
 * success/throw check) — station-control's `api()` helper is the only
 * pre-#167 consumer of this route family and it already forwards the raw
 * envelope as the MCP tool result; this preserves that exact contract
 * rather than introducing a new throw-on-failure behavior with no existing
 * consumer to justify it.
 */

import type { UsageRollup } from '@kontourai/station-contracts/usage-rollup';
import { type ClientRequestOptions, getJson } from './http';

export interface UsageRollupQuery {
  days: 7 | 14 | 30;
  groupBy?: 'provider' | 'model' | 'station' | 'conversation' | 'task' | 'day';
  cursor?: string;
  pageSize?: number;
}

export interface UsageRollupResponse {
  success: boolean;
  data?: UsageRollup;
  error?: string;
}

function buildUsagePath(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) {
    params.set('from', from);
  }
  if (to) {
    params.set('to', to);
  }
  const query = params.toString();
  return `/api/analytics/usage${query ? `?${query}` : ''}`;
}

/** `GET /api/analytics/usage[?from&to]` — usage analytics. */
export async function fetchUsage(
  apiBase: string,
  from?: string,
  to?: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await getJson(`${apiBase}${buildUsagePath(from, to)}`, opts);
  return response.json();
}

/** Explicit-apiBase, read-only Station usage rollup client. */
export async function fetchUsageRollup(
  apiBase: string,
  query: UsageRollupQuery,
  opts?: ClientRequestOptions,
): Promise<UsageRollupResponse> {
  const params = new URLSearchParams({ days: String(query.days) });
  if (query.groupBy) params.set('groupBy', query.groupBy);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.pageSize !== undefined)
    params.set('pageSize', String(query.pageSize));
  const response = await getJson(
    `${apiBase}/api/analytics/usage-rollup?${params}`,
    opts,
  );
  return response.json() as Promise<UsageRollupResponse>;
}

/** `GET /api/analytics/achievements` — usage achievements/milestones. */
export async function fetchAchievements(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await getJson(`${apiBase}/api/analytics/achievements`, opts);
  return response.json();
}
