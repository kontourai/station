/**
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs';
import {
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_INGRESS_IDENTITY_HEADER,
  INTERNAL_ORCHESTRATION_THREAD_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
  INTERNAL_PROXY_FORWARDED_HOST_HEADER,
  INTERNAL_PROXY_PEER_HEADER,
  INTERNAL_TENANT_HEADER,
} from '../../../src-server/utils/internal-api-token';
import {
  attestDevProxyRequest,
  DEV_PROXY_ATTESTATION_HEADERS,
  stationDevIdentity,
  stationDevProxy,
  stationDevServerAccess,
  stationDevWatchOptions,
} from '../../../vite.config';

function recorder() {
  const headers = new Map<string, string>();
  return {
    headers,
    removeHeader: (name: string) => void headers.delete(name),
    setHeader: (name: string, value: string) => void headers.set(name, value),
  };
}

describe('station dev-mode Vite proxy (#3254)', () => {
  test('is absent unless the lifecycle names the instance API port', () => {
    expect(stationDevProxy({})).toBeUndefined();
    expect(stationDevProxy({ STATION_DEV_API_PORT: '' })).toBeUndefined();
    expect(() => stationDevProxy({ STATION_DEV_API_PORT: '99999' })).toThrow(
      /TCP port/,
    );
    expect(() => stationDevProxy({ STATION_DEV_API_PORT: 'x' })).toThrow(
      /TCP port/,
    );
  });

  test('proxies exactly the paths the production UI listener forwards, to the instance port', () => {
    const proxy = stationDevProxy({ STATION_DEV_API_PORT: '47310' });
    expect(Object.keys(proxy ?? {}).sort()).toEqual(
      [
        '/.well-known',
        '/api',
        '/agents',
        '/acp',
        '/events',
        '/integrations',
        '/config',
        '/bedrock',
        '/monitoring',
        '/scheduler',
        '/notifications',
        '/tools',
        '/observability',
      ].sort(),
    );
    for (const entry of Object.values(proxy ?? {})) {
      expect(entry.target).toBe('http://127.0.0.1:47310');
      expect(entry.ws).toBe(true);
      expect(entry.changeOrigin).toBe(true);
    }
  });

  test('leaves browser navigations to the SPA but proxies API calls', () => {
    const entry = stationDevProxy({ STATION_DEV_API_PORT: '47310' })?.['/api'];
    const bypass = entry?.bypass as (req: object) => string | undefined;
    expect(
      bypass({
        method: 'GET',
        url: '/config',
        headers: { accept: 'text/html' },
      }),
    ).toBe('/config');
    expect(
      bypass({ method: 'GET', url: '/api/x', headers: { accept: '*/*' } }),
    ).toBeUndefined();
    expect(
      bypass({
        method: 'POST',
        url: '/config',
        headers: { accept: 'text/html' },
      }),
    ).toBeUndefined();
  });

  test('attests as the production listener does: remote caller, own token, no client-supplied attestation', () => {
    const out = recorder();
    for (const name of DEV_PROXY_ATTESTATION_HEADERS)
      out.headers.set(name, 'forged');
    attestDevProxyRequest(
      out,
      {
        headers: { host: '127.0.0.1:47320', 'tailscale-user-login': 'x' },
        socket: { remoteAddress: '::ffff:127.0.0.1' },
      },
      'per-boot-token',
    );
    expect(out.headers.get(INTERNAL_API_TOKEN_HEADER)).toBe('per-boot-token');
    expect(out.headers.get(INTERNAL_PROXY_CALLER_HEADER)).toBe('remote');
    expect(out.headers.get(INTERNAL_PROXY_PEER_HEADER)).toBe(
      '::ffff:127.0.0.1',
    );
    expect(out.headers.get(INTERNAL_PROXY_FORWARDED_HOST_HEADER)).toBe(
      '127.0.0.1:47320',
    );
    for (const forged of [
      INTERNAL_INGRESS_IDENTITY_HEADER,
      INTERNAL_TENANT_HEADER,
      INTERNAL_ORCHESTRATION_THREAD_HEADER,
    ]) {
      expect(out.headers.has(forged)).toBe(false);
    }
  });

  test('mirrored header names match the server contract', () => {
    expect([...DEV_PROXY_ATTESTATION_HEADERS].sort()).toEqual(
      [
        INTERNAL_API_TOKEN_HEADER,
        INTERNAL_PROXY_CALLER_HEADER,
        INTERNAL_INGRESS_IDENTITY_HEADER,
        INTERNAL_PROXY_PEER_HEADER,
        INTERNAL_PROXY_FORWARDED_HOST_HEADER,
        INTERNAL_TENANT_HEADER,
        INTERNAL_ORCHESTRATION_THREAD_HEADER,
      ].sort(),
    );
  });

  test('polling is opt-in through STATION_DEV_WATCH_POLL=1 only', () => {
    expect(stationDevWatchOptions({})).toBeUndefined();
    expect(
      stationDevWatchOptions({ STATION_DEV_WATCH_POLL: '0' }),
    ).toBeUndefined();
    expect(stationDevWatchOptions({ STATION_DEV_WATCH_POLL: '1' })).toEqual({
      usePolling: true,
      interval: 300,
    });
  });

  test('identity answer carries the boot the lifecycle launched', () => {
    expect(stationDevIdentity({})).toBeUndefined();
    expect(
      stationDevIdentity({
        STATION_DEV_API_PORT: '1',
        STATION_INSTANCE_ID: 'a',
        STATION_BUILD_SHA: 's',
        STATION_BOOT_ID: 'b',
      }),
    ).toEqual({ instanceId: 'a', sha: 's', bootId: 'b' });
  });
});

describe('station dev server file access (#3254 review)', () => {
  const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const configFile = join(repo, 'vite.config.ts');
  let server: ViteDevServer | undefined;
  const makeTempDir = trackTempDirs({ lifetime: 'file' });
  let origin = '';

  beforeAll(async () => {
    const cacheDir = makeTempDir('station-vite-access-');
    server = await createServer({
      configFile,
      logLevel: 'error',
      cacheDir,
      server: { port: 0, strictPort: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    origin = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  }, 120_000);

  test('turns CORS off and allows only the UI import roots', () => {
    const access = stationDevServerAccess(repo);
    expect(access.cors).toBe(false);
    expect(access.fs.strict).toBe(true);
    expect(access.fs.allow).toEqual(
      expect.arrayContaining([
        join(repo, 'src-ui'),
        join(repo, 'src-shared'),
        join(repo, 'packages', 'sdk', 'src'),
        join(repo, 'node_modules'),
      ]),
    );
    expect(access.fs.allow).not.toContain(repo);
    expect(access.fs.allow).not.toContain(join(repo, 'packages'));
    expect(server?.config.server.cors).toBe(false);
  });

  test('a page on another localhost port cannot read repo files', async () => {
    // package.json sits at the repo root, outside every allowed root.
    const target = join(repo, 'package.json');
    const response = await fetch(`${origin}/@fs${target}`, {
      headers: { Origin: 'http://localhost:9999' },
    });
    const body = await response.text();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    // Refused outright; an SPA-shell 200 does not count as a pass.
    expect(response.status).toBe(403);
    expect(body).not.toContain(readFileSync(target, 'utf8').slice(0, 200));
  });

  test('the UI shell is still served, without CORS headers', async () => {
    const response = await fetch(`${origin}/`, {
      headers: { Origin: 'http://localhost:9999', Accept: 'text/html' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
