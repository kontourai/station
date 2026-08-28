// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_FORWARDED_HOST_HEADER,
} from '../../utils/internal-api-token.js';
import {
  attestedBrowserVisibleHost,
  browserVisibleHost,
  isLoopbackAuthority,
} from '../runtime-request-security.js';

/**
 * archive#3752. Station's UI proxy rewrites `Host` to the upstream address,
 * so a URL minted for the BROWSER from the request's own `Host` names
 * `127.0.0.1` while the browser is on `localhost`. Cookies are scoped by
 * HOST, so the consent transaction cookie was never sent and the review page
 * refused every operator with "Sign in to Station first".
 *
 * The forwarded host is therefore accepted under exactly one rule — the same
 * one `x-station-proxy-peer` uses — and these pin both directions of it.
 */

function request(options: {
  host?: string;
  forwarded?: string;
  token?: string;
  peer?: string;
}) {
  const headers = new Map<string, string>();
  if (options.host !== undefined) headers.set('host', options.host);
  if (options.forwarded !== undefined) {
    headers.set(INTERNAL_PROXY_FORWARDED_HOST_HEADER, options.forwarded);
  }
  if (options.token !== undefined) {
    headers.set(INTERNAL_API_TOKEN_HEADER, options.token);
  }
  return {
    environment: {
      incoming: { socket: { remoteAddress: options.peer ?? '127.0.0.1' } },
    },
    header: (name: string) => headers.get(name.toLowerCase()),
  };
}

describe('browserVisibleHost (station#3752)', () => {
  it('prefers the attested proxy hop, which is the defect this exists to fix', () => {
    expect(
      browserVisibleHost(
        request({
          host: '127.0.0.1:3141',
          forwarded: 'localhost:3000',
          token: getInternalApiToken(),
        }),
      ),
    ).toBe('localhost:3000');
  });

  it('falls back to the request Host with no proxy hop at all (the direct topology)', () => {
    expect(browserVisibleHost(request({ host: 'localhost:3141' }))).toBe(
      'localhost:3141',
    );
  });

  it('refuses a forwarded host presented WITHOUT a trusted internal token', () => {
    // A direct caller spelling the header, which is precisely why this is
    // not `x-forwarded-host`.
    expect(
      browserVisibleHost(
        request({ host: '127.0.0.1:3141', forwarded: 'attacker.example' }),
      ),
    ).toBe('127.0.0.1:3141');
    expect(
      browserVisibleHost(
        request({
          host: '127.0.0.1:3141',
          forwarded: 'attacker.example',
          token: 'not-the-token',
        }),
      ),
    ).toBe('127.0.0.1:3141');
  });

  it('refuses a forwarded host from a NON-loopback socket even with a valid token', () => {
    expect(
      browserVisibleHost(
        request({
          host: '127.0.0.1:3141',
          forwarded: 'attacker.example',
          token: getInternalApiToken(),
          peer: '192.168.1.50',
        }),
      ),
    ).toBe('127.0.0.1:3141');
  });

  it('refuses a forwarded value that is more than a bare authority (review MEDIUM)', () => {
    // Attestation proves WHO sent the value, not WHAT it says: the proxy
    // copies its client's Host verbatim, and consumers embed it as
    // `new URL('http://' + host)`, which absorbs userinfo and paths. Left
    // unvalidated, the first case below mints a review URL on evil.example.
    for (const poisoned of [
      'station.local@evil.example:3000',
      'localhost:3000/path',
      'localhost:3000?q=1',
      'localhost:3000#f',
      'localhost:3000\\evil.example',
      'localhost:3000,evil.example',
      'local host:3000',
      'not:a:port',
    ]) {
      expect(
        browserVisibleHost(
          request({
            host: 'localhost:3141',
            forwarded: poisoned,
            token: getInternalApiToken(),
          }),
        ),
        `must refuse ${poisoned}`,
      ).toBe('localhost:3141');
    }
  });

  it('accepts the authority shapes a real browser sends, including IPv6 and a bare host', () => {
    for (const host of [
      'localhost:3000',
      '127.0.0.1:3141',
      '[::1]:3000',
      'station.local',
    ]) {
      expect(
        browserVisibleHost(
          request({
            host: 'localhost:3141',
            forwarded: host,
            token: getInternalApiToken(),
          }),
        ),
        `must accept ${host}`,
      ).toBe(host);
    }
  });

  it('refuses a malformed Host on the DIRECT path too, rather than passing it to URL construction', () => {
    expect(
      browserVisibleHost(request({ host: 'station.local@evil.example:3000' })),
    ).toBeUndefined();
  });

  it('returns undefined only when the request itself has no Host to fall back to', () => {
    expect(browserVisibleHost(request({}))).toBeUndefined();
    expect(
      browserVisibleHost(request({ forwarded: 'attacker.example' })),
    ).toBeUndefined();
  });
});

/**
 * archive#3876. `browserVisibleHost` falls back to the request's own `Host`
 * because it is minting a URL either way. A caller asking "did the browser
 * address THIS MACHINE?" cannot take that fallback: behind the proxy the
 * request's own `Host` is the address the PROXY dialled, so the fallback
 * answers `127.0.0.1` for every browser on earth.
 */
describe('attestedBrowserVisibleHost (station#3876)', () => {
  it('reports the attested hop, and NOTHING when there is no attested hop', () => {
    expect(
      attestedBrowserVisibleHost(
        request({
          host: '127.0.0.1:3141',
          forwarded: 'kontour.example.ts.net',
          token: getInternalApiToken(),
        }),
      ),
    ).toBe('kontour.example.ts.net');
    // The fallback `browserVisibleHost` would take here reads `127.0.0.1:3141`
    // — the proxy's own dial — which is exactly the answer that must not be
    // mistaken for the browser's.
    expect(
      attestedBrowserVisibleHost(request({ host: '127.0.0.1:3141' })),
    ).toBe(undefined);
    expect(
      attestedBrowserVisibleHost(
        request({ host: '127.0.0.1:3141', forwarded: 'localhost:3000' }),
      ),
      "an unattested forwarded header was reported as the browser's own Host",
    ).toBeUndefined();
  });
});

describe('isLoopbackAuthority (station#3876)', () => {
  it("accepts only names for this machine's own loopback interface", () => {
    for (const authority of [
      'localhost',
      'localhost:5274',
      'LocalHost:5274',
      '127.0.0.1:5274',
      '127.7.0.1',
      '[::1]:5274',
    ]) {
      expect(isLoopbackAuthority(authority), `must accept ${authority}`).toBe(
        true,
      );
    }
  });

  it('refuses every authority that names somewhere else', () => {
    for (const authority of [
      undefined,
      '',
      // The unconfigured-Serve case: Serve re-dials from loopback but
      // preserves the browser's Host, and this is what it preserves.
      'kontour.example.ts.net',
      '192.168.1.20:5274',
      '100.96.12.7:5274',
      'station.example.test',
      // Not a bare authority at all — `validAuthority` refuses these upstream,
      // and so does this.
      'station.local@127.0.0.1:5274',
      '127.0.0.1:5274/path',
    ]) {
      expect(
        isLoopbackAuthority(authority),
        `must refuse ${String(authority)}`,
      ).toBe(false);
    }
  });
});
