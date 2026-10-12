import {
  DEPLOYMENT_AUTHENTICATION_VERSION,
  type DeploymentAuthenticationProvider,
  type DeploymentAuthenticationResult,
} from '@kontourai/station-contracts/deployment-authentication';
import { expect, test } from 'vitest';
import { DeploymentAuthenticationService } from '../../services/identity/deployment-authentication-service.js';
import { captureRelayManagementActor } from '../relay-management-actor.js';

async function actorFixture() {
  let now = Date.parse('2026-10-04T00:00:00Z');
  let result: DeploymentAuthenticationResult = {
    kind: 'authenticated',
    session: {
      subject: 'manager',
      displayName: 'Manager',
      sessionId: 'manager-session',
      authenticatedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 1000).toISOString(),
      contacts: [],
    },
  };
  const provider: DeploymentAuthenticationProvider = {
    version: DEPLOYMENT_AUTHENTICATION_VERSION,
    issuer: 'https://identity.example',
    displayName: 'Test identity',
    sessionCookies: ['manager_account'],
    endpoints: [{ path: '/logout', methods: ['POST'], operation: 'logout' }],
    authenticate: async () => result,
    handle: async () => new Response(null, { status: 204 }),
  };
  const authentication = new DeploymentAuthenticationService(
    provider,
    () => now,
  );
  const request = new Request(
    'https://station.example/api/relay-management/invitations',
    { method: 'POST', headers: { Cookie: 'manager_account=current' } },
  );
  const admitted = await authentication.authenticate(request);
  if (admitted.kind !== 'authenticated')
    throw new Error('Account fixture was not admitted');
  const currency = captureRelayManagementActor(
    request,
    admitted.principal,
    { listDevices: () => [], identifyDevice: () => null },
    authentication,
  );
  return {
    currency,
    expire: () => {
      now += 1001;
    },
    revoke: () => {
      result = { kind: 'invalid', reason: 'revoked' };
    },
  };
}
test('the admitted manager account expires while a role grant can remain live', async () => {
  const f = await actorFixture();
  expect(f.currency.current()).toBe(true);
  f.expire();
  expect(f.currency.current()).toBe(false);
  await expect(f.currency.refresh()).resolves.toBe(false);
});
test('authoritative refresh refuses a revoked provider session before its admitted expiry', async () => {
  const f = await actorFixture();
  f.revoke();
  expect(f.currency.current()).toBe(true);
  await expect(f.currency.refresh()).resolves.toBe(false);
  expect(f.currency.current()).toBe(false);
});
