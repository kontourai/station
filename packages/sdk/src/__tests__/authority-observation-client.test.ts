import { beforeEach, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({ getJson: vi.fn() }));
vi.mock('../client/http', () => transport);

import {
  AUTHORITY_OBSERVATION_SCHEMA_VERSION,
  getAuthorityObservation,
} from '../client/authority-observation';

const options = {
  requestScope: { apiBase: 'http://station.test', authorityKey: 'scope-1' },
};
const observation = {
  schemaVersion: AUTHORITY_OBSERVATION_SCHEMA_VERSION,
  environmentId: '11111111-1111-4111-8111-111111111111',
  principal: { kind: 'human', id: 'human:local:operator' },
  grant: { kind: 'operator' },
};
const response = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => vi.resetAllMocks());

test('reads /api/auth/authority with the captured request scope and returns the closed observation', async () => {
  transport.getJson.mockResolvedValue(response(200, observation));
  const result = await getAuthorityObservation('http://station.test', options);
  expect(transport.getJson).toHaveBeenCalledWith(
    'http://station.test/api/auth/authority',
    options,
  );
  expect(result).toEqual(observation);
});

test('fail-closed on the boundary refusal, never a guessed identity', async () => {
  transport.getJson.mockResolvedValue(
    response(401, { error: { code: 'authentication_required' } }),
  );
  await expect(
    getAuthorityObservation('http://station.test', options),
  ).rejects.toThrow('did not accept the presented credential');
});

test('fail-closed on other refusals with their status', async () => {
  transport.getJson.mockResolvedValue(
    response(503, { error: { code: 'authentication_unavailable' } }),
  );
  await expect(
    getAuthorityObservation('http://station.test', options),
  ).rejects.toThrow('HTTP 503');
});

test('rejects an incompatible (non-closed) payload', async () => {
  transport.getJson.mockResolvedValue(
    response(200, { ...observation, unexpected: true }),
  );
  await expect(
    getAuthorityObservation('http://station.test', options),
  ).rejects.toThrow('incompatible authority observation');
});

test('rejects a wrong schema version', async () => {
  transport.getJson.mockResolvedValue(
    response(200, {
      ...observation,
      schemaVersion: 'station.authority-observation/v0',
    }),
  );
  await expect(
    getAuthorityObservation('http://station.test', options),
  ).rejects.toThrow('incompatible authority observation');
});

test('propagates the caller request authority (credential, headers, scope) verbatim', async () => {
  transport.getJson.mockResolvedValue(response(200, observation));
  const authorized = {
    requestScope: { apiBase: 'http://station.test', authorityKey: 'scope-1' },
    credential: 'device-credential-value',
    credentialOrigin: 'http://station.test',
    headers: { 'X-Station-Client-Origin': '1;desktop;2.0.0' },
    authentication: 'required' as const,
  };
  await getAuthorityObservation('http://station.test', authorized);
  // The observation must travel on the caller's own authority, exactly like
  // every other protected read — no ambient credential, no dropped scope.
  expect(transport.getJson).toHaveBeenCalledWith(
    'http://station.test/api/auth/authority',
    authorized,
  );
});
