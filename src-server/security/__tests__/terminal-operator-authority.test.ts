import { expect, test } from 'vitest';
import {
  isOperatorsOwnDevice,
  isTerminalOperator,
  type OperatorDeviceRecord,
} from '../coding-authority.js';
import {
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../runtime-request-security.js';

function deviceRequest(
  principal: Partial<RuntimeAuthenticatedRequestPrincipal> = {},
): Request {
  const request = new Request('http://station.test/api/terminal/tickets', {
    method: 'POST',
  });
  setRuntimeAuthenticatedRequestPrincipal(request, {
    kind: 'credential',
    credential: 'phone-credential',
    authority: 'device-credential',
    deviceId: 'phone',
    deviceKind: 'device',
    source: 'bearer',
    ...principal,
  });
  return request;
}

const operatorsPhone: OperatorDeviceRecord = {
  id: 'phone',
  kind: 'device',
  revokedAt: null,
};
const identify =
  (record: OperatorDeviceRecord | null) => (credential: string) =>
    credential === 'phone-credential' ? record : null;

test("the operator's own paired device (no person binding) is the terminal operator", () => {
  const request = deviceRequest();
  expect(isOperatorsOwnDevice(request, identify(operatorsPhone))).toBe(true);
  expect(isTerminalOperator(request, identify(operatorsPhone))).toBe(true);
});

// Each refusal below is the injected fault for the positive case above.
test.each([
  [
    'a device tied to another person (a member)',
    { ...operatorsPhone, principalBinding: { provider: 'local', id: 'm' } },
  ],
  [
    "a person's personal access token",
    {
      ...operatorsPhone,
      credentialKind: 'personal-token',
      principalBinding: { provider: 'local', id: 'operator' },
    },
  ],
  [
    'a delegation grant from another Station',
    { ...operatorsPhone, kind: 'delegation' },
  ],
  ['a revoked device', { ...operatorsPhone, revokedAt: 1 }],
  [
    'a credential that resolves to a different device',
    { ...operatorsPhone, id: 'tablet' },
  ],
  ['a credential that no longer resolves', null],
] as const)('refuses %s', (_name, record) => {
  const request = deviceRequest();
  expect(
    isOperatorsOwnDevice(
      request,
      identify(record as OperatorDeviceRecord | null),
    ),
  ).toBe(false);
  expect(
    isTerminalOperator(
      request,
      identify(record as OperatorDeviceRecord | null),
    ),
  ).toBe(false);
});

test('refuses the internal principal, an unauthenticated request and a delegation principal', () => {
  expect(
    isTerminalOperator(
      deviceRequest({ kind: 'internal', authority: undefined }),
      identify(operatorsPhone),
    ),
  ).toBe(false);
  expect(
    isTerminalOperator(
      new Request('http://station.test/api/terminal/tickets'),
      identify(operatorsPhone),
    ),
  ).toBe(false);
  expect(
    isTerminalOperator(
      deviceRequest({ deviceKind: 'delegation' }),
      identify(operatorsPhone),
    ),
  ).toBe(false);
});

test('the operator credential in person needs no device record', () => {
  const request = deviceRequest({
    authority: 'operator-credential',
    deviceId: undefined,
    deviceKind: undefined,
  });
  expect(isOperatorsOwnDevice(request, identify(null))).toBe(false);
  expect(isTerminalOperator(request, identify(null))).toBe(true);
});
