/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  PLUGIN_REGISTRY_INVENTORY_ATTEMPTS,
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

  /**
   * Deadlines handed to the inventory reads, each one aborted by the test
   * when it wants that read to time out.
   */
  function controlDeadlines() {
    const deadlines: { ms: number; controller: AbortController }[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      deadlines.push({ ms, controller });
      return controller.signal;
    });
    return deadlines;
  }

  /** An inventory read that answers only by timing out. */
  function hangUntilAborted(init?: RequestInit) {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Timed out', 'TimeoutError')),
        { once: true },
      );
    });
  }

  function recordStates(registry: PluginRegistry) {
    const states: string[] = [registry.getLoadStatus().state];
    registry.subscribe(() => states.push(registry.getLoadStatus().state));
    return states;
  }

  test('degrades only after every inventory attempt times out, each with a longer deadline', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(log, 'api').mockImplementation(() => {});
      const deadlines = controlDeadlines();
      const inventoryReads = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          hangUntilAborted(init),
      );
      vi.stubGlobal('fetch', inventoryReads);

      const registry = new PluginRegistry(Promise.resolve({ platform: 'web' }));
      registry.setApiBase('http://127.0.0.1:3141');
      const states = recordStates(registry);
      const reloading = registry.reload();

      for (
        let attempt = 1;
        attempt <= PLUGIN_REGISTRY_INVENTORY_ATTEMPTS;
        attempt += 1
      ) {
        await vi.waitFor(() =>
          expect(inventoryReads).toHaveBeenCalledTimes(attempt),
        );
        expect(registry.getLoadStatus().state).toBe('loading');
        deadlines.at(-1)?.controller.abort();
        await vi.advanceTimersByTimeAsync(1_000);
      }

      await expect(reloading).resolves.toBe('degraded');
      expect(inventoryReads).toHaveBeenCalledTimes(3);
      expect(PLUGIN_REGISTRY_INVENTORY_ATTEMPTS).toBe(3);
      expect(deadlines.map((deadline) => deadline.ms)).toEqual([
        PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS,
        PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS * 2,
        PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS * 3,
      ]);
      expect(deadlines.map((deadline) => deadline.ms)).toEqual([
        8_000, 16_000, 24_000,
      ]);
      expect(states).toEqual(['loading', 'degraded']);
      expect(registry.getLoadStatus()).toMatchObject({
        state: 'degraded',
        failure: 'registry-unavailable',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('a timed-out first inventory read is retried, and its plugin tab components register without the load ever degrading', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(log, 'api').mockImplementation(() => {});
      const deadlines = controlDeadlines();
      let inventoryReads = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!String(input).endsWith('/api/plugins')) return new Response('');
          inventoryReads += 1;
          if (inventoryReads === 1) return hangUntilAborted(init);
          return Response.json({
            plugins: [
              {
                name: 'knowledge-docs-starter',
                version: '1.0.0',
                hasBundle: true,
              },
            ],
          });
        }),
      );

      const registry = new PluginRegistry(Promise.resolve({ platform: 'web' }));
      registry.setApiBase('http://localhost:3000');
      const states = recordStates(registry);
      const reloading = registry.reload();

      await vi.waitFor(() => expect(inventoryReads).toBe(1));
      deadlines.at(-1)?.controller.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(inventoryReads).toBe(2));

      const script = await vi.waitFor(() => {
        const element = document.head.querySelector<HTMLScriptElement>(
          'script[data-station-plugin]',
        );
        if (!element) throw new Error('Plugin script was not appended.');
        return element;
      });
      expect(script.src).toBe(
        'http://localhost:3000/api/plugins/knowledge-docs-starter/bundle.js',
      );
      const KnowledgeSources = () => null;
      (window as any).__station_ai_plugins = {
        'knowledge-docs-starter': {
          components: { 'knowledge-sources': KnowledgeSources },
        },
      };
      script.dispatchEvent(new Event('load'));

      await expect(reloading).resolves.toBe('ready');
      expect(registry.getLayout('knowledge-sources')).toBe(KnowledgeSources);
      expect(states).toEqual(['loading', 'ready']);
    } finally {
      document.head
        .querySelectorAll('[data-station-plugin]')
        .forEach((node) => node.remove());
      delete (window as any).__station_ai_plugins;
      vi.useRealTimers();
    }
  });

  test('a refused inventory read is reported at once, not retried', async () => {
    const inventoryReads = vi.fn(async () => new Response('', { status: 403 }));
    vi.stubGlobal('fetch', inventoryReads);

    const registry = new PluginRegistry(Promise.resolve({ platform: 'web' }));
    registry.setApiBase('http://127.0.0.1:3141');

    await expect(registry.reload()).resolves.toBe('degraded');
    expect(inventoryReads).toHaveBeenCalledTimes(1);
    expect(registry.getLoadStatus().failure).toBe('registry-unavailable');
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
    // The stylesheet downloads ahead of its plugin's turn, and that turn
    // issues its deadline. Once the turn has started, the newest deadline is
    // this request's own, if it has one; a bundle fetch without one leaves an
    // earlier request's, whose firing cannot reach this fetch, so the reload
    // stays pending and the race below reds.
    await new Promise((resolve) => setTimeout(resolve, 0));
    deadlines.at(-1)?.abort();

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
