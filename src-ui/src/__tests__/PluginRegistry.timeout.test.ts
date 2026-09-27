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

  // The bundle fetches carry the same deadline as the inventory: a Station
  // that lists a plugin and then never answers for its bytes must degrade the
  // load, not leave plugin discovery pending forever.
  test.each([
    ['CSS', '/bundle.css'],
    ['JavaScript', '/bundle.js'],
  ])(
    'a hung %s bundle fetch degrades the load at its deadline',
    async (_label, hungPath) => {
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
            // The deadline this request was issued under, if it has one.
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
      // Loopback, and cross-origin to jsdom, so both bundles are fetched.
      registry.setApiBase('http://127.0.0.1:3141');
      const reloading = registry.reload();

      await hung;
      // Fire the newest deadline at the moment the bundle was requested. Without
      // a deadline of its own that is an earlier request's, whose firing cannot
      // reach this fetch, and the reload stays pending.
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
    },
  );
});
