import { describe, expect, test } from 'vitest';
import { parseRelayIceConfiguration } from '../core/relayIceConfiguration.js';

const scope = {
  stationId: 'station-12345678',
  enrollmentId: 'enroll-12345678',
  routingGeneration: 1,
};
const configuration = {
  version: 'station-relay-ice-configuration/v1',
  scope,
  iceTransportPolicy: 'relay',
  issuedAt: 1000,
  expiresAt: 601000,
  iceServers: [
    {
      urls: ['turns:turn.example:443?transport=tcp'],
      username: 'short-lived-user',
      credential: 'end-user-secret',
    },
  ],
};

describe('relay ICE boundary', () => {
  test('copies and freezes only short-lived TURN credentials for the exact route', () => {
    const input = structuredClone(configuration);
    const result = parseRelayIceConfiguration(input, { scope }, 1000);
    input.iceServers[0]!.credential = 'replaced';
    expect(result.iceServers[0]?.credential).toBe('end-user-secret');
    expect(Object.isFrozen(result.iceServers[0]?.urls)).toBe(true);
    expect(result.iceTransportPolicy).toBe('relay');
  });
  test.each([
    { ...configuration, issuerSecret: 'never-client-visible' },
    { ...configuration, expiresAt: 16000 },
    { ...configuration, expiresAt: 601001 },
    { ...configuration, iceTransportPolicy: 'all' },
    { ...configuration, scope: { ...scope, stationId: 'other-station' } },
    { ...configuration, iceServers: [] },
    {
      ...configuration,
      iceServers: [
        {
          urls: ['https://issuer.example'],
          username: 'user',
          credential: 'secret',
        },
      ],
    },
    {
      ...configuration,
      iceServers: [
        {
          urls: ['turns:turn.example:443?transport=udp'],
          username: 'user',
          credential: 'secret',
        },
      ],
    },
    {
      ...configuration,
      iceServers: [
        {
          urls: ['turn:turn.example:70000'],
          username: 'user',
          credential: 'secret',
        },
      ],
    },
  ])('refuses stale, unbound or non-TURN configuration %#', (input) => {
    expect(() => parseRelayIceConfiguration(input, { scope }, 1000)).toThrow(
      'relay_ice_configuration_invalid',
    );
  });
});
