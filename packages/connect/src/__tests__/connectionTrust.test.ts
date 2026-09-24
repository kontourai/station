import type { DeviceConnectionTrustRecord } from '@kontourai/station-contracts/connection-proof';
import { describe, expect, test } from 'vitest';
import { stationRelayRouteTrustStatus } from '../core/connectionTrust';

const route = {
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
};
const record: DeviceConnectionTrustRecord = {
  schemaVersion: 1,
  revision: 2,
  status: 'approved',
  trust: {
    stationId: '11111111-1111-4111-8111-111111111111',
    enrollmentId: '22222222-2222-4222-8222-222222222222',
    generation: 3,
    signingKey: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
  },
};

describe('Station relay profile trust display', () => {
  test('reports only an independently approved exact Station enrollment as approved', () => {
    expect(stationRelayRouteTrustStatus(record, route)).toBe('approved');
    expect(stationRelayRouteTrustStatus(null, route)).toBe('untrusted');
    expect(
      stationRelayRouteTrustStatus({ ...record, status: 'revoked' }, route),
    ).toBe('revoked');
    expect(
      stationRelayRouteTrustStatus(record, {
        ...route,
        enrollmentId: '33333333-3333-4333-8333-333333333333',
      }),
    ).toBe('mismatch');
    expect(
      stationRelayRouteTrustStatus(record, {
        ...route,
        stationId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toBe('mismatch');
  });
});
