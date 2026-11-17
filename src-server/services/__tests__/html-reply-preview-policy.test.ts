import { rm } from 'node:fs/promises';
import { Server } from 'node:http';
import { beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { installLoggerLineSink } from '../../utils/logger.js';
import { BrowserEgressProxy } from '../browser/browser-egress-proxy.js';
import type { CdpTransport } from '../browser/browser-host.js';
import {
  type ChromiumServerHostOptions,
  SERVED_DOCUMENT_URL,
} from '../browser/hosts/chromium-server-host.js';

const probe = vi.hoisted(() => ({
  authored: false,
  policyRead: false,
  restrictive: false,
  cleanupFailure: false,
  flood: false,
  exitDuringRender: false,
  launchFailure: undefined as Error | undefined,
  launchArgs: undefined as readonly string[] | undefined,
  navigations: [] as string[],
  servedDocuments: [] as (string | undefined)[],
  tokens: [] as string[],
  observe: undefined as ChromiumServerHostOptions['onEvent'],
  late: undefined as (() => void) | undefined,
  cleanup: undefined as (() => Promise<void>) | undefined,
  removeProfile: undefined as (() => Promise<void>) | undefined,
}));
beforeEach(() => {
  probe.authored = false;
  probe.policyRead = false;
  probe.restrictive = false;
  probe.cleanupFailure = false;
  probe.flood = false;
  probe.exitDuringRender = false;
  probe.launchFailure = undefined;
  probe.launchArgs = undefined;
  probe.navigations = [];
  probe.servedDocuments = [];
  probe.tokens = [];
  probe.observe = undefined;
  probe.late = undefined;
});
vi.mock('../browser/chromium-acquisition.js', () => ({
  ChromiumAcquisition: class {
    resolveExecutable() {
      return '/fixture/chrome';
    }
  },
}));
vi.mock('../browser/hosts/chromium-server-host.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../browser/hosts/chromium-server-host.js')
    >();
  return {
    ...actual,
    ChromiumServerHost: class extends actual.ChromiumServerHost {
      constructor(options: ChromiumServerHostOptions) {
        let target = 0;
        let internal = false;
        let policyUrl = '';
        let resolveExit!: (reason: string) => void;
        const exited = new Promise<string>((resolve) => {
          resolveExit = resolve;
        });
        const listeners = new Map<
          string,
          Set<(params: unknown, sessionId?: string) => void>
        >();
        const transport: CdpTransport = {
          closed: Promise.resolve(),
          close: async () => {},
          on(event, callback) {
            const list = listeners.get(event) ?? new Set();
            list.add(callback);
            listeners.set(event, list);
            return () => {
              list.delete(callback);
            };
          },
          async send<R>(
            method: string,
            params?: object,
            sessionId?: string,
          ): Promise<R> {
            if (method === 'Target.createTarget') {
              policyUrl = (params as { url?: string })?.url ?? '';
              internal = [
                'chrome://prefs-internals/webrtc.ip_handling_policy',
                'chrome://prefs-internals/webrtc.ip_handling_url',
              ].includes(policyUrl);
              return { targetId: `T${++target}` } as R;
            }
            if (method === 'Target.attachToTarget')
              return { sessionId: 'policy-session' } as R;
            if (method === 'Page.navigate') {
              policyUrl = (params as { url?: string })?.url ?? '';
              probe.navigations.push(policyUrl);
            }
            internal = [
              'chrome://prefs-internals/webrtc.ip_handling_policy',
              'chrome://prefs-internals/webrtc.ip_handling_url',
            ].includes(policyUrl);
            if (method === 'Page.getFrameTree')
              return {
                frameTree: {
                  frame: {
                    id: 'policy-frame',
                    loaderId: 'policy-loader',
                    url: internal ? policyUrl : 'about:blank',
                  },
                },
              } as R;
            if (method === 'Page.createIsolatedWorld') {
              if (
                !internal ||
                (params as { frameId?: string })?.frameId !== 'policy-frame'
              )
                throw new Error('Policy world was not bound to its frame');
              return { executionContextId: 41 } as R;
            }
            if (method === 'Target.closeTarget') internal = false;
            if (method === 'Page.navigate')
              for (const callback of listeners.get('Page.loadEventFired') ?? [])
                callback({}, sessionId);
            if (method === 'Runtime.callFunctionOn') {
              if (
                internal &&
                (params as { executionContextId?: number })
                  ?.executionContextId === 41 &&
                (params as { awaitPromise?: boolean })?.awaitPromise === true
              ) {
                probe.policyRead = true;
                // Resolved browser value overrides the restrictive profile file.
                return {
                  result: {
                    value: {
                      policy: probe.restrictive
                        ? 'disable_non_proxied_udp'
                        : 'default',
                      urlOverrides: false,
                    },
                  },
                } as R;
              }
              probe.authored = true;
              const token = (params as { arguments?: { value?: unknown }[] })
                ?.arguments?.[1]?.value;
              if (typeof token === 'string') probe.tokens.push(token);
              if (probe.exitDuringRender) {
                resolveExit('fixture exited during render');
                await exited;
              }
              if (probe.flood) {
                for (let i = 0; i < 65_600; i++)
                  for (const callback of listeners.get(
                    'Target.targetDestroyed',
                  ) ?? [])
                    callback({ targetId: `secret-native-id-${i}` });
              }
              throw new Error('Authored content reached an unverified browser');
            }
            if (method === 'Runtime.evaluate')
              return { result: { objectId: 'fixture-global' } } as R;
            return {} as R;
          },
        };
        super({
          ...options,
          onEvent: (event) => {
            probe.observe?.(event);
            options.onEvent?.(event);
          },
          launcher: (request) => {
            probe.launchArgs = request.args;
            const directory = request.args
              .find((arg) => arg.startsWith('--user-data-dir='))
              ?.slice('--user-data-dir='.length);
            probe.removeProfile = directory
              ? () => rm(directory, { recursive: true, force: true })
              : undefined;
            if (probe.launchFailure) throw probe.launchFailure;
            probe.late = () =>
              request.onDiagnostic?.({
                type: 'child-exit',
                code: null,
                signal: 'SIGABRT',
              });
            return {
              transport,
              pid: undefined,
              exited,
              terminate: async () => {
                if (probe.cleanupFailure)
                  throw new Error('fixture cleanup failure');
                resolveExit('terminated');
              },
            };
          },
        });
        probe.cleanup = () => this.shutdown();
      }
      override async openTarget(
        p: Parameters<
          InstanceType<typeof actual.ChromiumServerHost>['openTarget']
        >[0],
      ) {
        probe.servedDocuments.push(p.document);
        return super.openTarget(p);
      }
    },
  };
});

