import {
  CLIENT_PROTOCOL_HEADER,
  PUBLIC_STATION_HANDSHAKE_PATH,
  parsePublicStationHandshake,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import {
  parseUsageExportPage,
  USAGE_EXPORT_SOURCE_REVISION_HEADER,
  type UsageExportQuery,
} from '@kontourai/station-contracts/usage-export';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import { AuthorityObservationRejected } from '../services/identity/authority-observation.js';
import type { sourceDeliveryProofSchema } from './source-export-proof.js';

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
  );
const sequence = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const recipientSourceReadInput = z
  .object({
    from: day,
    to: day,
    pageSize: z.number().int().min(1).max(100).optional(),
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    snapshot: z
      .object({
        streamEpoch: z.string().min(1).max(200),
        highWater: sequence,
        afterGlobalSequence: sequence,
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.from <= value.to &&
      Date.parse(value.to) - Date.parse(value.from) <= 365 * 86400000 &&
      (value.cursor !== undefined) === (value.snapshot !== undefined) &&
      (!value.snapshot ||
        value.snapshot.afterGlobalSequence <= value.snapshot.highWater),
  );

/** Person-approved HTTPS origin only. No peer, operator, provider or browser credential is forwarded. */
export async function readRecipientSourcePage(input: {
  origin: string;
  stationId: string;
  approvalId: string;
  revision: number;
  scope: UsageExportQuery['scope'];
  credential: string;
  proof: z.infer<typeof sourceDeliveryProofSchema>;
  query: z.infer<typeof recipientSourceReadInput>;
  assertLocalCurrent(): Promise<void>;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}) {
  const origin = new URL(input.origin);
  if (origin.protocol !== 'https:' || origin.origin !== input.origin)
    throw new Error('Source transport is not authenticated HTTPS');
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
  const transport = {
    signal,
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
  } as const;
  const receive = async (url: string, init: RequestInit, maxBytes: number) => {
    const response = await input.fetchImpl(url, { ...transport, ...init });
    if (response.url !== url || response.redirected) {
      void response.body?.cancel();
      throw new Error('Source transport changed');
    }
    if (!response.ok) {
      void response.body?.cancel();
      if (init.headers && [401, 403, 404, 409, 410].includes(response.status))
        throw new AuthorityObservationRejected(403, 'authority_changed');
      throw new Error('Source read unavailable');
    }
    if (init.method === 'HEAD') {
      void response.body?.cancel();
      const expected = new Headers(init.headers).get(
        USAGE_EXPORT_SOURCE_REVISION_HEADER,
      );
      if (
        response.status !== 204 ||
        expected === null ||
        response.headers.get(USAGE_EXPORT_SOURCE_REVISION_HEADER) !== expected
      )
        throw new Error('Source authorization response is unsupported');
      return { body: undefined, sourceRevision: expected };
    }
    const body = await readBoundedRequestBody(response, maxBytes);
    if (body.status !== 'ok')
      throw new Error('Source response exceeds byte limit or is invalid');
    return {
      body: JSON.parse(body.body) as unknown,
      sourceRevision: response.headers.get(USAGE_EXPORT_SOURCE_REVISION_HEADER),
    };
  };
  await input.assertLocalCurrent();
  const handshake = parsePublicStationHandshake(
    (
      await receive(
        `${input.origin}${PUBLIC_STATION_HANDSHAKE_PATH}`,
        {},
        65536,
      )
    ).body,
  );
  if (handshake?.environmentId !== input.stationId)
    throw new Error('Source Station identity changed');
  await input.assertLocalCurrent();
  const headers = {
    Authorization: `Bearer ${input.credential}`,
    'x-station-analytics-proof': Buffer.from(
      JSON.stringify(input.proof),
    ).toString('base64url'),
    [CLIENT_PROTOCOL_HEADER]: String(STATION_COMPAT_PROTOCOL_VERSION),
  };
  const path = `${input.origin}/api/analytics/source-grant-export/${input.approvalId}`;
  const query = recipientSourceReadInput.parse(input.query);
  const params = new URLSearchParams({
    from: query.from,
    to: query.to,
    pageSize: String(query.pageSize ?? 100),
  });
  if (query.cursor) params.set('cursor', query.cursor);
  const received = await receive(
    `${path}?${params}`,
    { headers },
    2 * 1024 * 1024,
  );
  const sourceRevision = received.sourceRevision;
  if (
    sourceRevision === null ||
    !/^(0|[1-9][0-9]*)$/.test(sourceRevision) ||
    !Number.isSafeInteger(Number(sourceRevision))
  )
    throw new Error('Source snapshot response is unsupported');
  const body = z
    .object({
      success: z.literal(true),
      data: z.unknown(),
      grant: z
        .object({
          sourceApprovalId: z.literal(input.approvalId),
          revision: z.literal(input.revision),
          scope: z.literal(input.scope),
        })
        .strict(),
    })
    .strict()
    .parse(received.body);
  const page = parseUsageExportPage(body.data, {
    ...query,
    scope: input.scope,
    expectedStationId: input.stationId,
  });
  const assertCurrent = async () => {
    await input.assertLocalCurrent();
    // A successful transferred page is historical evidence, not continuing source permission.
    await receive(
      path,
      {
        method: 'HEAD',
        headers: {
          ...headers,
          [USAGE_EXPORT_SOURCE_REVISION_HEADER]: sourceRevision,
        },
      },
      0,
    );
    await input.assertLocalCurrent();
  };
  await assertCurrent();
  return { page, sourceRevision: Number(sourceRevision), assertCurrent };
}
