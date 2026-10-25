// @vitest-environment node
import { spawn } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import net from 'node:net';
import {
  MEDIA_UPLOAD_POLICIES,
  mediaUploadPolicy,
} from '@kontourai/station-contracts/walkthrough';
import { configureHttpReceive } from '@kontourai/station-shared/http-upload';
import type { ServerProviderDeps } from '@voltagent/core';
import { streamSSE } from 'hono/streaming';
import { afterEach, expect, it, vi } from 'vitest';
import { buildUiServerScript } from '../../../../packages/cli/src/commands/lifecycle.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { DIRECT_LISTENER_LINK } from '../../bootstrap/supervisor-link.js';
import { stationHonoServer } from '../voltagent-hono-runtime.js';

const makeHome = trackTempDirs();
const cleanups: Array<() => unknown> = [];
const nativeTimer = globalThis.setTimeout;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
function accelerateTotal() {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn, ms, ...args) =>
    nativeTimer(
      fn,
      ms !== undefined && ms >= 299_000 && ms <= 300_000 ? 150 : ms,
      ...args,
    )) as typeof setTimeout);
}
async function uiListener(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  unread = false,
) {
  const upstream = createServer(handler);
  configureHttpReceive(
    upstream,
    (method, path) => mediaUploadPolicy(method, path, MEDIA_UPLOAD_POLICIES),
    MEDIA_UPLOAD_POLICIES.walkthrough.totalMs,
  );
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  cleanups.push(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const script = buildUiServerScript({
    uiDir: makeHome('station-receive-ui-'),
    upstreamPort: (upstream.address() as net.AddressInfo).port,
    uiPort: 0,
    host: '127.0.0.1',
  });
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const nativeTimer=globalThis.setTimeout;
    globalThis.setTimeout=(fn,ms,...args)=>nativeTimer(fn,ms>=299000&&ms<=300000?150:ms,...args);
    ${script}
    ${
      unread
        ? `
      // The production proxy drains requests. Install the same unread fixture
      // on its generated listener without replacing its receive-policy listeners.
      const uiHandler=server.listeners('request').at(-1);
      server.removeListener('request',uiHandler);
      server.on('request',(req,res)=>req.url==='/api/unread-stream'?(${handler.toString()})(req,res):uiHandler(req,res));
    `
        : ''
    }
    server.on('listening',()=>console.log(server.address().port));
  `,
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        STATION_INTERNAL_API_TOKEN: 'test-receive-internal',
      },
    },
  );
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill('SIGTERM');
    await exited;
  });
  return await new Promise<number>((resolve, reject) => {
    let output = '',
      errors = '';
    const guard = nativeTimer(
      () => reject(new Error(`UI listener did not start: ${errors}`)),
      5000,
    );
    child.stderr.on('data', (b) => {
      errors += b.toString();
    });
    child.stdout.on('data', (b) => {
      output += b.toString();
      if (/^\d+\n/.test(output)) {
        clearTimeout(guard);
        resolve(Number(output.trim()));
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(guard);
      reject(new Error(`UI exited ${code}: ${errors}`));
    });
  });
}

it.each(['api', 'serialized-ui'] as const)(
  '%s keeps an unread completed POST body SSE response alive beyond the ordinary receive total',
  async (listener) => {
    let port: number;
    if (listener === 'api') {
      accelerateTotal();
      const provider = stationHonoServer(
        {
          port: 0,
          hostname: '127.0.0.1',
          configureFullApp: ({ app }) => {
            app.post('/api/unread-stream', (c) =>
              streamSSE(c, async (s) => {
                await s.writeSSE({ data: 'first' });
                await new Promise((r) => nativeTimer(r, 500));
                await s.writeSSE({ data: 'last' });
              }),
            );
          },
        },
        () => DIRECT_LISTENER_LINK,
      )({} as ServerProviderDeps);
      port = (await provider.start()).port;
      cleanups.push(() => provider.stop());
    } else {
      port = await uiListener((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: first\n\n');
        setTimeout(() => res.end('data: last\n\n'), 500);
      }, true);
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/unread-stream`, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    const result = await response
      .text()
      .catch((e: Error) => `stream failed: ${e.message}`);
    expect(response.status).toBe(200);
    expect(result).toContain('data: last');
  },
);

it.each(['api', 'serialized-ui'] as const)(
  '%s delivers a refusal body to a client still writing a large upload',
  async (listener) => {
    const path = '/api/projects/absent/walkthroughs/import';
    let port: number;
    if (listener === 'api') {
      const provider = stationHonoServer(
        {
          port: 0,
          hostname: '127.0.0.1',
          configureFullApp: ({ app }) => {
            app.post(path, (c) => {
              c.header('Connection', 'close');
              return c.json({ error: 'Project not found' }, 404);
            });
          },
        },
        () => DIRECT_LISTENER_LINK,
      )({} as ServerProviderDeps);
      port = (await provider.start()).port;
      cleanups.push(() => provider.stop());
    } else {
      port = await uiListener((_req, res) => {
        res.writeHead(404, {
          Connection: 'close',
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'Project not found' }));
      });
    }
    const total = 64 * 1024 * 1024;
    const result = await new Promise<{ reply: string; supplied: number }>(
      (resolve) => {
        const socket = net.connect({
          host: '127.0.0.1',
          port,
          allowHalfOpen: true,
        });
        let reply = '',
          supplied = 0;
        const done = () => {
          clearTimeout(guard);
          resolve({ reply, supplied });
          socket.destroy();
        };
        const guard = nativeTimer(done, 3000);
        socket.on('data', (b) => {
          reply += b.toString();
        });
        socket.on('end', done);
        socket.on('error', done);
        socket.on('close', done);
        socket.write(
          `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: ${total}\r\n\r\n`,
        );
        const chunk = Buffer.alloc(64 * 1024, 1);
        const pump = () => {
          while (supplied < total && !socket.destroyed) {
            supplied += chunk.length;
            if (!socket.write(chunk)) {
              socket.once('drain', pump);
              return;
            }
          }
        };
        pump();
      },
    );
    expect(result.reply).toMatch(/^HTTP\/1.1 404/);
    expect(result.reply).toMatch(/connection: close/i);
    expect(result.reply).toContain('{"error":"Project not found"}');
    expect(result.supplied).toBeLessThan(total);
  },
);
