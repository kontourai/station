/**
 * The hub allowlists (#1970): what the server-side connection and the
 * client proxy may reach. Shell-exec routes are never reachable.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  createDeviceHubConnection,
  DeviceHubPathRefusedError,
  hubForwardSearch,
  hubRouteDevice,
  isHubHttpRequestAllowed,
  isHubWebSocketPathAllowed,
  matchHubClientRoute,
} from '../device-hub-connection.js';

describe('hub HTTP allowlist', () => {
  test.each([
    ['GET', '/api/devices'],
    ['GET', '/vendor/serve-sim/helper/ABC-123/stream.mjpeg'],
    ['GET', '/vendor/serve-sim/helper/ABC-123/config'],
    ['GET', '/vendor/serve-emu/api/devices'],
    ['GET', '/vendor/serve-emu/health'],
    ['HEAD', '/api/devices'],
    ['POST', '/vendor/serve-sim/api/screenshot'],
    ['POST', '/vendor/serve-emu/api/screenshot'],
    // Lane F: boot and power off (authorized per route by the proxy).
    ['POST', '/api/devices/boot'],
    ['POST', '/api/devices/shutdown'],
  ])('admits %s %s', (method, path) => {
    expect(isHubHttpRequestAllowed(method, path)).toBe(true);
  });

  test.each([
    // serve-sim's shell-exec surface, and its /api that discloses the token.
    ['GET', '/vendor/serve-sim/exec'],
    ['POST', '/vendor/serve-sim/exec'],
    ['GET', '/vendor/serve-sim/exec-ws'],
    ['GET', '/vendor/serve-sim/api'],
    // Device creation/removal and app installation.
    ['POST', '/api/devices/create'],
    ['POST', '/api/devices/remove'],
    ['POST', '/vendor/serve-emu/api/apps/install'],
    // The dashboard and anything unlisted.
    ['GET', '/'],
    ['GET', '/index.html'],
    // Reads are GET-only; only capture and tuning accept POST.
    ['POST', '/api/devices'],
    ['DELETE', '/vendor/serve-sim/api/screenshot'],
    // Stream tuning is PUT/PATCH on the hub and is not offered.
    ['POST', '/vendor/serve-emu/api/stream-settings'],
    ['POST', '/vendor/serve-emu/api/stream-mode'],
    // WebRTC offers, devtools and the helper spawn route.
    ['POST', '/vendor/serve-emu/api/webrtc/offer'],
    ['GET', '/vendor/serve-sim/devtools'],
    ['GET', '/vendor/serve-sim/'],
    // Server-only routes are not for clients.
    ['GET', '/readyz'],
    ['POST', '/vendor/serve-sim/grid/api/start'],
    // Traversal and encoding tricks.
    ['GET', '/vendor/serve-sim/helper/../exec'],
    ['GET', '/vendor/serve-sim/helper/a%2F..%2Fexec/config'],
    ['GET', '/vendor/serve-sim/helper/x/../../exec'],
    ['GET', '//api/devices'],
    ['GET', 'api/devices'],
  ])('refuses %s %s', (method, path) => {
    expect(isHubHttpRequestAllowed(method, path)).toBe(false);
  });
});

describe('hub WebSocket allowlist', () => {
  test('admits only the stream/input sockets', () => {
    expect(isHubWebSocketPathAllowed('/api/devices/ws')).toBe(true);
    expect(isHubWebSocketPathAllowed('/vendor/serve-sim/helper/ws')).toBe(true);
    expect(isHubWebSocketPathAllowed('/vendor/serve-emu/ws')).toBe(true);
    expect(isHubWebSocketPathAllowed('/vendor/serve-sim/exec-ws')).toBe(false);
    expect(isHubWebSocketPathAllowed('/api/argent-interactions/ws')).toBe(
      false,
    );
  });

  test('openWebSocket refuses a shell socket before connecting', () => {
    const connection = createDeviceHubConnection({
      port: 50_123,
      version: '0.10.1',
      secret: 's'.repeat(64),
    });
    expect(() => connection.openWebSocket('/vendor/serve-sim/exec-ws')).toThrow(
      DeviceHubPathRefusedError,
    );
  });
});

describe('ticket stripping', () => {
  test('credentials and Station routing never reach the hub', () => {
    expect(
      hubForwardSearch(
        new URLSearchParams(
          'device=emulator-5554&wsTicket=t1&token=t2&access_token=t3&credential=t4&auth=t5&projectSlug=alpha&hostId=local&TICKET=t6',
        ),
      ),
    ).toBe('?device=emulator-5554');
    expect(hubForwardSearch(new URLSearchParams('wsTicket=only'))).toBe('');
  });

  test('connection.request forwards allowlisted paths with tickets removed', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    const connection = createDeviceHubConnection({
      port: 50_123,
      version: '0.10.1',
      secret: 's'.repeat(64),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await connection.request(
      'GET',
      '/vendor/serve-sim/helper/A1/stream.mjpeg?wsTicket=secret&fps=10',
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:50123/vendor/serve-sim/helper/A1/stream.mjpeg?fps=10',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: { 'x-station-hub-secret': 's'.repeat(64) },
      }),
    );
    await expect(
      connection.request('POST', '/vendor/serve-sim/exec'),
    ).rejects.toBeInstanceOf(DeviceHubPathRefusedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('station audience', () => {
  test('server code may probe readiness and attach a stream helper; clients may not', () => {
    expect(isHubHttpRequestAllowed('GET', '/readyz', 'station')).toBe(true);
    expect(
      isHubHttpRequestAllowed(
        'POST',
        '/vendor/serve-sim/grid/api/start',
        'station',
      ),
    ).toBe(true);
    expect(isHubHttpRequestAllowed('GET', '/readyz')).toBe(false);
    expect(
      isHubHttpRequestAllowed('POST', '/vendor/serve-sim/exec', 'station'),
    ).toBe(false);
    expect(
      isHubHttpRequestAllowed('GET', '/vendor/serve-sim/api', 'station'),
    ).toBe(false);
  });
});

describe('client route table (D12)', () => {
  const device = (
    method: string,
    path: string,
    query = '',
    body?: { platform: 'ios' | 'android'; id: string },
  ) => {
    const route = matchHubClientRoute(method, path);
    return (
      route && {
        purpose: route.purpose,
        device: hubRouteDevice(route, path, new URLSearchParams(query), body),
      }
    );
  };

  test('fleet, health, stream-mode and accessibility routes name no device (operator only)', () => {
    for (const [method, path] of [
      ['GET', '/api/devices'],
      // serve-emu's device listing ignores ?device=: a fleet route.
      ['GET', '/vendor/serve-emu/api/devices'],
      ['GET', '/vendor/serve-emu/health'],
      ['GET', '/vendor/serve-emu/api/accessibility'],
      ['GET', '/vendor/serve-emu/api/stream-mode'],
    ] as const)
      expect(
        device(method, path, 'device=emulator-5554')?.device,
        path,
      ).toBeUndefined();
  });

  test('device-scoped routes name their device where the table says', () => {
    expect(
      device('GET', '/vendor/serve-sim/helper/ABC-1/stream.mjpeg'),
    ).toEqual({
      purpose: 'view',
      device: { platform: 'ios', deviceId: 'ABC-1' },
    });
    expect(
      device(
        'GET',
        '/vendor/serve-emu/api/stream-settings',
        'device=emulator-5554&device=emulator-9',
      ),
    ).toEqual({
      purpose: 'view',
      device: { platform: 'android', deviceId: 'emulator-5554' },
    });
    expect(
      device('POST', '/vendor/serve-sim/api/screenshot', 'device=ABC-1'),
    ).toEqual({
      purpose: 'drive',
      device: { platform: 'ios', deviceId: 'ABC-1' },
    });
    expect(
      device('POST', '/api/devices/boot', '', {
        platform: 'android',
        id: 'Pixel_9',
      }),
    ).toEqual({
      purpose: 'drive',
      device: { platform: 'android', deviceId: 'Pixel_9' },
    });
    expect(device('POST', '/api/devices/shutdown')?.purpose).toBe('operator');
  });

  test('side-effecting reads are drive, not view', () => {
    expect(device('GET', '/vendor/serve-emu/api/stream-mode')?.purpose).toBe(
      'drive',
    );
  });
});
