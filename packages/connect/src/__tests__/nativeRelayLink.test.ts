import type { NativeRelayLinkV1 } from '@kontourai/station-contracts/native-relay-link';
import { describe, expect, test } from 'vitest';
import {
  encodeNativeRelayLink,
  parseNativeRelayLink,
} from '../core/nativeRelayLink.js';

const now = 1_700_000_000_000;
const intent: NativeRelayLinkV1 = {
  version: 'station-native-relay-link/v1',
  kind: 'route-intent',
  applicationOrigin: 'https://station.example',
  brokerOrigin: 'https://broker.example',
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
};
const bound: NativeRelayLinkV1 = {
  version: 'station-native-relay-link/v1',
  kind: 'bound-invitation',
  applicationOrigin: 'https://station.example',
  invitation: {
    version: 'station-broker-native-route-invitation/v2',
    brokerOrigin: 'https://broker.example',
    scope: {
      stationId: intent.stationId,
      enrollmentId: intent.enrollmentId,
      routingGeneration: 9,
    },
    stationSigningKeyId: 'K'.repeat(43),
    stationSigningGeneration: 4,
    surface: {
      kind: 'station-native',
      appIdentifier: 'io.kontourai.station.nightly',
      channel: 'nightly',
      clientInstanceId: '33333333-3333-4333-8333-333333333333',
      keyThumbprint: 'T'.repeat(43),
    },
    invitationId: 'invite-12345678',
    invitationSecret: 'S'.repeat(43),
    expiresAt: now + 60_000,
  },
};

function inputLink(value: unknown): string {
  return `station-relay-nightly://relay#relay-link=${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
}
const options = {
  channel: 'nightly' as const,
  appIdentifier: 'io.kontourai.station.nightly',
  now,
};

describe('native relay link publication contract', () => {
  test('publishes a distinct native association with the entire invitation in its fragment', () => {
    const url = new URL(encodeNativeRelayLink(bound, options));
    expect(url.protocol).toBe('station-relay-nightly:');
    expect(url.hostname).toBe('relay');
    expect(url.search).toBe('');
    expect(
      JSON.parse(
        Buffer.from(
          url.hash.slice('#relay-link='.length),
          'base64url',
        ).toString('utf8'),
      ),
    ).toEqual(bound);
  });

  test.each([now + 24 * 60 * 60_000, Number.MAX_SAFE_INTEGER])(
    'publishes and accepts invitation expiry %s',
    (expiresAt) => {
      const value = {
        ...bound,
        invitation: { ...bound.invitation, expiresAt },
      };
      expect(
        parseNativeRelayLink(encodeNativeRelayLink(value, options), options),
      ).toEqual(value);
    },
  );

  test('reads public first-contact metadata without adding an invitation or trust', () => {
    expect(parseNativeRelayLink(inputLink(intent), options)).toEqual(intent);
  });

  test('requires HTTPS in production and allows numeric loopback only for the explicit development association', () => {
    for (const applicationOrigin of [
      'http://localhost:3491',
      'http://127.0.0.1:3491',
      'http://[::1]:3491',
    ]) {
      expect(() =>
        parseNativeRelayLink(
          inputLink({ ...intent, applicationOrigin }),
          options,
        ),
      ).toThrow('native_relay_link_invalid');
    }
    const local = {
      ...intent,
      applicationOrigin: 'http://127.0.0.1:3491',
      brokerOrigin: 'http://[::1]:3492',
    };
    const dev = {
      channel: 'dev' as const,
      devScheme: 'station-relay-dev-instance',
      appIdentifier: 'io.kontourai.station.dev.instance',
      now,
    };
    const encoded = encodeNativeRelayLink(local, dev);
    expect(parseNativeRelayLink(encoded, dev)).toEqual(local);
    expect(() =>
      encodeNativeRelayLink(
        { ...local, brokerOrigin: 'http://localhost:3492' },
        dev,
      ),
    ).toThrow('native_relay_link_invalid');
    expect(() =>
      parseNativeRelayLink(
        inputLink({
          ...bound,
          invitation: {
            ...bound.invitation,
            brokerOrigin: 'http://127.0.0.1:3492',
          },
        }),
        options,
      ),
    ).toThrow('native_relay_link_invalid');
  });

  test.each([
    { ...bound, trusted: true },
    { ...bound, version: 'station-native-relay-link/v99' },
    { ...bound, applicationOrigin: 'https://station.example/api' },
    { ...bound, invitation: { ...bound.invitation, expiresAt: now } },
    {
      ...bound,
      invitation: {
        ...bound.invitation,
        scope: { ...bound.invitation.scope, routingGeneration: 0 },
      },
    },
    {
      ...bound,
      invitation: {
        ...bound.invitation,
        surface: { ...bound.invitation.surface, channel: 'beta' },
      },
    },
    {
      ...bound,
      invitation: {
        ...bound.invitation,
        surface: {
          ...bound.invitation.surface,
          appIdentifier: 'io.kontourai.station.beta',
        },
      },
    },
    { ...bound, invitation: { ...bound.invitation, invitationSecret: 'bad' } },
  ])(
    'rejects unsupported or malformed typed envelopes with a fixed safe error',
    (value) => {
      expect(() => parseNativeRelayLink(inputLink(value), options)).toThrow(
        'native_relay_link_invalid',
      );
    },
  );

  test.each([
    'station-nightly://relay',
    'station-relay-beta://relay',
    'station-relay-nightly://pair',
    'station-relay-nightly://relay/',
    'station-relay-nightly://relay?secret=ignored',
    'station-relay-nightly://user@relay',
  ])(
    'rejects a different association or a request-visible payload carrier: %s',
    (prefix) => {
      const fragment = inputLink(bound).slice(inputLink(bound).indexOf('#'));
      expect(() =>
        parseNativeRelayLink(`${prefix}${fragment}`, options),
      ).toThrow('native_relay_link_invalid');
    },
  );
});
