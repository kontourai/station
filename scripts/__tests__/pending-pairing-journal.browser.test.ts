import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { type Browser, type BrowserContext, chromium } from '@playwright/test';
import { build, stop } from 'esbuild';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';

let browser: Browser;
let origin: string;
let script = '';
let exchanges = 0;
let redirects = 0;
let mode: 'redirect' | 'success' | 'approval' = 'redirect';
const contexts: BrowserContext[] = [];
const server = createServer(async (request, response) => {
  if (request.url === '/journal.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(script);
    return;
  }
  if (request.url === '/redirect-target') {
    redirects += 1;
    response.end('{}');
    return;
  }
  if (request.url === '/.well-known/station/v1/pairing/exchange') {
    exchanges += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (mode === 'redirect') {
      response.writeHead(302, { Location: '/redirect-target' });
      response.end();
      return;
    }
    if (mode === 'approval' && exchanges === 1) {
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ error: { code: 'request_not_confirmed' } }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        environmentId: '11111111-1111-4111-8111-111111111111',
        clientInstanceId: body.clientInstanceId,
        credential: 'credential-result',
        device: {
          id: 'device-1',
          name: 'This device',
          scope: 'station:interactive',
          kind: 'device',
          createdAt: Date.now(),
          revokedAt: null,
        },
      }),
    );
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><script src="/journal.js"></script>');
});

beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: `
    import {createPendingPairingCompletion} from './packages/connect/src/core/pendingPairingCompletion.ts';
    import {savePendingExchange,clearPendingExchange,loadPendingExchange} from './packages/connect/src/core/devicePairing.ts';
    import {claimPendingPairingExchange,restoreHeldPairingExchanges,settlePendingPairingExchange} from './packages/connect/src/core/pendingPairingExchangeJournal.ts';
    window.pairingJournal = {
      pending: () => ({ endpoint: location.origin, offerId:'offer-1', proof:'proof-1', requestId:'request-1', expiresAt:Date.now()+60000, expectedEnvironmentId:'11111111-1111-4111-8111-111111111111', browserSession:false, requestKind:'direct' }),
      run: (pending, failCustody=false) => createPendingPairingCompletion()(pending, { completePaired: async () => { if(failCustody) throw new Error('custody failed'); return {status:'completed'}; } }),
      claim:claimPendingPairingExchange, restore:restoreHeldPairingExchanges, settle:settlePendingPairingExchange,
      save:savePendingExchange, clear:clearPendingExchange, load:loadPendingExchange,
    };
  `,
      resolveDir: resolve(import.meta.dirname, '../..'),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  });
  script = output.outputFiles[0].text;
  stop();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture listener');
  origin = `http://pairing.test:${address.port}`;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--host-resolver-rules=MAP pairing.test 127.0.0.1',
      '--no-proxy-server',
    ],
  });
}, 30_000);
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  exchanges = 0;
  redirects = 0;
  mode = 'redirect';
});
afterAll(async () => {
  await browser?.close();
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((done) => server.close(() => done()));
  stop();
});
async function context() {
  const context = await browser.newContext();
  contexts.push(context);
  return context;
}
async function page(context: BrowserContext) {
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => 'pairingJournal' in window);
  return page;
}

test('serializes two nonsecure tabs and retains a redirected one-shot exchange across ordinary clear and reload', async () => {
  const ctx = await context();
  const first = await page(ctx);
  const second = await page(ctx);
  expect(await first.evaluate(() => isSecureContext)).toBe(false);
  const pending = await first.evaluate(() =>
    (window as any).pairingJournal.pending(),
  );
  const results = await Promise.all(
    [first, second].map((tab) =>
      tab.evaluate(
        (pending) => (window as any).pairingJournal.run(pending),
        pending,
      ),
    ),
  );
  expect(results.map((result) => result.status)).toEqual([
    'indeterminate',
    'indeterminate',
  ]);
  expect(exchanges).toBe(1);
  expect(redirects).toBe(0);
  await first.evaluate((pending) => {
    localStorage.clear();
    (window as any).pairingJournal.clear(pending.endpoint, pending.requestKind);
  }, pending);
  await first.reload();
  await first.waitForFunction(() => 'pairingJournal' in window);
  expect(
    await first.evaluate(() =>
      (window as any).pairingJournal
        .restore()
        .then(({ held }: { held: unknown[] }) => held.length),
    ),
  ).toBe(1);
  expect(
    (
      await first.evaluate(
        (pending) => (window as any).pairingJournal.run(pending),
        pending,
      )
    ).status,
  ).toBe('indeterminate');
  expect(exchanges).toBe(1);
});

test('a committed claim survives renderer loss before send and blocks a fresh completion owner', async () => {
  const ctx = await context();
  const first = await page(ctx);
  const pending = await first.evaluate(() =>
    (window as any).pairingJournal.pending(),
  );
  expect(
    await first.evaluate(
      (pending) => (window as any).pairingJournal.claim(pending),
      pending,
    ),
  ).toBe('claimed');
  await first.close();
  const restored = await page(ctx);
  expect(
    (
      await restored.evaluate(
        (pending) => (window as any).pairingJournal.run(pending),
        pending,
      )
    ).status,
  ).toBe('indeterminate');
  expect(exchanges).toBe(0);
});

test('keeps the attempt after successful wire delivery when credential custody fails', async () => {
  mode = 'success';
  const tab = await page(await context());
  const pending = await tab.evaluate(() =>
    (window as any).pairingJournal.pending(),
  );
  expect(
    (
      await tab.evaluate(
        (pending) => (window as any).pairingJournal.run(pending, true),
        pending,
      )
    ).status,
  ).toBe('indeterminate');
  expect(exchanges).toBe(1);
  await tab.reload();
  await tab.waitForFunction(() => 'pairingJournal' in window);
  expect(
    (
      await tab.evaluate(
        (pending) => (window as any).pairingJournal.run(pending),
        pending,
      )
    ).status,
  ).toBe('indeterminate');
  expect(exchanges).toBe(1);
});

test('does not send when the authoritative journal cannot open', async () => {
  const tab = await page(await context());
  await tab.evaluate(() =>
    Object.defineProperty(window, 'indexedDB', { value: undefined }),
  );
  expect(
    (
      await tab.evaluate(() =>
        (window as any).pairingJournal.run(
          (window as any).pairingJournal.pending(),
        ),
      )
    ).status,
  ).toBe('not-started');
  expect(exchanges).toBe(0);
});

test('completes successful custody once and refuses the same proof in a fresh coordinator', async () => {
  mode = 'success';
  const tab = await page(await context());
  const pending = await tab.evaluate(() =>
    (window as any).pairingJournal.pending(),
  );
  expect(
    (
      await tab.evaluate(
        (pending) => (window as any).pairingJournal.run(pending),
        pending,
      )
    ).status,
  ).toBe('paired');
  expect(
    (
      await tab.evaluate(
        (pending) => (window as any).pairingJournal.run(pending),
        pending,
      )
    ).status,
  ).toBe('indeterminate');
  expect(exchanges).toBe(1);
  expect(
    await tab.evaluate(() => (window as any).pairingJournal.restore()),
  ).toEqual({ status: 'available', held: [] });
});

test('releases only an exact unconsumed approval response before completing custody', async () => {
  mode = 'approval';
  const tab = await page(await context());
  expect(
    (
      await tab.evaluate(() =>
        (window as any).pairingJournal.run(
          (window as any).pairingJournal.pending(),
        ),
      )
    ).status,
  ).toBe('paired');
  expect(exchanges).toBe(2);
});
