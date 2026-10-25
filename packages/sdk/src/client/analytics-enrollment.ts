import { z } from 'zod';
import { envelopeError } from './api-error-message';
import {
  type ApiRequestScope,
  getJson,
  isApiRequestScope,
  mutateJson,
  StationRequestAuthorityError,
} from './http';

const uuid = z
  .string()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
const identity = z.string().min(1).max(200);
const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.origin === value &&
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  });
const retention = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('live-mirror') }).strict(),
  z
    .object({
      mode: z.literal('retained-copy'),
      days: z.number().int().min(1).max(90),
    })
    .strict(),
]);
const intent = z
  .object({
    protocol: z.literal('station-analytics-source-enrollment-intent/v1'),
    operationId: uuid,
    sourceStationId: identity,
    proposedDestination: z.object({ stationId: identity, origin }).strict(),
    destinationVerified: z.literal(false),
    scope: z.enum(['individual', 'personal-account']),
    expiresAt: z.iso.datetime(),
    retention,
    phase: z.enum(['prepared', 'cancelled']),
    createdAt: z.iso.datetime(),
    exportAuthority: z.literal(false),
  })
  .strict();
const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const candidate = z
  .object({
    claims: z
      .object({
        protocol: z.literal('station-analytics-recipient-candidate/v1'),
        recipientId: uuid,
        sourceOperationId: uuid,
        sourceStationId: identity,
        sourceIntentSha256: z.string().regex(/^[a-f0-9]{64}$/),
        proposedSourceOrigin: origin,
        destinationStationId: identity,
        proposedDestinationOrigin: origin,
        recipientPrincipalId: identity,
        recipientBindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
        encryptionKey: z
          .object({
            kty: z.literal('OKP'),
            crv: z.literal('X25519'),
            x: coordinate,
          })
          .strict(),
        proofKey: z
          .object({
            kty: z.literal('OKP'),
            crv: z.literal('Ed25519'),
            x: coordinate,
          })
          .strict(),
        createdAt: z.number().int().nonnegative(),
        expiresAt: z.number().int().nonnegative(),
      })
      .strict(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
const delivery = z
  .object({
    protocol: z.literal('station-analytics-source-delivery/v1'),
    sourceApprovalId: uuid,
    sourceOperationId: uuid,
    sourceStationId: identity,
    destinationStationId: identity,
    recipientId: uuid,
    revision: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
    envelope: z.string().min(1).max(16384),
    exportAuthority: z.literal(false),
  })
  .strict();
const approval = z
  .object({
    id: uuid,
    status: z.enum(['pending', 'approved', 'denied', 'expired', 'invalidated']),
    reviewUrl: z.string().url().nullable().optional(),
  })
  .strict();
export type AnalyticsSourceOffer = z.infer<typeof intent>;
export type AnalyticsReceivingProof = z.infer<typeof candidate>;
export type AnalyticsEncryptedDelivery = z.infer<typeof delivery>;
export interface AnalyticsRecipientSetup {
  candidate: AnalyticsReceivingProof;
  confirmationCode: string;
  sourceIntent: AnalyticsSourceOffer;
  phase: string;
}
export type AnalyticsReview = {
  kind: 'source' | 'address';
  subject: string;
  id: string;
  status: z.infer<typeof approval>['status'];
  reviewUrl?: string | null;
};
export type AnalyticsSetupAction =
  | {
      kind: 'offer';
      operationId: string;
      destinationStationId: string;
      destinationOrigin: string;
      scope: 'individual' | 'personal-account';
      expiresAt: string;
      retention: z.infer<typeof retention>;
    }
  | {
      kind: 'receive';
      operationId: string;
      offer: unknown;
      sourceOrigin: string;
    }
  | { kind: 'source-review'; proof: unknown }
  | { kind: 'delivery'; approvalId: string }
  | { kind: 'store-delivery'; delivery: unknown }
  | { kind: 'address-review'; recipientId: string }
  | { kind: 'cancel-receiver'; recipientId: string }
  | { kind: 'revoke-source'; approvalId: string };
export function parseAnalyticsTransfer(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > 24576)
    throw new Error('The connection packet exceeds its size limit');
  return JSON.parse(text);
}
async function request(
  scope: ApiRequestScope,
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!isApiRequestScope(scope)) throw new StationRequestAuthorityError();
  const options = { requestScope: scope, signal, maxResponseBytes: 65536 };
  const response =
    method === 'GET'
      ? await getJson(`${scope.apiBase}${path}`, options)
      : await mutateJson(`${scope.apiBase}${path}`, method, options, body);
  const value: unknown = await response.json();
  if (!response.ok)
    throw envelopeError(response, value, 'Source setup unavailable');
  return value;
}
function data(value: unknown) {
  return z.object({ data: z.unknown() }).strict().parse(value).data;
}
function recipient(value: unknown): AnalyticsRecipientSetup {
  const v = z
    .object({
      candidate,
      confirmationCode: z.string().min(1),
      sourceIntent: intent,
      phase: z.string(),
    })
    .parse(value);
  return v;
}
export async function fetchAnalyticsRecipientSetup(
  scope: ApiRequestScope,
  id: string,
  signal?: AbortSignal,
) {
  return recipient(
    data(
      await request(
        scope,
        `/api/analytics/recipient-candidates/${uuid.parse(id)}`,
        'GET',
        undefined,
        signal,
      ),
    ),
  );
}
export async function performAnalyticsSetup(
  scope: ApiRequestScope,
  input: AnalyticsSetupAction,
): Promise<{
  offer?: AnalyticsSourceOffer;
  recipient?: AnalyticsRecipientSetup;
  delivery?: AnalyticsEncryptedDelivery;
  review?: AnalyticsReview;
  message?: string;
}> {
  if (input.kind === 'offer')
    return {
      offer: intent.parse(
        data(
          await request(scope, '/api/analytics/source-enrollments', 'POST', {
            operationId: uuid.parse(input.operationId),
            proposedDestination: {
              stationId: input.destinationStationId,
              origin: input.destinationOrigin,
            },
            scope: input.scope,
            expiresAt: input.expiresAt,
            retention: input.retention,
          }),
        ),
      ),
    };
  if (input.kind === 'receive') {
    const offer = intent.parse(input.offer);
    if (offer.phase !== 'prepared')
      throw new Error('This source offer is cancelled');
    return {
      recipient: recipient(
        data(
          await request(scope, '/api/analytics/recipient-candidates', 'POST', {
            operationId: uuid.parse(input.operationId),
            sourceIntent: offer,
            proposedSourceOrigin: origin.parse(input.sourceOrigin),
          }),
        ),
      ),
    };
  }
  if (input.kind === 'source-review') {
    const proof = candidate.parse(input.proof);
    const id = proof.claims.sourceOperationId;
    const raw = await request(
      scope,
      '/api/analytics/source-grant-approvals',
      'POST',
      { operationId: id, sourceOperationId: id, recipientCandidate: proof },
    );
    const settled = z
      .object({
        data: z
          .object({ operationId: uuid, phase: z.literal('approved') })
          .passthrough(),
      })
      .safeParse(raw);
    if (settled.success)
      return {
        review: {
          kind: 'source',
          subject: settled.data.data.operationId,
          id: settled.data.data.operationId,
          status: 'approved',
        },
        message: 'This receiving key is already approved.',
      };
    const result = z.object({ approval }).strict().parse(raw).approval;
    return { review: { ...result, kind: 'source', subject: id } };
  }
  if (input.kind === 'delivery')
    return {
      delivery: delivery.parse(
        data(
          await request(
            scope,
            `/api/analytics/source-grant-approvals/${uuid.parse(input.approvalId)}/delivery`,
            'POST',
          ),
        ),
      ),
    };
  if (input.kind === 'store-delivery') {
    const packet = delivery.parse(input.delivery);
    await request(
      scope,
      `/api/analytics/recipient-candidates/${packet.recipientId}/credentials`,
      'POST',
      packet,
    );
    return {
      recipient: await fetchAnalyticsRecipientSetup(scope, packet.recipientId),
      message:
        'Encrypted grant stored. Confirm the source address before syncing.',
    };
  }
  if (input.kind === 'address-review') {
    const id = uuid.parse(input.recipientId);
    const result = z
      .object({ approval })
      .strict()
      .parse(
        await request(
          scope,
          `/api/analytics/recipient-candidates/${id}/source-confirmation`,
          'POST',
          {},
        ),
      ).approval;
    return { review: { ...result, kind: 'address', subject: id } };
  }
  if (input.kind === 'cancel-receiver') {
    await request(
      scope,
      `/api/analytics/recipient-candidates/${uuid.parse(input.recipientId)}`,
      'DELETE',
    );
    return {
      message: 'Receiving slot stopped. This does not claim remote erasure.',
    };
  }
  await request(
    scope,
    `/api/analytics/source-grant-approvals/${uuid.parse(input.approvalId)}`,
    'DELETE',
  );
  return { message: 'Source access revoked.' };
}
export async function fetchAnalyticsReview(
  scope: ApiRequestScope,
  review: AnalyticsReview,
  signal?: AbortSignal,
) {
  const path =
    review.kind === 'source'
      ? `/api/analytics/source-grant-approvals/requests/${review.id}`
      : `/api/analytics/recipient-candidates/${review.subject}/source-confirmation/requests/${review.id}`;
  const raw = z
    .object({
      approval: approval.omit({ reviewUrl: true }),
      data: z.unknown().optional(),
    })
    .strict()
    .parse(await request(scope, path, 'GET', undefined, signal));
  return { ...review, status: raw.approval.status };
}
/** The main UI never decides consent. It only opens the server's separate, same-host reviewer. */
export function analyticsReviewUrl(
  scope: ApiRequestScope,
  review: AnalyticsReview,
): string {
  if (!review.reviewUrl)
    throw new Error('The requester review surface is unavailable');
  const url = new URL(review.reviewUrl),
    base = new URL(scope.apiBase);
  if (
    url.hostname !== base.hostname ||
    url.origin === base.origin ||
    (url.protocol !== base.protocol &&
      !(base.protocol === 'http:' && url.protocol === 'https:')) ||
    url.username ||
    url.password ||
    url.pathname !== `/consent/${review.id}`
  )
    throw new Error(
      'The trusted requester review address could not be verified',
    );
  return url.toString();
}

export async function fetchAnalyticsReceiverInfo(
  scope: ApiRequestScope,
  signal?: AbortSignal,
) {
  const { PUBLIC_STATION_HANDSHAKE_PATH, parsePublicStationHandshake } =
    await import('@kontourai/station-contracts/environment-security');
  const parsed = parsePublicStationHandshake(
    await request(
      scope,
      PUBLIC_STATION_HANDSHAKE_PATH,
      'GET',
      undefined,
      signal,
    ),
  );
  if (!parsed) throw new Error('This Station identity could not be read');
  return {
    stationId: parsed.environmentId,
    origin: new URL(scope.apiBase).origin,
  };
}

export async function fetchAnalyticsSourceOffers(
  scope: ApiRequestScope,
  signal?: AbortSignal,
) {
  return z
    .array(intent)
    .max(1000)
    .parse(
      data(
        await request(
          scope,
          '/api/analytics/source-enrollments',
          'GET',
          undefined,
          signal,
        ),
      ),
    );
}
