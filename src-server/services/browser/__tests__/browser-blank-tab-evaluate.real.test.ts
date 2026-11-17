/**
 * An agent's `browser_evaluate` on a blank Browser pane tab against a REAL
 * installed Chromium. Chrome 158 aborts the whole browser, closing every tab,
 * when script on an about:blank page the browser opened adds a
 * `sandbox="allow-scripts"` srcdoc frame (`site_instance_impl.cc` CHECK
 * `has_site_`); Chrome 157 does not. Station refuses evaluation on such a
 * page and keeps it on pages that have a site, including an about:blank a
 * page navigated to itself.
 *
 * Runs against an INSTALLED Chrome/Edge only (never a download). Hosted full
 * regression binds Playwright's pinned Chrome for Testing as `google-chrome`
 * for the process-exclusive group, which is why this file belongs to it.
 * Without a browser every case reports an explicit skip; the survival case
 * also skips, naming the version, below Chrome 158.
 */
import { spawnSync } from 'node:child_process';
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

const acquisitionHome = mkdtempSync(join(tmpdir(), 'station-blank-acq-'));
const acquisitionStatus = new ChromiumAcquisition(
  acquisitionHome,
  defaultChromiumAcquisitionDeps(),
).status();
const executablePath =
  acquisitionStatus.state === 'found-system'
    ? acquisitionStatus.executablePath
    : undefined;
const SKIP_REASON = `no installed Google Chrome / Microsoft Edge / Chromium was found (acquisition state: ${acquisitionStatus.state}); this real-browser test never downloads one`;

function majorVersion(executable: string): number | undefined {
  const probe = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const match = /(\d+)\.\d+\.\d+\.\d+/.exec(probe.stdout ?? '');
  return match ? Number(match[1]) : undefined;
}
const major = executablePath ? majorVersion(executablePath) : undefined;
const ABORTING_MAJOR = 158;

/** The action that aborts Chrome 158 on a site-less about:blank page. */
const SANDBOXED_SRCDOC = `new Promise((resolve) => {
  const frame = document.createElement('iframe');
  frame.sandbox = 'allow-scripts';
  frame.srcdoc = '<p>x</p>';
  frame.onload = () => resolve('loaded');
  document.body.append(frame);
})`;

const OPERATOR = 'human:local:operator';

describe('browser_evaluate on a blank tab against a real installed Chromium', () => {
  let fixture: Server;
  let fixtureUrl = '';
  let home = '';
  let sessions: BrowserSessionRegistry;
  let surfaces: LiveSurfaceRegistry;
  let binder: BrowserLiveSurfaces;
  let automation: BrowserAutomation;
  let authority: BrowserAgentAuthority;

  const open = async (url?: string) => {
    const opened = await automation.open(authority, {
      ...(url ? { url } : {}),
      projectSlug: 'alpha',
    });
    // An open at a URL a live session already shows reuses that session.
    expect(opened).toMatchObject({ ok: true });
    const id = (opened as { session: { browserSessionId: string } }).session
      .browserSessionId;
    // The live surface binds asynchronously after the session goes live.
    const deadline = Date.now() + 15_000;
    while (!binder.surfaceIdFor(id) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    return id;
  };
  const evaluate = (id: string, expression: string) =>
    automation.evaluate(authority, id, { expression, timeoutMs: 10_000 });
  const answers = async (id: string) =>
    expect(await evaluate(id, '1 + 1')).toMatchObject({ ok: true, value: '2' });

  beforeAll(async () => {
    if (!executablePath) return;
    const chromium = executablePath;
    fixture = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>site</title><p>a page with a site</p>');
    });
    const port = await new Promise<number>((resolve) =>
      fixture.listen(0, '127.0.0.1', () =>
        resolve((fixture.address() as AddressInfo).port),
      ),
    );
    fixtureUrl = `http://127.0.0.1:${port}/`;
    home = mkdtempSync(join(tmpdir(), 'station-blank-real-'));
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
      authorizeProject: async () => ({ kind: 'operator' }),
    });
    const settings = new BrowserProjectSettingsStore(home);
    settings.setBrowserEvaluate('alpha', true, 'operator');
    automation = new BrowserAutomation({
      sessions,
      surfaces,
      surfaceIdFor: (id) => binder.surfaceIdFor(id),
      settings,
      locatorEngine: loadLocatorEngineInstallExpression,
    });
    const decided = await authorizeBrowserAgentCaller(
      {
        sessionId: 'agent-session-blank',
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

  test('refuses on a new tab and on a browser-navigated about:blank, and runs on a page that went blank itself', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const blank = await open();
    expect(await evaluate(blank, SANDBOXED_SRCDOC)).toMatchObject({
      ok: false,
      code: 'browser-refused',
    });

    const site = await open(fixtureUrl);
    expect(await evaluate(site, 'location.href')).toMatchObject({
      ok: true,
      value: JSON.stringify(fixtureUrl),
    });
    // A page that navigates itself to about:blank keeps its origin and site.
    await evaluate(site, "location.href = 'about:blank'; true");
    const deadline = Date.now() + 10_000;
    let origin: unknown;
    while (Date.now() < deadline) {
      const read = await evaluate(site, 'location.href + " " + self.origin');
      origin = (read as { value?: unknown }).value;
      if (origin === JSON.stringify(`about:blank ${fixtureUrl.slice(0, -1)}`))
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(origin).toBe(
      JSON.stringify(`about:blank ${fixtureUrl.slice(0, -1)}`),
    );
    expect(await evaluate(site, SANDBOXED_SRCDOC)).toMatchObject({
      ok: true,
      value: '"loaded"',
    });

    // The browser, not the page, navigating to about:blank leaves no site.
    expect(
      await automation.navigate(authority, site, { url: 'about:blank' }),
    ).toMatchObject({ ok: true, url: 'about:blank' });
    expect(await evaluate(site, SANDBOXED_SRCDOC)).toMatchObject({
      ok: false,
      code: 'browser-refused',
    });
  }, 120_000);

  test('under Chrome 158 the refused trigger leaves the browser and its other tab answering', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    if (major === undefined || major < ABORTING_MAJOR)
      return ctx.skip(
        `the installed browser at ${executablePath} reports major version ${major ?? 'unknown'}; the abort this guards against needs Chrome ${ABORTING_MAJOR} or later`,
      );
    const other = await open(fixtureUrl);
    await answers(other);
    const blank = await open();
    expect(await evaluate(blank, SANDBOXED_SRCDOC)).toMatchObject({
      ok: false,
      code: 'browser-refused',
    });
    await answers(other);
    expect(sessions.getSession(blank)?.state).toBe('live');
    expect(sessions.getSession(other)?.state).toBe('live');
  }, 120_000);
});
