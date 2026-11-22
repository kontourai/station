/**
 * An agent's `browser_evaluate` on a blank Browser pane tab against a REAL
 * installed Chromium. Chrome 158 aborts the whole browser, closing every tab,
 * when script on an about:blank page the browser opened adds a
 * `sandbox="allow-scripts"` srcdoc frame (`site_instance_impl.cc` CHECK
 * `has_site_`); Chrome 157 does not. Station refuses evaluation on such a
 * page and keeps it on pages that have a site, including an about:blank a
 * page navigated to itself. The check and the script share one page-world
 * context, so a navigation landing between them fails the script instead of
 * running it in the new blank document.
 *
 * These cases are the behavioural witness for the check's logic: the unit
 * fake evaluates the check against a modelled URL and origin, but only a real
 * browser decides which pages have a site.
 *
 * Runs against Playwright's Chromium under `PLAYWRIGHT_BROWSERS_PATH` when
 * one is there (the pinned Chrome for Testing), else an INSTALLED
 * Chrome/Edge; never a download. Hosted full regression binds the pinned
 * browser as `google-chrome` for the process-exclusive group, which is why
 * this file belongs to it. Without a browser every case reports an explicit
 * skip; the survival case also skips below Chrome 158, and a line on stderr
 * and the case titles name the browser it found.
 */
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { stationControlCallerPrincipal } from '../../../tools/station-control-shared.js';
import { LiveSurfaceRegistry } from '../../live-surface/registry.js';
import {
  authorizeBrowserAgentCaller,
  type BrowserAgentAuthority,
} from '../browser-agent-authority.js';
import { BrowserAutomation } from '../browser-automation.js';
import {
  type CdpTransport,
  createLocalBrowserHostResolver,
} from '../browser-host.js';
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
import { playwrightChromium } from './real-chromium-selection.js';

// Created before the suite's own afterAll, so it is removed after the browser
// that uses these directories has shut down (after-hooks run in reverse order).
const makeTempDir = trackTempDirs({ lifetime: 'file' });
const acquisitionHome = makeTempDir('station-blank-acq-');
const acquisitionStatus = new ChromiumAcquisition(
  acquisitionHome,
  defaultChromiumAcquisitionDeps(),
).status();
const executablePath =
  playwrightChromium() ??
  (acquisitionStatus.state === 'found-system'
    ? acquisitionStatus.executablePath
    : undefined);
const SKIP_REASON = `no Playwright Chromium under PLAYWRIGHT_BROWSERS_PATH and no installed Google Chrome / Microsoft Edge / Chromium was found (acquisition state: ${acquisitionStatus.state}); this real-browser test never downloads one`;

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
const BROWSER = executablePath
  ? `major version ${major ?? 'unknown'} at ${executablePath}`
  : 'none';
const SURVIVAL_SKIP =
  executablePath && (major === undefined || major < ABORTING_MAJOR)
    ? `browser ${BROWSER}: the abort this guards against needs Chrome ${ABORTING_MAJOR} or later, so the survival case does not apply`
    : undefined;