test('render keeps primary rejection separate from cleanup failure, late exit and capped close facts', async () => {
  const lines: string[] = [];
  installLoggerLineSink({ writeLine: (line) => lines.push(line) });
  probe.restrictive = true;
  probe.cleanupFailure = true;
  probe.flood = true;
  try {
    const service = new HtmlReplyPreview(makeTempDir('html-preview-cleanup-'));
    await expect(
      service.render(
        { html: 'secret-authored-canary', height: 400 },
        800,
        'dark',
      ),
    ).rejects.toThrow('fixture cleanup failure');
    const receipts = () =>
      lines
        .map((line) => JSON.parse(line))
        .filter((line) => line.previewTerminalReceipt)
        .map((line) => line.previewTerminalReceipt);
    const initial = receipts()[0];
    expect(initial.terminal.phases).toMatchObject({
      primary: 'REJECTED',
      surfaced: 'REJECTED',
      shutdown: 'REJECTED',
      terminate: 'REJECTED',
      proxyClose: 'NOT_REACHED',
      workSettlement: 'NOT_REACHED',
      profileRemoval: 'NOT_REACHED',
      slotRelease: 'NOT_REACHED',
    });
    expect(initial.terminal.child).toBe('UNOBSERVED');
    expect(initial.closes).toHaveLength(16);
    expect(initial.closeFactsDropped).toBe(65535);
    expect(initial.identityExhausted).toBe(true);
    expect(initial.countersSaturated).toBe(true);
    expect(
      initial.closes.some(
        (fact: { target: string | null }) => fact.target === null,
      ),
    ).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(initial))).toBeLessThanOrEqual(
      6144,
    );
    expect(
      Buffer.byteLength(JSON.stringify(initial.terminal)),
    ).toBeLessThanOrEqual(2048);
    for (const fact of initial.closes)
      expect(Buffer.byteLength(JSON.stringify(fact))).toBeLessThanOrEqual(128);
    probe.late?.();
    probe.late?.();
    const all = receipts();
    expect(all).toHaveLength(2);
    expect(all[1].terminal.child).toEqual({
      type: 'child-exit',
      code: null,
      signal: 'SIGABRT',
    });
    expect(all[1].late).toBe(true);
    expect(all[1].sequence).toBeGreaterThanOrEqual(initial.sequence);
    expect(all[0].terminal.child).toBe('UNOBSERVED');
    expect(JSON.stringify(all)).not.toMatch(
      /secret-authored-canary|secret-native-id|fixture-global/,
    );
  } finally {
    probe.cleanupFailure = false;
    await probe.cleanup?.();
    await probe.removeProfile?.();
    installLoggerLineSink(undefined);
  }
});

import { BOOTSTRAP_PAGE, HtmlReplyPreview } from '../html-reply-preview.js';

