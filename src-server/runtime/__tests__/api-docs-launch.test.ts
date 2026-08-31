import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HttpBindings } from '@hono/node-server';
import {
  PUBLIC_DEVICE_PAIRING_API_DOCS_LAUNCH_PATH,
  PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH,
  PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { DevicePairingService } from '../../services/ssh/device-pairing-service.js';
import { configureDevicePairingPublicRoutes } from '../routes/runtime-routes.js';

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

let peerCounter = 1;
const loopback = () => `127.0.0.${(peerCounter++ % 250) + 2}`;
const remote = () => `100.96.${(peerCounter++ % 250) + 1}.7`;

function createHarness() {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-api-docs-launch-'));
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const app = new Hono<{ Bindings: TestBindings }>();
  configureDevicePairingPublicRoutes(
    app as never,
    new DevicePairingService({
      homeDir,
      environmentId: '11111111-1111-4111-8111-111111111111',
    }),
    {
      localGrant: {
        secretPath: join(homeDir, 'runtime', 'local-grant.secret'),
      },
      allowedOrigins: ['https://station.example.test'],
    },
  );
  return (path: string, peer: string) =>
    app.request(path, { method: 'GET' }, {
      incoming: { socket: { remoteAddress: peer } },
    } as TestBindings);
}

describe('API docs launcher (#934)', () => {
  test('serves the launcher page to a direct loopback caller', async () => {
    const response = await createHarness()(
      PUBLIC_DEVICE_PAIRING_API_DOCS_LAUNCH_PATH,
      loopback(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain(
      'Opening the Station API docs',
    );
  });

  test('carries no credential and no capability of its own', async () => {
    // The whole reason this page may be unauthenticated: it is inert HTML.
    // The single-use capability arrives in the URL fragment, which a browser
    // never transmits, so nothing secret is in this response.
    const response = await createHarness()(
      PUBLIC_DEVICE_PAIRING_API_DOCS_LAUNCH_PATH,
      loopback(),
    );
    const body = await response.text();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(body).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('the only script that can run is the one served, pinned by hash', async () => {
    // `unsafe-inline` would let any injected script run on an origin that
    // holds a Station session cookie. The policy names the exact bytes.
    const response = await createHarness()(
      PUBLIC_DEVICE_PAIRING_API_DOCS_LAUNCH_PATH,
      loopback(),
    );
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");

    const script = /<script>([\s\S]*?)<\/script>/.exec(await response.text());
    expect(script).not.toBeNull();
    const digest = createHash('sha256')
      .update(script?.[1] ?? '', 'utf8')
      .digest('base64');
    // The served bytes must satisfy the policy that gates them; a drift here
    // means the page ships a script the browser will refuse to execute.
    expect(csp).toContain(`script-src 'sha256-${digest}'`);
  });

  test('redeems through the existing bootstrap path and to a fixed destination', async () => {
    const body = await (
      await createHarness()(
        PUBLIC_DEVICE_PAIRING_API_DOCS_LAUNCH_PATH,
        loopback(),
      )
    ).text();
    expect(body).toContain(PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH);
    // A destination read from the request would make Station's own origin a
    // redirector for any link a user can be sent.
    expect(body).toContain('window.location.replace("/ui")');
    expect(body).not.toMatch(/location\.search|searchParams|[?&]next=/);
  });

  test('refuses a non-loopback caller', async () => {
    const response = await createHarness()(
      PUBLIC_DEVICE_PAIRING_API_DOCS_LAUNCH_PATH,
      remote(),
    );
    expect(response.status).toBe(403);
  });

  test('refuses a query string', async () => {
    const response = await createHarness()(
      `${PUBLIC_DEVICE_PAIRING_API_DOCS_LAUNCH_PATH}?token=abc`,
      loopback(),
    );
    expect(response.status).toBe(400);
  });
});

describe('the tray mirrors these paths as Rust literals', () => {
  // The desktop cannot import a TypeScript constant, so `src-desktop/src/tray.rs`
  // repeats both paths. A silent drift would send the tray to a 404 and leave
  // the menu item looking broken for a reason nothing points at, so bind them.
  const tray = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'src-desktop',
      'src',
      'tray.rs',
    ),
    'utf8',
  );

  test.each([
    ['launcher', PUBLIC_DEVICE_PAIRING_API_DOCS_LAUNCH_PATH],
    ['capability mint', PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH],
  ])('%s path matches the server contract', (_label, path) => {
    expect(tray).toContain(`"${path}"`);
  });
});
