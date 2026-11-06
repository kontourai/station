import { expect, test } from 'vitest';
import {
  STATION_CONTROL_ORIGIN_AGENT_TOOL,
  STATION_CONTROL_ORIGIN_HEADER,
} from '../../tools/station-control-shared.js';
import { memoryReviewerKindForRequest } from '../memory-reviewer-kind.js';
import {
  bindRuntimeLocalOperator,
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../runtime-request-security.js';

function request(
  principal: RuntimeAuthenticatedRequestPrincipal | undefined,
  headers: Record<string, string> = {},
): Request {
  const req = new Request('http://station.test/api/knowledge/memory/queue', {
    headers,
  });
  if (principal) setRuntimeAuthenticatedRequestPrincipal(req, principal);
  bindRuntimeLocalOperator(req);
  return req;
}

const operator: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'operator-secret',
  authority: 'operator-credential',
  source: 'bearer',
};

test('the operator in person is attested human', () => {
  expect(memoryReviewerKindForRequest(request(operator))).toBe('human');
  expect(
    memoryReviewerKindForRequest(
      request({
        ...operator,
        authority: undefined,
        source: 'session',
        locality: 'home-possession',
        mintKind: 'local-grant',
      }),
    ),
  ).toBe('human');
  expect(
    memoryReviewerKindForRequest(
      request({
        ...operator,
        authority: 'device-credential',
        standing: 'owner-device',
      }),
    ),
  ).toBe('human');
});

test('an agent tool call, Station’s internal token, another device and an unknown caller are never human', () => {
  expect(
    memoryReviewerKindForRequest(
      request(operator, {
        [STATION_CONTROL_ORIGIN_HEADER]: STATION_CONTROL_ORIGIN_AGENT_TOOL,
      }),
    ),
  ).toBe('agent');
  expect(
    memoryReviewerKindForRequest(
      request({
        kind: 'internal',
        credential: 'internal-token',
        authority: undefined,
        source: 'bearer',
        locality: 'home-possession',
      }),
    ),
  ).toBe('agent');
  expect(
    memoryReviewerKindForRequest(
      request({
        ...operator,
        authority: 'device-credential',
        deviceId: 'device-1',
        deviceKind: 'delegation',
      }),
    ),
  ).toBe('agent');
  expect(memoryReviewerKindForRequest(request(undefined))).toBe('agent');
});
