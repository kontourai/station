// @vitest-environment node

/**
 * #2760: human input under frame-stream load, in a real browser.
 *
 * Chromium speaks HTTP/1.1 to a plain Node server, so the page gets the
 * browser's real per-origin connection pool (six), not a mock of it. The page
 * mounts real `useLiveSurface` viewers of four distinct surfaces and holds
 * two event streams open, as Station's always-on `/events` and orchestration
 * streams do. Every response the server opens stays open until the test ends.
 *
 * - Baseline (no admission cap, as before #2760): two event streams and four
 *   frame streams fill the pool, and a pointer POST does not reach the
 *   server: it queues behind responses that never end.
 * - With the per-origin cap: two frame streams are admitted, two viewers read
 *   `queued`, and pointer and lease POSTs reach the server while every stream
 *   stays open. Hiding a pane ends its stream and admits a queued viewer,
 *   with one request each and no reconnect storm.
 *
 * Latencies are printed for the record; the assertions are the invariants
 * (arrives while the streams are open, or does not arrive at all).
 */
import { appendFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  encodeLiveSurfaceRecord,
  type LiveSurfaceRecord,
} from '@kontourai/station-contracts/live-surface';
import { type Browser, chromium, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { chromiumIsInstalled } from '../../../../tests/helpers/css-cascade-fixture';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDWQAAAAASUVORK5CYII=',
  'base64',
);
/** Measurements go here when set (the runner does not show console output). */
function report(line: string): void {
  const file = process.env.LIVE_SURFACE_HEADROOM_REPORT;
  if (file) appendFileSync(file, `${line}\n`);
}

/** The longest an admitted input may take and still count as not queued. */
const NOT_QUEUED_WITHIN_MS = 2_000;

interface Receipt {
  surface: string;
  kind: 'input' | 'lease';
  at: number;
}

function lease(surfaceId: string) {
  return { surfaceId, epoch: 1, holder: null, expiresAt: null };
}

