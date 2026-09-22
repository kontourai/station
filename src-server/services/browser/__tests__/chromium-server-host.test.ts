import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CdpTransport } from '../browser-host.js';
import {
  BrowserHostExitedError,
  BrowserHostPolicyError,
  buildChromiumArgs,
  type ChromiumHostEvent,
  type ChromiumLauncher,
  ChromiumServerHost,
  chromiumEnvironment,
  decidePausedRequest,
} from '../hosts/chromium-server-host.js';
import { deriveStationListeners } from '../station-listeners.js';

const LISTENERS = deriveStationListeners({
  serverPort: 4100,
  configuredOrigins: ['http://localhost:4200'],
});
const VIEWPORT = { width: 800, height: 600, deviceScaleFactor: 1 };

interface SentCall {
  method: string;
  params?: object;
  sessionId?: string;
}

function fakeTransport(respond: (call: SentCall) => unknown = () => ({})) {
  const calls: SentCall[] = [];
  const listeners = new Map<string, Set<(p: unknown, s?: string) => void>>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  let targetSeq = 0;
  const transport: CdpTransport = {
    async send<R>(method: string, params?: object, sessionId?: string) {
      const call = { method, params, sessionId };
      calls.push(call);
      if (method === 'Target.createTarget') {
        targetSeq += 1;
        return { targetId: `T${targetSeq}` } as R;
      }
      if (method === 'Target.attachToTarget') {
        return {
          sessionId: `S-${(params as { targetId: string }).targetId}`,
        } as R;
      }
      const result = respond(call);
      if (result instanceof Error) throw result;
      return (result ?? {}) as R;
    },
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return () => set.delete(fn);
    },
    async close() {
      resolveClosed();
    },
    closed,
  };
  const emit = (event: string, params: unknown, sessionId?: string) => {
    for (const fn of listeners.get(event) ?? []) fn(params, sessionId);
  };
  return { transport, calls, emit };
}

