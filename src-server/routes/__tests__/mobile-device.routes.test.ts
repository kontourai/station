import type { HttpBindings } from '@hono/node-server';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import { isRuntimeRequestPrincipalCurrent } from '../../security/runtime-request-security.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { createMobileDeviceRoutes } from '../mobile-device.js';

const capturePath =
  '/api/mobile-devices/hosts/local/devices/ios/6E8C08FA-3A81-4347-90B9-AD41B7FAE876/capture';
const inventoryPath = '/api/mobile-devices/hosts/local/devices';
function harness() {
  const credentials = new Map([
    ['operator', DEFAULT_GRANT_PAIRING_SCOPE],
    ['viewer', pairingScopePresetString('read-only')],
  ]);
  const security = {
    verifyCredential: (value: string) => credentials.has(value),
    authorizeCredential: (value: string) => credentials.has(value),
    resolveGrantedScope: (value: string) => credentials.get(value),
    allowedOrigins: [],
  };
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return this;
    },
    setLevel() {},
    getLevel() {
      return 'info' as const;
    },
  };
  const app = new Hono<{ Bindings: HttpBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: new EventBus(),
    security,
  } as Parameters<typeof configureRuntimeHttp>[0]);
  const host = {
    inventory: vi.fn(async () => ({
      hostId: 'local',
      state: 'ready' as const,
      observedAt: new Date().toISOString(),
      devices: [],
    })),
    capture: vi.fn(async () => ({
      captureId: 'capture',
      target: {
        hostId: 'local',
        platform: 'ios' as const,
        deviceId: 'selected',
      },
      capturedAt: new Date().toISOString(),
      width: 1,
      height: 1,
      mimeType: 'image/png' as const,
      pngBase64: 'private-frame',
    })),
  };
  app.route(
    '/api/mobile-devices',
    createMobileDeviceRoutes(host, {
      isRequestPrincipalCurrent: (request) =>
        isRuntimeRequestPrincipalCurrent(request, security),
    }),
  );
  const request = (path: string, credential?: string, body?: string) =>
    app.request(
      path,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body }),
      },
      {
        incoming: { socket: { remoteAddress: '100.96.12.7' } },
      } as HttpBindings,
    );
  return { credentials, host, request };
}

describe('mobile device routes through runtime authentication', () => {
  test('unauthenticated inventory is rejected before the helper is called', async () => {
    const h = harness();
    expect((await h.request(inventoryPath)).status).toBe(401);
    expect(h.host.inventory).not.toHaveBeenCalled();
  });
  test('read-only credentials can list metadata but cannot capture screens', async () => {
    const h = harness();
    expect((await h.request(inventoryPath, 'viewer')).status).toBe(200);
    expect((await h.request(capturePath, 'viewer', '{}')).status).toBe(403);
    expect(h.host.capture).not.toHaveBeenCalled();
  });
  test('authorized capture is not cached and has no raw proxy route', async () => {
    const h = harness();
    const response = await h.request(capturePath, 'operator', '{}');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(h.host.capture).toHaveBeenCalledWith({
      hostId: 'local',
      platform: 'ios',
      deviceId: '6E8C08FA-3A81-4347-90B9-AD41B7FAE876',
    });
    expect(
      (await h.request('/api/mobile-devices/exec', 'operator', '{}')).status,
    ).toBe(404);
  });
  test('scope revocation during capture suppresses the private frame', async () => {
    const h = harness();
    const original = h.host.capture.getMockImplementation()!;
    h.host.capture.mockImplementation(async () => {
      const result = await original();
      h.credentials.set('operator', pairingScopePresetString('read-only'));
      return result;
    });
    const response = await h.request(capturePath, 'operator', '{}');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('private-frame');
  });
  test('removing a credential during inventory suppresses its result', async () => {
    const h = harness();
    const original = h.host.inventory.getMockImplementation()!;
    h.host.inventory.mockImplementation(async () => {
      const result = await original();
      h.credentials.delete('viewer');
      return result;
    });
    expect((await h.request(inventoryPath, 'viewer')).status).toBe(403);
  });
  test.each(['{"url":"http://other-host"}', '[]', 'null', 'x'.repeat(1025)])(
    'rejects capture body instead of forwarding it',
    async (body) => {
      const h = harness();
      expect((await h.request(capturePath, 'operator', body)).status).toBe(400);
      expect(h.host.capture).not.toHaveBeenCalled();
    },
  );
});
