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
      let settled: string | undefined;
      void registry.reload().then((result) => {
        settled = result;
      });

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

      // A fourth read would hang on a deadline nobody aborts: the count, not
      // the test timeout, is what catches an unbounded retry.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(inventoryReads).toHaveBeenCalledTimes(3);
      expect(settled).toBe('degraded');
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

  /** Answers each `GET /api/plugins` with the next scripted outcome. */
  function scriptInventory(
    outcomes: Array<'503' | '403' | 'network' | 'hang' | 'ok'>,
  ) {
    const reads = { count: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith('/api/plugins')) return new Response('');
        const outcome = outcomes[reads.count] ?? outcomes.at(-1);
        reads.count += 1;
        if (outcome === 'network') throw new TypeError('Failed to fetch');
        if (outcome === 'hang') return hangUntilAborted(init);
        if (outcome === '503') return new Response('', { status: 503 });
        if (outcome === '403') return new Response('', { status: 403 });
        return Response.json({ plugins: [] });
      }),
    );
    return reads;
  }

  function loopbackRegistry() {
    const registry = new PluginRegistry(Promise.resolve({ platform: 'web' }));
    registry.setApiBase('http://127.0.0.1:3141');
    return registry;
  }

  test('a 5xx inventory answer is retried', async () => {
    vi.useFakeTimers();
    try {
      const reads = scriptInventory(['503', 'ok']);
      const registry = loopbackRegistry();
      const reloading = registry.reload();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(reloading).resolves.toBe('ready');
      expect(reads.count).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a network failure on the inventory read is retried', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(log, 'api').mockImplementation(() => {});
      const reads = scriptInventory(['network', 'ok']);
      const registry = loopbackRegistry();
      const reloading = registry.reload();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(reloading).resolves.toBe('ready');
      expect(reads.count).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('waits 1 s between inventory attempts', async () => {
    vi.useFakeTimers();
    try {
      const reads = scriptInventory(['503', 'ok']);
      const registry = loopbackRegistry();
      const reloading = registry.reload();
      await vi.advanceTimersByTimeAsync(0);
      expect(reads.count).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(reads.count).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads.count).toBe(2);
      await expect(reloading).resolves.toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a connection change during the attempts stops them, with no later read or state change', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(log, 'api').mockImplementation(() => {});
      const reads = scriptInventory(['503']);
      const registry = loopbackRegistry();
      let settled: string | undefined;
      void registry.reload().then((result) => {
        settled = result;
      });
      await vi.waitFor(() => expect(reads.count).toBe(1));
      // Inside the pause before attempt 2.
      registry.setApiBase('http://127.0.0.1:3142');
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe('degraded');
      const states = recordStates(registry);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(reads.count).toBe(1);
      expect(states).toEqual(['degraded']);
      // An aborted load is not a reason to re-read on the next healthy probe.
      registry.retryUnavailableInventory();
      await vi.advanceTimersByTimeAsync(0);
      expect(reads.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a healthy probe after the attempts ran out re-reads the inventory, registers its components and clears the failure', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(log, 'api').mockImplementation(() => {});
      let recovered = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          if (!String(input).endsWith('/api/plugins')) return new Response('');
          if (!recovered) throw new TypeError('Failed to fetch');
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
      const first = registry.reload();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(first).resolves.toBe('degraded');
      expect(registry.getLoadStatus().failure).toBe('registry-unavailable');

      recovered = true;
      registry.retryUnavailableInventory();
      const script = await vi.waitFor(() => {
        const element = document.head.querySelector<HTMLScriptElement>(
          'script[data-station-plugin]',
        );
        if (!element) throw new Error('Plugin script was not appended.');
        return element;
      });
      const KnowledgeSources = () => null;
      (window as any).__station_ai_plugins = {
        'knowledge-docs-starter': {
          components: { 'knowledge-sources': KnowledgeSources },
        },
      };
      script.dispatchEvent(new Event('load'));
      await vi.waitFor(() =>
        expect(registry.getLoadStatus().state).toBe('ready'),
      );
      expect(registry.getLoadStatus().failure).toBeUndefined();
      expect(registry.getLayout('knowledge-sources')).toBe(KnowledgeSources);
    } finally {
      document.head
        .querySelectorAll('[data-station-plugin]')
        .forEach((node) => node.remove());
      delete (window as any).__station_ai_plugins;
      vi.useRealTimers();
    }
  });

  test('healthy-probe re-reads back off, and never start while a load is in flight', async () => {
    vi.useFakeTimers();
    try {
      const reads = scriptInventory(['503']);
      const registry = loopbackRegistry();
      const first = registry.reload();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(first).resolves.toBe('degraded');
      expect(reads.count).toBe(3);

      const reloadedOnProbe: number[] = [];
      for (let probe = 1; probe <= 24; probe += 1) {
        const before = reads.count;
        registry.retryUnavailableInventory();
        await vi.advanceTimersByTimeAsync(0);
        if (reads.count > before) {
          // A second cue while that re-read is in flight starts nothing.
          registry.retryUnavailableInventory();
          await vi.advanceTimersByTimeAsync(0);
          expect(reads.count - before).toBe(1);
        }
        await vi.advanceTimersByTimeAsync(5_000);
        if (reads.count > before) {
          expect(reads.count - before).toBe(3);
          reloadedOnProbe.push(probe);
        }
      }
      // Never on two probes in a row: against a Station that hangs, each
      // re-read takes about 50 s, and back-to-back re-reads would keep one
      // running nearly all the time.
      expect(reloadedOnProbe).toEqual([1, 3, 7, 15, 23]);
    } finally {
      vi.useRealTimers();
    }
  });

  /** An inventory whose next answers the test switches as it goes. */
  function controlInventory(initial: '503' | 'ok' | 'null-entry') {
    const state = { outcome: initial, reads: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).endsWith('/api/plugins')) return new Response('');
        state.reads += 1;
        if (state.outcome === '503') return new Response('', { status: 503 });
        if (state.outcome === 'null-entry')
          return Response.json({ plugins: [null] });
        return Response.json({ plugins: [] });
      }),
    );
    return state;
  }

  async function degradeWith503(registry: PluginRegistry) {
    const first = registry.reload();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toBe('degraded');
  }

  test('a failing background re-read keeps the failure on screen and notifies nobody; a successful one becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const inventory = controlInventory('503');
      const registry = loopbackRegistry();
      await degradeWith503(registry);
      const failed = registry.getLoadStatus();
      const states: unknown[] = [];
      registry.subscribe(() => states.push(registry.getLoadStatus()));

      registry.retryUnavailableInventory();
      await vi.advanceTimersByTimeAsync(0);
      expect(inventory.reads).toBe(4);
      expect(registry.getLoadStatus()).toBe(failed);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(inventory.reads).toBe(6);
      expect(registry.getLoadStatus()).toBe(failed);
      expect(states).toEqual([]);

      inventory.outcome = 'ok';
      registry.retryUnavailableInventory(); // probe 2: skipped
      registry.retryUnavailableInventory(); // probe 3: re-reads
      await vi.advanceTimersByTimeAsync(0);
      expect(registry.getLoadStatus()).toMatchObject({
        state: 'ready',
        failure: undefined,
      });
      expect(states).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('Retry during a failing background re-read shows loading, then a fresh pass reports the failure', async () => {
    vi.useFakeTimers();
    try {
      const inventory = controlInventory('503');
      const registry = loopbackRegistry();
      await degradeWith503(registry);
      const states: Array<{ state: string; failure?: string }> = [];
      registry.subscribe(() => {
        const { state, failure } = registry.getLoadStatus();
        states.push({ state, failure });
      });

      registry.retryUnavailableInventory();
      await vi.advanceTimersByTimeAsync(0);
      expect(inventory.reads).toBe(4);
      const retried = registry.reload();
      expect(registry.getLoadStatus().state).toBe('loading');
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(retried).resolves.toBe('degraded');
      // The background chain's three reads, then the fresh pass's three.
      expect(inventory.reads).toBe(9);
      expect(states).toEqual([
        { state: 'loading', failure: undefined },
        { state: 'degraded', failure: 'registry-unavailable' },
      ]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(inventory.reads).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a reload during a failing background re-read gets a fresh read, which can succeed and register components', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          if (!String(input).endsWith('/api/plugins')) return new Response('');
          reads += 1;
          // Initial load 1-3 and the background chain 4-6 fail.
          if (reads <= 6) return new Response('', { status: 503 });
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
      await degradeWith503(registry);

      registry.retryUnavailableInventory();
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(4);
      // Not Retry: an install or a plugin-change event reloading.
      const reloading = registry.reload();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reads).toBe(7);

      const script = await vi.waitFor(() => {
        const element = document.head.querySelector<HTMLScriptElement>(
          'script[data-station-plugin]',
        );
        if (!element) throw new Error('Plugin script was not appended.');
        return element;
      });
      const KnowledgeSources = () => null;
      (window as any).__station_ai_plugins = {
        'knowledge-docs-starter': {
          components: { 'knowledge-sources': KnowledgeSources },
        },
      };
      script.dispatchEvent(new Event('load'));
      await expect(reloading).resolves.toBe('ready');
      expect(registry.getLoadStatus().state).toBe('ready');
      expect(registry.getLayout('knowledge-sources')).toBe(KnowledgeSources);
    } finally {
      document.head
        .querySelectorAll('[data-station-plugin]')
        .forEach((node) => node.remove());
      delete (window as any).__station_ai_plugins;
      vi.useRealTimers();
    }
  });

  test('a healthy probe does nothing when the registry is ready', async () => {
    const inventory = controlInventory('ok');
    const registry = loopbackRegistry();
    await expect(registry.reload()).resolves.toBe('ready');
    registry.retryUnavailableInventory();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inventory.reads).toBe(1);
  });

  test('the probe backoff starts over after a successful load', async () => {
    vi.useFakeTimers();
    try {
      const inventory = controlInventory('503');
      const registry = loopbackRegistry();
      await degradeWith503(registry);
      registry.retryUnavailableInventory(); // probe 1 re-reads, then skip 1
      await vi.advanceTimersByTimeAsync(5_000);
      expect(inventory.reads).toBe(6);

      inventory.outcome = 'ok';
      await expect(registry.reload()).resolves.toBe('ready');
      inventory.outcome = '503';
      await degradeWith503(registry);
      const before = inventory.reads;
      registry.retryUnavailableInventory();
      await vi.advanceTimersByTimeAsync(0);
      expect(inventory.reads).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the probe backoff starts over when the connection changes', async () => {
    vi.useFakeTimers();
    try {
      const inventory = controlInventory('503');
      const registry = loopbackRegistry();
      await degradeWith503(registry);
      registry.retryUnavailableInventory(); // probe 1 re-reads, then skip 1
      await vi.advanceTimersByTimeAsync(5_000);

      registry.setApiBase('http://127.0.0.1:3142');
      await degradeWith503(registry);
      const before = inventory.reads;
      registry.retryUnavailableInventory();
      await vi.advanceTimersByTimeAsync(0);
      expect(inventory.reads).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failure after the inventory was read is not re-read on healthy probes', async () => {
    vi.spyOn(log, 'api').mockImplementation(() => {});
    const inventory = controlInventory('null-entry');
    const registry = loopbackRegistry();
    await expect(registry.reload()).resolves.toBe('degraded');
    expect(registry.getLoadStatus().failure).toBe('registry-unavailable');
    registry.retryUnavailableInventory();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inventory.reads).toBe(1);
  });

  test('a refused inventory read is not re-read on healthy probes', async () => {
    const reads = scriptInventory(['403']);
    const registry = loopbackRegistry();
    await expect(registry.reload()).resolves.toBe('degraded');
    registry.retryUnavailableInventory();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads.count).toBe(1);
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
