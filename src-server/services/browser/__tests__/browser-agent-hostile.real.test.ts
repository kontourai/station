/**
 * Browser tools against HOSTILE pages in a REAL installed Chromium (#90
 * review S1–S3). Each page attacks one assumption:
 *  - /steer lies about geometry (overrides `getBoundingClientRect`) and
 *    pre-defines the locator engine's global to redirect locators onto a
 *    hidden "Buy" button: a click on "Cancel" must still land on Cancel, and
 *    history must say what really happened;
 *  - /covered lays a transparent element over a button: the click is
 *    refused `obscured` and nothing is recorded as clicked;
 *  - /flood has 300,000 elements and a 1.5M-character URL: the snapshot is
 *    bounded, the URL capped, and the browser survives;
 *  - /busy spins forever: wait_for returns within its bound, and the next
 *    call is not stuck behind it.
 *
 * Runs against an INSTALLED Chrome/Edge only (never a download). With none
 * installed every case reports an explicit skip naming why.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { stationControlCallerPrincipal } from '../../../tools/station-control-shared.js';
import { LiveSurfaceRegistry } from '../../live-surface/registry.js';
import {
  authorizeBrowserAgentCaller,
  type BrowserAgentAuthority,
} from '../browser-agent-authority.js';
import { BrowserAutomation } from '../browser-automation.js';
import { BrowserLiveSurfaces } from '../browser-live-surfaces.js';
import { loadLocatorEngineInstallExpression } from '../browser-locator-engine.js';
import { BrowserProjectSettingsStore } from '../browser-project-settings.js';
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

const acquisitionHome = mkdtempSync(join(tmpdir(), 'station-hostile-acq-'));
const acquisitionStatus = new ChromiumAcquisition(
  acquisitionHome,
  defaultChromiumAcquisitionDeps(),
).status();
const executablePath =
  acquisitionStatus.state === 'found-system'
    ? acquisitionStatus.executablePath
    : undefined;
const SKIP_REASON = `no installed Google Chrome / Microsoft Edge / Chromium was found (acquisition state: ${acquisitionStatus.state}); this real-browser test never downloads one`;

const STEER = `<!doctype html><html><head><title>steer</title>
<style>body{margin:0;font:16px sans-serif}button{position:absolute;left:40px;width:160px;height:60px}</style>
</head><body>
<p id="out">idle</p>
<div id="__stationPlaywrightInjected"></div>
<button id="cancel" style="top:100px">Cancel</button>
<button id="buy" style="top:400px;opacity:0.01">Buy</button>
<script>
const buy = document.getElementById('buy');
document.getElementById('cancel').addEventListener('click', () => {
  document.getElementById('out').textContent = 'cancelled';
});
buy.addEventListener('click', () => {
  document.getElementById('out').textContent = 'bought';
});
// Lie about where everything is: every element "is" where Buy is.
const real = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () { return real.call(buy); };
// Squat on the locator engine's global, pointing every locator at Buy.
Object.defineProperty(window, '__stationPlaywrightInjected', {
  value: {
    parseSelector: (s) => s,
    querySelector: () => buy,
    elementState: () => ({ matches: true }),
  },
});
</script></body></html>`;

const COVERED = `<!doctype html><html><head><title>covered</title>
<style>body{margin:0}button{position:absolute;left:40px;top:100px;width:160px;height:60px}
#shield{position:absolute;left:0;top:0;width:400px;height:300px;background:transparent}</style>
</head><body>
<p id="out">idle</p>
<button id="target">Delete</button>
<div id="shield"></div>
<script>
document.getElementById('target').addEventListener('click', () => {
  document.getElementById('out').textContent = 'deleted';
});
document.getElementById('shield').addEventListener('click', () => {
  document.getElementById('out').textContent = 'shield';
});
</script></body></html>`;

const FLOOD = `<!doctype html><html><head><title>flood</title></head><body>
<p id="ready">building</p>
<script>
const box = document.createElement('div');
for (let i = 0; i < 300000; i += 1) {
  const span = document.createElement('span');
  span.textContent = 'x' + i;
  box.appendChild(span);
}
document.body.appendChild(box);
history.replaceState(null, '', location.pathname + '?' + 'q'.repeat(1500000));
document.getElementById('ready').textContent = 'flooded';
</script></body></html>`;

const BUSY = `<!doctype html><html><head><title>busy</title></head><body>
<p>loaded</p>
<script>setTimeout(() => { for (;;) {} }, 1500);</script>
</body></html>`;

// D1: an invisible Buy (in form o) sits over Cancel, and Cancel holds a
// control associated with form o named `parentNode`, so a walk that reads
// `node.parentNode` goes Buy → o → (clobbered) input → Cancel and "passes".
const CLOBBER = `<!doctype html><html><head><title>clobber</title>
<style>body{margin:0}.b{position:absolute;left:40px;top:100px;width:160px;height:60px}</style>
</head><body>
<p id="out">idle</p>
<button id="cancel" class="b" aria-label="Cancel"><input form="o" name="parentNode" style="width:1px;height:1px">Cancel</button>
<form id="o"><button id="buy" type="button" class="b" style="opacity:0.01;z-index:5">Buy</button></form>
<script>
document.getElementById('cancel').addEventListener('click', () => { document.getElementById('out').textContent = 'cancelled'; });
document.getElementById('buy').addEventListener('click', () => { document.getElementById('out').textContent = 'bought'; });
</script></body></html>`;

// D1 variant: a form whose named control makes its own "parent" point back
// into itself (a cycle a naive walk never leaves).
const CLOBBER_CYCLE = `<!doctype html><html><head><title>cycle</title>
<style>body{margin:0}.b{position:absolute;left:40px;top:100px;width:160px;height:60px}</style>
</head><body>
<p id="out">idle</p>
<button id="cancel" class="b" aria-label="Cancel">Cancel</button>
<form id="o2"><img name="parentNode" alt=""><button id="buy" type="button" class="b" style="opacity:0.01;z-index:5">Buy</button></form>
<script>
document.getElementById('cancel').addEventListener('click', () => { document.getElementById('out').textContent = 'cancelled'; });
document.getElementById('buy').addEventListener('click', () => { document.getElementById('out').textContent = 'bought'; });
</script></body></html>`;

// D2: Buy waits off-screen and moves over Cancel the moment the pointer
// arrives (capture-phase pointermove), before any press.
const MOVE_IN = `<!doctype html><html><head><title>movein</title>
<style>body{margin:0}.b{position:absolute;left:40px;width:160px;height:60px}</style>
</head><body>
<p id="out">idle</p>
<button id="cancel" class="b" style="top:100px">Cancel</button>
<button id="buy" class="b" style="top:500px;opacity:0.01;z-index:5">Buy</button>
<script>
const buy = document.getElementById('buy');
document.addEventListener('pointermove', () => { buy.style.top = '100px'; }, true);
document.getElementById('cancel').addEventListener('click', () => { document.getElementById('out').textContent = 'cancelled'; });
buy.addEventListener('click', () => { document.getElementById('out').textContent = 'bought'; });
</script></body></html>`;

// D2 for typing: focusing the name field moves focus to another field
// right after (a microtask), so text would land in the wrong field.
const FOCUS_MOVE = `<!doctype html><html><head><title>focusmove</title></head><body>
<p id="out">idle</p>
<input id="name" aria-label="Name">
<input id="card" aria-label="Card">
<script>
const card = document.getElementById('card');
document.getElementById('name').addEventListener('focus', () => queueMicrotask(() => card.focus()));
card.addEventListener('input', () => { document.getElementById('out').textContent = 'card:' + card.value; });
</script></body></html>`;

// A page that moves focus to another field on the name field's first
// `input` event, so a long text would continue into the wrong field.
const STEAL = `<!doctype html><html><head><title>steal</title></head><body>
<p id="out">idle</p>
<input id="name" aria-label="Your name">
<input id="evil" aria-label="Evil">
<script>
const evil = document.getElementById('evil');
const name = document.getElementById('name');
name.addEventListener('input', () => evil.focus(), { once: true });
</script></body></html>`;

const OPERATOR = 'human:local:operator';

describe('browser tools against hostile pages in a real Chromium', () => {
  let fixture: Server;
  let base = '';
  let home = '';
  let sessions: BrowserSessionRegistry;
  let surfaces: LiveSurfaceRegistry;
  let binder: BrowserLiveSurfaces;
  let automation: BrowserAutomation;
  let authority: BrowserAgentAuthority;

  const open = async (
    path: string,
    ready: { text: string } | { url: string },
  ) => {
    const opened = await automation.open(authority, {
      url: `${base}${path}`,
      projectSlug: 'alpha',
    });
    expect(opened).toMatchObject({ ok: true });
    const id = (opened as { session: { browserSessionId: string } }).session
      .browserSessionId;
    expect(
      await automation.waitFor(authority, id, {
        ...ready,
        timeoutMs: 20_000,
      }),
    ).toMatchObject({ ok: true });
    return id;
  };
  const pageText = async (id: string) => {
    const live = sessions.liveTarget(id)!;
    const result = await live.host.cdp().send<{ result: { value?: unknown } }>(
      'Runtime.evaluate',
      {
        expression: "document.getElementById('out').textContent",
        returnByValue: true,
      },
      live.target.cdpSessionId,
    );
    return result.result.value;
  };

  beforeAll(async () => {
    if (!executablePath) return;
    const chromium = executablePath;
    fixture = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      const body =
        path === '/steer'
          ? STEER
          : path === '/covered'
            ? COVERED
            : path === '/flood'
              ? FLOOD
              : path === '/busy'
                ? BUSY
                : path === '/clobber'
                  ? CLOBBER
                  : path === '/clobber-cycle'
                    ? CLOBBER_CYCLE
                    : path === '/movein'
                      ? MOVE_IN
                      : path === '/focusmove'
                        ? FOCUS_MOVE
                        : path === '/steal'
                          ? STEAL
                          : '<!doctype html><title>blank</title>';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    });
    const port = await new Promise<number>((resolve) =>
      fixture.listen(0, '127.0.0.1', () =>
        resolve((fixture.address() as AddressInfo).port),
      ),
    );
    base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), 'station-hostile-real-'));
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
    automation = new BrowserAutomation({
      sessions,
      surfaces,
      surfaceIdFor: (id) => binder.surfaceIdFor(id),
      settings: new BrowserProjectSettingsStore(home),
      locatorEngine: loadLocatorEngineInstallExpression,
      stepDeadlineMs: 3_000,
    });
    const decided = await authorizeBrowserAgentCaller(
      {
        sessionId: 'agent-session-hostile',
        assurance: 'bound',
        principal: stationControlCallerPrincipal(OPERATOR, 'session-owner'),
        localProjectId: 'alpha',
        projectIdSource: 'session-record',
      },
      async (principalId) =>
        principalId === OPERATOR ? { kind: 'operator' } : undefined,
    );
    if (!decided.ok) throw new Error(decided.refusal.code);
    authority = decided.authority;
  }, 60_000);

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

  test('S1: a page that lies about geometry and squats on the locator global cannot redirect a click', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const id = await open('/steer', { text: 'idle' });
    const snap = (await automation.snapshot(authority, id)) as {
      snapshot: string;
    };
    const ref = /button "Cancel" \[ref=(e\d+)\]/.exec(snap.snapshot)?.[1];
    expect(ref, snap.snapshot).toBeDefined();
    expect(await automation.click(authority, id, { ref: ref! })).toMatchObject({
      ok: true,
      clicked: 'button "Cancel"',
    });
    expect(await pageText(id)).toBe('cancelled');
    // A locator resolves in Station's isolated world, not through the
    // page's squatted global.
    expect(
      await automation.click(authority, id, {
        locator: 'role=button[name="Cancel"]',
      }),
    ).toMatchObject({ ok: true });
    expect(await pageText(id)).toBe('cancelled');
    const clicked = sessions
      .getSession(id)!
      .history.entries.filter((e) => e.kind === 'clicked');
    expect(clicked.map((e) => e.detail)).toEqual([
      'button "Cancel"',
      'locator role=button[name="Cancel"]',
    ]);
  }, 120_000);

  test('S1: a covered target is refused as obscured; nothing is clicked or recorded', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const id = await open('/covered', { text: 'idle' });
    const snap = (await automation.snapshot(authority, id)) as {
      snapshot: string;
    };
    const ref = /button "Delete" \[ref=(e\d+)\]/.exec(snap.snapshot)?.[1];
    expect(ref, snap.snapshot).toBeDefined();
    expect(await automation.click(authority, id, { ref: ref! })).toMatchObject({
      ok: false,
      code: 'obscured',
    });
    expect(await pageText(id)).toBe('idle');
    expect(
      sessions
        .getSession(id)!
        .history.entries.some((e) => e.kind === 'clicked'),
    ).toBe(false);
  }, 120_000);

  // `test.for`, not `test.each`: only `for` hands the case its test context,
  // which the no-browser skip below needs.
  test.for<[path: string, what: string]>([
    ['/clobber', 'a form control named parentNode'],
    ['/clobber-cycle', 'a self-referential parentNode'],
    ['/movein', 'an element that moves in when the pointer arrives'],
  ])(
    'D1/D2 %s (%s): the covered Cancel is refused obscured, and Buy never fires',
    { timeout: 120_000 },
    async ([path], ctx) => {
      if (!executablePath) return ctx.skip(SKIP_REASON);
      const id = await open(path, { text: 'idle' });
      const snap = (await automation.snapshot(authority, id)) as {
        snapshot: string;
      };
      const ref = /button "Cancel" \[ref=(e\d+)\]/.exec(snap.snapshot)?.[1];
      expect(ref, snap.snapshot).toBeDefined();
      const result = await automation.click(authority, id, { ref: ref! });
      expect(result).toMatchObject({ ok: false, code: 'obscured' });
      expect(await pageText(id)).toBe('idle');
      expect(
        sessions
          .getSession(id)!
          .history.entries.some((e) => e.kind === 'clicked'),
      ).toBe(false);
    },
  );

  test('D2: focus moved away right after focusing: nothing is typed anywhere', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const id = await open('/focusmove', { text: 'idle' });
    const result = await automation.type(authority, id, {
      text: '4111-secret',
      target: { locator: 'css=#name' },
    });
    expect(result).toMatchObject({ ok: false, code: 'focus-moved' });
    expect(await pageText(id)).toBe('idle');
    expect(
      sessions.getSession(id)!.history.entries.some((e) => e.kind === 'typed'),
    ).toBe(false);
  }, 120_000);

  test('focus stolen mid-text: typing stops after the first chunk and reports what the field really got', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const id = await open('/steal', { text: 'idle' });
    const result = await automation.type(authority, id, {
      text: 'a'.repeat(2_500),
      target: { locator: 'css=#name' },
      submit: true,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'focus-moved',
      typed: 1_024,
    });
    const live = sessions.liveTarget(id)!;
    const lengths = await live.host.cdp().send<{ result: { value?: unknown } }>(
      'Runtime.evaluate',
      {
        expression:
          "[document.getElementById('name').value.length, document.getElementById('evil').value.length]",
        returnByValue: true,
      },
      live.target.cdpSessionId,
    );
    expect(lengths.result.value).toEqual([1_024, 0]);
    expect(
      sessions
        .getSession(id)!
        .history.entries.filter((e) => e.kind === 'typed')
        .map((e) => e.detail),
    ).toEqual(['1024 characters into locator css=#name, then focus moved']);
  }, 120_000);

  test('S3: 300,000 elements and a 1.5M-character URL give a bounded snapshot, and the browser survives', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const id = await open('/flood', { url: 'qqqqqqqq' });
    const snap = (await automation.snapshot(authority, id)) as {
      ok: boolean;
      url: string;
      snapshot: string;
      truncated: boolean;
    };
    expect(snap.ok).toBe(true);
    expect(snap.truncated).toBe(true);
    expect(snap.url.length).toBeLessThanOrEqual(2_049);
    expect(snap.snapshot.length).toBeLessThanOrEqual(48_000);
    expect(snap.snapshot.split('\n').length).toBeLessThanOrEqual(600);
    // Still alive: the same page answers.
    expect(sessions.liveTarget(id)).toBeDefined();
    expect(
      await automation.waitFor(authority, id, {
        url: 'qqqqqqqq',
        timeoutMs: 10_000,
      }),
    ).toMatchObject({ ok: true });
  }, 180_000);

  test('S2: a page stuck in a loop costs a bounded timeout, and the next call is not blocked', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const id = await open('/busy', { url: '/busy' });
    // Let the page start spinning.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    let started = Date.now();
    const waited = await automation.waitFor(authority, id, {
      text: 'never there',
      timeoutMs: 2_000,
    });
    expect(waited).toMatchObject({ ok: false, code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(8_000);
    started = Date.now();
    const next = await automation.snapshot(authority, id);
    expect(next).toMatchObject({ ok: false, code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 120_000);
});
