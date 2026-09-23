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
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { stationControlCallerPrincipal } from '../../../tools/station-control-shared.js';
import {
  dispatchHumanInput,
  type LiveSurfaceEntry,
  LiveSurfaceRegistry,
} from '../../live-surface/registry.js';
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
#name{position:absolute;left:40px;top:220px;width:300px;height:40px}</style>
</head><body>
<p id="out">idle</p>
<button id="go">Go</button>
<label for="name" style="position:absolute;left:40px;top:190px">Your name</label>
<input id="name" aria-label="Your name">
<p id="greet" style="position:absolute;top:300px"></p>
<script>
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
    expect(history.filter((e) => e.kind === 'typed')).toHaveLength(1);
  }, 120_000);
});
