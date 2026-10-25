import {
  type AnalyticsSavedView,
  type AnalyticsViewDefinition,
  parseAnalyticsSavedView,
  parseAnalyticsViewDefinition,
} from '@kontourai/station-contracts/analytics-views';
import {
  type PrivateUsageReceiptPage,
  type PrivateUsageReceiptQuery,
  parsePrivateUsageReceiptPage,
} from '@kontourai/station-contracts/usage-export';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { z } from 'zod';
import { envelopeError } from './api-error-message';
import {
  type ApiRequestScope,
  getJson,
  isApiRequestScope,
  mutateJson,
  StationRequestAuthorityError,
} from './http';

export type { AnalyticsSavedView, AnalyticsViewDefinition };
export type PrivateInsightsQuery = Omit<
  PrivateUsageReceiptQuery,
  | 'protocol'
  | 'expectedReceiverEpoch'
  | 'expectedCheckpoint'
  | 'expectedSourceRevision'
  | 'expectedHighWater'
>;
export interface PrivateInsightsSource {
  id: string;
  stationId: string;
  origin?: string;
  ready: boolean;
  credentialRevision?: number;
  retainedCopy: boolean;
  sync?: {
    operationId: string;
    from: string;
    to: string;
    phase: string;
    restart?: boolean;
  };
}
export interface PrivateInsightsResult extends PrivateUsageReceiptPage {
  retainedCopy: boolean;
  receivedAt: string;
  recipientId: string;
  asOf: {
    stationId: string;
    streamEpoch: string;
    highWater: number;
    sourceRevision: number;
    observedSourceHighWater: number;
    freshness: 'at-captured-source-head' | 'behind-current-source-head';
  };
}
const uuid = z.string().uuid();
const sourceSchema = z.object({
  sourceIntent: z.object({
    sourceStationId: z.string().min(1),
    retention: z.object({ mode: z.enum(['live-mirror', 'retained-copy']) }),
  }),
  candidate: z.object({ claims: z.object({ recipientId: uuid }) }),
  phase: z.string(),
  sourceConfirmation: z
    .object({ revision: z.number().int().positive(), origin: z.string().url() })
    .optional(),
  storedCredential: z
    .object({
      revision: z.number().int().positive(),
      expiresAt: z.iso.datetime(),
    })
    .optional(),
  sync: z
    .object({
      operationId: uuid,
      from: z.iso.date(),
      to: z.iso.date(),
      phase: z.string(),
      restart: z.boolean().optional(),
    })
    .optional(),
});
function source(value: unknown): PrivateInsightsSource {
  const v = sourceSchema.parse(value);
  return {
    id: v.candidate.claims.recipientId,
    stationId: v.sourceIntent.sourceStationId,
    ...(v.sourceConfirmation ? { origin: v.sourceConfirmation.origin } : {}),
    retainedCopy: v.sourceIntent.retention.mode === 'retained-copy',
    ready:
      v.phase === 'credential-stored' &&
      v.sourceConfirmation !== undefined &&
      v.sourceConfirmation.revision === v.storedCredential?.revision &&
      Date.parse(v.storedCredential.expiresAt) > Date.now(),
    ...(v.storedCredential
      ? { credentialRevision: v.storedCredential.revision }
      : {}),
    ...(v.sync ? { sync: v.sync } : {}),
  };
}
async function request(
  scope: ApiRequestScope,
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
  readOnly = false,
): Promise<unknown> {
  if (!isApiRequestScope(scope)) throw new StationRequestAuthorityError();
  const options = {
    requestScope: scope,
    signal,
    maxResponseBytes: 1024 * 1024,
    readOnly,
  };
  const response =
    method === 'GET'
      ? await getJson(`${scope.apiBase}${path}`, options)
      : await mutateJson(`${scope.apiBase}${path}`, method, options, body);
  const value: unknown = await response.json();
  if (!response.ok)
    throw envelopeError(response, value, 'Private Insights unavailable');
  return z.object({ data: z.unknown() }).strict().parse(value).data;
}
export async function fetchPrivateInsightsSources(
  scope: ApiRequestScope,
  signal?: AbortSignal,
): Promise<PrivateInsightsSource[]> {
  const value = await request(
    scope,
    '/api/analytics/recipient-candidates',
    'GET',
    undefined,
    signal,
  );
  return z.array(z.unknown()).max(1000).parse(value).map(source);
}
export async function fetchSavedAnalyticsViews(
  scope: ApiRequestScope,
  signal?: AbortSignal,
): Promise<AnalyticsSavedView[]> {
  const value = await request(
    scope,
    '/api/analytics/saved-views',
    'GET',
    undefined,
    signal,
  );
  return z
    .array(z.unknown())
    .max(100)
    .parse(value)
    .map(parseAnalyticsSavedView);
}
export async function createSavedAnalyticsView(
  scope: ApiRequestScope,
  operationId: string,
  definition: AnalyticsViewDefinition,
) {
  return parseAnalyticsSavedView(
    await request(scope, '/api/analytics/saved-views', 'POST', {
      operationId: uuid.parse(operationId),
      definition: parseAnalyticsViewDefinition(definition),
    }),
  );
}
export async function updateSavedAnalyticsView(
  scope: ApiRequestScope,
  id: string,
  revision: number,
  definition: AnalyticsViewDefinition,
) {
  return parseAnalyticsSavedView(
    await request(
      scope,
      `/api/analytics/saved-views/${uuid.parse(id)}`,
      'PUT',
      {
        expectedRevision: revision,
        definition: parseAnalyticsViewDefinition(definition),
      },
    ),
  );
}
export async function deleteSavedAnalyticsView(
  scope: ApiRequestScope,
  id: string,
  revision: number,
) {
  return z
    .object({ deleted: z.literal(true), revision: z.number().int().positive() })
    .strict()
    .parse(
      await request(
        scope,
        `/api/analytics/saved-views/${uuid.parse(id)}`,
        'DELETE',
        { expectedRevision: revision },
      ),
    );
}
export async function exportSavedAnalyticsView(
  scope: ApiRequestScope,
  id: string,
) {
  return parseAnalyticsSavedView(
    await request(scope, `/api/analytics/saved-views/${uuid.parse(id)}/export`),
  );
}
export async function fetchPrivateInsights(
  scope: ApiRequestScope,
  recipientId: string,
  input: PrivateInsightsQuery,
  signal?: AbortSignal,
): Promise<PrivateInsightsResult> {
  const id = uuid.parse(recipientId);
  const metadata = source(
    await request(
      scope,
      `/api/analytics/recipient-candidates/${id}`,
      'GET',
      undefined,
      signal,
    ),
  );
  const raw = await request(
    scope,
    `/api/analytics/recipient-candidates/${id}/query`,
    'POST',
    input,
    signal,
    true,
  );
  const header = z
    .object({
      recipientId: z.literal(id),
      asOf: z
        .object({
          stationId: z.literal(metadata.stationId),
          streamEpoch: z.string().min(1),
          highWater: z.number().int().nonnegative(),
          sourceRevision: z.number().int().nonnegative(),
          observedSourceHighWater: z.number().int().nonnegative(),
          freshness: z.enum([
            'at-captured-source-head',
            'behind-current-source-head',
          ]),
        })
        .strict(),
    })
    .passthrough()
    .parse(raw);
  const { recipientId: received, asOf, ...page } = header;
  if (
    asOf.observedSourceHighWater < asOf.highWater ||
    (asOf.freshness === 'at-captured-source-head') !==
      (asOf.highWater === asOf.observedSourceHighWater)
  )
    throw new Error('Private source snapshot is inconsistent');
  const parsed = parsePrivateUsageReceiptPage(page, {
    from: input.from,
    to: input.to,
    highWater: asOf.highWater,
    stationId: metadata.stationId,
    indexId: input.indexId,
    mode: input.mode,
    groupBy: input.groupBy,
    summaryId: input.summaryId,
  });
  return {
    ...parsed,
    recipientId: received,
    asOf,
    retainedCopy: metadata.retainedCopy,
    receivedAt: new Date().toISOString(),
  };
}
export async function syncPrivateInsightsPage(
  scope: ApiRequestScope,
  id: string,
  input: { operationId: string; from: string; to: string; restart?: boolean },
  signal?: AbortSignal,
) {
  const value = await request(
    scope,
    `/api/analytics/recipient-candidates/${uuid.parse(id)}/sync`,
    'POST',
    {
      operationId: input.operationId,
      from: input.from,
      to: input.to,
      ...(input.restart !== undefined ? { restart: input.restart } : {}),
    },
    signal,
  );
  return z
    .object({
      operationId: z.literal(input.operationId),
      recipientId: z.literal(id),
      from: z.literal(input.from),
      to: z.literal(input.to),
      phase: z.enum([
        'prepared',
        'pending',
        'page-stored',
        'facts-captured',
        'cancelled',
        'unconfirmed',
        'invalidations-pending',
      ]),
      restart: z.boolean().optional(),
    })
    .parse(value);
}

