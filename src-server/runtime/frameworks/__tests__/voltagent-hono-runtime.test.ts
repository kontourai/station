// @vitest-environment node
/**
 * Station's API server provider: the VoltAgent app, bound through the
 * listener link.
 */

import type { Server as HttpServer } from 'node:http';
import net from 'node:net';
import type { HttpBindings } from '@hono/node-server';
import type { ServerProviderDeps } from '@voltagent/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECT_LISTENER_LINK,
  type ListenerLink,
  type SupervisorChannelProcess,
  SupervisorLink,
} from '../../bootstrap/supervisor-link.js';
import { stationHonoServer } from '../voltagent-hono-runtime.js';

type HonoConfig = Parameters<typeof stationHonoServer>[0];

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The direct link, recording what the provider asked it to bind. */
function recordingLink() {
  const calls: Array<{ name: string; host?: string; server: net.Server }> = [];
  const link: ListenerLink = {
    supervised: false,
    async listen(name, server, address) {
      calls.push({ name, host: address.host, server });
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            if (server.listening) server.close(() => resolve());
            else resolve();
          }),
      );
      return DIRECT_LISTENER_LINK.listen(name, server, address);
    },
    upgraded() {},
  };
  return { link, calls };
}

function config(extra: Partial<HonoConfig> = {}): HonoConfig {
  return {
    port: 0,
    enableWebSocket: false,
    configureFullApp: ({ app }) => {
      app.get('/probe', (c) => c.text(new URL(c.req.url).host));
    },
    ...extra,
  } as HonoConfig;
}

const deps = {} as ServerProviderDeps;

/** A raw HTTP/1.0 request with no Host header. */
function hostlessGet(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let reply = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      reply += chunk;
    });
    socket.on('end', () => resolve(reply));
    socket.on('error', reject);
    socket.write('GET /probe HTTP/1.0\r\n\r\n');
  });
}

describe('stationHonoServer', () => {
  it('binds the api listener on all interfaces by default and answers a request without Host', async () => {
    const { link, calls } = recordingLink();
    const provider = stationHonoServer(config(), () => link)(deps);
    expect(provider.isRunning()).toBe(false);
    const { port } = await provider.start();
    expect(provider.isRunning()).toBe(true);
    const api = calls[0]!.server as HttpServer;
    expect(api.headersTimeout).toBeLessThanOrEqual(60_000);
    expect(calls.map(({ name, host }) => ({ name, host }))).toEqual([
      { name: 'api', host: '0.0.0.0' },
    ]);
    const reply = await hostlessGet(port);
    expect(reply).toMatch(/^HTTP\/1\.[01] 200/);
    expect(reply.endsWith('0.0.0.0')).toBe(true);
    await expect(provider.start()).rejects.toThrow(/already running/);
    await provider.stop();
    expect(provider.isRunning()).toBe(false);
  });

  it('binds the configured hostname', async () => {
    const { link, calls } = recordingLink();
    const provider = stationHonoServer(
      config({ hostname: '127.0.0.1' }),
      () => link,
    )(deps);
    await provider.start();
    expect(calls[0]?.host).toBe('127.0.0.1');
    await provider.stop();
  });

  it('propagates a bind failure and stays stopped', async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) =>
      taken.listen(0, '127.0.0.1', () => resolve()),
    );
    cleanups.push(
      () => new Promise<void>((resolve) => taken.close(() => resolve())),
    );
    const { port } = taken.address() as net.AddressInfo;
    const { link } = recordingLink();
    const provider = stationHonoServer(
      config({ port, hostname: '127.0.0.1' }),
      () => link,
    )(deps);
    await expect(provider.start()).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect(provider.isRunning()).toBe(false);
  });

  it('stops cleanly after a drain already stopped its listener', async () => {
    const { link, calls } = recordingLink();
    const provider = stationHonoServer(
      config({ hostname: '127.0.0.1' }),
      () => link,
    )(deps);
    await provider.start();
    const server = calls[0]?.server as net.Server;
    // What a supervisor drain does to the listener.
    net.Server.prototype.close.call(server);
    expect(server.listening).toBe(false);
    await expect(provider.stop()).resolves.toBeUndefined();
    expect(provider.isRunning()).toBe(false);
  });

  it('answers a Connection: Upgrade request through the app when a supervisor link tracks it', async () => {
    // A supervised link that has bound normally: it tracks the server for drains.
    const channel = {
      env: {},
      connected: true,
      send: () => true,
      on: () => undefined,
      exit: () => {},
    } as unknown as SupervisorChannelProcess;
    const supervised = new SupervisorLink({ process: channel, log: () => {} });
    const provider = stationHonoServer(
      config({
        hostname: '127.0.0.1',
        // The device toolchain proxy's guard (routes/device-toolchain.ts).
        configureFullApp: ({ app }) => {
          app.all('/hub/*', (c) =>
            c.req.header('upgrade') !== undefined
              ? c.json({ code: 'method-not-allowed' }, 405)
              : c.text('ok'),
          );
        },
      }),
      () => supervised,
    )(deps);
    const { port } = await provider.start();
    cleanups.push(() => provider.stop());
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      cleanups.push(() => socket.destroy());
      let text = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        text += chunk;
        if (text.includes('method-not-allowed')) resolve(text);
      });
      socket.on('error', reject);
      // A request Node handed to an absent upgrade handler is never answered.
      socket.setTimeout(5_000, () =>
        reject(new Error(`no response to the Upgrade request: ${text}`)),
      );
      socket.write(
        'GET /hub/api HTTP/1.1\r\nHost: x\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\n\r\n',
      );
    });
    expect(reply).toMatch(/^HTTP\/1\.1 405/);
  });
});

