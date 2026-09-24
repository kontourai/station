import { describe, expect, test, vi } from 'vitest';
import {
  DeviceHubPathRefused,
  deviceHubEndpointFromToolchain,
  explicitDeviceHubEndpoint,
  explicitHubConnection,
} from '../device-hub-endpoint.js';

const ORIGIN = 'http://127.0.0.1:43871';

describe('the explicit hub connection allowlist', () => {
  const fetch = vi.fn(async () => new Response('{}'));
  const opened: string[] = [];
  const connection = explicitHubConnection(ORIGIN, {
    fetch: fetch as never,
    openSocket: (url) => {
      opened.push(url);
      return {} as never;
    },
  });

  test.each([
    ['GET', '/api/devices'],
    ['GET', '/vendor/serve-sim/helper/ABC-123/stream.mjpeg'],
    ['POST', '/vendor/serve-emu/api/screenshot?device=emulator-5554'],
    ['POST', '/api/devices/boot'],
    ['POST', '/api/devices/shutdown'],
    ['POST', '/vendor/serve-sim/grid/api/start'],
    ['POST', '/vendor/serve-sim/grid/api/shutdown'],
  ] as const)('admits %s %s', async (method, path) => {
    await connection.request(method, path);
    expect(fetch).toHaveBeenLastCalledWith(
      `${ORIGIN}${path}`,
      expect.objectContaining({ method, redirect: 'error' }),
    );
  });

  test.each([
    ['POST', '/vendor/serve-sim/exec'],
    ['GET', '/vendor/serve-sim/exec-ws'],
    ['GET', '/vendor/serve-sim/api'],
    ['POST', '/api/devices/create'],
    ['POST', '/api/devices/remove'],
    ['POST', '/api/devices'],
    ['GET', '/vendor/serve-sim/helper/../exec'],
    ['GET', '/vendor/serve-sim/helper/%2e%2e/stream.mjpeg'],
    ['GET', '/'],
  ] as const)('refuses %s %s without a request', async (method, path) => {
    fetch.mockClear();
    await expect(connection.request(method, path)).rejects.toBeInstanceOf(
      DeviceHubPathRefused,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test('opens only the three hub sockets', () => {
    connection.openWebSocket('/vendor/serve-sim/helper/ws?device=X');
    connection.openWebSocket(
      '/vendor/serve-emu/ws?device=emulator-5554&video=0',
    );
    expect(opened).toEqual([
      'ws://127.0.0.1:43871/vendor/serve-sim/helper/ws?device=X',
      'ws://127.0.0.1:43871/vendor/serve-emu/ws?device=emulator-5554&video=0',
    ]);
    expect(() => connection.openWebSocket('/vendor/serve-sim/exec-ws')).toThrow(
      DeviceHubPathRefused,
    );
  });
});

describe('explicit configuration', () => {
  test('missing and refused configuration are typed', async () => {
    expect(await explicitDeviceHubEndpoint(undefined).connect()).toEqual({
      ok: false,
      failure: 'not-configured',
    });
    expect(
      await explicitDeviceHubEndpoint('http://localhost:4000').connect(),
    ).toEqual({ ok: false, failure: 'invalid-configuration' });
  });
});

describe('the toolchain adapter', () => {
  function supervised() {
    const exits = new Set<(reason: string) => void>();
    return {
      baseUrl: 'http://127.0.0.1:55001',
      ready: true,
      request: vi.fn(),
      openWebSocket: vi.fn(),
      onExit(listener: (reason: string) => void) {
        exits.add(listener);
        return () => exits.delete(listener);
      },
      exit(reason: string) {
        for (const listener of exits) listener(reason);
      },
    };
  }

  test('prefers the supervised hub and forwards its exit', async () => {
    const hub = supervised();
    const endpoint = deviceHubEndpointFromToolchain(
      { ensureHub: async () => hub as never },
      explicitDeviceHubEndpoint(undefined),
    );
    const onExit = vi.fn();
    endpoint.onExit(onExit);
    const result = await endpoint.connect();
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.connection).toBe(hub);
    hub.exit('crashed');
    expect(onExit).toHaveBeenCalledWith('crashed');
  });

  test('falls back to the explicit hub when the toolchain has none', async () => {
    const endpoint = deviceHubEndpointFromToolchain(
      { ensureHub: async () => undefined },
      explicitDeviceHubEndpoint(ORIGIN),
    );
    const result = await endpoint.connect();
    expect(result.ok && result.connection.baseUrl).toBe(ORIGIN);
  });

  test('a toolchain failure is hub-unavailable, not a throw', async () => {
    const endpoint = deviceHubEndpointFromToolchain(
      {
        ensureHub: async () => {
          throw new Error('not consented');
        },
      },
      explicitDeviceHubEndpoint(ORIGIN),
    );
    expect(await endpoint.connect()).toEqual({
      ok: false,
      failure: 'hub-unavailable',
    });
  });
});
