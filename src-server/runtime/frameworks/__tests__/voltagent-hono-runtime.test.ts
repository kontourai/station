// @vitest-environment node
/**
 * Station's API server provider: the VoltAgent app, bound through the
 * listener link.
 */

import type { Server as HttpServer } from 'node:http';
import net from 'node:net';
import type { HttpBindings } from '@hono/node-server';
import type { ServerProviderDeps } from '@voltagent/core';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(
      api.requestTimeout,
      'healthy long uploads use route deadlines rather than Node’s receive-total default',
    ).toBe(0);
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