const makeTempDir = trackTempDirs();
test.each([true, false])(
  'render records exit-triggered proxy close settlement without waiting for it (exitDuringRender=%s)',
  async (exitDuringRender) => {
    const lines: string[] = [];
    installLoggerLineSink({ writeLine: (line) => lines.push(line) });
    const originalClose = BrowserEgressProxy.prototype.close;
    const originalServerClose = Server.prototype.close;
    let releaseClose!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closing: Promise<void> | undefined;
    const close = vi
      .spyOn(BrowserEgressProxy.prototype, 'close')
      .mockImplementation(function (this: BrowserEgressProxy) {
        const pending = originalClose.call(this);
        closing ??= pending;
        return pending;
      });
    const serverClose = vi
      .spyOn(Server.prototype, 'close')
      .mockImplementation(function (
        this: Server,
        callback?: (error?: Error) => void,
      ) {
        return originalServerClose.call(this, (error) => {
          void gate.then(() => callback?.(error));
        });
      });
    probe.restrictive = true;
    probe.exitDuringRender = exitDuringRender;
    const receipts = () =>
      lines
        .map((line) => JSON.parse(line))
        .filter((line) => line.previewTerminalReceipt)
        .map((line) => line.previewTerminalReceipt);
    try {
      const service = new HtmlReplyPreview(
        makeTempDir('html-preview-exit-close-'),
      );
      await expect(
        service.render(
          { html: 'secret-authored-canary', height: 400 },
          800,
          'dark',
        ),
      ).rejects.toThrow('Authored content reached an unverified browser');
      expect(probe.authored).toBe(true);
      expect(close).toHaveBeenCalledTimes(exitDuringRender ? 1 : 2);
      expect(serverClose).toHaveBeenCalledTimes(1);
      const initial = receipts()[0];
      expect(initial.terminal.phases).toMatchObject({
        proxyClose: 'STARTED',
        browserClose: exitDuringRender ? 'NOT_REACHED' : 'RESOLVED',
        terminate: exitDuringRender ? 'NOT_REACHED' : 'RESOLVED',
        shutdown: 'RESOLVED',
      });
      releaseClose();
      await closing;
      const settled = receipts().at(-1);
      expect(settled.attempt).toBe(initial.attempt);
      expect(settled.late).toBe(true);
      expect(settled.terminal.phases.proxyClose).toBe('RESOLVED');
      expect(initial.terminal.phases.proxyClose).toBe('STARTED');
    } finally {
      releaseClose();
      try {
        await closing;
      } finally {
        serverClose.mockRestore();
        close.mockRestore();
        probe.exitDuringRender = false;
        await probe.cleanup?.();
        await probe.removeProfile?.();
        installLoggerLineSink(undefined);
      }
    }
  },
);

test.each([false, true])(
  'render records proxy cleanup after synchronous launcher rejection (closeRejects=%s)',
  async (closeRejects) => {
    const lines: string[] = [];
    installLoggerLineSink({ writeLine: (line) => lines.push(line) });
    const steps: unknown[] = [];
    probe.observe = (event) => {
      if (
        event.kind === 'preview-diagnostic' &&
        event.diagnostic.type === 'step'
      )
        steps.push(event.diagnostic);
    };
    const launchFailure = new Error('secret synchronous launcher failure');
    const closeFailure = new Error('secret proxy cleanup failure');
    probe.launchFailure = launchFailure;
    const originalClose = BrowserEgressProxy.prototype.close;
    const originalServerClose = Server.prototype.close;
    let releaseClose!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      closeEntered = resolve;
    });
    let closing: Promise<void> | undefined;
    const close = vi
      .spyOn(BrowserEgressProxy.prototype, 'close')
      .mockImplementation(function (this: BrowserEgressProxy) {
        const pending = originalClose.call(this).then(() => {
          if (closeRejects) throw closeFailure;
        });
        closing = pending;
        return pending;
      });
    const serverClose = vi
      .spyOn(Server.prototype, 'close')
      .mockImplementation(function (
        this: Server,
        callback?: (error?: Error) => void,
      ) {
        return originalServerClose.call(this, (error) => {
          closeEntered();
          void gate.then(() => callback?.(error));
        });
      });
    const receipts = () =>
      lines
        .map((line) => JSON.parse(line))
        .filter((line) => line.previewTerminalReceipt)
        .map((line) => line.previewTerminalReceipt);
    const service = new HtmlReplyPreview(makeTempDir('html-preview-launch-'));
    const outcome = service
      .render({ html: 'secret-authored-canary', height: 400 }, 800, 'dark')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    try {
      await entered;
      const heldSteps = steps.slice();
      expect(settled).toBe(false);
      expect(receipts()).toHaveLength(0);
      releaseClose();
      expect(await outcome).toBe(closeRejects ? closeFailure : launchFailure);
      expect(close).toHaveBeenCalledTimes(1);
      expect(serverClose).toHaveBeenCalledTimes(1);
      expect(receipts()).toHaveLength(1);
      expect(receipts()[0].terminal.phases).toMatchObject({
        proxyClose: closeRejects ? 'REJECTED' : 'RESOLVED',
        primary: 'REJECTED',
        surfaced: 'REJECTED',
        shutdown: 'RESOLVED',
        browserClose: 'NOT_REACHED',
        terminate: 'NOT_REACHED',
        profileRemoval: 'RESOLVED',
        slotRelease: 'RESOLVED',
      });
      expect(heldSteps).toEqual([
        {
          type: 'step',
          step: 'proxyClose',
          origin: 'launch-failure',
          state: 'STARTED',
        },
      ]);
      expect(steps).toEqual([
        ...heldSteps,
        {
          type: 'step',
          step: 'proxyClose',
          origin: 'launch-failure',
          state: closeRejects ? 'REJECTED' : 'RESOLVED',
        },
      ]);
      expect(probe.policyRead).toBe(false);
      expect(probe.authored).toBe(false);
      expect(JSON.stringify(receipts())).not.toMatch(
        /secret synchronous|secret proxy|secret-authored/,
      );
    } finally {
      releaseClose();
      await outcome;
      await closing?.catch(() => {});
      serverClose.mockRestore();
      close.mockRestore();
      probe.launchFailure = undefined;
      probe.observe = undefined;
      await probe.cleanup?.();
      await probe.removeProfile?.();
      installLoggerLineSink(undefined);
    }
  },
);

