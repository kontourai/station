import { describe, expect, test } from 'vitest';
import {
  isPairableEndpoint,
  pairingRoutesFrom,
  preferredPairingRoute,
} from '../core/pairingRoutes';

describe('isPairableEndpoint', () => {
  test.each([
    'https://kontour.example.ts.net',
    'https://station.example.com',
    'http://192.168.50.16:3774',
    'http://10.0.0.4:3774',
    'http://172.20.1.2:3774',
    'http://100.77.142.114:3774',
    'http://studio.local:3774',
  ])('accepts %s', (value) => {
    expect(isPairableEndpoint(value)).toBe(true);
  });

  test.each([
    // A phone that scans loopback dials itself.
    'http://127.0.0.1:3774',
    'http://localhost:3774',
    'https://localhost:3774',
    // Cleartext to a public or DNS name is refused by the server.
    'http://station.example.com',
    'http://kontour.example.ts.net:3774',
    'https://user:pass@station.example.com',
    'ftp://192.168.1.2',
    'not a url',
  ])('refuses %s', (value) => {
    expect(isPairableEndpoint(value)).toBe(false);
  });
});

describe('pairingRoutesFrom', () => {
  test('orders routes best first, drops loopback and duplicates', () => {
    const routes = pairingRoutesFrom(
      [
        { kind: 'lan', url: 'http://192.168.50.16:3774' },
        { kind: 'tailscale', url: 'http://100.77.142.114:3774' },
        // MagicDNS over cleartext is refused by the server, so it is not offered.
        { kind: 'tailscale', url: 'http://kontour.example.ts.net:3774' },
        { kind: 'tailscale-https', url: 'https://kontour.example.ts.net' },
        { kind: 'lan', url: 'http://192.168.50.16:3774' },
      ],
      'http://127.0.0.1:3774',
    );
    expect(routes.map((route) => [route.kind, route.url])).toEqual([
      ['tailscale-https', 'https://kontour.example.ts.net'],
      ['tailscale', 'http://100.77.142.114:3774'],
      ['lan', 'http://192.168.50.16:3774'],
    ]);
    expect(routes[0]?.label).toBe('Tailscale HTTPS');
  });

  test('offers the current address when nothing else is reported', () => {
    expect(
      pairingRoutesFrom([], 'https://station.example.com/some/path'),
    ).toEqual([
      expect.objectContaining({
        kind: 'current',
        url: 'https://station.example.com',
      }),
    ]);
  });

  test('a current address already reported keeps its reported kind', () => {
    const routes = pairingRoutesFrom(
      [{ kind: 'tailscale-https', url: 'https://kontour.example.ts.net' }],
      'https://kontour.example.ts.net',
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.kind).toBe('tailscale-https');
  });

  test('offers nothing when only loopback is known', () => {
    expect(pairingRoutesFrom([], 'http://127.0.0.1:3774')).toEqual([]);
  });
});

describe('preferredPairingRoute', () => {
  const routes = pairingRoutesFrom(
    [
      { kind: 'tailscale-https', url: 'https://kontour.example.ts.net' },
      { kind: 'lan', url: 'http://192.168.50.16:3774' },
    ],
    undefined,
  );

  test('prefers the remembered route when it is still offered', () => {
    expect(
      preferredPairingRoute(routes, 'http://192.168.50.16:3774')?.kind,
    ).toBe('lan');
  });

  test('falls back to the best route', () => {
    expect(preferredPairingRoute(routes, 'http://10.9.9.9:1')?.kind).toBe(
      'tailscale-https',
    );
    expect(preferredPairingRoute(routes, undefined)?.kind).toBe(
      'tailscale-https',
    );
    expect(preferredPairingRoute([], undefined)).toBeUndefined();
  });
});
