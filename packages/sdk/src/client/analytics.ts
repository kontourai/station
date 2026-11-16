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

import type {
  UsageRollup,
  UsageRollupGroupBy,
} from '@kontourai/station-contracts/usage-rollup';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson } from './http';
import { unlessDeadline } from './request-deadline';

export { fetchStationUsage, type StationUsageOverview } from './station-usage';

export interface UsageRollupQuery {
  /**
   * A provider kind the host declares usage semantics for (`claude`,
   * `codex`, `bedrock`, `ollama`, `muse`, `opencode`, `acp`); any other id is
   * a 400. A host without the `usageConnectionFilters` capability accepts
   * only `claude` and `codex`. A declared kind with no receipts answers
   * unknown coverage.
   */
  provider?: string;
  credentialProfileRef?: string | null;
  /**
   * Engine connection the session recorded. Requires `localOnly`, since
   * connection ids are per Station. Send it only to a host with the
   * `usageConnectionFilters` capability: an older host ignores it and
   * answers unfiltered totals.
   */
  connectionId?: string;
  /** Model connection of an accepted launch plan; gated like `connectionId`. */
  modelConnectionId?: string;
  localOnly?: boolean;
  days: 7 | 14 | 30;
  groupBy?: UsageRollupGroupBy;
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
  if (query.provider) params.set('provider', query.provider);
  if (query.credentialProfileRef !== undefined)
    params.set('credentialProfileRef', query.credentialProfileRef ?? '');
  if (query.connectionId !== undefined)
    params.set('connectionId', query.connectionId);
  if (query.modelConnectionId !== undefined)
    params.set('modelConnectionId', query.modelConnectionId);
  if (query.localOnly) params.set('localOnly', '1');
  if (query.groupBy) params.set('groupBy', query.groupBy);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.pageSize !== undefined)
    params.set('pageSize', String(query.pageSize));
  const response = await getJson(
    `${apiBase}/api/analytics/usage-rollup?${params}`,
    opts,
  );
  if (!response.ok)
    throw envelopeError(
      response,
      await response.json().catch(unlessDeadline(() => null)),
      'Usage rollup unavailable',
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
