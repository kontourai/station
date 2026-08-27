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

  test('bounds both CSS and JavaScript bundle retrieval', async () => {
    vi.spyOn(log, 'api').mockImplementation(() => {});
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(
      () => new AbortController().signal,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '',
      }),
    );

    const registry = new PluginRegistry();
    registry.setApiBase('http://127.0.0.1:3141');
    const registryInternals = registry as unknown as {
      loadPlugin: (
        plugin: { hasBundle: boolean; name: string },
        apiBase: string,
        apiBaseGeneration: number,
        signal: AbortSignal,
      ) => Promise<boolean>;
    };

    await registryInternals.loadPlugin.call(
      registry,
      { hasBundle: true, name: 'broken-layout' },
      'http://127.0.0.1:3141',
      1,
      new AbortController().signal,
    );
    expect(AbortSignal.timeout).toHaveBeenCalledTimes(2);
    expect(AbortSignal.timeout).toHaveBeenNthCalledWith(
      1,
      PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS,
    );
    expect(AbortSignal.timeout).toHaveBeenNthCalledWith(
      2,
      PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS,
    );
  });
});
