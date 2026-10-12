import { NATIVE_DEVICE_BINDING_CANDIDATE_VERSION } from '@kontourai/station-contracts/native-device-proof';
import type { NativeRelayLinkRoute } from '@kontourai/station-contracts/native-relay-link';
import type {
  RelayInvitationLifetime,
  RelayManagementView,
  RelaySetupApproval,
} from '@kontourai/station-contracts/relay-management';
import { parseNativeRelayLink } from '@kontourai/station-shared/native-relay-link';
import { z } from 'zod/v3';
import { envelopeError } from './client/api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './client/http';

const uuid = z.string().uuid();
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const surface = z
  .object({
    kind: z.literal('station-native'),
    appIdentifier: z.string().min(1).max(255),
    channel: z.enum(['dev', 'stable', 'beta', 'nightly']),
    clientInstanceId: uuid,
    keyThumbprint: opaque,
  })
  .strict();
const scope = z
  .object({
    stationId: uuid,
    enrollmentId: uuid,
    routingGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const key = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: opaque,
    y: opaque,
  })
  .strict();
const candidate = z
  .object({
    version: z.literal(NATIVE_DEVICE_BINDING_CANDIDATE_VERSION),
    stationId: uuid,
    deviceId: uuid,
    bindingId: uuid,
    surface,
    deviceProofJwk: key,
    deviceProofKeyThumbprint: opaque,
  })
  .strict();
const approval: z.ZodType<RelaySetupApproval> = z
  .object({
    approvalId: uuid,
    revision: z.number().int().positive(),
    approvedBy: z.string().optional(),
    scope,
    surface,
  })
  .strict();
const view: z.ZodType<RelayManagementView> = z
  .object({
    route: z
      .object({
        applicationOrigin: z.string().url(),
        brokerOrigin: z.string().url(),
        stationId: uuid,
        enrollmentId: uuid,
      })
      .strict(),
    confirmationCode: z.string().min(1).max(64),
    keyId: opaque,
    setupLinks: z
      .object({
        stable: z.string().max(24_000),
        beta: z.string().max(24_000),
        nightly: z.string().max(24_000),
      })
      .strict(),
    approvals: z.array(approval).max(1024),
    pendingDevices: z
      .array(
        z
          .object({
            enrollmentId: opaque,
            requestId: uuid,
            candidate,
            account: z
              .object({
                issuer: z.string().max(2048),
                subject: z.string().max(256),
                displayName: z.string().max(256),
              })
              .strict(),
            requestedScope: z.literal('orchestration:read'),
            expiresAt: z.number().int().positive(),
          })
          .strict(),
      )
      .max(1024),
  })
  .strict();
async function relayResponse(response: Response): Promise<unknown> {
  const body = await readJsonBody(response);
  if (!response.ok)
    throw envelopeError(response, body, 'Relay management is unavailable.', {
      message: 'Relay management is unavailable.',
    });
  return body;
}
const options = (input?: ClientRequestOptions): ClientRequestOptions => ({
  ...input,
  maxResponseBytes: 256 * 1024,
  timeoutMs: 35_000,
});
const url = (base: string, path = '') =>
  `${base.replace(/\/$/u, '')}/api/relay-management${path}`;

