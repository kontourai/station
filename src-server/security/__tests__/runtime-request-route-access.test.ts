import {
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  PAIRING_SCOPE_ORCHESTRATION_READ,
} from '@kontourai/station-contracts/environment-security';
import { expect, test } from 'vitest';
import {
  runtimeRequestPrincipalMayAccessHttpRoute,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../runtime-request-security.js';

/**
 * The inbox offers a paired-Station decision only when the reader's own
 * credential would pass this Station's HTTP boundary for the respond route
 * it posts to. The predicate evaluates THAT route, not the read's own path:
 * a device scoped to read orchestration may load the inbox but not decide.
 */
const RESPOND = {
  method: 'POST',
  path: '/api/orchestration/delegations/task-1/respond',
};

function requestAs(credential: string): Request {
  const request = new Request('http://station.test/api/attention');
  setRuntimeAuthenticatedRequestPrincipal(request, {
    kind: 'credential',
    credential,
    authority: 'device-credential',
    deviceId: `device-${credential}`,
    deviceKind: 'device',
    source: 'bearer',
  });
  return request;
}

const security = {
  authorizeCredential: () => true,
  resolveGrantedScope: (credential: string) =>
    credential === 'operate-device'
      ? `${PAIRING_SCOPE_ORCHESTRATION_READ} ${PAIRING_SCOPE_ORCHESTRATION_OPERATE}`
      : PAIRING_SCOPE_ORCHESTRATION_READ,
};

test('a device granted orchestration operate may post to the respond route', () => {
  expect(
    runtimeRequestPrincipalMayAccessHttpRoute(
      requestAs('operate-device'),
      security,
      RESPOND,
    ),
  ).toBe(true);
});

test('a read-only device may load the inbox but not post to the respond route', () => {
  const request = requestAs('read-device');
  expect(
    runtimeRequestPrincipalMayAccessHttpRoute(request, security, {
      method: 'GET',
      path: '/api/attention',
    }),
  ).toBe(true);
  expect(
    runtimeRequestPrincipalMayAccessHttpRoute(request, security, RESPOND),
  ).toBe(false);
});

test('no authenticated principal fails closed', () => {
  expect(
    runtimeRequestPrincipalMayAccessHttpRoute(
      new Request('http://station.test/api/attention'),
      security,
      RESPOND,
    ),
  ).toBe(false);
});
