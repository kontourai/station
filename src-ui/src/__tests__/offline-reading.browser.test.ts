import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { offlineShell } from '../../../scripts/vite-offline-shell';
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs';

declare global {
  interface Window {
    connections: ReturnType<
      typeof import('@kontourai/station-connect').useConnections
    >;
    fixtureMounted?: boolean;
    liveNonceRan?: boolean;
    holdReconnectOnline?: boolean;
    reconnectOnlineObserved?: boolean;
    reading: typeof import('../lib/offlineReading');
  }
}

const ROOT = path.resolve(import.meta.dirname, '../../..');
const temp = trackTempDirs({ base: path.join(ROOT, 'node_modules/.cache') });
let browser: Awaited<ReturnType<typeof chromium.launch>>;
let server: ReturnType<typeof createServer>;
let origin: string;
let navigationFailure: 'disconnect' | 'unavailable' | undefined;
const requests: { path: string; cookie?: string }[] = [];
beforeAll(async () => {
  mkdirSync(path.join(ROOT, 'node_modules/.cache'), { recursive: true });
  const root = temp('offline-reading-browser-');
  writeFileSync(
    path.join(root, 'index.html'),
    '<head><meta name="station-build-version" content="1"><meta name="station-build-commit" content="test-build"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body>',
  );
  writeFileSync(
    path.join(root, 'main.tsx'),
    `
    import React,{useEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
    import {OfflineReadingBoundary} from '${ROOT}/src-ui/src/components/OfflineReadingBoundary';
    import {WebOfflineShell} from '${ROOT}/src-ui/src/components/WebOfflineShell';
    import {OfflineReadingSection} from '${ROOT}/src-ui/src/views/settings/OfflineReadingSection';
    import * as reading from '${ROOT}/src-ui/src/lib/offlineReading';
    window.reading=reading;
    import {ConnectionsProvider,useConnections} from '@kontourai/station-connect';
    function Probe(){window.connections=useConnections(); useEffect(()=>{window.fixtureMounted=true},[]); return null;}
    function App(){return <><WebOfflineShell/><OfflineReadingBoundary><QueryClientProvider client={new QueryClient()}><main><h1>Live app</h1><OfflineReadingSection/></main></QueryClientProvider></OfflineReadingBoundary></>}
    createRoot(document.getElementById('root')).render(<ConnectionsProvider defaultUrl={location.origin}><Probe/><App/></ConnectionsProvider>);

  `,
  );
  const fixture = `
    import {useConnections} from '${ROOT}/packages/connect/src/react/ConnectionsContext';
    export {ConnectionsProvider,useConnections} from '${ROOT}/packages/connect/src/react/ConnectionsContext';
    export const useConnectionStatus=()=>({status:'connected'});
    export const usePlatformProfile=()=>({isTauri:false});
    export const useAuthorityPersistence=()=>({namespace:'authority-a'});
    export function useHostRequestAuthorityScope(){const {captureCredentialEvidence}=useConnections(); const id=captureCredentialEvidence().connectionId; return {isCurrent:()=>id===window.connections.activeConnection.id}}
  `;
  const fixturePath = path.join(root, 'connection-fixture.ts');
  writeFileSync(
    fixturePath,
    fixture +
      '\nexport const checkServerHealth = async () => true; export const probeServerConnection = async () => ({ok: true});',
  );
  const result = await build({
    configFile: false,
    define: { 'import.meta.env.PROD': 'true' },
    root,
    publicDir: path.join(ROOT, 'src-ui/public'),
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: {
      alias: [
        { find: /^@kontourai\/station-connect$/, replacement: fixturePath },
        {
          find: /^.*\/(?:ApiBaseContext|AuthorityPersistenceContext|PlatformProfileContext|serverHealth)(?:\.tsx?)?$/,
          replacement: fixturePath,
        },
      ],
    },
    plugins: [offlineShell()],
    build: { write: false, minify: false },
  });
  if (!('output' in result)) throw new Error('Expected one build output');
  const outputs = new Map(
    result.output.map((output) => [
      output.fileName,
      Buffer.from(output.type === 'chunk' ? output.code : output.source),
    ]),
  );
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/' && navigationFailure) {
      if (navigationFailure === 'disconnect') req.socket.destroy();
      else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end('{"success":false}');
      }
      return;
    }
    requests.push({ path: url.pathname, cookie: req.headers.cookie });
    if (url.pathname === '/api/private') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"secret":"api-secret"}');
      return;
    }
    const name =
      url.pathname === '/' || !path.extname(url.pathname)
        ? 'index.html'
        : url.pathname.slice(1);
    const content =
      outputs.get(name) ??
      (() => {
        try {
          return readFileSync(path.join(ROOT, 'src-ui/public', name));
        } catch {
          return undefined;
        }
      })();
    if (!content) {
      res.writeHead(404);
      res.end('Missing fixture asset');
      return;
    }
    const type = name.endsWith('.js')
      ? 'text/javascript'
      : name.endsWith('.css')
        ? 'text/css'
        : name.endsWith('.json')
          ? 'application/json'
          : name.endsWith('.html')
            ? 'text/html'
            : 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      ...(name === 'index.html'
        ? {
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self' 'nonce-fresh-request'; style-src 'self' 'unsafe-inline'",
          }
        : {}),
    });
    res.end(
      name === 'index.html'
        ? content
            .toString()
            .replace(
              '<head>',
              '<head><script nonce="fresh-request">window.liveNonceRan=true</script>',
            )
        : content,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP address');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
}, 60000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test('opt-in text survives an offline reload under CSP, stays read-only, and clears on request', async () => {
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  try {
    await context.addInitScript(() => {
      window.addEventListener(
        'online',
        (event) => {
          if (!window.holdReconnectOnline) return;
          event.stopImmediatePropagation();
          window.reconnectOnlineObserved = true;
        },
        { capture: true },
      );
    });
    await context.addCookies([
      { name: 'private-cookie', value: 'not-for-cache', url: origin },
    ]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    await page.goto(origin);
    await page
      .getByRole('switch', { name: 'Save offline reading copies' })
      .waitFor();
    expect(await page.getByRole('main').count()).toBe(1);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    expect(await page.getByRole('switch').getAttribute('aria-checked')).toBe(
      'false',
    );
    await page.getByRole('switch').click();
    await expect
      .poll(() => page.getByRole('switch').getAttribute('aria-checked'))
      .toBe('true');
    await page.evaluate(async () => {
      const reading = (window as any).reading;
      await reading.saveOfflineReading(
        'authority-a',
        'conversation-a',
        [
          {
            sequence: 1,
            event: {
              method: 'turn.started',
              turnId: 't',
              prompt: 'Remember this prompt',
              ambientContext: 'private ambient',
              metadata: { token: 'secret' },
            },
          },
          {
            sequence: 2,
            event: {
              method: 'content.text-delta',
              turnId: 't',
              delta: 'Saved answer',
              itemId: 'a',
            },
          },
          {
            sequence: 3,
            event: {
              method: 'tool.started',
              turnId: 't',
              arguments: 'tool-secret',
            },
          },
        ],
        () => true,
      );
    });
    expect(
      await page.evaluate(() => fetch('/api/private').then((r) => r.json())),
    ).toEqual({ secret: 'api-secret' });
    const before = await page.evaluate(
      () => window.connections.captureCredentialEvidence()!.generation,
    );
    await page.evaluate(() => {
      const c = window.connections;
      c.recordEndpointFailure(c.activeConnection!.id, 'unreachable');
    });
    await expect
      .poll(() =>
        page.evaluate(
          () => window.connections.captureCredentialEvidence()!.generation,
        ),
      )
      .toBeGreaterThan(before);
    expect(
      await page.evaluate(async () =>
        window.reading.readOfflineReading('authority-a'),
      ),
    ).toMatchObject({
      enabled: true,
      copies: [{ conversationId: 'conversation-a' }],
    });
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Read offline copies' }).click();
    await page
      .getByText('Conversation conversation-a', { exact: true })
      .waitFor();
    expect(await page.getByRole('main').count()).toBe(1);
    await page.reload();
    await page.getByRole('heading', { name: 'Station is offline' }).waitFor();
    expect(await page.getByRole('main').count()).toBe(1);
    await page
      .getByText('Conversation conversation-a', { exact: true })
      .click();
    await page.getByText('Saved answer', { exact: true }).waitFor();
    expect(await page.getByRole('textbox').count()).toBe(0);
    expect(await page.getByText(/Read-only offline copy from/).count()).toBe(1);
    expect(await page.locator('body').textContent()).not.toMatch(
      /tool-secret|private ambient/,
    );
    expect(await page.evaluate(() => window.liveNonceRan)).toBeUndefined();
    const keys = await page.evaluate(async () =>
      Promise.all(
        (await caches.keys()).map(async (name) => ({
          name,
          urls: (await (await caches.open(name)).keys()).map(
            (r) => new URL(r.url).pathname,
          ),
        })),
      ),
    );
    expect(keys.flatMap((k) => k.urls)).not.toContain('/api/private');
    expect(keys.flatMap((k) => k.urls)).not.toContain('/');
    expect(keys.flatMap((k) => k.urls)).toContain('/offline.html');
    expect(
      requests
        .filter((r) => r.path === '/offline-shell.json')
        .every((r) => !r.cookie),
    ).toBe(true);
    expect(errors).toEqual([]);
    await page.getByRole('button', { name: 'Clear offline copies' }).click();
    await page.getByText('Offline copies cleared.', { exact: true }).waitFor();
    await page.reload();
    await page.getByText(/No offline copies available/).waitFor();
    await page.waitForFunction(() => window.fixtureMounted);
    expect(
      await page.evaluate(
        () => !!document.querySelector('meta[name="station-offline-shell"]'),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => window.liveNonceRan)).toBeUndefined();
    // Chromium restores pages before workers. Hold its online notification
    // until both transports are restored, then deliver it to the real owner.
    await page.evaluate(() => {
      window.holdReconnectOnline = true;
      window.reconnectOnlineObserved = false;
    });
    await context.setOffline(false);
    await page.waitForFunction(() => window.reconnectOnlineObserved);
    await Promise.all([
      page.waitForEvent('framenavigated', {
        predicate: (frame) => frame === page.mainFrame(),
      }),
      page.evaluate(() => {
        window.holdReconnectOnline = false;
        window.dispatchEvent(new Event('online'));
      }),
    ]);
    await page.waitForLoadState('domcontentloaded');
    expect(
      await page.evaluate(() => ({
        offlineShell: !!document.querySelector(
          'meta[name="station-offline-shell"]',
        ),
        liveNonceRan: window.liveNonceRan,
      })),
    ).toEqual({ offlineShell: false, liveNonceRan: true });
    await page.getByRole('heading', { name: 'Live app' }).waitFor();
    expect(await page.getByRole('main').count()).toBe(1);
  } finally {
    await context.close();
  }
}, 30000);

test('storage bounds, authority fencing, expiry and clearing prevent stale copies returning', async () => {
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  try {
    const page = await context.newPage();
    await page.goto(origin);

    await page.getByRole('switch').waitFor();
    const result = await page.evaluate(async () => {
      const r = (window as any).reading;
      const binding = r.offlineReadingBinding(
        window.connections.captureCredentialEvidence(),
      );
      const events = (text: string) => [
        {
          sequence: 1,
          event: { method: 'turn.started', turnId: 't', prompt: text },
        },
      ];
      await r.saveOfflineReading(
        'authority-a',
        'off',
        events('not saved'),
        () => true,
      );
      const disabled = await r.readOfflineReading('authority-a');
      await r.configureOfflineReading('authority-a', binding, true, () => true);
      for (let i = 0; i < 25; i++)
        await r.saveOfflineReading(
          'authority-a',
          `c${i}`,
          events('small'),
          () => true,
        );
      const count = (await r.readOfflineReading('authority-a')).copies.length;
      for (let i = 0; i < 25; i++)
        await r.saveOfflineReading(
          'authority-a',
          `big${i}`,
          events('😀'.repeat(200000)),
          () => true,
        );
      const bounded = await r.readOfflineReading('authority-a');
      const serialized = new TextEncoder().encode(
        JSON.stringify(bounded.copies),
      ).length;
      const largest = Math.max(
        ...bounded.copies.map(
          (copy: unknown) =>
            new TextEncoder().encode(JSON.stringify(copy)).length,
        ),
      );
      const foreign = await r.readDeviceOfflineCopies('other-device');
      const oldNow = Date.now;
      Date.now = () => oldNow() + 25 * 60 * 60 * 1000;
      const expired = await r.readOfflineReading('authority-a');
      Date.now = oldNow;
      await r.saveOfflineReading(
        'authority-a',
        'stale',
        events('must not return'),
        () => false,
      );
      const stale = (await r.readOfflineReading('authority-a')).copies.some(
        (c: any) => c.conversationId === 'stale',
      );
      const inFlight = r.saveOfflineReading(
        'authority-a',
        'late',
        events('must not return'),
        () => true,
      );
      await r.clearOfflineReading();
      await inFlight;
      return {
        disabled,
        count,
        serialized,
        largest,
        foreign,
        expired,
        stale,
        cleared: await r.readOfflineReading('authority-a'),
      };
    });
    expect(result.disabled).toEqual({ enabled: false, copies: [] });
    expect(result.count).toBe(20);
    expect(result.serialized).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.largest).toBeLessThanOrEqual(256 * 1024);
    expect(result.foreign).toEqual([]);
    expect(result.expired.copies).toEqual([]);
    expect(result.stale).toBe(false);
    expect(result.cleared).toEqual({ enabled: false, copies: [] });
  } finally {
    await context.close();
  }
}, 30000);

