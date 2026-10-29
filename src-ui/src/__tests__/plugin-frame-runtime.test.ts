/** @vitest-environment jsdom */
import { runInNewContext } from 'node:vm';
import { describe, expect, test, vi } from 'vitest';
import { buildPluginFrameRuntime } from '../components/plugins/plugin-frame-runtime';

describe('plugin frame runtime serialization', () => {
  test('keeps supplied identity data inside one script and preserves its value', () => {
    const pluginName =
      '</script><script id="injected">globalThis.injected=true</script>\u2028\u2029';
    const origin = 'https://plugins.example.test';
    const runtime = buildPluginFrameRuntime(origin, pluginName);
    const parsed = document.implementation.createHTMLDocument();
    parsed.body.innerHTML = `<script>${runtime}</script>`;
    expect(parsed.querySelectorAll('script')).toHaveLength(1);
    expect(parsed.getElementById('injected')).toBeNull();
    expect(runtime).not.toMatch(/[\u2028\u2029]/);

    const frameWindow = {
      __station_ai_plugins: {
        [pluginName]: { components: { card: () => null } },
      },
      __stationPaneHostOrigin: undefined,
    };
    const post = vi.fn();
    let loaded: (() => void) | undefined;
    runInNewContext(runtime, {
      window: frameWindow,
      parent: { postMessage: post },
      addEventListener: (_type: string, callback: () => void) => {
        loaded = callback;
      },
      queueMicrotask: (callback: () => void) => callback(),
    });
    loaded?.();
    expect(frameWindow.__stationPaneHostOrigin).toBe(origin);
    expect(post).toHaveBeenCalledWith(
      { method: 'initialize', params: { exports: ['card'] } },
      '*',
    );
  });

  // The related-pane client is injected as its own source text: it must run
  // inside the frame with nothing from this module in scope, and answer a
  // host result correlated by id.
  test('injects a self-contained related-pane client the frame can call', async () => {
    const runtime = buildPluginFrameRuntime(
      'https://plugins.example.test',
      'reports',
    );
    const listeners: ((event: unknown) => void)[] = [];
    const host = { postMessage: vi.fn() };
    const frameWindow: Record<string, unknown> = {
      addEventListener: (_type: string, listener: (event: unknown) => void) =>
        listeners.push(listener),
      removeEventListener: () => {},
    };
    runInNewContext(runtime, {
      window: frameWindow,
      parent: host,
      addEventListener: () => {},
      queueMicrotask: (callback: () => void) => callback(),
      URL,
      Map,
      setTimeout,
      clearTimeout,
      Promise,
    });
    const create = frameWindow.__stationCreateRelatedPanesPaneHost as (
      target: unknown,
      origin: string,
    ) => {
      open(request: unknown): Promise<unknown>;
      dispose(): void;
    };
    expect(typeof create).toBe('function');
    const client = create(host, 'https://station.example.test');
    const opening = client.open({
      descriptorId: 'pane:plugin%3Areports:detail',
      modeId: 'project',
      key: 'weekly',
    });
    const [message] = host.postMessage.mock.calls[0] as [
      { method: string; params: { id: string } },
    ];
    expect(message.method).toBe('pane-host/related-open');
    for (const listener of listeners)
      listener({
        source: host,
        origin: 'https://station.example.test',
        data: {
          method: 'pane-host/related-result',
          params: {
            id: message.params.id,
            data: {
              status: 'opened',
              handle: `plugin-pane:${'a'.repeat(32)}`,
              presentation: 'beside',
            },
          },
        },
      });
    await expect(opening).resolves.toEqual({
      status: 'opened',
      handle: `plugin-pane:${'a'.repeat(32)}`,
      presentation: 'beside',
    });
    client.dispose();
  });
});
