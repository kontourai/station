import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, request } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createDevHttpServer,
  getOpenFileMime,
  isAllowedOpenFilePath,
  parseToolCallResponse,
} from '../dev/http.js';
import type { DevFetchDependencies } from '../dev/security.js';
import { MAX_JSON_BODY_BYTES } from '../dev/security.js';

async function requestServer(
  options: {
    body?: string;
    fetchDependencies?: DevFetchDependencies;
    headers?:
      | Record<string, string>
      | ((port: number) => Record<string, string>);
    manager?: any;
    method?: string;
    path?: string | ((cwd: string, pluginsDir: string) => string);
    setup?: (cwd: string, pluginsDir: string) => void;
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), 'station-dev-http-'));
  const pluginsDir = mkdtempSync(join(tmpdir(), 'station-dev-plugins-'));
  writeFileSync(join(cwd, 'inside.txt'), 'inside');
  options.setup?.(cwd, pluginsDir);
  const { server } = createDevHttpServer({
    cwd,
    pluginsDir,
    bundleJs: join(cwd, 'bundle.js'),
    bundleCss: join(cwd, 'bundle.css'),
    bundleCssFallback: join(cwd, 'bundle-fallback.css'),
    reactBundle: join(cwd, 'react.js'),
    sdkBundle: join(cwd, 'sdk.js'),
    getHtml: () => '<html></html>',
    getMcpManager: () => options.manager || null,
    fetchDependencies: options.fetchDependencies,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing address');
  const path =
    typeof options.path === 'function'
      ? options.path(cwd, pluginsDir)
      : options.path;
  const headers =
    typeof options.headers === 'function'
      ? options.headers(address.port)
      : options.headers;
  const result = await new Promise<{
    allow?: string;
    body: string;
    cors?: string;
    status: number;
  }>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: path || '/api/open-file?path=inside.txt',
        headers,
        method: options.method,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({
            allow: res.headers.allow,
            body,
            cors: res.headers['access-control-allow-origin'],
            status: res.statusCode || 0,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return result;
}

describe('dev http helpers', () => {
  test('parseToolCallResponse unwraps nested MCP text payloads', () => {
    expect(
      parseToolCallResponse({
        content: [
          {
            text: JSON.stringify({
              content: [{ text: JSON.stringify({ ok: true, count: 2 }) }],
            }),
          },
        ],
      }),
    ).toEqual({ ok: true, count: 2 });
  });

  test('getOpenFileMime maps known extensions and falls back to plain text', () => {
    expect(getOpenFileMime('notes.md')).toBe('text/markdown');
    expect(getOpenFileMime('config.json')).toBe('application/json');
    expect(getOpenFileMime('other.xyz')).toBe('text/plain');
  });

  test('isAllowedOpenFilePath only allows cwd and plugin tree access', () => {
    expect(
      isAllowedOpenFilePath('/repo/src/file.ts', '/repo', '/plugins'),
    ).toBe(true);
    expect(
      isAllowedOpenFilePath('/plugins/demo/plugin.json', '/repo', '/plugins'),
    ).toBe(true);
    expect(isAllowedOpenFilePath('/etc/passwd', '/repo', '/plugins')).toBe(
      false,
    );
    expect(
      isAllowedOpenFilePath('/repo-secret/token', '/repo', '/plugins'),
    ).toBe(false);
  });

  test('rejects a hostile Host before reading privileged files', async () => {
    const response = await requestServer({
      headers: { Host: 'attacker.example' },
    });
    expect(response).toMatchObject({ body: 'invalid_host', status: 403 });
  });

  test('rejects a hostile Origin before reading privileged files', async () => {
    const response = await requestServer({
      headers: (port) => ({
        Host: `127.0.0.1:${port}`,
        Origin: 'https://attacker.example',
      }),
    });
    expect(response).toMatchObject({ body: 'invalid_origin', status: 403 });
  });

  test.each(['cross-site', 'same-site', 'unknown', '', 'Same-Origin'])(
    'rejects %s fetch metadata',
    async (site) => {
      const response = await requestServer({
        headers: (port) => ({
          Host: `127.0.0.1:${port}`,
          'Sec-Fetch-Site': site,
        }),
      });
      expect(response).toMatchObject({
        body: 'cross_site_request',
        status: 403,
      });
    },
  );

  test.each(['none', 'same-origin'])(
    'allows %s fetch metadata',
    async (site) => {
      const response = await requestServer({
        headers: (port) => ({
          Host: `127.0.0.1:${port}`,
          'Sec-Fetch-Site': site,
        }),
      });
      expect(response.status).toBe(200);
    },
  );

  test('permits exact same-origin access and emits exact preflight CORS', async () => {
    const allowed = await requestServer({
      headers: (port) => ({
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
      }),
    });
    expect(allowed).toMatchObject({ body: 'inside', status: 200 });
    const preflight = await requestServer({
      method: 'OPTIONS',
      headers: (port) => ({
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
      }),
    });
    expect(preflight.status).toBe(204);
    expect(preflight.cors).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('rejects traversal, sibling-prefix, directory, and symlink escapes', async () => {
    const traversal = await requestServer({
      path: '/api/open-file?path=../outside.txt',
    });
    expect(traversal.status).toBe(404);
    const encoded = await requestServer({
      path: '/api/open-file?path=%2e%2e%2foutside.txt',
    });
    expect(encoded.status).toBe(404);
    const directory = await requestServer({ path: '/api/open-file?path=.' });
    expect(directory.status).toBe(404);
    const symlink = await requestServer({
      setup: (cwd) => symlinkSync('/etc/hosts', join(cwd, 'escape')),
      path: '/api/open-file?path=escape',
    });
    expect(symlink.status).toBe(404);
    let siblingFile = '';
    const sibling = await requestServer({
      setup: (cwd) => {
        const siblingDir = `${cwd}-secret`;
        mkdirSync(siblingDir);
        siblingFile = join(siblingDir, 'token.txt');
        writeFileSync(siblingFile, 'secret', { flag: 'w' });
      },
      path: () => `/api/open-file?path=${encodeURIComponent(siblingFile)}`,
    });
    expect(sibling.status).toBe(404);
    const outside = await requestServer({
      path: `/api/open-file?path=${encodeURIComponent('/etc/hosts')}`,
    });
    expect(outside.status).toBe(404);
  });

  test('reads a real file under the installed-plugin root', async () => {
    const response = await requestServer({
      setup: (_cwd, pluginsDir) =>
        writeFileSync(join(pluginsDir, 'installed.json'), '{"ok":true}'),
      path: (_cwd, pluginsDir) =>
        `/api/open-file?path=${encodeURIComponent(join(pluginsDir, 'installed.json'))}`,
    });
    expect(response).toMatchObject({ status: 200, body: '{"ok":true}' });
  });

  test('gates MCP before manager invocation and allows the intended origin', async () => {
    let calls = 0;
    const manager = {
      listTools: () => {
        calls += 1;
        return [{ name: 'ok' }];
      },
    };
    const blocked = await requestServer({
      manager,
      path: '/agents/demo/tools',
      headers: { Host: 'evil.example' },
    });
    expect(blocked.status).toBe(403);
    expect(calls).toBe(0);
    const allowed = await requestServer({
      manager,
      path: '/agents/demo/tools',
    });
    expect(allowed.status).toBe(200);
    expect(calls).toBe(1);
  });

  test('gates MCP execution before the manager is invoked', async () => {
    let calls = 0;
    const manager = {
      callTool: async () => {
        calls += 1;
        return { content: [] };
      },
    };
    const blocked = await requestServer({
      body: '{}',
      headers: { Host: 'evil.example' },
      manager,
      method: 'POST',
      path: '/agents/demo/tools/run',
    });
    expect(blocked.status).toBe(403);
    expect(calls).toBe(0);
    const allowed = await requestServer({
      body: '{"value":1}',
      manager,
      method: 'POST',
      path: '/agents/demo/tools/run',
    });
    expect(allowed.status).toBe(200);
    expect(calls).toBe(1);
  });

  test('blocks fetch before DNS/transport invocation', async () => {
    let lookups = 0;
    const dependencies = {
      lookup: async () => {
        lookups += 1;
        return [{ address: '8.8.8.8', family: 4 as const }];
      },
      httpRequest: (() => {
        throw new Error('must not reach transport');
      }) as DevFetchDependencies['httpRequest'],
      httpsRequest: (() => {
        throw new Error('must not reach transport');
      }) as DevFetchDependencies['httpsRequest'],
    };
    const response = await requestServer({
      body: '{"url":"http://public.example"}',
      fetchDependencies: dependencies,
      headers: { Host: 'evil.example' },
      method: 'POST',
      path: '/api/plugins/fetch',
    });
    expect(response.status).toBe(403);
    expect(lookups).toBe(0);
  });

  test('returns bounded JSON and explicit route errors', async () => {
    const malformed = await requestServer({
      path: '/agents/demo/tools/run',
      method: 'POST',
      body: '{',
    });
    expect(malformed).toMatchObject({ status: 400 });
    expect(JSON.parse(malformed.body).error).toBe('invalid_json');
    const oversized = await requestServer({
      path: '/agents/demo/tools/run',
      method: 'POST',
      body: `{"x":"${'x'.repeat(1_048_576)}"}`,
    });
    expect(oversized.status).toBe(413);
    const wrongMethod = await requestServer({
      path: '/api/reload',
      method: 'POST',
    });
    expect(wrongMethod).toMatchObject({ allow: 'GET', status: 405 });
    const unknown = await requestServer({ path: '/api/unknown' });
    expect(unknown.status).toBe(404);
  });

  test('returns one 413 and closes an unfinished oversized upload after parser teardown', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'station-dev-http-body-'));
    const pluginsDir = mkdtempSync(join(tmpdir(), 'station-dev-plugins-body-'));
    let toolCalls = 0;
    const { close, server } = createDevHttpServer({
      cwd,
      pluginsDir,
      bundleJs: join(cwd, 'bundle.js'),
      bundleCss: join(cwd, 'bundle.css'),
      bundleCssFallback: join(cwd, 'bundle-fallback.css'),
      reactBundle: join(cwd, 'react.js'),
      sdkBundle: join(cwd, 'sdk.js'),
      getHtml: () => '<html></html>',
      getMcpManager: () =>
        ({
          callTool: async () => {
            toolCalls += 1;
            return { content: [] };
          },
        }) as any,
    });
    let incoming: IncomingMessage | undefined;
    server.once('request', (req) => {
      incoming = req;
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');

    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({
        host: '127.0.0.1',
        port: address.port,
      });
      let raw = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => (raw += chunk));
      socket.on('error', reject);
      socket.on('close', () => resolve(raw));
      socket.on('connect', () => {
        socket.write(
          `POST /agents/demo/tools/run HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nContent-Type: application/json\r\nContent-Length: ${MAX_JSON_BODY_BYTES + 10_000}\r\n\r\n`,
        );
        socket.write(Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 97));
      });
    });

    expect(rawResponse.match(/HTTP\/1\.1 413/g)).toHaveLength(1);
    expect(rawResponse).toContain('Connection: close');
    expect(rawResponse).toContain('body_too_large');
    expect(toolCalls).toBe(0);
    expect(incoming?.destroyed).toBe(true);
    expect(incoming?.listenerCount('data')).toBe(0);
    const retainedParserListeners = ['data', 'end', 'error', 'aborted']
      .flatMap((event) => incoming?.listeners(event) || [])
      .filter((listener) =>
        ['onData', 'onEnd', 'onError'].includes(listener.name),
      );
    expect(retainedParserListeners).toEqual([]);
    await close();
  });

  test('caps reload streams at 32 and releases closed clients', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'station-dev-http-sse-'));
    const pluginsDir = mkdtempSync(join(tmpdir(), 'station-dev-plugins-sse-'));
    const { close, reloadClients, server } = createDevHttpServer({
      cwd,
      pluginsDir,
      bundleJs: join(cwd, 'bundle.js'),
      bundleCss: join(cwd, 'bundle.css'),
      bundleCssFallback: join(cwd, 'bundle-fallback.css'),
      reactBundle: join(cwd, 'react.js'),
      sdkBundle: join(cwd, 'sdk.js'),
      getHtml: () => '<html></html>',
      getMcpManager: () => null,
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const clients = await Promise.all(
      Array.from(
        { length: 32 },
        () =>
          new Promise<ReturnType<typeof request>>((resolve, reject) => {
            const client = request(
              {
                hostname: '127.0.0.1',
                port: address.port,
                path: '/api/reload',
              },
              (response) => {
                response.once('data', () => resolve(client));
              },
            );
            client.on('error', reject);
            client.end();
          }),
      ),
    );
    expect(reloadClients.size).toBe(32);
    const overflow = await new Promise<{ retry?: string; status: number }>(
      (resolve, reject) => {
        const client = request(
          { hostname: '127.0.0.1', port: address.port, path: '/api/reload' },
          (response) => {
            response.resume();
            response.on('end', () =>
              resolve({
                retry: response.headers['retry-after'],
                status: response.statusCode || 0,
              }),
            );
          },
        );
        client.on('error', reject);
        client.end();
      },
    );
    expect(overflow).toEqual({ retry: '1', status: 503 });
    for (const client of clients) client.destroy();
    for (
      let attempt = 0;
      attempt < 20 && reloadClients.size > 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(reloadClients.size).toBe(0);
    await close();
  });

  test('explicit shutdown ends live SSE clients before closing the server', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'station-dev-http-close-'));
    const pluginsDir = mkdtempSync(
      join(tmpdir(), 'station-dev-plugins-close-'),
    );
    const { close, reloadClients, server } = createDevHttpServer({
      cwd,
      pluginsDir,
      bundleJs: join(cwd, 'bundle.js'),
      bundleCss: join(cwd, 'bundle.css'),
      bundleCssFallback: join(cwd, 'bundle-fallback.css'),
      reactBundle: join(cwd, 'react.js'),
      sdkBundle: join(cwd, 'sdk.js'),
      getHtml: () => '<html></html>',
      getMcpManager: () => null,
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    const ended = new Promise<void>((resolve, reject) => {
      const client = request(
        { hostname: '127.0.0.1', port: address.port, path: '/api/reload' },
        (response) => {
          response.resume();
          response.once('end', resolve);
        },
      );
      client.on('error', reject);
      client.end();
    });
    for (
      let attempt = 0;
      attempt < 20 && reloadClients.size === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(reloadClients.size).toBe(1);
    await close();
    await ended;
    expect(reloadClients.size).toBe(0);
    expect(server.listening).toBe(false);
  });
});
