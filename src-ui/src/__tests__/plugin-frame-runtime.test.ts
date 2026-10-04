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
});
