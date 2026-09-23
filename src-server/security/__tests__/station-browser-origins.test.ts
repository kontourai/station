import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  createCredentialFreeOriginVerifier,
  resolveStationBrowserOrigins,
} from '../station-browser-origins.js';

describe('resolveStationBrowserOrigins', () => {
  it('combines configured origins, the server loopback origins, and the native shells', () => {
    expect(
      resolveStationBrowserOrigins({
        port: 4100,
        allowedOriginsEnv:
          ' http://127.0.0.1:4200 ,,https://station.example.test',
      }),
    ).toEqual([
      'http://127.0.0.1:4200',
      'https://station.example.test',
      'http://localhost:4100',
      'http://127.0.0.1:4100',
      'http://[::1]:4100',
      'tauri://localhost',
      'https://tauri.localhost',
      'http://tauri.localhost',
    ]);
  });

  it.each(['0.0.0.0', '::'])(
    'adds no host origin for the wildcard bind %s',
    (host) => {
      const origins = resolveStationBrowserOrigins({
        port: 4100,
        host,
        allowedOriginsEnv: '',
      });
      expect(origins).toHaveLength(6);
      for (const scheme of ['http', 'https']) {
        expect(origins).not.toContain(`${scheme}://${host}:4100`);
        expect(origins).not.toContain(`${scheme}://[${host}]:4100`);
      }
    },
  );

  it('adds http and https origins for a specific bound host', () => {
    expect(
      resolveStationBrowserOrigins({
        port: 4100,
        host: '192.168.1.5',
        allowedOriginsEnv: '',
      }),
    ).toEqual(
      expect.arrayContaining([
        'http://192.168.1.5:4100',
        'https://192.168.1.5:4100',
      ]),
    );
  });

  it('brackets an IPv6 bound host the way a browser Origin spells it', () => {
    const origins = resolveStationBrowserOrigins({
      port: 4100,
      host: 'fe80::1',
      allowedOriginsEnv: '',
    });
    expect(origins).toEqual(
      expect.arrayContaining([
        'http://[fe80::1]:4100',
        'https://[fe80::1]:4100',
      ]),
    );
    expect(origins).not.toContain('http://fe80::1:4100');
  });
});

describe('createCredentialFreeOriginVerifier', () => {
  function verify(
    options: Parameters<typeof createCredentialFreeOriginVerifier>[0],
    headers: IncomingMessage['headers'],
  ): Promise<[boolean, number | undefined, string | undefined]> {
    const verifier = createCredentialFreeOriginVerifier(options);
    const req = {
      headers,
      socket: { remoteAddress: '203.0.113.9' },
    } as unknown as IncomingMessage;
    return new Promise((resolve) =>
      verifier({ origin: '', secure: false, req }, (result, code, message) =>
        resolve([result, code, message]),
      ),
    );
  }

  it('refuses a remote peer with a foreign Origin when no credential is required', async () => {
    const onRejected = vi.fn();
    await expect(
      verify(
        {
          allowedOrigins: ['http://127.0.0.1:4200'],
          credentialRequired: false,
          classifyPeer: () => 'remote',
          onRejected,
        },
        { origin: 'https://evil.example' },
      ),
    ).resolves.toEqual([false, 403, 'origin_forbidden']);
    expect(onRejected).toHaveBeenCalledWith('remote');
  });

  it('defers a remote peer to the credential handshake when one is required', async () => {
    await expect(
      verify(
        {
          allowedOrigins: [],
          credentialRequired: true,
          classifyPeer: () => 'remote',
        },
        { origin: 'https://evil.example' },
      ),
    ).resolves.toEqual([true, undefined, undefined]);
  });
});