it('bodyless responses do not inherit upload receive-idle timeouts', async () => {
  const { link } = recordingLink();
  const provider = stationHonoServer(
    config({
      hostname: '127.0.0.1',
      configureFullApp: ({ app }) => {
        app.get('/receive-timeout', (c) =>
          c.text(String((c.env as HttpBindings).incoming.socket.timeout ?? 0)),
        );
      },
    }),
    () => link,
  )(deps);
  const { port } = await provider.start();
  cleanups.push(() => provider.stop());
  expect(
    await (await fetch(`http://127.0.0.1:${port}/receive-timeout`)).text(),
  ).toBe('0');
});

it.each([401, 413])(
  'ordinary %s response racing body end retains Node keep-alive close',
  async (status) => {
    const { link, calls } = recordingLink();
    const provider = stationHonoServer(
      config({
        hostname: '127.0.0.1',
        configureFullApp: ({ app }) => {
          app.post('/api/ordinary', (c) =>
            c.json({ refused: true }, status as 401),
          );
        },
      }),
      () => link,
    )(deps);
    const { port } = await provider.start();
    cleanups.push(() => provider.stop());
    const server = calls[0]!.server as HttpServer;
    server.keepAliveTimeout = 100;
    server.keepAliveTimeoutBuffer = 0;
    const closed = await new Promise<boolean>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      const guard = setTimeout(() => {
        resolve(false);
        socket.destroy();
      }, 700);
      socket.once('data', () => setTimeout(() => socket.write('B'), 20));
      socket.once('close', () => {
        clearTimeout(guard);
        resolve(true);
      });
      socket.once('error', reject);
      socket.write(
        'POST /api/ordinary HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nA',
      );
    });
    expect(closed, 'body end cleared the keep-alive timer').toBe(true);
  },
);
it('ordinary receive total and upload idle refresh survive several idle windows', async () => {
  const original = globalThis.setTimeout;
  const timers = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms: number,
      ...args: unknown[]
    ) =>
      original(
        fn,
        ms >= 299_000 && ms <= 300_000
          ? 120
          : ms === 60_000
            ? 150
            : ms === 7_200_000
              ? 700
              : ms,
        ...args,
      )) as typeof setTimeout);
  const { link } = recordingLink();
  const provider = stationHonoServer(
    config({
      hostname: '127.0.0.1',
      configureFullApp: ({ app }) => {
        app.post('*', async (c) => {
          await c.req.text();
          return c.text('complete');
        });
      },
    }),
    () => link,
  )(deps);
  try {
    const { port } = await provider.start();
    cleanups.push(() => provider.stop());
    for (const [path, expected] of [
      ['/api/ordinary', 408],
      ['/api/projects/a/walkthroughs/import', 200],
    ] as const) {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        let reply = '';
        const guard = original(() => {
          socket.destroy();
          reject(new Error('no receive answer'));
        }, 1500);
        socket.on('data', (b) => {
          reply += b.toString();
          if (reply.includes('\r\n\r\n')) {
            clearTimeout(guard);
            resolve(reply);
            socket.destroy();
          }
        });
        socket.on('error', reject);
        socket.write(
          `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: 6\r\n\r\nA`,
        );
        for (let i = 1; i <= 5; i++) {
          original(() => {
            if (!socket.destroyed) {
              if (i === 5) socket.end('B');
              else socket.write('B');
            }
          }, i * 80);
        }
      });
      expect(reply).toContain(`HTTP/1.1 ${expected}`);
    }
  } finally {
    timers.mockRestore();
    await provider.stop();
  }
});

it('ordinary receive total includes time already spent receiving headers', async () => {
  let now = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const nativeTimer = globalThis.setTimeout;
  const timer = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms: number,
      ...args: unknown[]
    ) =>
      nativeTimer(
        fn,
        ms === 300_000 ? 250 : ms,
        ...args,
      )) as typeof setTimeout);
  const { link, calls } = recordingLink();
  const provider = stationHonoServer(
    config({
      hostname: '127.0.0.1',
      configureFullApp: ({ app }) => {
        app.post('*', async (c) => {
          await c.req.text();
          return c.text('complete');
        });
      },
    }),
    () => link,
  )(deps);
  try {
    const { port } = await provider.start();
    const server = calls[0]!.server as HttpServer;
    const firstData = new Promise<void>((resolve) =>
      server.once('connection', (socket) =>
        socket.once('data', () => resolve()),
      ),
    );
    const socket = net.connect(port, '127.0.0.1');
    cleanups.push(() => socket.destroy());
    socket.write(
      'POST /api/ordinary HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n',
    );
    await firstData;
    now = 299_950;
    const started = performance.now();
    const reply = new Promise<string>((resolve, reject) => {
      const guard = nativeTimer(
        () => reject(new Error('no header-inclusive timeout')),
        1000,
      );
      socket.once('data', (bytes) => {
        clearTimeout(guard);
        resolve(bytes.toString());
      });
      socket.once('error', reject);
    });
    socket.write('\r\nA');
    expect(await reply).toContain('HTTP/1.1 408');
    expect(
      performance.now() - started,
      'headers must spend the same receive-total budget',
    ).toBeLessThan(180);
  } finally {
    timer.mockRestore();
    clock.mockRestore();
    await provider.stop();
  }
});
