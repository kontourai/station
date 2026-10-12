import { describe, expect, test } from 'vitest';
import { ConsentChannelService } from '../consent-channel.js';
import {
  MAX_TRUSTED_CONSENT_ORIGIN_LENGTH,
  parseTrustedConsentOrigin,
  TrustedConsentOriginError,
} from '../consent-origin.js';

/** 63.63.63.61 labels plus dots = a 253-character DNS name. */
const LONGEST_HOST = [
  'a'.repeat(63),
  'b'.repeat(63),
  'c'.repeat(63),
  'd'.repeat(61),
].join('.');

describe('parseTrustedConsentOrigin', () => {
  test('unset and empty mean "not configured"', () => {
    expect(parseTrustedConsentOrigin(undefined)).toBeNull();
    expect(parseTrustedConsentOrigin('')).toBeNull();
  });

  test.each([
    'https://station.example.ts.net:1',
    'https://station.example.ts.net:65535',
    'https://station.example.ts.net',
    'https://station.example.ts.net:8443',
    'https://localhost:4443',
  ])('accepts the exact https origin %s', (value) => {
    expect(parseTrustedConsentOrigin(value)).toBe(value);
  });

  test.each([
    ['http scheme', 'http://station.example.ts.net'],
    ['a path', 'https://station.example.ts.net/consent'],
    ['a trailing slash', 'https://station.example.ts.net/'],
    ['a query', 'https://station.example.ts.net?x=1'],
    ['a fragment', 'https://station.example.ts.net#x'],
    ['a wildcard host', 'https://*.example.ts.net'],
    ['a wildcard port', 'https://station.example.ts.net:*'],
    ['userinfo', 'https://user:pw@station.example.ts.net'],
    ['userinfo without password', 'https://user@station.example.ts.net'],
    ['trailing junk', 'https://station.example.ts.net:8443 extra'],
    ['trailing whitespace', 'https://station.example.ts.net '],
    ['an IPv4 literal', 'https://100.64.0.7:8443'],
    ['an IPv4 literal in a numeric spelling', 'https://0x7f.1'],
    ['an IPv6 literal', 'https://[fd7a:115c:a1e0::1]:8443'],
    ['a spelled-out default port', 'https://station.example.ts.net:443'],
    ['uppercase', 'https://Station.Example.ts.net'],
    ['port 0', 'https://station.example.ts.net:0'],
    ['a trailing-dot FQDN', 'https://station.example.ts.net.'],
    ['a trailing-dot FQDN with a port', 'https://station.example.ts.net.:8443'],
    ['a bare host', 'station.example.ts.net'],
    ['a non-URL', 'not a url'],
  ])('refuses %s', (_label, value) => {
    expect(() => parseTrustedConsentOrigin(value)).toThrow(
      TrustedConsentOriginError,
    );
    expect(() => parseTrustedConsentOrigin(value)).toThrow(
      /STATION_TRUSTED_CONSENT_ORIGIN/,
    );
  });

  test('a value of exactly the maximum length is accepted and one more is refused', () => {
    expect(LONGEST_HOST).toHaveLength(253);
    const atMax = `https://${LONGEST_HOST}:65535`;
    expect(atMax).toHaveLength(MAX_TRUSTED_CONSENT_ORIGIN_LENGTH);
    expect(parseTrustedConsentOrigin(atMax)).toBe(atMax);
    const overMax = `https://e${LONGEST_HOST}:65535`;
    expect(overMax).toHaveLength(MAX_TRUSTED_CONSENT_ORIGIN_LENGTH + 1);
    expect(() => parseTrustedConsentOrigin(overMax)).toThrow(/longer than/);
  });

  test('the maximum is pinned to its derivation', () => {
    expect(MAX_TRUSTED_CONSENT_ORIGIN_LENGTH).toBe(267);
  });
});

describe('ConsentChannelService.reviewUrlFor with the consent origin', () => {
  test('without the setting it keeps the request hostname and the consent port', () => {
    const channel = new ConsentChannelService();
    channel.markListening(4321);
    expect(channel.reviewUrlFor('station.local:3141', 'tx 1')).toBe(
      'http://station.local:4321/consent/tx%201',
    );
  });

  test('with the setting it issues the configured origin, whatever the request Host says', () => {
    const channel = new ConsentChannelService({
      trustedOrigin: 'https://station.example.ts.net:8443',
    });
    channel.markListening(4321);
    expect(channel.reviewUrlFor('station.local:3141', 'tx-1')).toBe(
      'https://station.example.ts.net:8443/consent/tx-1',
    );
    expect(channel.reviewUrlFor(undefined, 'tx-1')).toBe(
      'https://station.example.ts.net:8443/consent/tx-1',
    );
  });

  test('an unavailable listener still yields no URL, configured or not', () => {
    const channel = new ConsentChannelService({
      trustedOrigin: 'https://station.example.ts.net',
    });
    expect(channel.reviewUrlFor('station.local', 'tx-1')).toBeNull();
  });
});
