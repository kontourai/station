import { describe, expect, test } from 'vitest';
import { encodeDevicePairingPayload } from '../core/devicePairing';
import {
  encodePairingDeepLink,
  PAIRING_LINK_REMEDY,
  parsePairingDeepLink,
} from '../core/pairingDeepLink';

const payload = encodeDevicePairingPayload({
  protocolVersion: 1,
  environmentId: 'backend-identity-is-independent',
  offerId: 'offer-test',
  challenge: 'challenge-test',
  manualCode: 'ABCDE12345',
  endpoint: 'https://station.example.test',
  scope: 'orchestration:read',
  expiresAt: Date.now() + 60_000,
});

describe('channel-aware pairing deep links', () => {
  test.each(['stable', 'beta', 'nightly'] as const)(
    'round-trips the %s client route without constraining backend identity',
    (clientChannel) => {
      const link = encodePairingDeepLink({ payload, clientChannel });
      expect(link).toMatch(
        new RegExp(
          `^station-${clientChannel}://pair\\?linkVersion=1&clientChannel=${clientChannel}&payload=`,
        ),
      );
      expect(parsePairingDeepLink(link, { clientChannel })).toEqual({
        status: 'ok',
        payload,
      });
    },
  );

  test.each([
    'station://pair?payload=anything',
    `station-beta://pair?linkVersion=1&clientChannel=beta&payload=${encodeURIComponent(payload)}`,
    `station-stable://pair?linkVersion=2&clientChannel=stable&payload=${encodeURIComponent(payload)}`,
    `station-stable://pair?linkVersion=1&clientChannel=beta&payload=${encodeURIComponent(payload)}`,
    `station-stable://pair?linkVersion=1&clientChannel=stable&payload=${encodeURIComponent(payload)}&payload=again`,
    `station-stable://pair/?linkVersion=1&clientChannel=stable&payload=${encodeURIComponent(payload)}`,
    `station-stable://user@pair?linkVersion=1&clientChannel=stable&payload=${encodeURIComponent(payload)}`,
    `station-stable://pair?linkVersion=1&clientChannel=stable&payload=${encodeURIComponent(payload)}#fragment`,
    'station-stable://pair?linkVersion=1&clientChannel=stable&payload=malformed',
  ])('rejects obsolete, foreign, malformed, or ambiguous input', (url) => {
    const parsed = parsePairingDeepLink(url, { clientChannel: 'stable' });
    expect(parsed.status).toBe('error');
    if (parsed.status === 'error')
      expect(parsed.message).toContain(PAIRING_LINK_REMEDY);
  });

  function deepLinkWithOffer(extra: Record<string, unknown>): string {
    const encoded = btoa(
      JSON.stringify({
        protocolVersion: 1,
        environmentId: 'backend-identity-is-independent',
        offerId: 'offer-test',
        challenge: 'challenge-test',
        endpoint: 'https://station.example.test',
        scope: 'orchestration:read',
        expiresAt: Date.now() + 60_000,
        ...extra,
      }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `station-stable://pair?linkVersion=1&clientChannel=stable&payload=${encodeURIComponent(`station-pairing:v1:${encoded}`)}`;
  }

  test('admits a hand-encoded offer carrying only canonical fields', () => {
    expect(
      parsePairingDeepLink(deepLinkWithOffer({}), { clientChannel: 'stable' })
        .status,
    ).toBe('ok');
  });

  // The rejection comes from canonical-field enforcement, not from scanning
  // for credentials: benign additive data is refused the same way, so no
  // extra field reaches URL admission whatever it carries.
  test.each([
    { metadata: { note: 'plain' } },
    { metadata: { credential: 'must-not-enter-url-admission' } },
    { metadata: { authorization: { bearer: 'must-not-enter-url-admission' } } },
  ])(
    'rejects any non-canonical offer field at the deep-link boundary',
    (extra) => {
      expect(
        parsePairingDeepLink(deepLinkWithOffer(extra), {
          clientChannel: 'stable',
        }).status,
      ).toBe('error');
    },
  );
});
