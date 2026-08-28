/**
 * @vitest-environment jsdom
 *
 * archive#4287 — how a plugin bundle reaches the shell's realm, and what the
 * shell hands it on the way.
 *
 * jsdom does not enforce CSP and never loads an external `<script src>`, so
 * these tests pin the SHAPE of the injection (URL vs inlined bytes, nonce vs
 * no nonce) and the live policy is exercised in `tests/plugin-bundle-csp.spec.ts`
 * against a real browser and the real header.
 */

import { setClientCredentialResolver } from '@kontourai/station-sdk';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PluginRegistry } from '../core/PluginRegistry';

const SAME_ORIGIN = 'http://localhost:3000';
const CROSS_ORIGIN = 'http://127.0.0.1:3141';

function pluginScript(): HTMLScriptElement | null {
  return document.head.querySelector<HTMLScriptElement>(
    'script[data-station-plugin]',
  );
}

/**
 * jsdom leaves an external script inert, so stand in for the browser's load.
 *
 * `evaluate` runs before the load event is dispatched, which is the real
 * order: a classic script's `load` fires after its evaluation, so anything a
 * bundle registers is on the window by the time the browser reports the load.
 */
async function completeBundleLoad(
  evaluate?: () => void,
): Promise<HTMLScriptElement> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const script = pluginScript();
    if (script) {
      evaluate?.();
      script.dispatchEvent(new Event('load'));
      return script;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('no plugin script element was ever appended');
}

function stubInventory(bundleBody = 'void 0;') {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.endsWith('/api/plugins')) {
      return new Response(
        JSON.stringify({
          plugins: [{ name: 'demo-layout', version: '1.0.0', hasBundle: true }],
        }),
      );
    }
    if (url.endsWith('/bundle.css')) return new Response('.demo {}');
    if (url.endsWith('/bundle.js')) return new Response(bundleBody);
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head
    .querySelectorAll('[data-station-plugin]')
    .forEach((node) => node.remove());
  document.head
    .querySelectorAll('[data-station-csp-nonce]')
    .forEach((node) => node.remove());
  delete (window as any).__station_ai_plugins;
  delete (window as any).__STATION_CSP_NONCE__;
  delete (window as any).require;
});

describe('same-origin plugin bundles', () => {
  test('loads the bundle by URL and gives it no nonce', async () => {
    (window as any).__STATION_CSP_NONCE__ = 'shell-response-nonce';
    const marker = document.createElement('script');
    marker.nonce = 'tauri-runtime-nonce';
    marker.setAttribute('data-station-csp-nonce', '');
    document.head.appendChild(marker);
    stubInventory();

    const registry = new PluginRegistry();
    registry.setApiBase(SAME_ORIGIN);
    const settled = registry.initialize();
    const script = await completeBundleLoad();

    expect(script.getAttribute('src')).toBe(
      `${SAME_ORIGIN}/api/plugins/demo-layout/bundle.js`,
    );
    expect(script.textContent).toBe('');
    expect(script.nonce).toBe('');
    expect(script.getAttribute('nonce')).toBe(null);
    await settled;
  });

  test('never fetches the bundle bytes, so no credential rides the load', async () => {
    const fetchMock = stubInventory();
    setClientCredentialResolver(() => ({
      credential: 'shell-session-credential',
      origin: SAME_ORIGIN,
    }));

    const registry = new PluginRegistry();
    registry.setApiBase(SAME_ORIGIN);
    const settled = registry.initialize();
    await completeBundleLoad();
    await settled;

    const requested = fetchMock.mock.calls.map(([input]) => input.toString());
    expect(requested).toContain(`${SAME_ORIGIN}/api/plugins`);
    expect(requested).toContain(
      `${SAME_ORIGIN}/api/plugins/demo-layout/bundle.css`,
    );
    expect(requested).not.toContain(
      `${SAME_ORIGIN}/api/plugins/demo-layout/bundle.js`,
    );
  });

  test('registers the bundle exports once the browser reports the load', async () => {
    stubInventory();
    const registry = new PluginRegistry();
    registry.setApiBase(SAME_ORIGIN);
    const settled = registry.initialize();
    await completeBundleLoad(() => {
      (window as any).__station_ai_plugins = {
        'demo-layout': { components: { 'demo-pane': () => null } },
      };
    });
// The exports read must happen after the script evaluated, not before it
// was appended. It must ALSO not happen after the load was reported --
// that is archive#4302's late-bundle window, pinned in
// `PluginRegistry.late-bundle.test.ts`.
    expect(await settled).toBe('ready');
    expect(registry.hasLayout('demo-pane')).toBe(true);
  });

  test('a refused bundle response fails the plugin, and the element stays put', async () => {
    stubInventory();
    const registry = new PluginRegistry();
    registry.setApiBase(SAME_ORIGIN);
    const settled = registry.reload();
    for (let attempt = 0; attempt < 200 && !pluginScript(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    pluginScript()?.dispatchEvent(new Event('error'));

    expect(await settled).toBe('degraded');
    expect(registry.getLoadStatus().failedPluginNames).toEqual(['demo-layout']);
// Deliberately NOT removed. Removing a `<script src>` does not cancel its
// pending fetch or its evaluation, so removal cannot mean "this will not
// run" -- it would only hide a load still in flight. The reload sweep
// clears `[data-station-plugin]`, which is what actually tidies up.
    expect(pluginScript()).not.toBe(null);
  });
});

describe('cross-origin plugin bundles (the desktop shell)', () => {
  test('still inline the fetched bytes under the shell nonce', async () => {
    const marker = document.createElement('script');
    marker.nonce = 'tauri-runtime-nonce';
    marker.setAttribute('data-station-csp-nonce', '');
    document.head.appendChild(marker);
    stubInventory('window.__desktop_bundle_ran = true;');

    const registry = new PluginRegistry();
    registry.setApiBase(CROSS_ORIGIN);
    await registry.initialize();

    const script = pluginScript();
    expect(script?.getAttribute('src')).toBe(null);
    expect(script?.textContent).toContain('window.__desktop_bundle_ran');
// Disclosed residual: Tauri's window is its asset origin, so `'self'`
// cannot admit the loopback bundle URL and this path still needs a nonce.
    expect(script?.nonce).toBe('tauri-runtime-nonce');
  });
});
