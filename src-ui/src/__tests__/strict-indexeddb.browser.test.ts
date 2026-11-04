/**
 * The strict IndexedDB transaction that relay credential custody and
 * Connect's broker routing grants share, against Chromium's real IndexedDB:
 * commits, atomic failure, abort, a relaxed-durability browser and a
 * nonsecure origin. The custody callers' own tests use in-memory storage, so
 * the last cases drive two of them through their default IndexedDB storage.
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';
import { build, stop } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';

interface Fixture {
  write(key: string, value: unknown): Promise<unknown>;
  read(key: string): Promise<unknown>;
  failAfterPut(key: string, existing: string): Promise<string>;
  abortDuringTransaction(key: string): Promise<string>;
  abortBefore(): Promise<string>;
  relaxedWrite(key: string): Promise<string>;
  turnRoundTrip(): Promise<unknown>;
  grantRoundTrip(): Promise<unknown>;
}

declare global {
  interface Window {
    strictDb: Fixture;
  }
}

let browser: Browser;
let port = 0;
let script = '';
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(script);
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><script src="/fixture.js"></script>');
});

beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: `
    import {strictIndexedDbRequest,strictIndexedDbTransaction} from './packages/shared/src/strict-indexeddb.ts';
    import {BrowserRelayTurnCustody} from './src-ui/src/lib/browserRelayTurnCustody.ts';
    import {IndexedDbBrowserRoutingGrantStorage} from './packages/connect/src/core/brokerRouteEnrollment.ts';
    const target = {
      database: 'strict-indexeddb-fixture',
      store: 'records',
      unavailable: () => new Error('fixture-unavailable'),
      failed: () => new Error('fixture-failed'),
    };
    const message = (promise) => promise.then(() => 'resolved', (error) => String(error?.message ?? error));
    window.strictDb = {
      write: (key, value) => strictIndexedDbRequest(target, 'readwrite', (store) => store.put(value, key)),
      read: (key) => strictIndexedDbRequest(target, 'readonly', (store) => store.get(key)),
      failAfterPut: (key, existing) => message(strictIndexedDbTransaction(target, 'readwrite', (store) => {
        store.put('partial', key);
        // add() of a key that exists fails, so the whole transaction must roll back.
        return { request: store.add('duplicate', existing), result: () => 'committed' };
      })),
      abortDuringTransaction: (key) => {
        const controller = new AbortController();
        return message(strictIndexedDbTransaction(target, 'readwrite', (store) => {
          const request = store.put('aborted', key);
          request.onsuccess = () => controller.abort(new Error('fixture-aborted'));
          return { request, result: () => 'committed' };
        }, controller.signal));
      },
      abortBefore: () => message(strictIndexedDbRequest(target, 'readonly', (store) => store.get('x'), AbortSignal.abort(new Error('fixture-aborted-before')))),
      relaxedWrite: (key) => {
        const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'durability');
        Object.defineProperty(IDBTransaction.prototype, 'durability', { configurable: true, get: () => 'relaxed' });
        return message(strictIndexedDbRequest(target, 'readwrite', (store) => store.put('relaxed', key)))
          .finally(() => Object.defineProperty(IDBTransaction.prototype, 'durability', descriptor));
      },
      turnRoundTrip: async () => {
        const custody = new BrowserRelayTurnCustody({
          applicationOrigin: location.origin,
          browserOrigin: location.origin,
          route: {
            brokerOrigin: 'https://broker.test',
            scope: { browserOrigin: location.origin, stationId: 'station-1', enrollmentId: 'enrollment-1', routingGeneration: 1 },
          },
        });
        await custody.save({ schemaVersion: 1, url: 'turns:turn.test:5349', username: 'user', credential: 'secret' });
        const restored = await custody.restore();
        await custody.forget();
        return { restored, forgotten: await custody.restore() };
      },
      grantRoundTrip: async () => {
        const storage = new IndexedDbBrowserRoutingGrantStorage();
        await storage.write('grant-1', { credential: { id: 'credential-1' } });
        const read = await storage.read('grant-1');
        await storage.removeIfCredentialId('grant-1', 'credential-other');
        const kept = await storage.read('grant-1');
        await storage.removeIfCredentialId('grant-1', 'credential-1');
        return { read, kept, removed: await storage.read('grant-1') };
      },
    };
  `,
      resolveDir: resolve(import.meta.dirname, '../../..'),
      loader: 'ts',
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
  port = address.port;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--host-resolver-rules=MAP insecure.test 127.0.0.1',
      '--no-proxy-server',
    ],
  });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((done) => server.close(() => done()));
  stop();
});

async function open(origin: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => 'strictDb' in window);
  return page;
}

test('commits a strict write and reads it back after the transaction completes', async () => {
  const page = await open(`http://127.0.0.1:${port}/`);
  try {
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await page.evaluate(() => window.strictDb.write('a', { value: 1 }));
    expect(await page.evaluate(() => window.strictDb.read('a'))).toEqual({
      value: 1,
    });
  } finally {
    await page.context().close();
  }
});

test('a failed request rejects with the caller error and rolls back the whole transaction', async () => {
  const page = await open(`http://127.0.0.1:${port}/`);
  try {
    await page.evaluate(() => window.strictDb.write('existing', 'kept'));
    expect(
      await page.evaluate(() =>
        window.strictDb.failAfterPut('partial', 'existing'),
      ),
    ).toBe('fixture-failed');
    expect(await page.evaluate(() => window.strictDb.read('partial'))).toBe(
      undefined,
    );
    expect(await page.evaluate(() => window.strictDb.read('existing'))).toBe(
      'kept',
    );
  } finally {
    await page.context().close();
  }
});

test('an abort rejects with its reason, before or during the transaction, and writes nothing', async () => {
  const page = await open(`http://127.0.0.1:${port}/`);
  try {
    expect(await page.evaluate(() => window.strictDb.abortBefore())).toBe(
      'fixture-aborted-before',
    );
    expect(
      await page.evaluate(() =>
        window.strictDb.abortDuringTransaction('aborted'),
      ),
    ).toBe('fixture-aborted');
    expect(await page.evaluate(() => window.strictDb.read('aborted'))).toBe(
      undefined,
    );
  } finally {
    await page.context().close();
  }
});

test('refuses a write the browser would only relax-commit', async () => {
  const page = await open(`http://127.0.0.1:${port}/`);
  try {
    expect(
      await page.evaluate(() => window.strictDb.relaxedWrite('relaxed')),
    ).toBe('fixture-unavailable');
    expect(await page.evaluate(() => window.strictDb.read('relaxed'))).toBe(
      undefined,
    );
  } finally {
    await page.context().close();
  }
});

test('stores nothing on a nonsecure origin', async () => {
  const page = await open(`http://insecure.test:${port}/`);
  try {
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    expect(
      await page.evaluate(() =>
        window.strictDb.read('a').then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
      ),
    ).toBe('fixture-unavailable');
  } finally {
    await page.context().close();
  }
});

test('TURN credential custody and broker routing grants keep and forget through real IndexedDB', async () => {
  const page = await open(`http://127.0.0.1:${port}/`);
  try {
    expect(await page.evaluate(() => window.strictDb.turnRoundTrip())).toEqual({
      restored: {
        urls: 'turns:turn.test:5349',
        username: 'user',
        credential: 'secret',
      },
      forgotten: null,
    });
    expect(await page.evaluate(() => window.strictDb.grantRoundTrip())).toEqual(
      {
        read: { credential: { id: 'credential-1' } },
        kept: { credential: { id: 'credential-1' } },
        removed: null,
      },
    );
  } finally {
    await page.context().close();
  }
});