export async function getRelayManagement(
  base: string,
  input?: ClientRequestOptions,
): Promise<RelayManagementView> {
  const result = z
    .object({ data: view })
    .strict()
    .parse(await relayResponse(await getJson(url(base), options(input)))).data;
  for (const channel of ['stable', 'beta', 'nightly'] as const) {
    const parsed = parseNativeRelayLink(result.setupLinks[channel], {
      channel,
      appIdentifier: 'io.kontourai.station',
    });
    if (
      parsed.kind !== 'route-intent' ||
      parsed.applicationOrigin !== result.route.applicationOrigin ||
      parsed.brokerOrigin !== result.route.brokerOrigin ||
      parsed.stationId !== result.route.stationId ||
      parsed.enrollmentId !== result.route.enrollmentId
    )
      throw new Error('Relay setup link does not match this Station.');
  }
  if (
    result.approvals.some(
      (entry) =>
        entry.scope.stationId !== result.route.stationId ||
        entry.scope.enrollmentId !== result.route.enrollmentId,
    ) ||
    result.pendingDevices.some(
      (entry) => entry.candidate.stationId !== result.route.stationId,
    )
  )
    throw new Error('Relay management response names another Station.');
  return result;
}
export async function approveRelaySetup(
  base: string,
  prepare: unknown,
  input?: ClientRequestOptions,
): Promise<RelaySetupApproval> {
  return z
    .object({ data: approval })
    .strict()
    .parse(
      await relayResponse(
        await mutateJson(url(base, '/approvals'), 'POST', options(input), {
          prepare,
        }),
      ),
    ).data;
}
export async function createRelayInvitation(
  base: string,
  expectedRoute: NativeRelayLinkRoute,
  prepare: unknown,
  lifetime: RelayInvitationLifetime,
  input?: ClientRequestOptions,
): Promise<{ link: string; expiresAt: number }> {
  const expected = z
    .object({
      brokerOrigin: z.string().url(),
      stationId: uuid,
      enrollmentId: uuid,
      appIdentifier: z.string().min(1).max(255),
      channel: z.enum(['stable', 'beta', 'nightly']),
      clientInstanceId: uuid,
      keyThumbprint: opaque,
    })
    .passthrough()
    .parse(prepare);
  if (
    expected.stationId !== expectedRoute.stationId ||
    expected.enrollmentId !== expectedRoute.enrollmentId ||
    expected.brokerOrigin !== expectedRoute.brokerOrigin
  )
    throw new Error('Recipient setup belongs to another Station.');
  const started = Date.now();
  const result = z
    .object({
      data: z
        .object({
          link: z.string().min(1).max(24_000),
          expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    })
    .strict()
    .parse(
      await relayResponse(
        await mutateJson(url(base, '/invitations'), 'POST', options(input), {
          prepare,
          lifetime,
        }),
      ),
    ).data;
  const parsed = parseNativeRelayLink(result.link, {
    channel: expected.channel,
    appIdentifier: expected.appIdentifier,
  });
  if (
    parsed.kind !== 'bound-invitation' ||
    parsed.applicationOrigin !== expectedRoute.applicationOrigin
  )
    throw new Error('Relay invitation does not match this Station.');
  const invite = parsed.invitation;
  if (
    invite.brokerOrigin !== expected.brokerOrigin ||
    invite.scope.stationId !== expected.stationId ||
    invite.scope.enrollmentId !== expected.enrollmentId ||
    invite.surface.clientInstanceId !== expected.clientInstanceId ||
    invite.surface.keyThumbprint !== expected.keyThumbprint ||
    invite.expiresAt !== result.expiresAt
  )
    throw new Error('Relay invitation does not match the approved recipient.');
  const durations = {
    '5m': 300_000,
    '15m': 900_000,
    '1h': 3_600_000,
    '24h': 86_400_000,
  };
  if (
    lifetime === 'never'
      ? result.expiresAt !== Number.MAX_SAFE_INTEGER
      : result.expiresAt < started + durations[lifetime] - 5000 ||
        result.expiresAt > Date.now() + durations[lifetime] + 5000
  )
    throw new Error(
      'Relay invitation expiry differs from the requested lifetime.',
    );
  return result;
}

export async function approveRelayDevice(
  base: string,
  device: RelayManagementView['pendingDevices'][number],
  input?: ClientRequestOptions,
): Promise<void> {
  z.object({ data: z.object({ state: z.literal('approved') }).strict() })
    .strict()
    .parse(
      await relayResponse(
        await mutateJson(
          url(
            base,
            `/devices/${encodeURIComponent(device.enrollmentId)}/approve`,
          ),
          'POST',
          options(input),
          { candidate: device.candidate },
        ),
      ),
    );
}

export async function revokeRelaySetup(
  base: string,
  approval: RelaySetupApproval,
  input?: ClientRequestOptions,
): Promise<void> {
  z.object({ data: z.object({ state: z.literal('revoked') }).strict() })
    .strict()
    .parse(
      await relayResponse(
        await mutateJson(
          url(base, '/approvals/revoke'),
          'POST',
          options(input),
          {
            approvalId: approval.approvalId,
            expectedRevision: approval.revision,
          },
        ),
      ),
    );
}

export async function getRelayManagementCapabilities(
  base: string,
  input?: ClientRequestOptions,
): Promise<{ canManage: boolean; configured: boolean }> {
  return z
    .object({
      data: z
        .object({ canManage: z.boolean(), configured: z.boolean() })
        .strict(),
    })
    .strict()
    .parse(
      await relayResponse(
        await getJson(url(base, '/capabilities'), options(input)),
      ),
    ).data;
}

export async function denyRelayDevice(
  base: string,
  device: RelayManagementView['pendingDevices'][number],
  input?: ClientRequestOptions,
): Promise<void> {
  z.object({ data: z.object({ state: z.literal('cancelled') }).strict() })
    .strict()
    .parse(
      await relayResponse(
        await mutateJson(
          url(base, `/devices/${encodeURIComponent(device.enrollmentId)}/deny`),
          'POST',
          options(input),
          { candidate: device.candidate },
        ),
      ),
    );
}