/** Explicit foreground sync. Stops on failure; the original operation is recovered from owned metadata. */
export async function syncPrivateInsightsWindow(
  scope: ApiRequestScope,
  id: string,
  windows: readonly { from: string; to: string }[],
  options: {
    signal: AbortSignal;
    onProgress?: (value: { phase: string; pages: number }) => void;
  },
) {
  if (windows.length < 1 || windows.length > 2)
    throw new Error('Sync requires one or two bounded windows');
  for (const window of windows) {
    const value = z
      .object({ from: z.iso.date(), to: z.iso.date() })
      .strict()
      .parse(window);
    if (
      value.from > value.to ||
      Date.parse(value.to) - Date.parse(value.from) > 365 * 86400000
    )
      throw new Error('Invalid sync window');
  }
  const metadata = source(
    await request(
      scope,
      `/api/analytics/recipient-candidates/${uuid.parse(id)}`,
      'GET',
      undefined,
      options.signal,
    ),
  );
  const pending =
    metadata.sync && ['pending', 'unconfirmed'].includes(metadata.sync.phase)
      ? metadata.sync
      : undefined;
  const selections = [
    ...(pending ? [{ from: pending.from, to: pending.to }] : []),
    ...windows,
  ].filter(
    (value, index, all) =>
      all.findIndex((v) => v.from === value.from && v.to === value.to) ===
      index,
  );
  let pages = 0;
  for (const window of selections) {
    let operationId =
      pending && pending.from === window.from && pending.to === window.to
        ? pending.operationId
        : randomCorrelationId();
    let restart =
      pending?.operationId === operationId ? pending.restart : undefined;
    let complete = false;
    for (let step = 0; step < 10000; step++) {
      options.signal.throwIfAborted();
      const result = await syncPrivateInsightsPage(
        scope,
        id,
        {
          operationId,
          ...window,
          ...(restart !== undefined ? { restart } : {}),
        },
        options.signal,
      );
      pages++;
      options.onProgress?.({ phase: result.phase, pages });
      if (result.phase === 'facts-captured') {
        complete = true;
        break;
      }
      if (!['page-stored', 'invalidations-pending'].includes(result.phase))
        throw new Error(
          'The sync outcome requires receipt recovery before continuing',
        );
      await new Promise<void>((resolve, reject) => {
        if (options.signal.aborted) {
          reject(options.signal.reason);
          return;
        }
        const finish = () => {
          options.signal.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(finish, 7000);
        const abort = () => {
          clearTimeout(timer);
          options.signal.removeEventListener('abort', abort);
          reject(options.signal.reason);
        };
        options.signal.addEventListener('abort', abort, { once: true });
      });
      operationId = randomCorrelationId();
      restart = undefined;
    }
    if (!complete)
      throw new Error(
        'Sync reached its bounded page budget; this window is not complete',
      );
  }
  return { phase: 'facts-captured' as const, pages };
}
