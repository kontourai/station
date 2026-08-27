/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Root-webview plugin bundles are deliberately restricted to trusted loopback
// saved Stations; hosted Stations cannot inject code into the root webview.
const ORIGIN = 'http://127.0.0.1:3141';

type Shared = Record<string, unknown> | undefined;

function shared(): Shared {
  return (
    window as unknown as { __station_ai_shared?: Record<string, unknown> }
  ).__station_ai_shared;
}

beforeEach(() => {
  vi.resetModules();
  delete (window as any).__station_ai_shared;
  delete (window as any).__station_ai_plugins;
  delete (window as any).require;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.head
    .querySelectorAll('[data-station-plugin]')
    .forEach((node) => node.remove());
});

describe('plugin shared-module bridge', () => {
  test('publishes the app-bundled modules synchronously', async () => {
    const { installPluginSharedRuntime } = await import(
      '../core/pluginSharedRuntime'
    );
    installPluginSharedRuntime();

    // Read straight after the call, with no awaits in between: these are the
    // modules the app genuinely ships in the first-paint bundle, so publishing
    // the same live namespace costs nothing.
    expect(shared()?.['@tanstack/react-query']).toBeDefined();
    expect(shared()?.react).toBeDefined();
    expect(shared()?.['react/jsx-runtime']).toBeDefined();
    expect(shared()?.debug).toBeDefined();

    // Held back out of the entry chunk until something actually needs them.
    // The SDK barrel and UserDetailModal joined this half in station#883: a
    // namespace import materializes every export, pinning 43 app-unreached SDK
    // modules into the entry chunk.
    expect(shared()?.['@kontourai/station-sdk']).toBeUndefined();
    expect(shared()?.['@kontourai/station-components']).toBeUndefined();
    expect(shared()?.['@kontourai/station-sdk/client']).toBeUndefined();
    expect(shared()?.['@kontourai/station-sdk/voice']).toBeUndefined();
    expect(shared()?.zod).toBeUndefined();
    expect(shared()?.dompurify).toBeUndefined();
  });

  test('exposes a readiness handle that resolves the deferred modules', async () => {
    // The contract that replaces synchronous SDK availability. It must be
    // published SYNCHRONOUSLY and must work on a Station with no plugins,
    // where nothing else would ever trigger the on-demand load.
    const { installPluginSharedRuntime } = await import(
      '../core/pluginSharedRuntime'
    );
    installPluginSharedRuntime();

    const ready = (
      window as unknown as { __station_ai_shared_ready?: () => Promise<void> }
    ).__station_ai_shared_ready;
    expect(typeof ready).toBe('function');

    await ready?.();

    // Assert on a real export, not on the container: the components entry is
    // an object literal, so `toBeDefined()` would pass even if the dynamic
    // import resolved `UserDetailModal` to undefined.
    const loadedShared = shared();
    if (!loadedShared) {
      throw new Error(
        'Plugin shared runtime was not published after readiness',
      );
    }
    expect(
      (loadedShared['@kontourai/station-sdk'] as any).useAgentsQuery,
    ).toBeTypeOf('function');
    expect(
      (loadedShared['@kontourai/station-components'] as any).UserDetailModal,
    ).toBeTypeOf('function');
  });

  test('leaves the plugin-only modules unloaded when no plugin has a bundle', async () => {
    const { installPluginSharedRuntime } = await import(
      '../core/pluginSharedRuntime'
    );
    const { PluginRegistry } = await import('../core/PluginRegistry');
    installPluginSharedRuntime();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ plugins: [] }))),
    );

    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);
    await registry.initialize();

    expect(shared()?.['@kontourai/station-sdk/client']).toBeUndefined();
    expect(shared()?.['@kontourai/station-sdk/voice']).toBeUndefined();
    expect(shared()?.zod).toBeUndefined();
    expect(shared()?.dompurify).toBeUndefined();
  });

  test('resolves the plugin-only modules before a bundle is injected', async () => {
    const { installPluginSharedRuntime } = await import(
      '../core/pluginSharedRuntime'
    );
    const { PluginRegistry } = await import('../core/PluginRegistry');
    installPluginSharedRuntime();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith('/api/plugins')) {
          return new Response(
            JSON.stringify({
              plugins: [{ name: 'demo-layout', hasBundle: true }],
            }),
          );
        }
        if (url.endsWith('/bundle.css')) return new Response('.demo {}');
        if (url.endsWith('/bundle.js')) return new Response('void 0;');
        return new Response('not found', { status: 404 });
      }),
    );

    const registry = new PluginRegistry();
    registry.setApiBase(ORIGIN);
    await registry.initialize();

    // The bundle's require() shim reads these synchronously the moment the
    // injected script runs, so they must already be resolved by now.
    const requireShim = (window as any).require as (m: string) => unknown;
    expect(typeof requireShim).toBe('function');
    // Assert on real exports: the shim answers unknown modules with `{}`, so a
    // bare `toBeDefined()` would pass even with the bridge left unresolved.
    expect((requireShim('zod') as any).string).toBeTypeOf('function');
    expect(typeof requireShim('dompurify')).toBe('function');
    expect((requireShim('dompurify') as any).sanitize).toBeTypeOf('function');
    const sdkClient = await import('@kontourai/station-sdk/client');
    expect(requireShim('@kontourai/station-sdk/client')).toBe(sdkClient);
    const voiceSdk = await import('@kontourai/station-sdk/voice');
    expect(requireShim('@kontourai/station-sdk/voice')).toBe(voiceSdk);

    // The two modules station#883 MOVED to the on-demand half. Without these,
    // the whole "no plugin can observe the deferral" claim rests on a path no
    // test exercises for the affected modules.
    const sdk = await import('@kontourai/station-sdk');
    expect(requireShim('@kontourai/station-sdk')).toBe(sdk);
    expect(
      (requireShim('@kontourai/station-components') as any).UserDetailModal,
    ).toBeTypeOf('function');
  });
});
