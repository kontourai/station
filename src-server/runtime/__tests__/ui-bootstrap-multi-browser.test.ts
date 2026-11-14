import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import {
  PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH,
  PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { DevicePairingService } from '../../services/ssh/device-pairing-service.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';
import { configureDevicePairingPublicRoutes } from '../routes/runtime-routes.js';

// Two browsers (a desktop and a phone, or the UI origin and the tailnet
// origin) each redeem their own `station open --print` link. Each link pairs
// the browser that opens it; neither redemption may end the other browser's
// session. Every request runs through the real bootstrap routes and the real
// credential middleware, from ONE socket address: the UI proxy and Tailscale
// Serve both reach the server from loopback, so the auth-failure budget is
// shared by every browser behind them.

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

const makeTempDir = trackTempDirs();
const UI_ORIGIN = 'https://station.example.test';
const TAILNET_ORIGIN = 'https://station.tailnet.example.test';
const SHARED_PEER = '127.0.0.1';
const MINT_PEER = '127.0.0.9';

async function createHarness() {
  const homeDir = makeTempDir('station-ui-bootstrap-multi-browser-');
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const secretPath = join(homeDir, 'runtime', 'local-grant.secret');
  const pairing = await DevicePairingService.create({
    homeDir,
    environmentId: '11111111-1111-4111-8111-111111111111',
  });
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  };
  const app = new Hono<{ Bindings: TestBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as never,
    security: {
      verifyCredential: (candidate: string) =>
        pairing.verifyCredential(candidate),
      recognizeCredential: (candidate: string) =>
        pairing.verifyCredential(candidate),
      resolveGrantedScope: (candidate: string) =>
        pairing.identifyDevice(candidate)?.scope,
      resolveCredentialAuthority: (candidate: string) =>
        pairing.identifyDevice(candidate) ? 'device-credential' : undefined,
      audit: () => {},
      allowedOrigins: [UI_ORIGIN, TAILNET_ORIGIN],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  configureDevicePairingPublicRoutes(app as never, pairing, {
    localGrant: { secretPath },
    allowedOrigins: [UI_ORIGIN, TAILNET_ORIGIN],
  });
  // Stand-in for a protected page the default grant reaches; the seam under
  // test is the credential middleware in front of it.
  app.get('/ui', (c) => c.html('<html>station</html>'));

  const send = (path: string, init: RequestInit, peer: string = SHARED_PEER) =>
    app.request(path, init, {
      incoming: { socket: { remoteAddress: peer } },
    } as TestBindings);

  /** What `station open --print` does: mint one link on direct loopback. */
  async function mintLink(): Promise<string> {
    const response = await send(
      PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: readFileSync(secretPath, 'utf8'),
        }),
      },
      MINT_PEER,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { token: string }).token;
  }

  /** A fresh browser opening the link: it carries no cookie yet. */
  async function openLinkInNewBrowser(origin: string) {
    const token = await mintLink();
    const response = await send(PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain('HttpOnly');
    const { device } = (await response.json()) as { device: { id: string } };
    return {
      deviceId: device.id,
      cookie: (setCookie as string).split(';', 1)[0],
    };
  }

  async function openLinkInSignedInBrowser(origin: string, cookie: string) {
    const token = await mintLink();
    return send(PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        Cookie: cookie,
      },
      body: JSON.stringify({ token }),
    });
  }

  const load = (cookie: string) =>
    send('/ui', { method: 'GET', headers: { Cookie: cookie } });

  return { pairing, openLinkInNewBrowser, openLinkInSignedInBrowser, load };
}

describe('sign-in links on more than one browser', () => {
  test.each([
    ['the same origin', UI_ORIGIN, UI_ORIGIN],
    ['the UI origin then the tailnet origin', UI_ORIGIN, TAILNET_ORIGIN],
    ['the tailnet origin then the UI origin', TAILNET_ORIGIN, UI_ORIGIN],
  ])(
    'a second browser signing in on %s leaves the first signed in',
    async (_label, firstOrigin, secondOrigin) => {
      const harness = await createHarness();
      const desktop = await harness.openLinkInNewBrowser(firstOrigin);
      expect((await harness.load(desktop.cookie)).status).toBe(200);

      const phone = await harness.openLinkInNewBrowser(secondOrigin);
      expect(phone.deviceId).not.toBe(desktop.deviceId);

      // Both sessions keep working, and keep working past the shared
      // per-address failure budget (10 per window). An evicted session would
      // answer 401 and then 429 here, which is what the operator saw.
      for (let request = 0; request < 15; request += 1) {
        expect((await harness.load(desktop.cookie)).status).toBe(200);
        expect((await harness.load(phone.cookie)).status).toBe(200);
      }
      const active = harness.pairing
        .listDevices()
        .filter((device) => device.revokedAt === null)
        .map((device) => device.id);
      expect(active).toEqual(
        expect.arrayContaining([desktop.deviceId, phone.deviceId]),
      );
    },
  );

  test('revoking one browser ends only that browser', async () => {
    const harness = await createHarness();
    const desktop = await harness.openLinkInNewBrowser(UI_ORIGIN);
    const phone = await harness.openLinkInNewBrowser(TAILNET_ORIGIN);

    harness.pairing.revokeDevice(phone.deviceId, 'operator-credential');

    expect((await harness.load(phone.cookie)).status).toBe(401);
    expect((await harness.load(desktop.cookie)).status).toBe(200);
  });

  test('a browser that already holds a session keeps its own device on a new link', async () => {
    // Re-opening a link in a signed-in browser stays idempotent: it neither
    // mints a second device for that browser nor touches the other one.
    const harness = await createHarness();
    const desktop = await harness.openLinkInNewBrowser(UI_ORIGIN);
    const phone = await harness.openLinkInNewBrowser(TAILNET_ORIGIN);
    const before = harness.pairing.listDevices().length;

    const again = await harness.openLinkInSignedInBrowser(
      UI_ORIGIN,
      desktop.cookie,
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { device: { id: string } }).device.id).toBe(
      desktop.deviceId,
    );
    expect(harness.pairing.listDevices().length).toBe(before);
    expect((await harness.load(phone.cookie)).status).toBe(200);
  });
});
