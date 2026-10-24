import { once } from 'node:events';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
} from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs';
import { buildUiServerScript } from '../commands/lifecycle';

// Execute the serialized production listener, including its standalone imports.
describe('built UI asset delivery', () => {
  const makeTempDir = trackTempDirs();
  let dir: string;
  let server: http.Server;
  let port: number;
  const content = Buffer.from(
    'export const station = "asset delivery";\n'.repeat(100),
  );
  const asset = '/assets/main-AbCd1234.js';
  beforeEach(async () => {
    dir = makeTempDir('station-ui-delivery-');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<head></head><body>Station</body>');
    writeFileSync(join(dir, asset), content);
    writeFileSync(join(dir, `${asset}.br`), brotliCompressSync(content));
    writeFileSync(join(dir, `${asset}.gz`), gzipSync(content));
    writeFileSync(join(dir, 'startup-theme.js'), content);
    const nodeRequire = createRequire(import.meta.url);
    runInNewContext(
      buildUiServerScript({
        uiDir: dir,
        uiPort: 0,
        upstreamPort: 1,
        host: '127.0.0.1',
        apiBaseOverride: 'http://127.0.0.1:52783',
      }),
      {
        process,
        require(name: string) {
          if (name !== 'http') return nodeRequire(name);
          return {
            ...http,
            createServer: (...args: Parameters<typeof http.createServer>) => {
              server = http.createServer(...args);
              return server;
            },
          };
        },
      },
    );
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing UI listener');
    port = address.port;
  });
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  const request = (
    url: string,
    headers: Record<string, string> = {},
    method = 'GET',
  ) =>
    new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: Buffer;
    }>((resolve, reject) => {
      const client = http.request(
        { host: '127.0.0.1', port, path: url, headers, method },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () =>
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      client.on('error', reject);
      client.end();
    });

  it('caches hashed assets immutably and revalidates a repeat load without transferring a body', async () => {
    const first = await request(asset);
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(first.body).toEqual(content);
    expect(first.headers.etag).toBeTruthy();
    const repeat = await request(asset, {
      'If-None-Match': first.headers.etag!,
    });
    expect(repeat.status).toBe(304);
    expect(repeat.body.length).toBe(0);
    const mutable = await request('/startup-theme.js');
    expect(mutable.headers['cache-control']).toBe('no-cache');
  });

  it.each([
    ['br, gzip', 'br'],
    ['gzip', 'gzip'],
    ['br;q=0.5, identity;q=1', undefined],
    ['br;q=0, gzip;q=0.8', 'gzip'],
    ['br;q=0.2, gzip;q=0.8', 'gzip'],
    ['*;q=0.5, br;q=0', 'gzip'],
    ['br;q=0, gzip;q=0', undefined],
    ['', undefined],
  ])(
    'negotiates %s and delivers decodable bytes (%s)',
    async (accept, encoding) => {
      const response = await request(asset, { 'Accept-Encoding': accept });
      expect(response.status).toBe(200);
      expect(response.headers['content-encoding']).toBe(encoding);
      expect(response.headers.vary).toBe('Accept-Encoding');
      expect(response.headers['content-type']).toBe('application/javascript');
      expect(Number(response.headers['content-length'])).toBe(
        response.body.length,
      );
      const decoded =
        encoding === 'br'
          ? brotliDecompressSync(response.body)
          : encoding === 'gzip'
            ? gunzipSync(response.body)
            : response.body;
      expect(decoded).toEqual(content);
      const repeat = await request(asset, {
        'Accept-Encoding': accept,
        'If-None-Match': response.headers.etag!,
      });
      expect(repeat.status).toBe(304);
      expect(repeat.body.length).toBe(0);
      const head = await request(asset, { 'Accept-Encoding': accept }, 'HEAD');
      expect(head.headers['content-length']).toBe(
        response.headers['content-length'],
      );
      expect(head.body.length).toBe(0);
    },
  );

  it('keeps HTML nonce-bound on conditional requests and never serves its compressed sidecar', async () => {
    writeFileSync(join(dir, 'index.html.br'), brotliCompressSync('STALE HTML'));
    const first = await request('/', { 'Accept-Encoding': 'br' });
    const second = await request('/', {
      'Accept-Encoding': 'br',
      'If-None-Match': '*',
    });
    expect(second.status).toBe(200);
    expect(second.headers['cache-control']).toBe('no-cache');
    expect(second.headers.etag).toBeUndefined();
    expect(second.headers['content-encoding']).toBeUndefined();
    expect(second.headers['content-security-policy']).not.toBe(
      first.headers['content-security-policy'],
    );
    expect(second.body.toString()).toContain('<script nonce=');
    expect(second.body.toString()).not.toContain('STALE HTML');
  });

  it('falls back safely when a sidecar is missing or escapes the UI root, and refuses unacceptable representations', async () => {
    rmSync(join(dir, `${asset}.br`));
    const outside = `${dir}-outside.br`;
    writeFileSync(outside, 'OUTSIDE SENTINEL');
    try {
      symlinkSync(outside, join(dir, `${asset}.br`));
      const fallback = await request(asset, { 'Accept-Encoding': 'br, gzip' });
      expect(fallback.headers['content-encoding']).toBe('gzip');
      expect(gunzipSync(fallback.body)).toEqual(content);
      const refused = await request(asset, {
        'Accept-Encoding': 'br, identity;q=0',
      });
      expect(refused.status).toBe(406);
      expect(refused.body.length).toBe(0);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});
