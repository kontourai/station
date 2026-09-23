/**
 * Real-Chromium integration test for the server Chromium host (#90 lane C).
 *
 * Runs against an INSTALLED Chrome/Edge only (never a download). When none is
 * installed every case reports an explicit skip naming why: a missing
 * prerequisite is not a pass.
 *
 * The browser gets its own temporary profile, a temporary download directory
 * (via the profile's Preferences, so a regression that stops denying
 * downloads writes there and never into the user's real Downloads folder),
 * and loopback fixture servers on ephemeral ports.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CdpTransport } from '../browser-host.js';
import {
  ChromiumAcquisition,
  defaultChromiumAcquisitionDeps,
} from '../chromium-acquisition.js';
import type { RegisteredLocalTarget } from '../egress-policy.js';
import {
  type ChromiumHostEvent,
  ChromiumServerHost,
  launchChromiumProcess,
} from '../hosts/chromium-server-host.js';
import {
  deriveStationListeners,
  localInterfaceAddresses,
  type StationListeners,
} from '../station-listeners.js';

// Only a system install counts; the acquisition's own Station home is a
// throwaway directory, so a previously downloaded build is never used and
// nothing is ever fetched.
const acquisitionHome = mkdtempSync(join(tmpdir(), 'station-browser-acq-'));
const acquisitionStatus = new ChromiumAcquisition(
  acquisitionHome,
  defaultChromiumAcquisitionDeps(),
).status();
const executablePath =
  acquisitionStatus.state === 'found-system'
    ? acquisitionStatus.executablePath
    : undefined;
const SKIP_REASON = `no installed Google Chrome / Microsoft Edge / Chromium was found (acquisition state: ${acquisitionStatus.state}); this real-browser test never downloads one`;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    );
  });
}

async function poll<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  // A read racing a navigation ("Inspected target navigated") is retried.
  const attempt = async () => {
    try {
      return { ok: true as const, value: await read() };
    } catch (error) {
      return { ok: false as const, error };
    }
  };
  let last = await attempt();
  while (!last.ok || !accept(last.value)) {
    if (Date.now() > deadline) {
      if (!last.ok) throw last.error;
      return last.value;
    }
    await new Promise((r) => setTimeout(r, 50));
    last = await attempt();
  }
  return last.value;
}

describe('ChromiumServerHost against a real installed Chromium', () => {
  const stationArrivals: string[] = [];
  const devArrivals: string[] = [];
  const events: ChromiumHostEvent[] = [];
  let station: Server;
  let dev: Server;
  let stationPort = 0;
  let devPort = 0;
  let workDir = '';
  let downloadDir = '';
  let host: ChromiumServerHost;
  let raw: CdpTransport | undefined;
  let session = '';
  let targetId = '';
  let blockedFile = '';

  const evaluate = async (expression: string): Promise<unknown> => {
    const result = await host.cdp().send<{ result: { value?: unknown } }>(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      session,
    );
    return result.result.value;
  };
  const href = () => evaluate('location.href') as Promise<string>;
  const gotoDev = async (path: string) => {
    const url = `http://127.0.0.1:${devPort}${path}`;
    await host.cdp().send('Page.navigate', { url }, session);
    return poll(
      () =>
        evaluate(
          'location.href + "|" + document.readyState',
        ) as Promise<string>,
      (value) => value === `${url}|complete`,
    );
  };

  beforeAll(async () => {
    if (!executablePath) return;
    station = createServer((req, res) => {
      stationArrivals.push(`http ${req.url}`);
      res.writeHead(200, { 'access-control-allow-origin': '*' });
      res.end('station');
    });
    station.on('upgrade', (req, socket) => {
      stationArrivals.push(`ws ${req.url}`);
      socket.destroy();
    });
    stationPort = await listen(station);
    dev = createServer((req, res) => {
      devArrivals.push(req.url ?? '');
      if (req.url === '/dl') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="denied.bin"',
        });
        res.end('should never be saved');
        return;
      }
      if (req.url === '/probe') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<script>
          const P = ${stationPort};
          const D = ${devPort};
          // Every spelling of this host, plus a DNS-rebinding style name the
          // egress resolver maps to 127.0.0.1.
          // Review H1: IPv4-mapped IPv6 in dotted, hex and expanded form.
          for (const h of ['127.0.0.1', 'localhost', 'probe.localhost', 'rebind.test',
            '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]']) {
            fetch('http://' + h + ':' + P + '/fetch-' + h).catch(() => {});
            try { new WebSocket('ws://' + h + ':' + P + '/ws-' + h); } catch {}
          }
          fetch('http://127.0.0.1:' + (P + 1) + '/terminal-port').catch(() => {});
          try { new WebSocket('ws://127.0.0.1:' + (P + 2) + '/voice-port'); } catch {}
          fetch('http://127.0.0.1:' + (P + 3) + '/consent-port').catch(() => {});
          new Worker('/worker.js');
          navigator.serviceWorker.register('/sw.js').catch(() => {});
          // Positive controls: other loopback ports stay reachable, by IP and
          // through a name that resolves to loopback.
          fetch('/ok').catch(() => {});
          fetch('http://devalias.test:' + D + '/alias-ok').catch(() => {});
        </script>probe`);
        return;
      }
      if (req.url === '/frames') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          `<iframe id="inline" srcdoc="<p>inline</p>"></iframe><iframe id="slot" src="about:blank"></iframe>`,
        );
        return;
      }
      if (req.url === '/worker.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(`fetch('http://127.0.0.1:${stationPort}/from-worker').catch(() => {});
          try { new WebSocket('ws://127.0.0.1:${stationPort}/ws-worker'); } catch {}
          fetch('/worker-ok').catch(() => {});`);
        return;
      }
      if (req.url === '/sw.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(`self.addEventListener('install', (event) => {
          event.waitUntil(Promise.allSettled([
            fetch('http://127.0.0.1:${stationPort}/from-service-worker'),
            fetch('/sw-ok'),
          ]));
        });`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>fixture ${req.url}</title>fixture`);
    });
    // The dev port must not collide with the block Station derives from its
    // port (server, +1 terminal, +2 voice, +3 consent).
    do {
      if (devPort) await new Promise<void>((r) => dev.close(() => r()));
      devPort = await listen(dev);
    } while (devPort >= stationPort && devPort <= stationPort + 3);

    workDir = mkdtempSync(join(tmpdir(), 'station-browser-real-'));
    const profileDir = join(workDir, 'profile');
    downloadDir = join(workDir, 'downloads');
    mkdirSync(join(profileDir, 'Default'), { recursive: true });
    mkdirSync(downloadDir);
    writeFileSync(
      join(profileDir, 'Default', 'Preferences'),
      JSON.stringify({
        download: {
          default_directory: downloadDir,
          prompt_for_download: false,
        },
        savefile: { default_directory: downloadDir },
      }),
    );
    blockedFile = join(workDir, 'secret.txt');
    writeFileSync(blockedFile, 'local file contents');

    const listeners = deriveStationListeners({
      serverPort: stationPort,
      configuredOrigins: [`http://127.0.0.1:${stationPort}`],
    });
    host = new ChromiumServerHost({
      executablePath,
      egressPolicy: {
        listeners: () => listeners,
        interfaceAddresses: localInterfaceAddresses,
        reach: { kind: 'operator' },
      },
      egress: {
        // Simulated DNS: two test names resolve to loopback, as a rebinding
        // attacker's name would. Everything else is refused as unresolvable.
        lookup: async (hostname) => {
          if (hostname === 'rebind.test' || hostname === 'devalias.test')
            return [{ address: '127.0.0.1' }];
          if (hostname === 'localhost' || hostname.endsWith('.localhost'))
            return [{ address: '127.0.0.1' }];
          throw new Error(`ENOTFOUND ${hostname}`);
        },
      },
      // The raw channel is captured ONLY to prove the network-layer guards
      // hold even for a caller that bypasses the guarded cdp() wrapper.
      launcher: (request) => {
        const launch = launchChromiumProcess(request);
        raw = launch.transport;
        return launch;
      },
      onEvent: (event) => events.push(event),
    });
    const target = await host.openTarget({
      profileDir,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    });
    session = target.cdpSessionId;
    targetId = target.targetId;
  }, 60_000);

  afterAll(async () => {
    if (!executablePath) {
      rmSync(acquisitionHome, { recursive: true, force: true });
      return;
    }
    await host?.shutdown().catch(() => {});
    await new Promise<void>((r) => (station ? station.close(() => r()) : r()));
    await new Promise<void>((r) => (dev ? dev.close(() => r()) : r()));
    rmSync(workDir, { recursive: true, force: true });
    rmSync(acquisitionHome, { recursive: true, force: true });
  }, 30_000);

  test('launches headless and navigates to a local fixture at the requested viewport', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    expect(await gotoDev('/hello')).toBe(
      `http://127.0.0.1:${devPort}/hello|complete`,
    );
    expect(await evaluate('document.title')).toBe('fixture /hello');
    expect(await evaluate('innerWidth + "x" + innerHeight')).toBe('800x600');
  });

  test('a file: navigation is refused by the guard AND failed by the network layer', async (ctx) => {
    if (!executablePath || !raw) return ctx.skip(SKIP_REASON);
    const fileUrl = pathToFileURL(blockedFile).href;
    await expect(
      host.cdp().send('Page.navigate', { url: fileUrl }, session),
    ).rejects.toMatchObject({ code: 'url-not-allowed' });
    // Bypassing the guard (as a buggy raw-channel caller would), the Fetch
    // document interception still fails the load before any byte is read.
    const result = await raw.send<{ errorText?: string }>(
      'Page.navigate',
      { url: fileUrl },
      session,
    );
    expect(result.errorText).toBe('net::ERR_BLOCKED_BY_CLIENT');
    expect(events).toContainEqual({
      kind: 'request-blocked',
      reason: 'disallowed-url',
      url: fileUrl,
    });
    expect(
      await evaluate('document.body ? document.body.innerText : ""'),
    ).not.toContain('local file contents');
  });

  test('a committed out-of-scope URL the network layer never sees is navigated away', async (ctx) => {
    if (!executablePath || !raw) return ctx.skip(SKIP_REASON);
    await raw.send(
      'Page.navigate',
      { url: 'data:text/html,<p>smuggled</p>' },
      session,
    );
    expect(await poll(href, (value) => value === 'about:blank')).toBe(
      'about:blank',
    );
    expect(events).toContainEqual({
      kind: 'committed-url-refused',
      targetId,
      frame: 'main',
      url: 'data:text/html,<p>smuggled</p>',
    });
  });

  test('downloads are denied: nothing is written', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    await host
      .cdp()
      .send(
        'Page.navigate',
        { url: `http://127.0.0.1:${devPort}/dl` },
        session,
      );
    await poll(
      async () => devArrivals.includes('/dl'),
      (seen) => seen,
    );
    // Give a (regressed) download time to start writing.
    await new Promise((r) => setTimeout(r, 1500));
    expect(devArrivals).toContain('/dl');
    expect(readdirSync(downloadDir)).toEqual([]);
  });

  test('a popup loads in the opener tab and the popup target is closed', async (ctx) => {
    if (!executablePath || !raw) return ctx.skip(SKIP_REASON);
    await gotoDev('/opener');
    await evaluate(`window.open('/popped'); true`);
    const landed = await poll(href, (value) => value.endsWith('/popped'));
    expect(landed).toBe(`http://127.0.0.1:${devPort}/popped`);
    const { targetInfos } = await raw.send<{
      targetInfos: Array<{
        targetId: string;
        type: string;
        url: string;
        openerId?: string;
      }>;
    }>('Target.getTargets');
    const survivors = await poll(
      async () =>
        (
          await raw!.send<{ targetInfos: typeof targetInfos }>(
            'Target.getTargets',
          )
        ).targetInfos.filter(
          (t) => t.type === 'page' && t.openerId === targetId,
        ),
      (list) => list.length === 0,
    );
    expect(survivors).toEqual([]);
    expect(events.some((e) => e.kind === 'popup-folded')).toBe(true);
  });

  test('permissions are denied by default', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    await gotoDev('/perm');
    expect(
      await evaluate(
        `navigator.permissions.query({ name: 'geolocation' }).then((r) => r.state)`,
      ),
    ).toBe('denied');
    expect(await evaluate('Notification.permission')).toBe('denied');
  });

  test('pages, workers and service workers cannot reach any Station listener, while other loopback ports work', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    await gotoDev('/probe');
    // Positive controls: the page, its worker and its service worker all ran
    // and reached the dev server, by IP and through a loopback-resolving name.
    const controls = ['/ok', '/alias-ok', '/worker-ok', '/sw-ok'];
    await poll(
      async () => controls.every((path) => devArrivals.includes(path)),
      (seen) => seen,
      15_000,
    );
    expect(devArrivals).toEqual(expect.arrayContaining(controls));
    // Allow every blocked attempt time to (wrongly) arrive.
    await new Promise((r) => setTimeout(r, 1500));
    // Top-level navigation to Station is refused as well, in every spelling.
    for (const h of [
      '127.0.0.1',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[0:0:0:0:0:ffff:7f00:1]',
    ]) {
      await host
        .cdp()
        .send(
          'Page.navigate',
          { url: `http://${h}:${stationPort}/nav` },
          session,
        )
        .catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 500));
    expect(stationArrivals).toEqual([]);
    // The refusals were decided on the resolved address, below the page.
    const refused = events.filter(
      (e): e is Extract<ChromiumHostEvent, { kind: 'egress-refused' }> =>
        e.kind === 'egress-refused',
    );
    const atStation = refused.filter(
      (e) => e.port >= stationPort && e.port <= stationPort + 3,
    );
    expect(atStation.map((e) => e.host)).toEqual(
      expect.arrayContaining([
        '127.0.0.1',
        'localhost',
        'rebind.test',
        '[::ffff:7f00:1]',
      ]),
    );
    expect(atStation.map((e) => e.refusal)).toEqual(
      atStation.map(() => 'station-listener'),
    );
  });

  test('review B2: the cdp() channel cannot smuggle browser-level methods', async (ctx) => {
    if (!executablePath || !raw) return ctx.skip(SKIP_REASON);
    const cdp = host.cdp();
    await expect(
      cdp.send('Target.attachToTarget', { targetId, flatten: false }, session),
    ).rejects.toMatchObject({ code: 'host-owned-method' });
    await expect(
      cdp.send(
        'Target.sendMessageToTarget',
        { targetId, message: '{"id":1,"method":"Browser.getVersion"}' },
        session,
      ),
    ).rejects.toMatchObject({ code: 'host-owned-method' });
    await expect(
      cdp.send('Target.attachToBrowserTarget', {}, session),
    ).rejects.toMatchObject({
      code: 'host-owned-method',
    });
    await expect(
      cdp.send(
        'Browser.setPermission',
        { permission: { name: 'geolocation' }, setting: 'granted' },
        session,
      ),
    ).rejects.toMatchObject({ code: 'host-owned-method' });
    await gotoDev('/perm-after-smuggle');
    expect(
      await evaluate(
        `navigator.permissions.query({ name: 'geolocation' }).then((r) => r.state)`,
      ),
    ).toBe('denied');
  });

  test('review B2: every page target in the browser is one this host opened', async (ctx) => {
    if (!executablePath || !raw) return ctx.skip(SKIP_REASON);
    const pages = await poll(
      async () =>
        (
          await raw!.send<{
            targetInfos: Array<{ targetId: string; type: string; url: string }>;
          }>('Target.getTargets')
        ).targetInfos.filter((t) => t.type === 'page'),
      (list) => list.length === 1,
    );
    expect(pages.map((t) => t.targetId)).toEqual([targetId]);
  });

  test('review S3: a data: subframe is replaced, an srcdoc subframe is kept', async (ctx) => {
    if (!executablePath || !raw) return ctx.skip(SKIP_REASON);
    await gotoDev('/frames');
    await evaluate(
      `document.getElementById('slot').src = 'data:text/html,<p>smuggled</p>'; true`,
    );
    type Tree = { frame: { url: string }; childFrames?: Tree[] };
    const childUrls = async () => {
      const { frameTree } = await raw!.send<{ frameTree: Tree }>(
        'Page.getFrameTree',
        {},
        session,
      );
      return (frameTree.childFrames ?? []).map((f) => f.frame.url);
    };
    const refusedDataFrame = () =>
      events.some(
        (e) =>
          e.kind === 'committed-url-refused' &&
          e.frame === 'subframe' &&
          e.url.startsWith('data:'),
      );
    await poll(
      async () => refusedDataFrame(),
      (seen) => seen,
      10_000,
    );
    const urls = await poll(
      childUrls,
      (list) => !list.some((u) => u.startsWith('data:')),
      10_000,
    );
    expect(urls.some((u) => u.startsWith('data:'))).toBe(false);
    expect(urls).toContain('about:srcdoc');
    expect(
      events.some(
        (e) =>
          e.kind === 'committed-url-refused' &&
          e.frame === 'subframe' &&
          e.url.startsWith('data:'),
      ),
    ).toBe(true);
  });

  test('D7: a Project admin profile reaches a loopback server only once it is registered', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const targets: RegisteredLocalTarget[] = [];
    const listeners: StationListeners = deriveStationListeners({
      serverPort: stationPort,
      configuredOrigins: [],
    });
    const adminHost = new ChromiumServerHost({
      executablePath,
      egressPolicy: {
        listeners: () => listeners,
        interfaceAddresses: localInterfaceAddresses,
        reach: { kind: 'project', localTargets: () => targets },
      },
    });
    try {
      const adminTarget = await adminHost.openTarget({
        profileDir: join(workDir, 'admin-profile'),
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      });
      const cdp = adminHost.cdp();
      await cdp.send(
        'Page.navigate',
        { url: `http://127.0.0.1:${devPort}/admin-blocked` },
        adminTarget.cdpSessionId,
      );
      await new Promise((r) => setTimeout(r, 1000));
      expect(devArrivals).not.toContain('/admin-blocked');
      targets.push({ host: 'localhost', port: devPort });
      await cdp.send(
        'Page.navigate',
        { url: `http://127.0.0.1:${devPort}/admin-ok` },
        adminTarget.cdpSessionId,
      );
      await poll(
        async () => devArrivals.includes('/admin-ok'),
        (seen) => seen,
      );
      expect(devArrivals).toContain('/admin-ok');
      // Station stays refused even for a registered-style request.
      await cdp.send(
        'Page.navigate',
        { url: `http://127.0.0.1:${stationPort}/admin-station` },
        adminTarget.cdpSessionId,
      );
      await new Promise((r) => setTimeout(r, 500));
      expect(stationArrivals).toEqual([]);
    } finally {
      await adminHost.shutdown();
    }
    // A second browser launch; generous for a loaded shared host.
  }, 120_000);

  test('a killed browser is reported through onExit and the host refuses further work', async (ctx) => {
    if (!executablePath) return ctx.skip(SKIP_REASON);
    const pid = host.pid;
    expect(pid).toBeTypeOf('number');
    const exit = new Promise<string>((resolve) => host.onExit(resolve));
    process.kill(pid as number, 'SIGKILL');
    const reason = await exit;
    expect(reason).toMatch(/exited/);
    await expect(
      host.openTarget({
        profileDir: join(workDir, 'profile'),
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      }),
    ).rejects.toMatchObject({ name: 'BrowserHostExitedError' });
    expect(() => process.kill(pid as number, 0)).toThrow();
  });
});
