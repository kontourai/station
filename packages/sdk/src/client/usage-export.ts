import type {
  UsageExportPage,
  UsageExportQuery,
  UsageExportRequest,
  UsageExportSnapshot,
} from '@kontourai/station-contracts/usage-export';
import { parseUsageExportPage } from '@kontourai/station-contracts/usage-export';
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

export type {
  UsageExportPage,
  UsageExportQuery,
  UsageExportRequest,
  UsageExportSnapshot,
};

const identity = z.string().min(1);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
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
    .strictObject({ success: z.literal(true), data: z.unknown() })
    .safeParse(body);
  if (!envelope.success)
    throw new Error('Usage export is invalid or unsupported');
  return parseUsageExportPage(envelope.data.data, input);
}