const profiles: string[] = [];
const hosts: ChromiumServerHost[] = [];
afterEach(async () => {
  // Every launch owns a real loopback egress proxy; release them all.
  for (const host of hosts.splice(0)) await host.shutdown().catch(() => {});
  for (const dir of profiles.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function harness(respond?: (call: SentCall) => unknown) {
  const fake = fakeTransport(respond);
  let exit!: (reason: string) => void;
  const exited = new Promise<string>((r) => {
    exit = r;
  });
  const terminate = vi.fn(async () => exit('terminated'));
  const launcher = vi.fn<ChromiumLauncher>(() => ({
    transport: fake.transport,
    pid: 4242,
    exited,
    terminate,
  }));
  const events: ChromiumHostEvent[] = [];
  const host = new ChromiumServerHost({
    executablePath: '/fake/chrome',
    stationListeners: () => LISTENERS,
    launcher,
    onEvent: (event) => events.push(event),
  });
  hosts.push(host);
  const profileDir = mkdtempSync(join(tmpdir(), 'station-browser-profile-'));
  profiles.push(profileDir);
  return { ...fake, host, launcher, terminate, exit, events, profileDir };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('launch arguments and environment', () => {
  test('headless pipe launch with the per-profile dir, all traffic through the egress proxy', () => {
    const args = buildChromiumArgs({
      profileDir: '/p',
      proxyServer: 'http://127.0.0.1:5555',
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '--headless=new',
        '--remote-debugging-pipe',
        '--user-data-dir=/p',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--proxy-server=http://127.0.0.1:5555',
        '--proxy-bypass-list=<-loopback>',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ]),
    );
    expect(args.some((arg) => arg.startsWith('--remote-debugging-port'))).toBe(
      false,
    );
  });

  test('refuses to build a launch without a loopback egress proxy', () => {
    for (const proxyServer of [
      '',
      'http://10.0.0.1:8080',
      'socks5://127.0.0.1:1080',
    ]) {
      expect(() =>
        buildChromiumArgs({ profileDir: '/p', proxyServer }),
      ).toThrow(/egress proxy/);
    }
  });

  test("the browser never inherits Station's secrets", () => {
    const env = chromiumEnvironment({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: 'sk-secret',
      STATION_INTERNAL_API_TOKEN: 'tok',
      GITHUB_TOKEN: 'gh',
      AWS_SECRET_ACCESS_KEY: 'aws',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      LANG: 'en_US.UTF-8',
    });
  });
});

describe('decidePausedRequest', () => {
  const context = {
    stationListeners: LISTENERS,
    popupFrameIds: new Set(['POP']),
  };
  test.each([
    ['http://127.0.0.1:4100/api/system', 'XHR', undefined, 'station-self'],
    ['http://localhost:4200/', 'Document', undefined, 'station-self'],
    ['http://probe.localhost:4101/', 'Fetch', undefined, 'station-self'],
    ['file:///etc/passwd', 'Document', undefined, 'disallowed-url'],
    ['https://u:p@example.com/', 'Document', undefined, 'disallowed-url'],
    ['https://example.com/', 'Document', 'POP', 'popup'],
  ])('%s (%s) is failed as %s', (url, resourceType, frameId, reason) => {
    expect(
      decidePausedRequest({ url, resourceType, frameId }, context),
    ).toEqual({
      action: 'fail',
      reason,
    });
  });

  test.each([
    ['http://127.0.0.1:5173/', 'Document'],
    ['https://example.com/app.js', 'Script'],
    ['http://localhost:4104/', 'Fetch'],
  ])('%s (%s) continues', (url, resourceType) => {
    expect(
      decidePausedRequest({ url, resourceType, frameId: 'F' }, context),
    ).toEqual({
      action: 'continue',
    });
  });
});

describe('ChromiumServerHost with a fake browser', () => {
  test('installs every enforcement before the first target exists', async () => {
    const { host, calls, profileDir, launcher } = harness();
    const target = await host.openTarget({ profileDir, viewport: VIEWPORT });
    expect(target).toEqual({ targetId: 'T1', cdpSessionId: 'S-T1' });
    expect(launcher).toHaveBeenCalledTimes(1);
    const methods = calls.map((c) => c.method);
    const firstTarget = methods.indexOf('Target.createTarget');
    const before = calls.slice(0, firstTarget);
    expect(before).toContainEqual({
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'deny', eventsEnabled: true },
      sessionId: undefined,
    });
    for (const name of [
      'geolocation',
      'notifications',
      'camera',
      'microphone',
      'clipboard-read',
    ]) {
      expect(before).toContainEqual({
        method: 'Browser.setPermission',
        params: { permission: { name }, setting: 'denied' },
        sessionId: undefined,
      });
    }
    const fetchEnable = before.find((c) => c.method === 'Fetch.enable');
    expect(fetchEnable?.sessionId).toBeUndefined();
    expect(fetchEnable?.params).toEqual({
      patterns: [
        { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
        { urlPattern: '*:4100/*', requestStage: 'Request' },
        { urlPattern: '*:4101/*', requestStage: 'Request' },
        { urlPattern: '*:4102/*', requestStage: 'Request' },
        { urlPattern: '*:4103/*', requestStage: 'Request' },
        { urlPattern: '*:4200/*', requestStage: 'Request' },
      ],
    });
    // The launch went through the egress proxy.
    const args = launcher.mock.calls[0]?.[0].args ?? [];
    expect(args.find((arg) => arg.startsWith('--proxy-server='))).toMatch(
      /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/,
    );
    expect(before.map((c) => c.method)).toContain('Target.setDiscoverTargets');
    expect(calls).toContainEqual({
      method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
      sessionId: 'S-T1',
    });
  });

  test('a refused mandatory enforcement step tears the launch down (fail closed)', async () => {
    const { host, profileDir, terminate, calls } = harness((call) =>
      call.method === 'Browser.setDownloadBehavior' ? new Error('nope') : {},
    );
    await expect(
      host.openTarget({ profileDir, viewport: VIEWPORT }),
    ).rejects.toThrow('nope');
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.method)).not.toContain('Target.createTarget');
    await expect(
      host.openTarget({ profileDir, viewport: VIEWPORT }),
    ).rejects.toBeInstanceOf(BrowserHostExitedError);
  });

  test('paused requests: Station-bound and out-of-scope documents fail, the rest continue', async () => {
    const { host, profileDir, emit, calls, events } = harness();
    await host.openTarget({ profileDir, viewport: VIEWPORT });
    emit('Fetch.requestPaused', {
      requestId: 'r1',
      request: { url: 'http://127.0.0.1:4100/api' },
      resourceType: 'XHR',
      frameId: 'T1',
    });
    emit('Fetch.requestPaused', {
      requestId: 'r2',
      request: { url: 'file:///etc/hosts' },
      resourceType: 'Document',
      frameId: 'T1',
    });
    emit('Fetch.requestPaused', {
      requestId: 'r3',
      request: { url: 'http://127.0.0.1:5173/' },
      resourceType: 'Document',
      frameId: 'T1',
    });
    await flush();
    expect(calls).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: 'r1', errorReason: 'BlockedByClient' },
      sessionId: undefined,
    });
    expect(calls).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: 'r2', errorReason: 'BlockedByClient' },
      sessionId: undefined,
    });
    expect(calls).toContainEqual({
      method: 'Fetch.continueRequest',
      params: { requestId: 'r3' },
      sessionId: undefined,
    });
    expect(events.filter((e) => e.kind === 'request-blocked')).toHaveLength(2);
  });

  test('a popup from our target is closed and its URL loads in the opener', async () => {
    const { host, profileDir, emit, calls } = harness();
    await host.openTarget({ profileDir, viewport: VIEWPORT });
    emit('Target.targetCreated', {
      targetInfo: { targetId: 'P1', type: 'page', url: '', openerId: 'T1' },
    });
    // The popup's own document request is failed rather than loaded.
    emit('Fetch.requestPaused', {
      requestId: 'rp',
      request: { url: 'https://example.com/w' },
      resourceType: 'Document',
      frameId: 'P1',
    });
    await flush();
    expect(calls).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: 'rp', errorReason: 'BlockedByClient' },
      sessionId: undefined,
    });
    expect(calls).toContainEqual({
      method: 'Target.closeTarget',
      params: { targetId: 'P1' },
      sessionId: undefined,
    });
    expect(calls).toContainEqual({
      method: 'Page.navigate',
      params: { url: 'https://example.com/w' },
      sessionId: 'S-T1',
    });
  });

  test('a popup to an out-of-scope URL is closed without navigating the opener', async () => {
    const { host, profileDir, emit, calls } = harness();
    await host.openTarget({ profileDir, viewport: VIEWPORT });
    emit('Target.targetInfoChanged', {
      targetInfo: {
        targetId: 'P2',
        type: 'page',
        url: 'file:///etc/hosts',
        openerId: 'T1',
      },
    });
    await flush();
    expect(calls).toContainEqual({
      method: 'Target.closeTarget',
      params: { targetId: 'P2' },
      sessionId: undefined,
    });
    expect(calls.filter((c) => c.method === 'Page.navigate')).toEqual([]);
  });

  test('pages not opened by our targets are left alone', async () => {
    const { host, profileDir, emit, calls } = harness();
    await host.openTarget({ profileDir, viewport: VIEWPORT });
    emit('Target.targetCreated', {
      targetInfo: { targetId: 'X', type: 'page', url: 'https://a.example/' },
    });
    await flush();
    expect(calls.filter((c) => c.method === 'Target.closeTarget')).toEqual([]);
  });

  test('a committed out-of-scope main-frame URL is navigated away', async () => {
    const { host, profileDir, emit, calls, events } = harness();
    await host.openTarget({ profileDir, viewport: VIEWPORT });
    emit(
      'Page.frameNavigated',
      { frame: { url: 'chrome-error://chromewebdata/' } },
      'S-T1',
    );
    emit(
      'Page.frameNavigated',
      { frame: { url: 'data:text/html,x', parentId: 'F' } },
      'S-T1',
    );
    emit(
      'Page.frameNavigated',
      { frame: { url: 'data:text/html,x' } },
      'S-OTHER',
    );
    await flush();
    expect(calls.filter((c) => c.method === 'Page.navigate')).toEqual([]);
    emit('Page.frameNavigated', { frame: { url: 'data:text/html,x' } }, 'S-T1');
    await flush();
    expect(calls).toContainEqual({
      method: 'Page.navigate',
      params: { url: 'about:blank' },
      sessionId: 'S-T1',
    });
    expect(events).toContainEqual({
      kind: 'committed-url-refused',
      targetId: 'T1',
      url: 'data:text/html,x',
    });
  });

  test('the public cdp() channel refuses host-owned methods and out-of-scope navigation', async () => {
    const { host, profileDir, calls } = harness();
    await host.openTarget({ profileDir, viewport: VIEWPORT });
    const cdp = host.cdp();
    for (const method of [
      'Fetch.disable',
      'Fetch.enable',
      'Fetch.continueRequest',
      'Browser.setDownloadBehavior',
      'Page.setDownloadBehavior',
      'Browser.grantPermissions',
      'Target.createTarget',
      'Target.createBrowserContext',
    ]) {
      await expect(cdp.send(method, {})).rejects.toMatchObject({
        name: 'BrowserHostPolicyError',
        code: 'host-owned-method',
      });
    }
    for (const url of [
      'file:///etc/passwd',
      'data:text/html,x',
      'chrome://version',
      'view-source:https://a.b/',
      'javascript:1',
    ]) {
      await expect(
        cdp.send('Page.navigate', { url }, 'S-T1'),
      ).rejects.toBeInstanceOf(BrowserHostPolicyError);
    }
    const before = calls.length;
    await cdp.send('Page.navigate', { url: 'https://example.com/' }, 'S-T1');
    expect(calls.slice(before)).toEqual([
      {
        method: 'Page.navigate',
        params: { url: 'https://example.com/' },
        sessionId: 'S-T1',
      },
    ]);
  });

  test('a second profile directory is refused: one process per profile', async () => {
    const { host, profileDir } = harness();
    await host.openTarget({ profileDir, viewport: VIEWPORT });
    await expect(
      host.openTarget({
        profileDir: `${profileDir}-other`,
        viewport: VIEWPORT,
      }),
    ).rejects.toMatchObject({ code: 'profile-mismatch' });
  });

  test('process exit reaches onExit once and the host becomes unusable', async () => {
    const { host, profileDir, exit } = harness();
    await host.openTarget({ profileDir, viewport: VIEWPORT });
    const reasons: string[] = [];
    host.onExit((reason) => reasons.push(reason));
    exit('browser process exited (code none, signal SIGKILL)');
    await flush();
    expect(reasons).toEqual([
      'browser process exited (code none, signal SIGKILL)',
    ]);
    await expect(
      host.openTarget({ profileDir, viewport: VIEWPORT }),
    ).rejects.toBeInstanceOf(BrowserHostExitedError);
    await expect(
      host.cdp().send('Runtime.evaluate', {}),
    ).rejects.toBeInstanceOf(BrowserHostExitedError);
    // A late subscriber still learns about the exit.
    const late = await new Promise<string>((resolve) => host.onExit(resolve));
    expect(late).toMatch(/SIGKILL/);
  });

  test('shutdown terminates the process tree and reports shutdown', async () => {
    const { host, profileDir, terminate, calls } = harness();
    await host.openTarget({ profileDir, viewport: VIEWPORT });
    const reasons: string[] = [];
    host.onExit((reason) => reasons.push(reason));
    await host.shutdown();
    expect(calls.map((c) => c.method)).toContain('Browser.close');
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(reasons).toEqual(['shutdown']);
  });
});
