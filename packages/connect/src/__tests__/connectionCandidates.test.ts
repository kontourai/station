import { afterEach, describe, expect, test } from 'vitest';
import {
  connectionCandidateProviderCount,
  discoverConnectionCandidates,
  registerConnectionCandidateProvider,
} from '../core/connectionCandidates';
import type { ConnectionCandidateProvider } from '../core/types';

const unregister: Array<() => void> = [];

afterEach(() => {
  while (unregister.length > 0) unregister.pop()?.();
});

function register(provider: ConnectionCandidateProvider): void {
  unregister.push(registerConnectionCandidateProvider(provider));
}

describe('connection candidate providers', () => {
  test('rejects unsafe and duplicate provider identifiers', () => {
    expect(() =>
      registerConnectionCandidateProvider({
        id: '../unsafe',
        discover: async () => [],
      }),
    ).toThrow(/safe, bounded identifier/);
    register({ id: 'native.tailnet', discover: async () => [] });
    expect(() =>
      registerConnectionCandidateProvider({
        id: 'native.tailnet',
        discover: async () => [],
      }),
    ).toThrow(/already registered/);
  });

  test('bounds provider registration and per-provider output', async () => {
    for (let index = 0; index < 16; index += 1) {
      register({
        id: `native.provider-${index}`,
        discover: async () =>
          Array.from({ length: 100 }, (_, candidateIndex) => ({
            candidateVersion: 1 as const,
            name: `Station ${candidateIndex}`,
            url: `https://station-${index}-${candidateIndex}.example.ts.net`,
            source: 'tailnet' as const,
            discoveredAt: Date.now(),
          })),
      });
    }
    expect(() =>
      registerConnectionCandidateProvider({
        id: 'native.provider-overflow',
        discover: async () => [],
      }),
    ).toThrow(/capacity reached/);

    const result = await discoverConnectionCandidates();
    expect(result.providers).toHaveLength(16);
    expect(result.candidates).toHaveLength(256);
    expect(
      result.candidates.some((candidate) => candidate.name === 'Station 64'),
    ).toBe(false);
  });

  test('normalizes, ranks, and deduplicates secret-free endpoint hints', async () => {
    const discoveredAt = Date.now();
    register({
      id: 'native.lan',
      discover: async () => [
        {
          candidateVersion: 1,
          name: 'LAN Station',
          url: 'https://station.local:3141/path?ignored=yes',
          source: 'lan-dns-sd',
          discoveredAt,
        },
        {
          candidateVersion: 1,
          name: 'Credential-shaped URL',
          url: 'https://user:secret@station.local:3141',
          source: 'lan-dns-sd',
          discoveredAt,
        },
      ],
    });
    register({
      id: 'native.tailnet',
      discover: async () => [
        {
          candidateVersion: 1,
          name: 'Tailnet Station',
          url: 'https://station.local:3141',
          source: 'tailnet',
          discoveredAt: discoveredAt + 1,
        },
        {
          candidateVersion: 1,
          name: 'Remote Station',
          url: 'https://remote.example.ts.net',
          source: 'tailnet',
          discoveredAt,
        },
      ],
    });

    const result = await discoverConnectionCandidates();

    expect(connectionCandidateProviderCount()).toBe(2);
    expect(result.providers).toEqual([
      { providerId: 'native.lan', status: 'available' },
      { providerId: 'native.tailnet', status: 'available' },
    ]);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        name: 'Tailnet Station',
        url: 'https://station.local:3141',
        source: 'tailnet',
        providerId: 'native.tailnet',
      }),
      expect.objectContaining({
        name: 'Remote Station',
        url: 'https://remote.example.ts.net',
        source: 'tailnet',
      }),
    ]);
  });

  test('isolates provider failures without discarding healthy candidates', async () => {
    register({
      id: 'native.failed',
      discover: async () => {
        throw new Error('adapter unavailable');
      },
    });
    register({
      id: 'native.desktop',
      discover: async () => [
        {
          candidateVersion: 1,
          name: 'Desktop Station',
          url: 'http://127.0.0.1:3141',
          source: 'desktop-host',
          discoveredAt: Date.now(),
        },
      ],
    });

    const result = await discoverConnectionCandidates();

    expect(result.providers).toEqual([
      { providerId: 'native.failed', status: 'failed' },
      { providerId: 'native.desktop', status: 'available' },
    ]);
    expect(result.candidates).toHaveLength(1);
  });

  test('bounds providers that ignore the cancellation signal', async () => {
    register({
      id: 'native.stuck',
      discover: () => new Promise(() => undefined),
    });

    const result = await discoverConnectionCandidates({ timeoutMs: 5 });

    expect(result).toEqual({
      candidates: [],
      providers: [{ providerId: 'native.stuck', status: 'failed' }],
    });
  });
});
