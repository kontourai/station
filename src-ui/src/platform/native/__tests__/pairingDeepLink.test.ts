import { encodeDevicePairingPayload } from '@kontourai/station-connect';
import { describe, expect, it } from 'vitest';
import { parsePairingDeepLink } from '../pairingDeepLink';

const payload = encodeDevicePairingPayload({
  protocolVersion: 1,
  environmentId: 'environment-test',
  offerId: 'offer-test',
  challenge: 'challenge-test',
  manualCode: 'ABCDE12345',
  endpoint: 'https://station.example.ts.net',
  scope: 'orchestration:read',
  expiresAt: Date.now() + 60_000,
});

describe('parsePairingDeepLink', () => {
  it('accepts exactly one valid offer payload', () => {
    expect(
      parsePairingDeepLink(
        `station://pair?payload=${encodeURIComponent(payload)}`,
      ),
    ).toEqual({ status: 'ok', payload });
  });

  it.each([
    'https://pair?payload=station-pairing:v1:nope',
    'station://other?payload=station-pairing:v1:nope',
    'station://pair/path?payload=station-pairing:v1:nope',
    'station://pair?payload=station-pairing:v1:nope&next=https://evil.example',
    'station://pair?payload=one&payload=two',
    'station://pair?payload=station-pairing:v1:nope#fragment',
  ])('fails closed for %s', (url) => {
    expect(parsePairingDeepLink(url).status).toBe('error');
  });
});