test('changing the selected authority clears local text instead of revealing it on return', async () => {
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  try {
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByRole('switch').waitFor();
    await page.getByRole('switch').click();
    await expect
      .poll(() => page.getByRole('switch').getAttribute('aria-checked'))
      .toBe('true');
    await page.evaluate(async () => {
      await (window as any).reading.saveOfflineReading(
        'authority-a',
        'private-conversation',
        [
          {
            sequence: 1,
            event: {
              method: 'turn.started',
              turnId: 't',
              prompt: 'Private saved text',
            },
          },
        ],
        () => true,
      );
    });
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Read offline copies' }).click();
    await page
      .getByText('Conversation private-conversation', { exact: true })
      .waitFor();
    await page.evaluate(() => {
      const c = window.connections;
      c.setCredential(c.activeConnection!.id, 'replacement-credential');
    });
    await page.getByText(/No offline copies available/).waitFor();
    await page.evaluate(() => {
      const c = window.connections;
      c.removeCredential(c.activeConnection!.id);
    });
    await page.getByText(/No offline copies available/).waitFor();
    expect(
      await page
        .getByText('Conversation private-conversation', { exact: true })
        .count(),
    ).toBe(0);
  } finally {
    await context.close();
  }
});

test.each(['disconnect', 'unavailable'] as const)(
  'fallback opens the local reader when the Station route is %s but the browser link stays online',
  async (failure) => {
    const context = await browser.newContext();
    context.setDefaultTimeout(5000);
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.getByRole('switch').waitFor();
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      await page.getByRole('switch').click();
      await expect
        .poll(() => page.getByRole('switch').getAttribute('aria-checked'))
        .toBe('true');
      await page.evaluate(async () => {
        await (window as any).reading.saveOfflineReading(
          'authority-a',
          'route-offline',
          [
            {
              sequence: 1,
              event: {
                method: 'turn.started',
                turnId: 't',
                prompt: 'Route offline copy',
              },
            },
          ],
          () => true,
        );
      });
      navigationFailure = failure;
      await page.reload();
      expect(await page.evaluate(() => navigator.onLine)).toBe(true);
      await page.getByRole('heading', { name: 'Station is offline' }).waitFor();
      await page
        .getByText('Conversation route-offline', { exact: true })
        .click();
      await page.getByText('Route offline copy', { exact: true }).waitFor();
      navigationFailure = undefined;
      await page.getByRole('button', { name: 'Retry connection' }).click();
      await page.getByRole('heading', { name: 'Live app' }).waitFor();
      expect(
        await page.getByText('Route offline copy', { exact: true }).count(),
      ).toBe(0);
    } finally {
      navigationFailure = undefined;
      await context.close();
    }
  },
);
