import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  UI_MIME_TYPES,
  UI_PROXY_BACKEND_PREFIXES,
  uiRequestHandler,
} from '../packages/cli/src/commands/lifecycle';
import { monitorBrowserHealth } from './helpers/browser-health';

let uiServer: http.Server;
let upstream: http.Server;
let uiOrigin: string;

test.beforeAll(async () => {
  upstream = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const upstreamAddress = upstream.address();
  const upstreamPort =
    typeof upstreamAddress === 'object' && upstreamAddress
      ? upstreamAddress.port
      : 0;
  const handler = uiRequestHandler({
    http,
    crypto,
    fs,
    path,
    dir: process.env.STATION_E2E_UI_DIR || path.resolve('dist-ui'),
    mime: UI_MIME_TYPES,
    inject: '<script>window.__API_BASE__=window.location.origin</script>',
    upstreamPort,
    backendPrefixes: UI_PROXY_BACKEND_PREFIXES,
    internalApiToken: 'playwright-only-internal-token',
  });
  uiServer = http.createServer(handler);
  await new Promise<void>((resolve) =>
    uiServer.listen(0, '127.0.0.1', resolve),
  );
  const address = uiServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  uiOrigin = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await Promise.all(
    [uiServer, upstream]
      .filter((server): server is http.Server => Boolean(server))
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

test('boots the built shell under CSP and opens its connection recovery UI', async ({
  page,
}) => {
  const browserHealth = await monitorBrowserHealth(page);
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([
        {
          id: 'csp-local',
          name: 'CSP Station',
          url: window.location.origin,
          lastConnected: Date.now(),
        },
      ]),
    );
    window.localStorage.setItem(
      'station-connect-connections-active',
      'csp-local',
    );
  });
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/system/status') {
      await route.fulfill({
        json: {
          ready: true,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          providers: {
            configuredChatReady: true,
            configured: [],
            detected: { ollama: false, bedrock: false },
          },
        },
      });
      return;
    }
    if (pathname === '/api/projects') {
      await route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 'p-csp',
              slug: 'csp',
              name: 'CSP Project',
              type: 'coding',
            },
          ],
        },
      });
      return;
    }
    await route.fulfill({ json: { success: true, data: [] } });
  });
  await page.route('**/config/app', (route) =>
    route.fulfill({ json: { success: true, data: {} } }),
  );
  await page.route('**/notifications?**', (route) =>
    route.fulfill({ json: { success: true, data: [] } }),
  );
  await page.route('**/acp/connections', (route) =>
    route.fulfill({ json: { success: true, data: [] } }),
  );
  await page.route('**/events', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'data: {"event":"connected"}\n\n',
    }),
  );

  const response = await page.goto(uiOrigin);
  expect(response?.headers()['content-security-policy']).toContain(
    "script-src 'self' 'nonce-",
  );
  const connectionControl = page.getByRole('button', {
    // station#3311 made the connection control self-describing: its
    // accessible name now carries the state and the connection identity
    // ("Manage Stations — Connected · <name>"), so this matches by prefix.
    // The bare string is still the control’s `title` (station#3297).
    name: /^Manage Stations/,
  });
  await expect(connectionControl).toBeVisible({ timeout: 15_000 });
  await expect(connectionControl.getByText('CSP Station')).toBeVisible();
  await connectionControl.click();
  await expect(page.getByRole('heading', { name: 'Stations' })).toBeVisible();
  browserHealth.assertHealthy();
});
