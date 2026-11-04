import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import type { CdpTransport } from '../browser/browser-host.js';
import type { ChromiumServerHostOptions } from '../browser/hosts/chromium-server-host.js';

const probe = vi.hoisted(() => ({ authored: false, policyRead: false }));
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
            if (method === 'Page.navigate')
              policyUrl = (params as { url?: string })?.url ?? '';
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
                  result: { value: { policy: 'default', urlOverrides: false } },
                } as R;
              }
              probe.authored = true;
              throw new Error('Authored content reached an unverified browser');
            }
            return {} as R;
          },
        };
        super({
          ...options,
          launcher: () => ({
            transport,
            pid: undefined,
            exited,
            terminate: async () => {
              resolveExit('terminated');
            },
          }),
        });
      }
    },
  };
});

import { HtmlReplyPreview } from '../html-reply-preview.js';

const makeTempDir = trackTempDirs();
test('preview refuses a managed effective-policy override before author code and reports the fixed refusal', async () => {
  const service = new HtmlReplyPreview(makeTempDir('html-preview-policy-'));
  await expect(
    service.render(
      { html: '<script>secret()</script>', height: 400 },
      800,
      'dark',
    ),
  ).rejects.toMatchObject({
    name: 'HtmlReplyRefusal',
    reason: expect.stringContaining('enterprise policy overrides the profile'),
  });
  expect(probe.policyRead).toBe(true);
  expect(probe.authored).toBe(false);
});
