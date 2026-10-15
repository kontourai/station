import type {
  UsageExportPage,
  UsageExportRequest,
} from '@kontourai/station-contracts/usage-export';
import { z } from 'zod';
import { envelopeError } from './api-error-message';
import {
  type ApiRequestScope,
  type ClientRequestOptions,
  getJson,
  isApiRequestScope,
  StationRequestAuthorityError,
} from './http';
import { rethrowDeadline } from './request-deadline';

export type { UsageExportPage, UsageExportRequest };

/** Captured from the preceding accepted page, not an authorization grant. */
export interface UsageExportSnapshot {
  streamEpoch: string;
  highWater: number;
  afterGlobalSequence: number;
}

export interface UsageExportQuery extends UsageExportRequest {
  expectedStationId: string;
  /** Required with a cursor; prevents accepting a different export snapshot. */
  snapshot?: UsageExportSnapshot;
}

const identity = z.string().min(1);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().nonnegative();
const time = z.iso.datetime({ offset: true });
const money = z.strictObject({ amount, currency: identity });
const receipt = z.strictObject({
  id: identity,
  sourceEventId: identity.optional(),
  sourceSequence: sequence.optional(),
  stationId: identity,
  provider: identity,
  model: identity.optional(),
  accountKey: identity.optional(),
  threadId: identity.optional(),
  turnId: identity.optional(),
  conversationId: identity.optional(),
  taskId: identity.optional(),
  occurredAt: time.optional(),
  observedAt: time,
  inputTokens: amount.optional(),
  outputTokens: amount.optional(),
  cacheReadTokens: amount.optional(),
  cacheWriteTokens: amount.optional(),
  reportedCost: money.optional(),
  estimatedCost: z
    .strictObject({
      amount,
      currency: identity,
      pricingSnapshotId: identity,
      pricingSnapshotObservedAt: time.optional(),
      pricingSnapshotSource: identity.optional(),
    })
    .optional(),
  pricing: z.strictObject({
    status: z.enum(['priced', 'partial', 'unpriced']),
    pricingSnapshotId: identity.optional(),
    pricingSnapshotCapturedAt: time.optional(),
    pricingSnapshotSource: identity.optional(),
    provider: identity.optional(),
    model: identity.optional(),
    currency: identity.optional(),
  }),
});
const day = z.iso.date();
const cursor = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/);
const request = z
  .strictObject({
    from: day,
    to: day,
    scope: z.enum(['individual', 'personal-account']),
    pageSize: z.number().int().min(1).max(100).optional(),
    cursor: cursor.optional(),
    expectedStationId: identity,
    snapshot: z
      .strictObject({
        streamEpoch: identity,
        highWater: sequence,
        afterGlobalSequence: sequence,
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.from <= value.to &&
      Date.parse(value.to) - Date.parse(value.from) <= 365 * 86400000 &&
      (value.cursor !== undefined) === (value.snapshot !== undefined) &&
      (!value.snapshot ||
        value.snapshot.afterGlobalSequence <= value.snapshot.highWater),
  );
const page = z.strictObject({
  schemaVersion: z.literal(1),
  stationId: identity,
  streamEpoch: identity,
  highWater: sequence,
  scope: z.enum(['individual', 'personal-account']),
  window: z.strictObject({
    from: day,
    to: day,
    clock: z.literal('station-observed-utc'),
  }),
  observations: z
    .array(
      z.strictObject({
        globalSequence: sequence,
        receipts: z.array(receipt),
      }),
    )
    .max(100),
  nextCursor: cursor.optional(),
  coverage: z.strictObject({
    state: z.literal('unknown'),
    reason: z.literal(
      'retained-observations-do-not-prove-provider-or-deletion-coverage',
    ),
  }),
});

/** Read one bounded canonical page through the host's current scoped transport. */
export async function fetchUsageExport(
  apiBase: string,
  query: UsageExportQuery,
  options: ClientRequestOptions & { requestScope: ApiRequestScope },
): Promise<UsageExportPage> {
  if (
    !isApiRequestScope(options?.requestScope) ||
    options.requestScope.apiBase !== apiBase
  )
    throw new StationRequestAuthorityError();
  const captured = request.safeParse(query);
  if (!captured.success) throw new Error('Invalid usage export request');
  const input = captured.data;
  const params = new URLSearchParams({
    from: input.from,
    to: input.to,
    scope: input.scope,
  });
  if (input.pageSize !== undefined)
    params.set('pageSize', String(input.pageSize));
  if (input.cursor !== undefined) params.set('cursor', input.cursor);
  const response = await getJson(
    `${apiBase}/api/analytics/usage-export?${params}`,
    {
      ...options,
      maxResponseBytes: 2 * 1024 * 1024,
    },
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    rethrowDeadline(error);
    if (error instanceof SyntaxError && !response.ok)
      throw envelopeError(response, undefined, 'Usage export unavailable');
    throw error;
  }
  if (!response.ok)
    throw envelopeError(response, body, 'Usage export unavailable');
  const envelope = z
    .strictObject({ success: z.literal(true), data: page })
    .safeParse(body);
  if (!envelope.success)
    throw new Error('Usage export is invalid or unsupported');
  const result = envelope.data.data;
  let previous = input.snapshot?.afterGlobalSequence ?? 0;
  const from = Date.parse(`${input.from}T00:00:00.000Z`);
  const to = Date.parse(`${input.to}T23:59:59.999Z`);
  if (
    result.stationId !== input.expectedStationId ||
    result.scope !== input.scope ||
    result.window.from !== input.from ||
    result.window.to !== input.to ||
    result.observations.length > (input.pageSize ?? 100) ||
    (input.snapshot &&
      (result.streamEpoch !== input.snapshot.streamEpoch ||
        result.highWater !== input.snapshot.highWater))
  )
    throw new Error('Usage export does not match the captured request');
  for (const observation of result.observations) {
    if (
      observation.globalSequence <= previous ||
      observation.globalSequence > result.highWater ||
      observation.receipts.some((item) => {
        const observedAt = Date.parse(item.observedAt);
        return (
          item.stationId !== result.stationId ||
          observedAt < from ||
          observedAt > to
        );
      })
    )
      throw new Error(
        'Usage export observations do not match the captured source order',
      );
    previous = observation.globalSequence;
  }
  if (
    result.nextCursor &&
    (!result.observations.length || result.nextCursor === input.cursor)
  )
    throw new Error('Usage export continuation did not advance');
  return result;
}