test('preview refuses a managed effective-policy override before author code and reports the fixed refusal', async () => {
  const lines: string[] = [];
  installLoggerLineSink({ writeLine: (line) => lines.push(line) });
  try {
    const service = new HtmlReplyPreview(makeTempDir('html-preview-policy-'));
    await expect(
      service.render(
        { html: '<script>secret()</script>', height: 400 },
        800,
        'dark',
      ),
    ).rejects.toMatchObject({
      name: 'HtmlReplyRefusal',
      reason: expect.stringContaining(
        'enterprise policy overrides the profile',
      ),
    });
    expect(probe.policyRead).toBe(true);
    expect(probe.authored).toBe(false);
    expect(lines.some((line) => line.includes('previewTerminalReceipt'))).toBe(
      true,
    );
  } finally {
    installLoggerLineSink(undefined);
  }
});

test('preview hosts its sandboxed frame in a served page and keeps sandboxed frames in their own process', async () => {
  // Chrome 158 aborts the browser (CHECK has_site_) when an about:blank page
  // adds the sandboxed srcdoc frame (#4917). The fix is the served page; turning
  // IsolateSandboxedIframes off would also stop the abort but would put
  // authored HTML in its bootstrap page's renderer, so it stays refused here.
  probe.restrictive = true;
  const service = new HtmlReplyPreview(makeTempDir('html-preview-shape-'));
  try {
    await expect(
      service.render({ html: '<p>x</p>', height: 400 }, 800, 'dark'),
    ).rejects.toThrow('Authored content reached an unverified browser');
    expect(probe.authored).toBe(true);
    expect(probe.navigations.at(-1)).toBe(SERVED_DOCUMENT_URL);
    for (const arg of probe.launchArgs ?? [])
      if (arg.startsWith('--disable-features='))
        expect(
          arg.slice('--disable-features='.length).split(','),
        ).not.toContain('IsolateSandboxedIframes');
    expect(
      (probe.launchArgs ?? []).some((arg) =>
        /IsolateSandboxedIframes|disable-site-isolation|site-per-process/.test(
          arg,
        ),
      ),
    ).toBe(false);
  } finally {
    await probe.cleanup?.();
    await probe.removeProfile?.();
  }
});

test('the served bootstrap page is the same constant for every render and never carries the token', async () => {
  probe.restrictive = true;
  const service = new HtmlReplyPreview(makeTempDir('html-preview-constant-'));
  try {
    for (let i = 0; i < 2; i++)
      await expect(
        service.render({ html: '<p>x</p>', height: 400 }, 800, 'dark'),
      ).rejects.toThrow('Authored content reached an unverified browser');
    expect(probe.servedDocuments).toEqual([BOOTSTRAP_PAGE, BOOTSTRAP_PAGE]);
    // The token still travels only as a Runtime.callFunctionOn value argument.
    expect(probe.tokens).toHaveLength(2);
    expect(new Set(probe.tokens).size).toBe(2);
    for (const token of probe.tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(BOOTSTRAP_PAGE).not.toContain(token);
    }
  } finally {
    await probe.cleanup?.();
    await probe.removeProfile?.();
  }
});
