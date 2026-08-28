import { encodeDevicePairingPayload } from '@kontourai/station-connect';
import { describe, expect, it } from 'vitest';
import { parsePairingDeepLink } from '../pairingDeepLink';

const payload = encodeDevicePairingPayload({
  protocolVersion: 1,
  environmentId: 'foreign-backend-is-valid',
  offerId: 'offer-test',
  challenge: 'challenge-test',
  manualCode: 'ABCDE12345',
  endpoint: 'https://station.example.ts.net',
  scope: 'orchestration:read',
  expiresAt: Date.now() + 60_000,
});

describe('native pairing deep-link presentation contract', () => {
  it('uses the shared channel-aware codec without a UI-specific parser', () => {
    expect(
      parsePairingDeepLink(
        `station-stable://pair?linkVersion=1&clientChannel=stable&payload=${encodeURIComponent(payload)}`,
        { clientChannel: 'stable' },
      ),
    ).toEqual({ status: 'ok', payload });
  });
});
