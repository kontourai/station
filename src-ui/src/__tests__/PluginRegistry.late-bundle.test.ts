/**
 * @vitest-environment jsdom
 *
 * archive#4302 — a plugin bundle whose load the registry disowned still runs.
 *
 * Removing a `<script src>` does not cancel its fetch or its evaluation, so a
 * bundle that timed out, errored or was aborted executes afterwards anyway,
 * assigns `globalThis.require` and writes `window.__station_ai_plugins`. The
 * host cannot stop that. What it can do — and what these tests pin — is refuse
 * to let a plugin it reported as failed become live by finishing late.
 *
 * jsdom never loads an external `<script src>`, so the browser's own load
 * report is stood in for; that is the same substitution the sibling
 * `PluginRegistry.csp.test.ts` makes.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { PluginRegistry } from '../core/PluginRegistry';

const SAME_ORIGIN = 'http://localhost:3000';
const PLUGIN = 'late-layout';

function pluginScript(): HTMLScriptElement | null {
  return document.head.querySelector<HTMLScriptElement>(
    'script[data-station-plugin]',
  );
}

async function awaitPluginScript(): Promise<HTMLScriptElement> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const script = pluginScript();
    if (script) return script;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('no plugin script element was ever appended');
}

/** The bundle's registration footer, as `packages/shared/src/build.ts` emits it. */
function runBundleFooter(components: Record<string, () => null>): void {
  const globals = window as any;
  globals.__station_ai_plugins = globals.__station_ai_plugins || {};
  globals.__station_ai_plugins[PLUGIN] = { components };
}

function stubInventory(onBundleCss?: () => void) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.endsWith('/api/plugins')) {
      return Response.json({
        plugins: [{ name: PLUGIN, version: '1.0.0', hasBundle: true }],
      });
    }
    if (url.endsWith('/bundle.css')) {
      onBundleCss?.();
      return new Response('');
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head
    .querySelectorAll('[data-station-plugin]')
    .forEach((node) => node.remove());
  delete (window as any).__station_ai_plugins;
  delete (window as any).require;
});

describe('a disowned plugin bundle that executes late', () => {
  test('does not become live on the pass that reported it failed', async () => {
    stubInventory();
    const registry = new PluginRegistry();
    registry.setApiBase(SAME_ORIGIN);

    const settled = registry.reload();
    const script = await awaitPluginScript();
    // The browser reports the load. The bundle has registered nothing yet --
    // it is still running, or it never ran and this is a cached empty body.
    script.dispatchEvent(new Event('load'));
    //...and only now does it finish and register, after the registry was
    // told the load was over.
    runBundleFooter({ 'late-pane': () => null });

    expect(await settled).toBe('degraded');
    expect(registry.getLoadStatus().failedPluginNames).toEqual([PLUGIN]);
    expect(registry.hasLayout('late-pane')).toBe(false);
  });

  test('does not become live on a later pass either, after re-creating the global', async () => {
    let cssRequests = 0;
    stubInventory(() => {
      cssRequests += 1;
      // Pass 1 timed out and was reported failed; `performReload` has just
      // deleted `window.__station_ai_plugins`; and NOW pass 1's bundle
      // finally executes and re-creates it. This is the exact sequence the
      // Chromium repro on archive#4302 recorded
      // (`pluginsGlobalRepopulated: true`).
      if (cssRequests === 2) runBundleFooter({ 'late-pane': () => null });
    });
    const registry = new PluginRegistry();
    registry.setApiBase(SAME_ORIGIN);

    const firstPass = registry.reload();
    (await awaitPluginScript()).dispatchEvent(new Event('error'));
    expect(await firstPass).toBe('degraded');
    expect(registry.getLoadStatus().failedPluginNames).toEqual([PLUGIN]);

    const secondPass = registry.reload();
    // Pass 2's own script loads and registers nothing of its own. The only
    // entry on the window is the corpse of the load pass 1 disowned.
    (await awaitPluginScript()).dispatchEvent(new Event('load'));

    expect(await secondPass).toBe('degraded');
    expect(registry.getLoadStatus().failedPluginNames).toEqual([PLUGIN]);
    expect(registry.hasLayout('late-pane')).toBe(false);
  });

  test('leaves a bundle that registers during its own load fully live', async () => {
    // The discriminating control: the admission check must refuse late
    // writes without refusing the ordinary one, which lands during the
    // script's evaluation and therefore before the load is reported.
    const LivePane = () => null;
    stubInventory();
    const registry = new PluginRegistry();
    registry.setApiBase(SAME_ORIGIN);

    const settled = registry.reload();
    const script = await awaitPluginScript();
    runBundleFooter({ 'live-pane': LivePane });
    script.dispatchEvent(new Event('load'));

    expect(await settled).toBe('ready');
    expect(registry.getLoadStatus().failedPluginNames).toEqual([]);
    expect(registry.getLayout('live-pane')).toBe(LivePane);
  });
});
