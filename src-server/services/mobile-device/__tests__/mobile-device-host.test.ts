import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  deviceHubEndpointFromToolchain,
  explicitDeviceHubEndpoint,
} from '../../devices/device-hub-endpoint.js';
import { createDeviceHubConnection } from '../../devices/toolchain/device-hub-connection.js';
import {
  LocalMobileDeviceHost,
  parseMobileDeviceHubOrigin,
} from '../mobile-device-host.js';

const ios = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
const target = { hostId: 'local', platform: 'ios' as const, deviceId: ios };
const device = {
  id: ios,
  name: 'Test iPhone',
  version: 'iOS 26.5',
  platform: 'ios',
  physical: false,
  booted: true,
};
const inventory = () => ({ simulators: [device], emulators: [], errors: [] });
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDWQAAAAASUVORK5CYII=',
  'base64',
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function fixtureFetch(rows: unknown = inventory()) {
  return vi.fn<typeof fetch>(async (_url, options) =>
    options?.method === 'POST'
      ? new Response(png, { headers: { 'content-type': 'image/png' } })
      : Response.json(rows),
  );
}

describe('mobile device host', () => {
  test.each([
    'http://localhost:4000',
    'http://127.1:4000',
    'http://2130706433:4000',
    'http://user@127.0.0.1:4000',
    'http://127.0.0.1:4000/path',
    'https://127.0.0.1:4000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3141',
    'http://127.0.0.1:99999',
  ])('refuses unapproved endpoint %s', (url) => {
    expect(parseMobileDeviceHubOrigin(url)).toBeUndefined();
  });
  test('missing configuration never contacts a helper', async () => {
    const fetch = fixtureFetch();
    expect(
      await new LocalMobileDeviceHost({ fetch }).inventory(),
    ).toMatchObject({
      state: 'unavailable',
      failure: 'not-configured',
      devices: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  test('captures the exact freshly discovered target and passes no caller credentials', async () => {
    const fetch = fixtureFetch();
    const host = new LocalMobileDeviceHost({
      endpoint: 'http://127.0.0.1:43871',
      fetch,
    });
    const result = await host.capture(target);
    expect(result).toMatchObject({
      target,
      width: 1,
      height: 1,
      pngBase64: png.toString('base64'),
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:43871/api/devices',
      `http://127.0.0.1:43871/vendor/serve-sim/api/screenshot?device=${ios}`,
    ]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: { accept: 'image/png' },
    });
  });
  test('selects Android by explicit emulator serial', async () => {
    const fetch = fixtureFetch({
      simulators: [],
      emulators: [
        {
          ...device,
          id: 'emulator-5584',
          platform: 'android',
          version: 'Android 16',
        },
      ],
    });
    const host = new LocalMobileDeviceHost({
      endpoint: 'http://127.0.0.1:43871',
      fetch,
    });
    await host.capture({
      hostId: 'local',
      platform: 'android',
      deviceId: 'emulator-5584',
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      'http://127.0.0.1:43871/vendor/serve-emu/api/screenshot?device=emulator-5584',
    );
  });
  test('ignores physical devices and refuses stale, stopped or foreign targets before capture', async () => {
    const fetch = fixtureFetch({
      ...inventory(),
      simulators: [{ ...device, physical: true }],
    });
    const host = new LocalMobileDeviceHost({
      endpoint: 'http://127.0.0.1:43871',
      fetch,
    });
    await expect(host.capture(target)).rejects.toMatchObject({
      code: 'device-unavailable',
    });
    await expect(
      host.capture({ ...target, hostId: 'another-host' }),
    ).rejects.toMatchObject({ code: 'invalid-target' });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(
      Response.json({
        ...inventory(),
        simulators: [{ ...device, booted: false }],
      }),
    );
    await expect(host.capture(target)).rejects.toMatchObject({
      code: 'device-unavailable',
    });
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(
      true,
    );
  });
  test('does not reuse a previously discovered device after it disappears', async () => {
    const fetch = fixtureFetch();
    const host = new LocalMobileDeviceHost({
      endpoint: 'http://127.0.0.1:43871',
      fetch,
    });
    expect((await host.inventory()).devices).toHaveLength(1);
    fetch.mockResolvedValue(Response.json({ simulators: [], emulators: [] }));
    await expect(host.capture(target)).rejects.toMatchObject({
      code: 'device-unavailable',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test.each([
    { ...inventory(), simulators: [device, device] },
    { ...inventory(), simulators: [{ ...device, id: '../exec' }] },
    { simulators: [], emulators: 'invalid' },
  ])('malformed inventories never become ready', async (rows) => {
    const host = new LocalMobileDeviceHost({
      endpoint: 'http://127.0.0.1:43871',
      fetch: fixtureFetch(rows),
    });
    expect(await host.inventory()).toMatchObject({
      state: 'unavailable',
      failure: 'invalid-response',
    });
  });
  test('retains working platforms without forwarding raw discovery errors', async () => {
    const host = new LocalMobileDeviceHost({
      endpoint: 'http://127.0.0.1:43871',
      fetch: fixtureFetch({
        ...inventory(),
        errors: [{ message: 'secret-path' }],
      }),
    });
    const result = await host.inventory();
    expect(result).toMatchObject({ state: 'partial' });
    expect(JSON.stringify(result)).not.toContain('secret-path');
  });
  test('bounds streamed data even without content-length', async () => {
    const endpoint = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(' '.repeat(260 * 1024));
      res.end();
    });
    expect(
      await new LocalMobileDeviceHost({ endpoint }).inventory(),
    ).toMatchObject({ failure: 'response-too-large' });
  });
  test('deadline includes a stalled response body', async () => {
    const endpoint = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
    });
    expect(
      await new LocalMobileDeviceHost({ endpoint, timeoutMs: 100 }).inventory(),
    ).toMatchObject({ failure: 'hub-unavailable' });
  });
  test('refuses a redirect before contacting its destination', async () => {
    let visits = 0;
    const destination = await listen((_req, res) => {
      visits++;
      res.end();
    });
    const endpoint = await listen((_req, res) => {
      res.writeHead(302, { location: destination });
      res.end();
    });
    expect(
      await new LocalMobileDeviceHost({ endpoint }).inventory(),
    ).toMatchObject({ failure: 'hub-unavailable' });
    expect(visits).toBe(0);
  });
  test('rejects non-image capture instead of returning a false screen', async () => {
    const fetch = fixtureFetch();
    fetch.mockImplementation(async (_url, init) =>
      init?.method === 'POST'
        ? new Response('not a PNG', {
            headers: { 'content-type': 'image/png' },
          })
        : Response.json(inventory()),
    );
    await expect(
      new LocalMobileDeviceHost({
        endpoint: 'http://127.0.0.1:43871',
        fetch,
      }).capture(target),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });
});

describe('read lanes (#1970)', () => {
  test('screenshots in flight never starve the inventory', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      if (options?.method === 'POST') {
        await gate;
        return new Response(png, { headers: { 'content-type': 'image/png' } });
      }
      return Response.json(inventory());
    });
    const host = new LocalMobileDeviceHost({
      endpoint: 'http://127.0.0.1:43871',
      fetch,
    });
    const shots = [host.screenshot(target), host.screenshot(target)];
    // The screenshot lane is full...
    await expect(host.screenshot(target)).rejects.toMatchObject({
      code: 'busy',
    });
    // ...and the inventory lane still answers.
    expect(await host.inventory()).toMatchObject({ state: 'ready' });
    release();
    await Promise.all(shots);
  });
});

// Lane E's managed-hub cases (#1970), carried across the integration: the
// host no longer takes a `managedHub` callback — it reaches the supervised
// hub only through `deviceHubEndpointFromToolchain`, which the runtime wires
// to `DeviceToolchainService`. Refusing a bad origin is now the supervisor's
// job (it builds the connection from a port it launched), so that case lives
// with the toolchain tests rather than here.
describe('mobile device host: the managed hub (#1970)', () => {
  test("reads from the managed hub, resolved per request, with each launch's guard secret", async () => {
    const fetch = fixtureFetch();
    const launches = [50001, 50002].map((port) =>
      createDeviceHubConnection({
        port,
        version: '0.10.1',
        secret: `secret-${port}`,
        fetch,
      }),
    );
    const ensureHub = vi.fn(async () => launches.shift());
    const host = new LocalMobileDeviceHost({
      hub: deviceHubEndpointFromToolchain(
        { ensureHub },
        explicitDeviceHubEndpoint(undefined),
      ),
    });
    expect((await host.inventory()).state).toBe('ready');
    expect((await host.inventory()).state).toBe('ready');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:50001/api/devices',
      'http://127.0.0.1:50002/api/devices',
    ]);
    expect(
      fetch.mock.calls.map(
        ([, init]) =>
          (init?.headers as Record<string, string> | undefined)?.[
            'x-station-hub-secret'
          ],
      ),
    ).toEqual(['secret-50001', 'secret-50002']);
  });

  test('an explicit endpoint is used when the toolchain defers to it', async () => {
    const fetch = fixtureFetch();
    // DeviceToolchainService.ensureHub answers undefined whenever
    // STATION_MOBILE_DEVICE_HUB_URL is configured.
    const host = new LocalMobileDeviceHost({
      hub: deviceHubEndpointFromToolchain(
        { ensureHub: async () => undefined },
        explicitDeviceHubEndpoint('http://127.0.0.1:43871', { fetch }),
      ),
    });
    await host.inventory();
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:43871/api/devices');
  });

  test('no running managed hub and no explicit endpoint reads as not-configured', async () => {
    const fetch = fixtureFetch();
    const host = new LocalMobileDeviceHost({
      fetch,
      hub: deviceHubEndpointFromToolchain(
        { ensureHub: async () => undefined },
        explicitDeviceHubEndpoint(undefined, { fetch }),
      ),
    });
    expect(await host.inventory()).toMatchObject({
      state: 'unavailable',
      failure: 'not-configured',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