// The default reporter shows only a count of skipped cases and none of what
// a test logs through console; say why on the process's own stderr.
for (const reason of executablePath ? [SURVIVAL_SKIP] : [SKIP_REASON])
  if (reason)
    process.stderr.write(`[browser-blank-tab-evaluate] skipped: ${reason}\n`);

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
  let host: ChromiumServerHost | undefined;
  /** Runs before each page CDP call the tools send; a test sets it. */
  let interpose:
    | ((
        method: string,
        params: object | undefined,
        sessionId: string | undefined,
        transport: CdpTransport,
      ) => Promise<void>)
    | undefined;

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
    home = makeTempDir('station-blank-real-');
    const stationPort = port > 60_000 ? port - 10 : port + 10;
    const listeners = deriveStationListeners({
      serverPort: stationPort,
      configuredOrigins: [`http://127.0.0.1:${stationPort}`],
    });
    sessions = new BrowserSessionRegistry({
      stationHome: home,
      hostResolver: createLocalBrowserHostResolver(() => {
        const created = new ChromiumServerHost({
          executablePath: chromium,
          egressPolicy: {
            listeners: () => listeners,
            interfaceAddresses: localInterfaceAddresses,
            reach: { kind: 'operator' },
          },
          launchTimeoutMs: 120_000,
        });
        const guarded = created.cdp.bind(created);
        created.cdp = () => {
          const transport = guarded();
          return {
            send: async (method, params, sessionId) => {
              await interpose?.(method, params, sessionId, transport);
              return transport.send(method, params, sessionId);
            },
            on: (event, fn) => transport.on(event, fn),
            close: () => transport.close(),
            closed: transport.closed,
          };
        };
        host = created;
        return created;
      }),
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
    interpose = undefined;
    if (executablePath) {
      await binder?.dispose().catch(() => {});
      await sessions?.shutdown().catch(() => {});
      await surfaces?.dispose().catch(() => {});
      await new Promise<void>((r) =>
        fixture ? fixture.close(() => r()) : r(),
      );
    }
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

  test(`a site-less about:blank#x and about:blank?x tab, reached by raw CDP navigation, is refused, and the browser reports an opaque origin for it (browser: ${BROWSER})`, async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const other = await open(fixtureUrl);
    const site = await open(`${fixtureUrl}hash`);
    await answers(site);
    const target = sessions.liveTarget(site)!.target;
    const contextOrigin = () => {
      const world = host?.mainWorld(target.targetId);
      return world === undefined
        ? undefined
        : host?.mainWorldOrigin(target.targetId, world);
    };
    // A page's own origin is a real one in the browser's report.
    expect(contextOrigin()).toBe(fixtureUrl.slice(0, -1));
    for (const address of ['about:blank#x', 'about:blank?x']) {
      const before = host?.mainWorld(target.targetId);
      // The host's policy transport refuses these addresses, as Station's own
      // inputs cannot reach them; the browser's raw connection does not.
      const raw = (
        host as unknown as { running: { launch: { transport: CdpTransport } } }
      ).running.launch.transport;
      await raw.send('Page.navigate', { url: address }, target.cdpSessionId);
      const deadline = Date.now() + 10_000;
      while (
        [undefined, before].includes(host?.mainWorld(target.targetId)) &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 20));
      expect(host?.mainWorld(target.targetId)).not.toBe(before);
      expect(contextOrigin()).toBe('://');
      expect(await evaluate(site, SANDBOXED_SRCDOC)).toMatchObject({
        ok: false,
        code: 'browser-refused',
      });
    }
    await answers(other);
  }, 120_000);

  test(`a page on a second hostname (localhost, not 127.0.0.1) runs evaluate, and so does a fixture page after a blank tab was refused (browser: ${BROWSER})`, async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const localhostUrl = fixtureUrl.replace('127.0.0.1', 'localhost');
    const page = await open(localhostUrl);
    expect(await evaluate(page, 'location.origin')).toMatchObject({
      ok: true,
      value: JSON.stringify(localhostUrl.slice(0, -1)),
    });
    expect(await evaluate(page, SANDBOXED_SRCDOC)).toMatchObject({
      ok: true,
      value: '"loaded"',
    });
  }, 120_000);

  test(`a navigation to about:blank between the check and the script: the script does not run there, and the browser keeps answering (browser: ${BROWSER})`, async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const other = await open(fixtureUrl);
    const site = await open(`${fixtureUrl}race`);
    await answers(site);
    const target = sessions.liveTarget(site)!.target;
    // The address bar's navigation lands after the check answered and
    // before the agent's script reaches the page: the race, made certain.
    // The script is recognised whether or not it names a context, so an
    // unbound script would run in the blank page (and abort Chrome 158).
    const checked = host?.mainWorld(target.targetId);
    expect(checked).toBeDefined();
    interpose = async (method, params, sessionId, transport) => {
      const p = params as { contextId?: number; silent?: boolean };
      if (
        method !== 'Runtime.evaluate' ||
        sessionId !== target.cdpSessionId ||
        p.contextId !== undefined ||
        p.silent === true
      )
        return;
      interpose = undefined;
      await transport.send('Page.navigate', { url: 'about:blank' }, sessionId);
      const deadline = Date.now() + 10_000;
      while (
        [undefined, checked].includes(host?.mainWorld(target.targetId)) &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 20));
      expect(host?.mainWorld(target.targetId)).not.toBe(checked);
    };
    const result = await evaluate(site, SANDBOXED_SRCDOC);
    expect(interpose).toBeUndefined();
    expect(result).toMatchObject({ ok: false, code: 'browser-error' });
    expect((result as { message: string }).message).toMatch(
      /navigated before the script ran, so it did not run/,
    );
    // The tab is on the site-less blank page now, and refused there.
    expect(await evaluate(site, SANDBOXED_SRCDOC)).toMatchObject({
      ok: false,
      code: 'browser-refused',
    });
    await answers(other);
    expect(sessions.getSession(site)?.state).toBe('live');
    expect(sessions.getSession(other)?.state).toBe('live');
  }, 120_000);

  test(`under Chrome ${ABORTING_MAJOR} the refused trigger leaves the browser and its other tab answering (browser: ${BROWSER})`, async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    if (SURVIVAL_SKIP) return ctx.skip(SURVIVAL_SKIP);
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
