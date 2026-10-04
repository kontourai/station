import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { parseNativeRelayLink } from '@kontourai/station-connect/native-relay-link';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { SelfHostedBrokerNativeRouteInvitationV2 } from '@kontourai/station-contracts/self-hosted-broker';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import {
  pairingScopeSatisfiesHttpRoute,
  requiredPairingScope,
} from '../../../security/pairing-route-scopes.js';
import {
  captureRelayManagementApproval,
  hasRelayManagementAuthority,
} from '../../../security/relay-management-authority.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { NativeSurfaceRegistry } from '../../../services/connections/native-surface-registry.js';
import type { RelayInvitationOwner } from '../../../services/connections/relay-invitation-owner.js';
import { ConnectionSigningKeyStore } from '../../../services/ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createRelayManagementRoutes } from '../relay-management-routes.js';

const temp = trackTempDirs();
const registries: NativeSurfaceRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
});
async function fixture() {
  const home = temp('relay-management-');
  const security = new EnvironmentSecurityService({ homeDir: home });
  const { credential } = await security.initialize();
  const trust = await new ConnectionSigningKeyStore(home).initialize();
  const registry = new NativeSurfaceRegistry(home, trust.stationId);
  registries.push(registry);
  const scope = {
    stationId: trust.stationId,
    enrollmentId: trust.enrollmentId,
    routingGeneration: 1,
  };
  const surface = {
    kind: 'station-native' as const,
    appIdentifier: 'io.kontourai.station.nightly',
    channel: 'nightly' as const,
    clientInstanceId: randomUUID(),
    keyThumbprint: 'T'.repeat(43),
  };
  const route = {
    applicationOrigin: 'https://station.example',
    brokerOrigin: 'https://broker.example',
    stationId: trust.stationId,
    enrollmentId: trust.enrollmentId,
  };
  const issue = vi.fn(
    async (
      _prepare: unknown,
      _signal: AbortSignal,
      ttl?: number | null,
    ): Promise<SelfHostedBrokerNativeRouteInvitationV2> => ({
      version: 'station-broker-native-route-invitation/v2',
      brokerOrigin: route.brokerOrigin,
      scope,
      stationSigningKeyId: 'K'.repeat(43),
      stationSigningGeneration: 1,
      surface,
      invitationId: 'I'.repeat(43),
      invitationSecret: 'S'.repeat(43),
      expiresAt:
        ttl === null
          ? Number.MAX_SAFE_INTEGER
          : Date.now() + (ttl ?? 86_400_000),
    }),
  );
  const prepare = vi.fn(async (_input: unknown) => ({ scope, surface }));
  const owner: RelayInvitationOwner = {
    describe: async () => ({ route, trust, routingGeneration: 1 }),
    prepare,
    issueNativeInvitation: issue,
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    const bearer = c.req.header('Authorization')?.replace(/^Bearer /u, '');
    if (
      bearer &&
      security.authorizeCredential(bearer, {
        method: c.req.method,
        path: c.req.path,
      })
    ) {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'credential',
        credential: bearer,
        source: 'bearer',
        authority: security.verifyOperatorCredential(bearer)
          ? 'operator-credential'
          : 'device-credential',
      });
    }
    await next();
  });
  app.route(
    '/api/relay-management',
    createRelayManagementRoutes({
      owner,
      registry,
      resolveActor: createOrchestrationRequestPrincipalResolver({
        environmentSecurityService: security,
      }),
      captureDecision: (request, subjectId, actor) =>
        captureRelayManagementApproval(
          request,
          subjectId,
          security,
          security.devicePairing,
          actor,
        ),
      isManager: (request) =>
        hasRelayManagementAuthority(request, security, security.devicePairing),
    }),
  );
  const send = (path: string, body?: unknown, bearer = credential) =>
    app.request(`/api/relay-management${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const pair = () => {
    const offer = security.devicePairing.createOffer({
      endpoint: route.applicationOrigin,
    });
    const request = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Operator phone',
      source: 'tailnet',
      requester: { provider: 'tailscale-serve', login: 'manager@example.test' },
    });
    security.devicePairing.confirmRequest(
      request.requestId,
      { kind: 'presented-credential' },
      { principalId: 'human:local:operator', kind: 'verified-ingress' },
    );
    return security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
  };
  return {
    send,
    pair,
    security,
    registry,
    owner,
    issue,
    prepare,
    surface,
    scope,
    credential,
  };
}

test('operator creates a bound link only after an explicit installation approval, with the chosen lifetime', async () => {
  const f = await fixture();
  const prepare = {
    publicKey: generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    }).publicKey.export({ format: 'jwk' }),
  };
  expect(
    (await f.send('/invitations', { prepare, lifetime: '24h' })).status,
  ).toBe(409);
  expect(f.issue).not.toHaveBeenCalled();
  expect((await f.send('/approvals', { prepare })).status).toBe(200);
  const response = await f.send('/invitations', { prepare, lifetime: 'never' });
  expect(response.status).toBe(200);
  const result = z
    .object({ data: z.object({ link: z.string(), expiresAt: z.number() }) })
    .parse(await response.json());
  const link = parseNativeRelayLink(result.data.link, {
    channel: 'nightly',
    appIdentifier: 'io.kontourai.station.nightly',
  });
  expect(link.kind).toBe('bound-invitation');
  if (link.kind !== 'bound-invitation')
    throw new Error('Expected bound invitation');
  expect(link.invitation.surface).toEqual(f.surface);
  expect(link.invitation.scope).toEqual(f.scope);
  expect(link.invitation.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
  expect(f.issue.mock.calls[0]?.[2]).toBeNull();
});

test('ordinary paired authority and inherited manage access refuse; an explicit relay promotion works and removing it refuses again', async () => {
  const f = await fixture();
  const paired = f.pair();
  expect(
    (await f.send('/approvals', { prepare: {} }, paired.credential)).status,
  ).toBe(403);
  expect(f.prepare).not.toHaveBeenCalled();
  const original = paired.device.scope;
  f.security.devicePairing.setDeviceScope(
    paired.device.id,
    ['orchestration:read', 'relay:manage'],
    { kind: 'presented-credential' },
    original,
  );
  expect(
    (await f.send('/approvals', { prepare: {} }, paired.credential)).status,
  ).toBe(200);
  expect(f.registry.approvedSurfaces()[0]?.approvedBy).toBe(
    humanPrincipal('tailscale-serve', 'manager@example.test', 'Manager').id,
  );
  f.security.devicePairing.setDeviceScope(
    paired.device.id,
    ['orchestration:read'],
    { kind: 'presented-credential' },
  );
  expect(
    (
      await f.send(
        '/invitations',
        { prepare: {}, lifetime: '24h' },
        paired.credential,
      )
    ).status,
  ).toBe(403);
  expect(f.issue).not.toHaveBeenCalled();
});

test('revoking an approval during invitation issuance suppresses its secret link', async () => {
  const f = await fixture();
  await f.send('/approvals', { prepare: {} });
  const original = f.issue.getMockImplementation()!;
  f.issue.mockImplementationOnce(async (...args) => {
    const invitation = await original(...args);
    f.security.devicePairing.setDeviceScope(
      phone.device.id,
      ['orchestration:read'],
      { kind: 'presented-credential' },
    );
    return invitation;
  });
  const phone = f.pair();
  f.security.devicePairing.setDeviceScope(
    phone.device.id,
    ['orchestration:read', 'relay:manage'],
    { kind: 'presented-credential' },
  );
  const response = await f.send(
    '/invitations',
    { prepare: {}, lifetime: '24h' },
    phone.credential,
  );
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('station-relay-nightly:');
  expect(f.issue).toHaveBeenCalledTimes(1);
});

test('a broker response failure after dispatch is uncertain and does not invite a blind retry', async () => {
  const f = await fixture();
  await f.send('/approvals', { prepare: {} });
  f.issue.mockRejectedValueOnce(
    new Error('Private broker response could include secrets'),
  );
  const response = await f.send('/invitations', {
    prepare: {},
    lifetime: '24h',
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: { code: 'invitation_delivery_uncertain' },
  });
});

test('the external capability table grants only the closed management leaves', () => {
  expect(requiredPairingScope('GET', '/api/relay-management')).toBe(
    'relay:manage',
  );
  expect(
    requiredPairingScope('POST', '/api/relay-management/invitations'),
  ).toBe('relay:manage');
  expect(
    requiredPairingScope('POST', '/api/relay-management/unlisted'),
  ).toBeUndefined();
  expect(
    requiredPairingScope('DELETE', '/api/relay-management'),
  ).toBeUndefined();
});

test('remote access management opens only Project membership operations, preserving the execution boundary', () => {
  const scopes = 'orchestration:read relay:manage';
  expect(
    pairingScopeSatisfiesHttpRoute(scopes, 'orchestration:operate', {
      method: 'POST',
      path: '/api/projects/shared/access/invitations',
    }),
  ).toBe(true);
  expect(
    pairingScopeSatisfiesHttpRoute(scopes, 'orchestration:operate', {
      method: 'POST',
      path: '/api/projects/shared/access/members',
    }),
  ).toBe(true);
  expect(
    pairingScopeSatisfiesHttpRoute(scopes, 'orchestration:operate', {
      method: 'POST',
      path: '/api/projects/shared/access/enable',
    }),
  ).toBe(false);
  expect(
    pairingScopeSatisfiesHttpRoute(scopes, 'orchestration:operate', {
      method: 'POST',
      path: '/api/orchestration/submit',
    }),
  ).toBe(false);
});
