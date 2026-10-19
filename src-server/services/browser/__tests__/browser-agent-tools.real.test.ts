/**
 * Browser tools against a REAL installed Chromium (#90 #122/#123): an agent,
 * holding a grant minted by the real authority chain, opens a fixture page,
 * snapshots it, clicks an element by ref, types through a Playwright
 * locator, waits for the page's reaction — and a person's input interrupts
 * it mid-action and then keeps it out.
 *
 * Runs against an INSTALLED Chrome/Edge only (never a download). With none
 * installed every case reports an explicit skip naming why: a missing
 * prerequisite is not a pass.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { stationControlCallerPrincipal } from '../../../tools/station-control-shared.js';
import {
  claimHumanControl,
  dispatchHumanInput,
  type LiveSurfaceEntry,
  LiveSurfaceRegistry,
  releaseHumanControl,
} from '../../live-surface/registry.js';
import {
  authorizeBrowserAgentCaller,
  type BrowserAgentAuthority,
} from '../browser-agent-authority.js';
import { BrowserAutomation } from '../browser-automation.js';
import { createLocalBrowserHostResolver } from '../browser-host.js';
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

const acquisitionHome = mkdtempSync(join(tmpdir(), 'station-agent-acq-'));
const acquisitionStatus = new ChromiumAcquisition(
  acquisitionHome,
  defaultChromiumAcquisitionDeps(),
).status();
const executablePath =
  acquisitionStatus.state === 'found-system'
    ? acquisitionStatus.executablePath
    : undefined;
const SKIP_REASON = `no installed Google Chrome / Microsoft Edge / Chromium was found (acquisition state: ${acquisitionStatus.state}); this real-browser test never downloads one`;

const FIXTURE = `<!doctype html><html><head><title>agent fixture</title>
<style>body{margin:0;font:16px sans-serif}#go{position:absolute;left:40px;top:100px;width:160px;height:60px}
#hover{position:absolute;left:400px;top:100px;width:160px;height:60px}#hover:hover{background:lime}\n#drag{position:absolute;left:400px;top:220px;width:100px;height:60px;background:coral}\n@media(prefers-color-scheme:dark){body{background:#181818;color:white}}\n#name{position:absolute;left:40px;top:220px;width:300px;height:40px}</style>
</head><body>
<p id="out">idle</p>
<button id="go">Go</button>
<button id="hidden" style="display:none">Hidden control</button>
<button id="hover">Hover me</button>
<div id="hoverOut"></div>
<div id="drag" role="button" aria-label="Drag me">Drag me</div>
<p id="dragOut" style="position:absolute;top:360px"></p>
<label style="position:absolute;top:420px">Color <select id="color"><option value="r">Red</option><option value="b">Blue</option><optgroup label="Unavailable" disabled><option value="x">Blocked</option></optgroup></select></label>
<p id="selection" style="position:absolute;top:460px"></p>
<fieldset disabled style="position:absolute;top:520px"><select id="disabled-color"><option value="r">Red</option><option value="b">Blue</option></select></fieldset>
<div style="position:absolute;top:580px"><select id="covered-color"><option value="r">Red</option><option value="b">Blue</option></select><div style="position:absolute;inset:0;background:white">Cover</div></div>
<label for="name" style="position:absolute;left:40px;top:190px">Your name</label>
<input id="name" aria-label="Your name">
<p id="greet" style="position:absolute;top:300px"></p>
<script>
document.getElementById('hover').addEventListener('mouseenter', () => document.getElementById('hoverOut').textContent = 'hovered');
let dragging = false;
document.getElementById('drag').addEventListener('mousedown', () => dragging = true);
document.addEventListener('mouseup', (e) => { if (dragging && e.clientX > 600) document.getElementById('dragOut').textContent = 'drag completed'; dragging = false; });
document.getElementById('color').addEventListener('change', (e) => document.getElementById('selection').textContent = 'Selected ' + e.target.value);
document.getElementById('go').addEventListener('click', () => {
  document.getElementById('out').textContent = 'clicked';
});
document.getElementById('name').addEventListener('input', (event) => {
  document.getElementById('greet').textContent = 'Hello ' + event.target.value;
});
</script></body></html>`;

const OPERATOR = 'human:local:operator';
const HUMAN = {
  kind: 'human',
  principal: OPERATOR,
  device: 'device:test',
} as const;

describe('browser tools against a real installed Chromium', () => {
  let fixture: Server;
  let fixtureUrl = '';
  let home = '';
  let sessions: BrowserSessionRegistry;
  let surfaces: LiveSurfaceRegistry;
  let binder: BrowserLiveSurfaces;
  let automation: BrowserAutomation;
  let authority: BrowserAgentAuthority;
  let browserSessionId = '';

  const entry = (): LiveSurfaceEntry => {
    const surfaceId = binder.surfaceIdFor(browserSessionId);
    if (!surfaceId) throw new Error('the live session has no surface');
    return surfaces.get(surfaceId)!;
  };

  beforeAll(async () => {
    if (!executablePath) return;
    const chromium = executablePath;
    fixture = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(FIXTURE);
    });
    const port = await new Promise<number>((resolve) =>
      fixture.listen(0, '127.0.0.1', () =>
        resolve((fixture.address() as AddressInfo).port),
      ),
    );
    fixtureUrl = `http://127.0.0.1:${port}/`;
    home = mkdtempSync(join(tmpdir(), 'station-agent-real-'));
    const stationPort = port > 60_000 ? port - 10 : port + 10;
    const listeners = deriveStationListeners({
      serverPort: stationPort,
      configuredOrigins: [`http://127.0.0.1:${stationPort}`],
    });
    sessions = new BrowserSessionRegistry({
      stationHome: home,
      hostResolver: createLocalBrowserHostResolver(
        () =>
          new ChromiumServerHost({
            executablePath: chromium,
            egressPolicy: {
              listeners: () => listeners,
              interfaceAddresses: localInterfaceAddresses,
              reach: { kind: 'operator' },
            },
            launchTimeoutMs: 120_000,
          }),
      ),
    });
    surfaces = new LiveSurfaceRegistry({ dispatchTimeoutMs: 10_000 });
    binder = new BrowserLiveSurfaces({
      sessions,
      surfaces,
      // People are authorized by the routes; this test drives the registry.
      authorizeProject: async () => ({ kind: 'operator' }),
    });
    automation = new BrowserAutomation({
      sessions,
      surfaces,
      surfaceIdFor: (id) => binder.surfaceIdFor(id),
      settings: new BrowserProjectSettingsStore(home),
      locatorEngine: loadLocatorEngineInstallExpression,
    });
    const decided = await authorizeBrowserAgentCaller(
      {
        sessionId: 'agent-session-real',
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

  test('open → snapshot → click a ref → type by locator → wait_for → a person interrupts', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);

    const opened = await automation.open(authority, {
      url: fixtureUrl,
      projectSlug: 'alpha',
    });
    expect(opened).toMatchObject({ ok: true, reused: false });
    browserSessionId = (opened as { session: { browserSessionId: string } })
      .session.browserSessionId;
    expect(
      await automation.waitFor(authority, browserSessionId, {
        text: 'idle',
        timeoutMs: 15_000,
      }),
    ).toMatchObject({ ok: true, matched: 'text' });

    const snapshot = await automation.snapshot(authority, browserSessionId, {
      screenshot: true,
    });
    expect(snapshot).toMatchObject({ ok: true, title: 'agent fixture' });
    const text = (snapshot as { snapshot: string }).snapshot;
    const ref = /button "Go" \[ref=(e\d+)\]/.exec(text)?.[1];
    expect(ref, text).toBeDefined();
    const shot = (snapshot as { screenshot?: { data: string; width?: number } })
      .screenshot;
    expect(shot?.data.length).toBeGreaterThan(100);
    expect(shot?.width).toBeGreaterThan(0);

    expect(
      await automation.click(authority, browserSessionId, { ref: ref! }),
    ).toMatchObject({ ok: true, clicked: 'button "Go"' });
    expect(
      await automation.waitFor(authority, browserSessionId, {
        text: 'clicked',
        timeoutMs: 10_000,
      }),
    ).toMatchObject({ ok: true });

    expect(
      await automation.type(authority, browserSessionId, {
        text: 'Ada',
        target: { locator: 'css=#name' },
      }),
    ).toMatchObject({ ok: true, typed: 3 });
    expect(
      await automation.waitFor(authority, browserSessionId, {
        text: 'Hello Ada',
        timeoutMs: 10_000,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await automation.waitFor(authority, browserSessionId, {
        locator: 'role=button[name="Go"]',
        timeoutMs: 10_000,
      }),
    ).toMatchObject({ ok: true, matched: 'locator' });
    expect(
      await automation.waitFor(authority, browserSessionId, {
        locator: 'css=#hidden',
        timeoutMs: 500,
      }),
    ).toMatchObject({ ok: false, code: 'timeout', pageBusy: false });

    expect(
      await automation.hover(authority, browserSessionId, {
        locator: 'css=#hover',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await automation.waitFor(authority, browserSessionId, {
        text: 'hovered',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await automation.drag(
        authority,
        browserSessionId,
        { locator: 'css=#drag' },
        { x: 680, y: 250 },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await automation.waitFor(authority, browserSessionId, {
        text: 'drag completed',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await automation.selectOption(
        authority,
        browserSessionId,
        { locator: 'css=#name' },
        { value: 'b' },
      ),
    ).toMatchObject({ ok: false, code: 'not-selectable' });
    expect(
      await automation.selectOption(
        authority,
        browserSessionId,
        { locator: 'css=#color' },
        { label: 'Blocked' },
      ),
    ).toMatchObject({ ok: false, code: 'not-selectable' });
    expect(
      await automation.selectOption(
        authority,
        browserSessionId,
        { locator: 'css=#color' },
        { label: 'Blue' },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await automation.waitFor(authority, browserSessionId, {
        text: 'Selected b',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await automation.selectOption(
        authority,
        browserSessionId,
        { locator: 'css=#color' },
        { value: 'r' },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await automation.waitFor(authority, browserSessionId, {
        text: 'Selected r',
      }),
    ).toMatchObject({ ok: true });

    expect(
      await automation.selectOption(
        authority,
        browserSessionId,
        { locator: 'css=#disabled-color' },
        { value: 'b' },
      ),
    ).toMatchObject({ ok: false, code: 'not-selectable' });
    expect(
      await automation.selectOption(
        authority,
        browserSessionId,
        { locator: 'css=#covered-color' },
        { value: 'b' },
      ),
    ).toMatchObject({ ok: false, code: 'obscured' });

    // Independent browser observation: the emulation changes matchMedia itself.
    const live = sessions.liveTarget(browserSessionId)!;
    const dark = async () => {
      const result = await live.host.cdp().send<{ result: { value: boolean } }>(
        'Runtime.evaluate',
        {
          expression: 'matchMedia("(prefers-color-scheme: dark)").matches',
          returnByValue: true,
        },
        live.target.cdpSessionId,
      );
      return result.result.value;
    };
    const systemDark = await dark();
    for (const scheme of ['dark', 'light', 'system'] as const) {
      expect(
        await automation.colorScheme(authority, browserSessionId, scheme),
      ).toMatchObject({ ok: true });
      expect(await dark()).toBe(
        scheme === 'system' ? systemDark : scheme === 'dark',
      );
    }
    expect(
      await automation.colorScheme(authority, browserSessionId, 'dark'),
    ).toMatchObject({ ok: true });
    const evidence = await automation.snapshot(authority, browserSessionId, {
      screenshot: true,
    });
    expect(evidence.ok && evidence.screenshot?.data).toBeTruthy();
    if (
      process.env.STATION_BROWSER_EVIDENCE_DIR &&
      evidence.ok &&
      evidence.screenshot
    ) {
      mkdirSync(process.env.STATION_BROWSER_EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        join(
          process.env.STATION_BROWSER_EVIDENCE_DIR,
          'agent-browser-parity.jpg',
        ),
        Buffer.from(evidence.screenshot.data, 'base64'),
      );
    }

    // A navigation retains the target override until human takeover restores system.
    const forced = systemDark ? 'light' : 'dark';
    expect(
      await automation.colorScheme(authority, browserSessionId, forced),
    ).toMatchObject({ ok: true });
    expect(await dark()).toBe(!systemDark);
    expect(
      await automation.navigate(authority, browserSessionId, {
        action: 'reload',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await automation.waitFor(authority, browserSessionId, { text: 'idle' }),
    ).toMatchObject({ ok: true });
    expect(await dark()).toBe(!systemDark);
    expect(claimHumanControl(entry(), HUMAN).ok).toBe(true);
    // CDP round-trip follows the binder's reset on the same page session.
    expect(await dark()).toBe(systemDark);
    expect(
      releaseHumanControl(entry(), HUMAN, entry().lease.snapshot().epoch).ok,
    ).toBe(true);
    expect(
      await automation.type(authority, browserSessionId, {
        text: 'Ada',
        target: { locator: 'css=#name' },
        clear: true,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await automation.waitFor(authority, browserSessionId, {
        text: 'Hello Ada',
      }),
    ).toMatchObject({ ok: true });

    // A person moves the mouse over the page while the agent is mid-action.
    const long = automation.type(authority, browserSessionId, {
      text: 'x'.repeat(8_000),
      target: { locator: 'css=#name' },
      clear: true,
    });
    const deadline = Date.now() + 10_000;
    while (entry().lease.snapshot().holder?.kind !== 'agent') {
      if (Date.now() > deadline)
        throw new Error('the agent never took control');
      await new Promise((resolve) => setImmediate(resolve));
    }
    const human = await dispatchHumanInput(
      entry(),
      HUMAN,
      entry().lease.snapshot().epoch,
      [{ kind: 'pointer', type: 'move', x: 600, y: 500 }],
    );
    expect(human).toMatchObject({ ok: true });
    expect(await long).toMatchObject({ ok: false, code: 'interrupted' });
    // The interrupted text never replaced the field's contents.
    expect(
      await automation.waitFor(authority, browserSessionId, {
        text: 'Hello Ada',
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ ok: true });

    // The person still holds control: the agent is kept out.
    expect(
      await automation.click(authority, browserSessionId, { ref: ref! }),
    ).toMatchObject({ ok: false, code: 'human-controlling' });

    // D6: what the agent did is in the session history, as the agent.
    const history = sessions.getSession(browserSessionId)!.history.entries;
    const agentKinds = history
      .filter((e) => e.actor.kind === 'agent')
      .map((e) => e.kind);
    expect(agentKinds).toEqual(
      expect.arrayContaining(['created', 'inspected', 'clicked', 'typed']),
    );
    expect(history.filter((e) => e.kind === 'typed')).toHaveLength(2);
  }, 120_000);
});
