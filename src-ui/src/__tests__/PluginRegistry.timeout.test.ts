/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS,
  PluginRegistry,
} from '../core/PluginRegistry';
import { log } from '../utils/logger';

vi.mock('../core/pluginSharedRuntime', () => ({
  ensurePluginSharedRuntimeReady: vi.fn().mockResolvedValue(undefined),
}));

describe('PluginRegistry inventory timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('returns a degraded state when a loopback inventory request times out', async () => {
    const deadline = new AbortController();
    vi.spyOn(log, 'api').mockImplementation(() => {});
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        markRequestStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Timed out', 'TimeoutError')),
            { once: true },
          );
        });
      }),
    );

    const registry = new PluginRegistry();
    registry.setApiBase('http://127.0.0.1:3141');
    const reloading = registry.reload();

    await requestStarted;
    expect(AbortSignal.timeout).toHaveBeenCalledWith(
      PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS,
    );
    deadline.abort();

    await expect(reloading).resolves.toBe('degraded');
  });

  test('a hung CSS fetch degrades the load at its deadline', async () => {
    const hungPath = '/bundle.css';
    vi.spyOn(log, 'api').mockImplementation(() => {});
    const deadlines: AbortController[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const deadline = new AbortController();
      deadlines.push(deadline);
      return deadline.signal;
    });
    let hungDeadline: AbortController | undefined;
    let markHung!: () => void;
    const hung = new Promise<void>((resolve) => {
      markHung = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/plugins')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              plugins: [{ name: 'slow-plugin', hasBundle: true }],
            }),
          });
        }
        if (url.endsWith(hungPath)) {
          // The newest deadline issued so far: this request's own, if it
          // has one.
          hungDeadline = deadlines.at(-1);
          markHung();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Timed out', 'TimeoutError')),
              { once: true },
            );
          });
        }
        return Promise.resolve({ ok: true, text: async () => '' });
      }),
    );

    const registry = new PluginRegistry();
    // CSS still uses authenticated fetch; JavaScript uses a script URL.
    registry.setApiBase('http://127.0.0.1:3141');
    const reloading = registry.reload();

    await hung;
    // A bundle fetch without a deadline of its own captured an earlier
    // request's, whose firing cannot reach this fetch, so the reload stays
    // pending and the race below reds.
    hungDeadline?.abort();

    const pending = Symbol('still pending');
    await expect(
      Promise.race([
        reloading,
        new Promise((resolve) => setTimeout(() => resolve(pending), 100)),
      ]),
    ).resolves.toBe('degraded');
    expect(registry.getLoadStatus()).toMatchObject({
      state: 'degraded',
      failedPluginNames: ['slow-plugin'],
      failure: 'bundle-load-failure',
    });
  });

  test('a script URL that never reports load degrades when its deadline elapses', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input).endsWith('/api/plugins'))
            return Response.json({
              plugins: [{ name: 'slow-plugin', hasBundle: true }],
            });
          return new Response('');
        }),
      );
      const registry = new PluginRegistry(Promise.resolve({ platform: 'web' }));
      registry.setApiBase('http://localhost:3000');
      let settled: string | undefined;
      const reloading = registry.reload().then((result) => {
        settled = result;
        return result;
      });
      const script = await vi.waitFor(() => {
        const element = document.head.querySelector<HTMLScriptElement>(
          'script[data-station-plugin]',
        );
        if (!element) throw new Error('Plugin script was not appended.');
        return element;
      });
      expect(script.src).toBe(
        'http://localhost:3000/api/plugins/slow-plugin/bundle.js',
      );
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS);
      expect(settled).toBe('degraded');
      await reloading;
      expect(registry.getLoadStatus().failedPluginNames).toEqual([
        'slow-plugin',
      ]);
    } finally {
      document.head
        .querySelectorAll('[data-station-plugin]')
        .forEach((node) => node.remove());
      vi.useRealTimers();
    }
  });
});
