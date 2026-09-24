/**
 * Real-Chromium integration for the Browser pane's live surface (#90 wave 2):
 * a server session registers a screencast surface, a viewer receives real
 * frames, human input changes the page, and an `alert()` is answered without
 * wedging the surface.
 *
 * Runs against an INSTALLED Chrome/Edge only (never a download). With none
 * installed every case reports an explicit skip naming why: a missing
 * prerequisite is not a pass.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveSurfaceRecord } from '@kontourai/station-contracts/live-surface';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  dispatchHumanInput,
  type LiveSurfaceEntry,
  LiveSurfaceRegistry,
} from '../../live-surface/registry.js';
import { BrowserLiveSurfaces } from '../browser-live-surfaces.js';
import { BrowserSessionRegistry } from '../browser-session-registry.js';
import {
  ChromiumAcquisition,
  defaultChromiumAcquisitionDeps,
} from '../chromium-acquisition.js';
import { ChromiumServerHost } from '../hosts/chromium-server-host.js';
import {
  deriveStationListeners,
  localInterfaceAddresses,
} from '../station-listeners.js';

const acquisitionHome = mkdtempSync(join(tmpdir(), 'station-screencast-acq-'));
const acquisitionStatus = new ChromiumAcquisition(
  acquisitionHome,
  defaultChromiumAcquisitionDeps(),
).status();
const executablePath =
  acquisitionStatus.state === 'found-system'
    ? acquisitionStatus.executablePath
    : undefined;
const SKIP_REASON = `no installed Google Chrome / Microsoft Edge / Chromium was found (acquisition state: ${acquisitionStatus.state}); this real-browser test never downloads one`;

const FIXTURE = `<!doctype html><html><head><title>fixture</title>
<style>body{margin:0;font:16px sans-serif}button{position:absolute;width:200px;height:80px}</style>
</head><body>
<p id="out">idle</p>
<button id="go" style="left:40px;top:100px">Go</button>
<button id="nag" style="left:40px;top:260px">Nag</button>
<script>
document.getElementById('go').addEventListener('click', () => {
  document.getElementById('out').textContent = 'clicked';
});
document.getElementById('nag').addEventListener('click', () => {
  alert('are you sure?');
  document.getElementById('out').textContent = 'after-alert';
});
</script></body></html>`;

// No <meta name=viewport>: on a mobile viewport Chrome lays this out at 980
// CSS px and shows it zoomed out to fit. Two full-width bands far down the
// page, so a tap mapped without the page zoom lands above both of them.
const NO_META_FIXTURE = `<!doctype html><html><head><title>nometa</title>
<style>body{margin:0}.band{position:absolute;left:0;width:100%;height:300px}</style>
</head><body>
<p id="out" style="position:absolute;top:0;margin:0">idle</p>
<div id="tap" class="band" style="top:1000px;background:#08f"></div>
<div id="click" class="band" style="top:1500px;background:#f80"></div>
<script>
document.getElementById('tap').addEventListener('click', () => {
  document.getElementById('out').textContent = 'tapped';
});
document.getElementById('click').addEventListener('click', () => {
  document.getElementById('out').textContent = 'clicked';
});
</script></body></html>`;

const HUMAN = {
  kind: 'human',
  principal: 'human:local:operator',
  device: 'device:test',
} as const;

describe('Browser live surface against a real installed Chromium', () => {
  let fixture: Server;
  let fixtureUrl = '';
  let home = '';
  let sessions: BrowserSessionRegistry;
  let surfaces: LiveSurfaceRegistry;
  let binder: BrowserLiveSurfaces;
  let browserSessionId = '';

  const live = () => sessions.liveTarget(browserSessionId)!;
  const evaluate = async (expression: string) => {
    const target = live();
    const result = await target.host
      .cdp()
      .send<{ result: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        target.target.cdpSessionId,
      );
    return result.result.value;
  };
  const poll = async <T>(
    read: () => Promise<T>,
    accept: (value: T) => boolean,
    timeoutMs = 15_000,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value: T | undefined;
      try {
        value = await read();
        if (accept(value)) return value;
      } catch {
        // A read racing a navigation is retried.
      }
      if (Date.now() > deadline) return value as T;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const entry = (): LiveSurfaceEntry => {
    const surfaceId = binder.surfaceIdFor(browserSessionId);
    if (!surfaceId) throw new Error('the live session has no surface');
    const found = surfaces.get(surfaceId);
    if (!found) throw new Error(`surface ${surfaceId} is not registered`);
    return found;
  };
  const click = (x: number, y: number) => {
    const surface = entry();
    return dispatchHumanInput(surface, HUMAN, surface.lease.snapshot().epoch, [
      { kind: 'pointer', type: 'move', x, y },
      { kind: 'pointer', type: 'down', x, y, button: 'left', clickCount: 1 },
      { kind: 'pointer', type: 'up', x, y, button: 'left', clickCount: 1 },
    ]);
  };

  beforeAll(async () => {
    if (!executablePath) return;
    const chromium = executablePath;
    fixture = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(req.url === '/no-meta' ? NO_META_FIXTURE : FIXTURE);
    });
    const port = await new Promise<number>((resolve) =>
      fixture.listen(0, '127.0.0.1', () =>
        resolve((fixture.address() as AddressInfo).port),
      ),
    );
    fixtureUrl = `http://127.0.0.1:${port}/`;
    home = mkdtempSync(join(tmpdir(), 'station-screencast-real-'));
    // A Station port that cannot collide with the fixture's.
    const stationPort = port > 60_000 ? port - 10 : port + 10;
    const listeners = deriveStationListeners({
      serverPort: stationPort,
      configuredOrigins: [`http://127.0.0.1:${stationPort}`],
    });
    sessions = new BrowserSessionRegistry({
      stationHome: home,
      createHost: () =>
        new ChromiumServerHost({
          executablePath: chromium,
          egressPolicy: {
            listeners: () => listeners,
            interfaceAddresses: localInterfaceAddresses,
            reach: { kind: 'operator' },
          },
          launchTimeoutMs: 120_000,
        }),
    });
    surfaces = new LiveSurfaceRegistry({ dispatchTimeoutMs: 10_000 });
    binder = new BrowserLiveSurfaces({
      sessions,
      surfaces,
      authorizeProject: async () => ({ kind: 'operator' }),
    });
    const session = await sessions.createSession({
      projectId: 'alpha',
      projectSlug: 'alpha',
      url: fixtureUrl,
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      actor: { kind: 'operator' },
    });
    browserSessionId = session.browserSessionId;
    await poll(
      () => evaluate('document.readyState + "|" + document.title'),
      (value) => value === 'complete|fixture',
    );
  }, 180_000);

  afterAll(async () => {
    if (executablePath) {
      await binder?.dispose().catch(() => {});
      await sessions?.shutdown().catch(() => {});
      await surfaces?.dispose().catch(() => {});
      await new Promise<void>((r) =>
        fixture ? fixture.close(() => r()) : r(),
      );
      if (home) rmSync(home, { recursive: true, force: true });
    }
    rmSync(acquisitionHome, { recursive: true, force: true });
  }, 60_000);

  test('a viewer attached to the session surface receives real JPEG frames with the effective DSF', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const surface = entry();
    const viewer = surface.hub.attach(
      { maxFps: 10, quality: 50, maxWidth: 640, maxHeight: 640 },
      { principal: HUMAN.principal, device: HUMAN.device },
    );
    try {
      const deadline = Date.now() + 30_000;
      let frame: Extract<LiveSurfaceRecord, { kind: 'frame' }> | undefined;
      while (!frame && Date.now() < deadline) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 5_000);
        const record = await viewer.next(abort.signal);
        clearTimeout(timer);
        if (record?.kind === 'frame') frame = record;
      }
      expect(frame, 'no frame arrived within 30 s').toBeDefined();
      const { header, body } = frame!;
      expect(header.codec).toBe('jpeg');
      expect([body[0], body[1]]).toEqual([0xff, 0xd8]);
      // A 1280 CSS px page fitted into 640 image px.
      expect(header.width).toBeLessThanOrEqual(640);
      expect(header.deviceScaleFactor).toBeCloseTo(header.width / 1280, 5);
    } finally {
      viewer.close();
    }
  }, 60_000);

  test('a click dispatched through the surface changes the page', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const result = await click(140, 140);
    expect(result).toMatchObject({ ok: true, accepted: 3 });
    expect(
      await poll(
        () => evaluate('document.getElementById("out").textContent'),
        (value) => value === 'clicked',
      ),
    ).toBe('clicked');
  }, 60_000);

  test('an alert() is answered automatically: input does not wedge and the history records it', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const started = Date.now();
    const result = await click(140, 300);
    // Without the dialog contract the mouse release stays pending until the
    // registry's 10 s dispatch timeout wedges the surface.
    expect(result).toMatchObject({ ok: true, accepted: 3 });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(
      await poll(
        () => evaluate('document.getElementById("out").textContent'),
        (value) => value === 'after-alert',
      ),
    ).toBe('after-alert');
    const history = sessions.getSession(browserSessionId)!.history.entries;
    expect(history.some((action) => action.kind === 'dialog-handled')).toBe(
      true,
    );
    expect(
      history.find((action) => action.kind === 'dialog-handled')?.detail,
    ).toBe('alert dismissed automatically: are you sure?');
    // And the surface still takes input afterwards.
    expect(await click(140, 140)).toMatchObject({ ok: true });
  }, 60_000);

  test('on a phone viewport, a page with no meta viewport is tapped and clicked where it is SEEN (D1)', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    await sessions.setViewport(
      browserSessionId,
      { width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
      { actor: { kind: 'operator' } },
    );
    await sessions.navigate(browserSessionId, `${fixtureUrl}no-meta`, {
      actor: { kind: 'operator' },
    });
    await poll(
      () => evaluate('document.readyState + "|" + document.title'),
      (value) => value === 'complete|nometa',
    );
    const layoutWidth = (await evaluate(
      'document.documentElement.clientWidth',
    )) as number;
    // The premise: the page is laid out wider than the phone and zoomed out.
    expect(layoutWidth).toBeGreaterThan(900);

    // Take the latest frame of the zoomed-out page.
    const surface = entry();
    const viewer = surface.hub.attach(
      { maxFps: 10, quality: 50, maxWidth: 1200, maxHeight: 2600 },
      { principal: HUMAN.principal, device: HUMAN.device },
    );
    let header:
      | Extract<LiveSurfaceRecord, { kind: 'frame' }>['header']
      | undefined;
    try {
      const until = Date.now() + 4_000;
      while (Date.now() < until) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 1_000);
        const record = await viewer.next(abort.signal);
        clearTimeout(timer);
        if (record?.kind === 'frame') header = record.header;
      }
    } finally {
      viewer.close();
    }
    expect(header, 'no frame of the zoomed-out page').toBeDefined();
    // Where the bands are in the IMAGE, from the page geometry alone: the
    // whole layout width fills the image width, uniformly scaled.
    const imagePerCss = header!.width / layoutWidth;
    const imageX = header!.width / 2;
    const toSurface = (imagePx: number) => imagePx / header!.deviceScaleFactor;

    // A touch tap on the first band, through the live-surface input path,
    // exactly as a viewer maps an image point.
    const tapY = toSurface(1150 * imagePerCss);
    const tap = await dispatchHumanInput(
      surface,
      HUMAN,
      surface.lease.snapshot().epoch,
      [
        {
          kind: 'pointer',
          type: 'down',
          x: toSurface(imageX),
          y: tapY,
          button: 'left',
          pointerType: 'touch',
        },
        {
          kind: 'pointer',
          type: 'up',
          x: toSurface(imageX),
          y: tapY,
          button: 'left',
          pointerType: 'touch',
        },
      ],
    );
    expect(tap).toMatchObject({ ok: true });
    expect(
      await poll(
        () => evaluate('document.getElementById("out").textContent'),
        (value) => value === 'tapped',
      ),
    ).toBe('tapped');

    // And a mouse click on the second band.
    const clickY = toSurface(1650 * imagePerCss);
    const click = await dispatchHumanInput(
      surface,
      HUMAN,
      surface.lease.snapshot().epoch,
      [
        { kind: 'pointer', type: 'move', x: toSurface(imageX), y: clickY },
        {
          kind: 'pointer',
          type: 'down',
          x: toSurface(imageX),
          y: clickY,
          button: 'left',
          clickCount: 1,
        },
        {
          kind: 'pointer',
          type: 'up',
          x: toSurface(imageX),
          y: clickY,
          button: 'left',
          clickCount: 1,
        },
      ],
    );
    expect(click).toMatchObject({ ok: true });
    expect(
      await poll(
        () => evaluate('document.getElementById("out").textContent'),
        (value) => value === 'clicked',
      ),
    ).toBe('clicked');
  }, 90_000);
});