function startServer(bundle: string) {
  const open = new Set<ServerResponse>();
  const receipts: Receipt[] = [];
  const framesOpened: string[] = [];
  const framesOpen = new Set<string>();
  const server = createServer((request: IncomingMessage, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    const path = url.pathname;
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<!doctype html><div id="root"></div><script type="module" src="/harness.js"></script>',
      );
      return;
    }
    if (path === '/harness.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(bundle);
      return;
    }
    if (path.startsWith('/events/')) {
      open.add(response);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(': open\n\n');
      request.on('close', () => open.delete(response));
      return;
    }
    const match = /^\/api\/live-surfaces\/([^/]+)\/(frames|input|lease)$/.exec(
      path,
    );
    if (!match) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const surface = decodeURIComponent(match[1]!);
    if (match[2] === 'frames') {
      open.add(response);
      framesOpened.push(surface);
      framesOpen.add(surface);
      response.writeHead(200, {
        'Content-Type': 'application/vnd.station.live-surface',
      });
      const state: LiveSurfaceRecord = {
        kind: 'state',
        state: {
          surfaceId: surface,
          lease: lease(surface),
          effectiveParams: {
            maxFps: 10,
            quality: 70,
            maxWidth: 1280,
            maxHeight: 1280,
          },
        },
      };
      response.write(encodeLiveSurfaceRecord(state));
      let seq = 0;
      const timer = setInterval(() => {
        seq += 1;
        response.write(
          encodeLiveSurfaceRecord({
            kind: 'frame',
            header: {
              surfaceId: surface,
              seq,
              epoch: 1,
              codec: 'png',
              width: 1,
              height: 1,
              deviceScaleFactor: 1,
              capturedAt: Date.now(),
            },
            body: new Uint8Array(PNG),
          }),
        );
      }, 100);
      request.on('close', () => {
        clearInterval(timer);
        open.delete(response);
        framesOpen.delete(surface);
      });
      return;
    }
    const kind = match[2] as 'input' | 'lease';
    request.resume();
    request.on('end', () => {
      receipts.push({ surface, kind, at: Date.now() });
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          success: true,
          data:
            kind === 'input'
              ? { ok: true, accepted: 1, lease: lease(surface) }
              : { ok: true, lease: lease(surface) },
        }),
      );
    });
  });
  return {
    server,
    receipts,
    framesOpened,
    framesOpen,
    async listen(): Promise<string> {
      await new Promise<void>((done) =>
        server.listen(0, '127.0.0.1', () => done()),
      );
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    async close() {
      for (const response of open) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

async function until(check: () => boolean, label: string, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

async function statuses(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.entries(window.liveSurfaces).map(([id, s]) => [id, s.status]),
    ),
  );
}

const tap = [
  { kind: 'pointer', type: 'down', x: 1, y: 1, button: 'left', clickCount: 1 },
  { kind: 'pointer', type: 'up', x: 1, y: 1, button: 'left', clickCount: 1 },
];

describe.skipIf(!chromiumIsInstalled(REPO_ROOT))(
  'live surface input headroom over HTTP/1.1 (#2760)',
  () => {
    let bundle = '';
    let browser: Browser;
    let fixture: ReturnType<typeof startServer> | null = null;

    beforeAll(async () => {
      const output = await build({
        entryPoints: [
          resolve(import.meta.dirname, 'fixtures/headroomHarness.tsx'),
        ],
        bundle: true,
        write: false,
        format: 'esm',
        jsx: 'automatic',
        platform: 'browser',
        logLevel: 'error',
        define: { 'process.env.NODE_ENV': '"production"' },
        // The SDK barrel imports component styles the page never renders.
        loader: { '.css': 'empty' },
      });
      bundle = output.outputFiles[0]!.text;
      browser = await chromium.launch();
    }, 60_000);

    afterEach(async () => {
      await fixture?.close();
      fixture = null;
    });

    afterAll(async () => {
      await browser?.close();
    });

    async function openPage(query: string) {
      fixture = startServer(bundle);
      const origin = await fixture.listen();
      const page = await browser.newPage();
      await page.goto(`${origin}/?${query}`);
      return { page, fixture };
    }

    async function sendTap(page: Page, surface: string): Promise<number> {
      const sentAt = Date.now();
      await page.evaluate(
        ([id, events]) => window.liveSurfaces[id]!.sendInput(events as never),
        [surface, tap] as const,
      );
      return sentAt;
    }

    test('baseline without a cap: four frame streams fill the pool and input never arrives', async () => {
      const { page, fixture } = await openPage(
        'cap=0&events=2&surfaces=a,b,c,d',
      );
      await until(() => fixture.framesOpen.size === 4, 'four frame streams');
      await sendTap(page, 'a');
      await new Promise((done) => setTimeout(done, NOT_QUEUED_WITHIN_MS));
      // Still queued behind six responses that never end.
      expect(fixture.receipts).toEqual([]);
      expect(fixture.framesOpen.size).toBe(4);
      report(
        `[headroom] baseline cap=none: input not received after ${NOT_QUEUED_WITHIN_MS} ms with 2 event + 4 frame streams open`,
      );
      await page.close();
    }, 30_000);

    test('with the cap, input and lease requests arrive while every stream stays open', async () => {
      const { page, fixture } = await openPage(
        'cap=2&events=2&surfaces=a,b,c,d',
      );
      await until(() => fixture.framesOpen.size === 2, 'two frame streams');
      await until(() => fixture.framesOpened.length >= 2, 'admitted');
      await page.waitForFunction(
        () =>
          Object.values(window.liveSurfaces).filter(
            (s) => s.status === 'queued',
          ).length === 2,
      );
      const admitted = [...fixture.framesOpen];
      const latencies: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const before = fixture.receipts.length;
        const sentAt = await sendTap(page, admitted[i % 2]!);
        await until(
          () => fixture.receipts.length > before,
          `input ${i} received`,
          NOT_QUEUED_WITHIN_MS,
        );
        latencies.push(fixture.receipts.at(-1)!.at - sentAt);
      }
      // A lease claim from a QUEUED viewer is not admitted either: it is input.
      const queued = Object.entries(await statuses(page)).find(
        ([, status]) => status === 'queued',
      )![0];
      const before = fixture.receipts.length;
      const claimAt = Date.now();
      await page.evaluate(
        (id) => void window.liveSurfaces[id]!.claimControl(),
        queued,
      );
      await until(
        () => fixture.receipts.length > before,
        'lease received',
        NOT_QUEUED_WITHIN_MS,
      );
      expect(fixture.receipts.at(-1)).toMatchObject({
        surface: queued,
        kind: 'lease',
      });
      expect(fixture.framesOpen.size).toBe(2);
      latencies.sort((a, b) => a - b);
      report(
        `[headroom] cap=2: 20 taps p50=${latencies[9]} ms p95=${latencies[18]} ms max=${latencies[19]} ms; lease ${fixture.receipts.at(-1)!.at - claimAt} ms; 2 event + 2 frame streams open, 2 viewers queued`,
      );
      await page.close();
    }, 60_000);

    test('hiding a pane ends its stream and admits a queued viewer, once', async () => {
      const { page, fixture } = await openPage('cap=2&events=2&surfaces=a,b,c');
      await until(() => fixture.framesOpen.size === 2, 'two frame streams');
      await page.waitForFunction(() =>
        Object.values(window.liveSurfaces).some((s) => s.status === 'queued'),
      );
      const queued = Object.entries(await statuses(page)).find(
        ([, status]) => status === 'queued',
      )![0];
      const hidden = [...fixture.framesOpen][0]!;
      await page.evaluate((id) => {
        document.querySelector<HTMLElement>(
          `[data-surface="${id}"]`,
        )!.style.display = 'none';
      }, hidden);
      await until(
        () => fixture.framesOpen.has(queued) && !fixture.framesOpen.has(hidden),
        'the queued viewer admitted in place of the hidden one',
      );
      await page.waitForFunction(
        (id) => window.liveSurfaces[id]!.status === 'suspended',
        hidden,
      );
      // Settle, then count: one request per surface, no reconnect storm.
      await new Promise((done) => setTimeout(done, 1_000));
      const perSurface = Object.fromEntries(
        ['a', 'b', 'c'].map((id) => [
          id,
          fixture.framesOpened.filter((opened) => opened === id).length,
        ]),
      );
      expect(perSurface).toEqual({ a: 1, b: 1, c: 1 });
      expect(fixture.framesOpen.size).toBe(2);
      await page.close();
    }, 30_000);
  },
);
