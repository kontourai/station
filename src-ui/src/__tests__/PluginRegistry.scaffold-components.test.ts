/**
 * @vitest-environment jsdom
 *
 * Epic #2323 S2 review H1: the host registers every plugin's components in
 * ONE map keyed by component name. Two plugins scaffolded from the same
 * template must not overwrite each other, so each scaffold's component keys
 * (and its Panes' `renderer.name`) carry the plugin name.
 *
 * Real scaffolds, built by the real `buildPlugin`, loaded through the real
 * `PluginRegistry`. jsdom never fetches `<script src>`, so the test runs each
 * built bundle's text when the registry appends its script, then reports the
 * load, the substitution `PluginRegistry.late-bundle.test.ts` makes.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { TextEncoder as NodeTextEncoder } from 'node:util';
import { buildPlugin } from '@kontourai/station-shared/build';
import { buildPluginScaffold } from '@kontourai/station-shared/plugin-scaffold';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { PluginRegistry } from '../core/PluginRegistry';

const SAME_ORIGIN = 'http://localhost:3000';
const PLUGINS = ['alpha-pane', 'beta-pane'] as const;
const dependencies = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../config/plugin-scaffold-dependencies.json'),
    'utf8',
  ),
);

const root = mkdtempSync(join(tmpdir(), 'station-scaffold-registry-'));
const bundles = new Map<string, string>();
const rendererNames = new Map<string, string>();

beforeAll(async () => {
  // esbuild checks that TextEncoder output is an instance of the global
  // Uint8Array; under jsdom the two come from different realms, so the build
  // runs with Node's pair and jsdom's is restored after.
  const jsdomTextEncoder = globalThis.TextEncoder;
  const jsdomUint8Array = globalThis.Uint8Array;
  globalThis.TextEncoder = NodeTextEncoder as typeof TextEncoder;
  globalThis.Uint8Array = new NodeTextEncoder().encode('')
    .constructor as Uint8ArrayConstructor;
  try {
    for (const name of PLUGINS) {
      const scaffold = buildPluginScaffold({
        name,
        template: 'pane',
        dependencies,
      });
      const pluginDir = join(root, name);
      for (const file of scaffold.files) {
        const target = join(pluginDir, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.contents);
      }
      const built = await buildPlugin(pluginDir);
      bundles.set(name, readFileSync(built.bundlePath!, 'utf8'));
      const manifest = JSON.parse(
        scaffold.files.find((file) => file.path === 'plugin.json')!.contents,
      );
      rendererNames.set(
        name,
        manifest.extensions['io.kontourai.station'].workspacePanes[0].renderer
          .name,
      );
    }
  } finally {
    globalThis.TextEncoder = jsdomTextEncoder;
    globalThis.Uint8Array = jsdomUint8Array;
  }
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

afterEach(() => {
  vi.unstubAllGlobals();
  document.head
    .querySelectorAll('[data-station-plugin]')
    .forEach((node) => node.remove());
  delete (window as any).__station_ai_plugins;
  delete (window as any).__station_ai_shared;
  delete (window as any).require;
});

test('two scaffolded plugins keep their own Pane components in one registry', async () => {
  const noop = () => null;
  (window as any).__station_ai_shared = {
    react: { useState: (value: unknown) => [value, noop] },
    'react/jsx-runtime': { jsx: noop, jsxs: noop, Fragment: 'fragment' },
    '@kontourai/station-sdk': {
      useAgents: () => [],
      useNavigation: () => ({ setDockState: noop }),
      useToast: () => ({ showToast: noop }),
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('/api/plugins')) {
        return Response.json({
          plugins: PLUGINS.map((name) => ({
            name,
            version: '0.1.0',
            hasBundle: true,
          })),
        });
      }
      if (url.endsWith('/bundle.css')) return new Response('');
      return new Response('not found', { status: 404 });
    }),
  );
  // Run each bundle as the browser would once its script is appended.
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLScriptElement)) continue;
        const name = PLUGINS.find((plugin) =>
          node.src.includes(`/api/plugins/${plugin}/bundle.js`),
        );
        if (!name) continue;
        new Function(bundles.get(name)!)();
        node.dispatchEvent(new Event('load'));
      }
  });
  observer.observe(document.head, { childList: true });

  const registry = new PluginRegistry();
  registry.setApiBase(SAME_ORIGIN);
  try {
    expect(await registry.reload()).toBe('ready');
  } finally {
    observer.disconnect();
  }

  const [alpha, beta] = PLUGINS.map((name) => rendererNames.get(name)!);
  expect(alpha).not.toBe(beta);
  const alphaComponent = registry.getLayout(alpha);
  const betaComponent = registry.getLayout(beta);
  expect(alphaComponent).toBeTruthy();
  expect(betaComponent).toBeTruthy();
  expect(alphaComponent).not.toBe(betaComponent);
  // Each Pane still resolves to a component its OWN plugin exported.
  expect(alphaComponent).toBe(
    (window as any).__station_ai_plugins['alpha-pane'].components[alpha],
  );
  expect(betaComponent).toBe(
    (window as any).__station_ai_plugins['beta-pane'].components[beta],
  );
});
