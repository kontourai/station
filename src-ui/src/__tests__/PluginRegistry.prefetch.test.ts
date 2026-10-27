/**
 * @vitest-environment jsdom
 *
 * Plugin bundles download together and still execute one at a time, in
 * registry order. Each plugin used to wait for the one before it to fetch its
 * stylesheet, then its script, so N plugins cost 2N round trips in a row.
 *
 * jsdom never loads an external `<script src>`, so the browser's load report
 * is stood in for, as in `PluginRegistry.late-bundle.test.ts`.
 */

import { afterEach, expect, test, vi } from 'vitest';
import {
  PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS,
  PluginRegistry,
} from '../core/PluginRegistry';
import { log } from '../utils/logger';

const SAME_ORIGIN = 'http://localhost:3000';
const PLUGINS = ['alpha', 'beta', 'gamma'];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head
    .querySelectorAll('[data-station-plugin], [data-station-plugin-preload]')
    .forEach((node) => node.remove());
  delete (window as any).__station_ai_plugins;
  delete (window as any).require;
});

async function nextScript(
  seen: number,
  wait = () => new Promise((resolve) => setTimeout(resolve, 5)),
): Promise<HTMLScriptElement> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const scripts = document.head.querySelectorAll<HTMLScriptElement>(
      'script[data-station-plugin]',
    );
    if (scripts.length > seen) return scripts[seen]!;
    await wait();
  }
  throw new Error(`script ${seen + 1} was never appended`);
}

/** Lets the browser report a bundle's script as loaded, registering `name`. */
function runBundle(script: HTMLScriptElement, name: string) {
  const globals = window as any;
  globals.__station_ai_plugins = globals.__station_ai_plugins || {};
  globals.__station_ai_plugins[name] = {
    components: { [`${name}-pane`]: () => null },
  };
  script.dispatchEvent(new Event('load'));
}

/**
 * An inventory of `names` whose stylesheets answer at once, except those in
 * `held`, which answer only when released.
 */
function stubBundles(names: string[], held: string[] = []) {
  const release = new Map<string, () => void>();
  const signals = new Map<string, AbortSignal>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/api/plugins'))
        return Response.json({
          plugins: names.map((name) => ({
            name,
            version: '1.0.0',
            hasBundle: true,
          })),
        });
      const name = url.split('/').at(-2)!;
      if (!url.endsWith('/bundle.css'))
        return new Response('not found', { status: 404 });
      if (!held.includes(name)) return new Response(`.${name} {}`);
      if (init?.signal) signals.set(name, init.signal);
      return new Promise<Response>((resolve, reject) => {
        release.set(name, () => resolve(new Response(`.${name} {}`)));
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal!.reason),
        );
      });
    }),
  );
  return { release, signals };
}

const fakeTimeWait = () => vi.advanceTimersByTimeAsync(5);

test('fetches every bundle up front and executes them in registry order', async () => {
  const cssRequests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('/api/plugins'))
        return Response.json({
          plugins: PLUGINS.map((name) => ({
            name,
            version: '1.0.0',
            hasBundle: true,
          })),
        });
      if (url.endsWith('/bundle.css')) {
        cssRequests.push(url.split('/').at(-2)!);
        return new Response(`.${url.split('/').at(-2)} { color: red }`);
      }
      return new Response('not found', { status: 404 });
    }),
  );
  const registry = new PluginRegistry();
  registry.setApiBase(SAME_ORIGIN);
  const settled = registry.reload();

  const first = await nextScript(0);
  // Before the first bundle runs, all three stylesheets were requested and
  // all three scripts were handed to the browser to download.
  expect(cssRequests).toEqual(PLUGINS);
  const preloads = [
    ...document.head.querySelectorAll<HTMLLinkElement>(
      'link[data-station-plugin-preload]',
    ),
  ];
  expect(
    preloads.map((link) => [link.rel, link.as, new URL(link.href).pathname]),
  ).toEqual(
    PLUGINS.map((name) => [
      'preload',
      'script',
      `/api/plugins/${name}/bundle.js`,
    ]),
  );

  const executed: string[] = [];
  const scripts: HTMLScriptElement[] = [];
  const run = (script: HTMLScriptElement, name: string) => {
    executed.push(new URL(script.src).pathname.split('/').at(-2)!);
    scripts.push(script);
    runBundle(script, name);
  };
  run(first, 'alpha');
  run(await nextScript(1), 'beta');
  run(await nextScript(2), 'gamma');
  // The browser reuses a preload only for the same URL, credentials mode and
  // referrer policy; anything else downloads every bundle twice.
  expect(
    scripts.map((script) => [
      script.src,
      script.crossOrigin,
      script.referrerPolicy,
    ]),
  ).toEqual(
    preloads.map((link) => [link.href, link.crossOrigin, link.referrerPolicy]),
  );

  expect(await settled).toBe('ready');
  expect(executed).toEqual(PLUGINS);
  for (const name of PLUGINS)
    expect(registry.hasLayout(`${name}-pane`)).toBe(true);
  // Each stylesheet was applied once, from its single request.
  expect(document.head.querySelectorAll('style[data-plugin-css]')).toHaveLength(
    3,
  );
  expect(cssRequests).toHaveLength(3);
  expect(
    document.head.querySelectorAll('link[data-station-plugin-preload]'),
  ).toHaveLength(0);
});

test('a stylesheet started early still has its whole deadline from its own turn', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { release } = stubBundles(['alpha', 'beta'], ['beta']);
  const registry = new PluginRegistry();
  registry.setApiBase(SAME_ORIGIN);
  const settled = registry.reload();

  // Alpha's script takes most of a deadline to load, so beta's stylesheet
  // has been downloading for longer than one when its turn starts.
  const alpha = await nextScript(0, fakeTimeWait);
  await vi.advanceTimersByTimeAsync(
    PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS - 1_000,
  );
  runBundle(alpha, 'alpha');
  await vi.advanceTimersByTimeAsync(
    PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS - 1_000,
  );
  release.get('beta')!();
  runBundle(await nextScript(1, fakeTimeWait), 'beta');

  expect(await settled).toBe('ready');
  expect(registry.hasLayout('beta-pane')).toBe(true);
  expect(
    [...document.head.querySelectorAll('style[data-plugin-css]')].map(
      (style) => style.textContent,
    ),
  ).toEqual(['.alpha {}', '.beta {}']);
});

test('a stylesheet that never answers in its turn fails only its plugin, and stops downloading', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(log, 'api').mockImplementation(() => {});
  const { signals } = stubBundles(['alpha', 'beta'], ['alpha']);
  const registry = new PluginRegistry();
  registry.setApiBase(SAME_ORIGIN);
  const settled = registry.reload();

  await vi.advanceTimersByTimeAsync(PLUGIN_REGISTRY_INVENTORY_TIMEOUT_MS);
  expect(signals.get('alpha')?.aborted).toBe(true);
  runBundle(await nextScript(0, fakeTimeWait), 'beta');

  expect(await settled).toBe('degraded');
  expect(registry.hasLayout('alpha-pane')).toBe(false);
  expect(registry.hasLayout('beta-pane')).toBe(true);
});
