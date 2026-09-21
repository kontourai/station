import { expect, test } from 'vitest';
import {
  AUTHORITY_OBSERVATION_SCHEMA_VERSION,
  isAuthorityObservation,
} from '../authority-observation.js';

const valid = {
  schemaVersion: AUTHORITY_OBSERVATION_SCHEMA_VERSION,
  environmentId: '11111111-1111-4111-8111-111111111111',
  principal: { kind: 'human', id: 'human:local:operator' },
  grant: { kind: 'operator' },
};

test('accepts the closed operator observation', () => {
  expect(isAuthorityObservation(valid)).toBe(true);
});

test('accepts the closed device observation', () => {
  expect(
    isAuthorityObservation({
      ...valid,
      principal: { kind: 'human', id: 'human:device:device-1' },
      grant: { kind: 'device', deviceId: 'device-1', grantedScopes: ['read'] },
    }),
  ).toBe(true);
});

test('accepts a tenant principal echo', () => {
  expect(
    isAuthorityObservation({
      ...valid,
      principal: { kind: 'tenant', id: 'tenant:acme' },
    }),
  ).toBe(true);
});

test('rejects unknown top-level fields (no unvalidated extras)', () => {
  expect(
    isAuthorityObservation({ ...valid, credential: 'bearer-token-value' }),
  ).toBe(false);
});

test('rejects principal extras, emails, and wrong kinds', () => {
  expect(
    isAuthorityObservation({
      ...valid,
      principal: { kind: 'human', id: 'human:local:operator', email: 'x' },
    }),
  ).toBe(false);
  expect(
    isAuthorityObservation({
      ...valid,
      principal: { kind: 'agent', id: 'agent:x' },
    }),
  ).toBe(false);
});

test('rejects wrong schema version and malformed shapes', () => {
  expect(
    isAuthorityObservation({
      ...valid,
      schemaVersion: 'station.authority-observation/v2',
    }),
  ).toBe(false);
  expect(isAuthorityObservation({ ...valid, environmentId: '' })).toBe(false);
  expect(isAuthorityObservation({ ...valid, grant: { kind: 'device' } })).toBe(
    false,
  );
  expect(
    isAuthorityObservation({
      ...valid,
      grant: { kind: 'device', deviceId: 'd', grantedScopes: ['read', ''] },
    }),
  ).toBe(false);
  expect(isAuthorityObservation(null)).toBe(false);
  expect(isAuthorityObservation([valid])).toBe(false);
});

test('device grant rejects extra fields (no token-like riders)', () => {
  expect(
    isAuthorityObservation({
      ...valid,
      grant: {
        kind: 'device',
        deviceId: 'device-1',
        grantedScopes: ['read'],
        tokenHash: 'abc',
      },
    }),
  ).toBe(false);
});

test('principal rejects display names, emails, and non-closed kinds', () => {
  // The closed echo is kind+id only: a display label or contact would let
  // a future server smuggle unaudited identity detail past the reader.
  expect(
    isAuthorityObservation({
      ...valid,
      principal: { kind: 'human', id: 'human:local:operator', display: 'Op' },
    }),
  ).toBe(false);
  expect(
    isAuthorityObservation({
      ...valid,
      principal: {
        kind: 'human',
        id: 'human:local:operator',
        email: 'op@example.test',
      },
    }),
  ).toBe(false);
  for (const kind of ['agent', 'service', 'operator']) {
    expect(
      isAuthorityObservation({
        ...valid,
        principal: { kind, id: `${kind}:x` },
      }),
    ).toBe(false);
  }
});

test('operator grant rejects device fields and vice versa', () => {
  expect(
    isAuthorityObservation({
      ...valid,
      grant: { kind: 'operator', deviceId: 'device-1' },
    }),
  ).toBe(false);
  expect(
    isAuthorityObservation({
      ...valid,
      grant: { kind: 'device', deviceId: '', grantedScopes: [] },
    }),
  ).toBe(false);
});
