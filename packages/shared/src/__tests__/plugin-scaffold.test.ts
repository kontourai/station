import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseWorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type AgentPluginManifestReport,
  parseAgentPluginManifest,
} from '../agent-plugin-manifest.js';
import { buildPlugin } from '../build.js';
import {
  buildPluginScaffold,
  PLUGIN_SCAFFOLD_TEMPLATES,
  type PluginScaffoldDependencies,
  PluginScaffoldInputError,
} from '../plugin-scaffold.js';

// esbuild startup can exceed the default budget on a loaded shared host.
const BUILD_TIMEOUT_MS = 30_000;
const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
// The same authority `station plugin create` and the server route read.
const dependencies = JSON.parse(
  readFileSync(
    join(workspaceRoot, 'config', 'plugin-scaffold-dependencies.json'),
    'utf8',
  ),
) as PluginScaffoldDependencies;

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function writeScaffold(files: { path: string; contents: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'station-plugin-scaffold-'));
  cleanupDirs.push(root);
  const pluginDir = join(root, 'plugin');
  for (const file of files) {
    const target = join(pluginDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents);
  }
  return pluginDir;
}

/** Runs a built bundle the way the host does and returns its exports. */
function loadBundle(bundle: string, pluginName: string) {
  const noop = () => null;
  const sandbox: Record<string, unknown> = { console };
  sandbox.window = sandbox;
  sandbox.__station_ai_shared = {
    react: { useState: (value: unknown) => [value, noop] },
    'react/jsx-runtime': { jsx: noop, jsxs: noop, Fragment: 'fragment' },
    '@kontourai/station-sdk': {
      useAgents: () => [],
      useNavigation: () => ({ setDockState: noop }),
      useToast: () => ({ showToast: noop }),
    },
  };
  runInNewContext(bundle, sandbox);
  const plugins = sandbox.__station_ai_plugins as Record<
    string,
    { components?: Record<string, unknown> }
  >;
  return plugins[pluginName];
}

describe('buildPluginScaffold', () => {
  test.each(PLUGIN_SCAFFOLD_TEMPLATES)(
    '%s: the manifest passes the shared parser with the Station extension and its Panes intact',
    (template) => {
      const name = `scaffold-${template}`;
      const scaffold = buildPluginScaffold({ name, template, dependencies });
      const manifestFile = scaffold.files.find(
        (file) => file.path === 'plugin.json',
      );
      const manifest = JSON.parse(manifestFile!.contents);
      const reports: AgentPluginManifestReport[] = [];
      const parsed = parseAgentPluginManifest(manifest, (report) =>
        reports.push(report),
      );

      // No warning either: an ignored field is a field the author thinks
      // Station reads.
      expect(reports).toEqual([]);
      expect(parsed?.manifest.name).toBe(name);
      const station = parsed?.stationExtension;
      expect(station).toBeDefined();

      const panes = station?.workspacePanes ?? [];
      if (template === 'provider') {
        expect(panes).toEqual([]);
        expect(station?.serverModule).toBe('./plugin.mjs');
        return;
      }
      expect(panes.length).toBe(template === 'full' ? 2 : 1);
      for (const pane of panes) {
        const descriptor = parseWorkspacePaneDescriptor(pane);
        expect(descriptor).not.toBeNull();
        expect(descriptor?.renderer.kind).toBe('plugin-component');
        expect(descriptor?.provenance).toEqual({
          origin: 'plugin',
          pluginId: name,
        });
      }
    },
  );

  test.each(
    PLUGIN_SCAFFOLD_TEMPLATES.filter((template) => template !== 'provider'),
  )(
    '%s: buildPlugin bundles it, and every declared renderer names an exported component',
    async (template) => {
      const name = `built-${template}`;
      const scaffold = buildPluginScaffold({ name, template, dependencies });
      const pluginDir = writeScaffold(scaffold.files);

      const result = await buildPlugin(pluginDir);

      expect(result.built).toBe(true);
      // The CSS import is part of the scaffold, so the build must emit it.
      expect(result.cssPath).toBeDefined();
      const exports = loadBundle(
        readFileSync(result.bundlePath!, 'utf8'),
        name,
      );
      const manifest = JSON.parse(
        readFileSync(join(pluginDir, 'plugin.json'), 'utf8'),
      );
      const rendererNames = manifest.extensions[
        'io.kontourai.station'
      ].workspacePanes.map(
        (pane: { renderer: { name: string } }) => pane.renderer.name,
      );
      expect(Object.keys(exports?.components ?? {}).sort()).toEqual(
        [...rendererNames].sort(),
      );
    },
    BUILD_TIMEOUT_MS,
  );

  test('the provider template carries its server module and provider files', () => {
    const scaffold = buildPluginScaffold({
      name: 'provider-kit',
      template: 'provider',
      dependencies,
    });
    const paths = scaffold.files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining(['plugin.mjs', 'providers/branding.js']),
    );
    expect(paths).not.toContain('src/index.tsx');
  });

  test('ids derive from the plugin name and every path stays relative', () => {
    const scaffold = buildPluginScaffold({
      name: 'acme.board',
      dependencies,
    });
    const manifest = JSON.parse(
      scaffold.files.find((file) => file.path === 'plugin.json')!.contents,
    );
    const [pane] = manifest.extensions['io.kontourai.station'].workspacePanes;
    expect(pane.id).toBe('pane:plugin%3Aacme.board:main:workspace');
    expect(pane.rendererId).toBe(
      'renderer:plugin%3Aacme.board:plugin-component:workspace',
    );
    expect(scaffold.displayName).toBe('Acme Board');
    for (const file of scaffold.files) {
      expect(file.path.startsWith('/')).toBe(false);
      expect(file.path.split('/')).not.toContain('..');
    }
  });

  test.each(['My Plugin', '../escape', '-lead', 'a--b', ''])(
    'refuses the invalid name %j',
    (name) => {
      expect(() => buildPluginScaffold({ name, dependencies })).toThrow(
        PluginScaffoldInputError,
      );
    },
  );

  test('refuses an unknown template', () => {
    expect(() =>
      buildPluginScaffold({
        name: 'ok-name',
        template: 'layout' as never,
        dependencies,
      }),
    ).toThrow(/Unknown plugin template/);
  });

  test('a display name becomes data in the entrypoint, not code', () => {
    const scaffold = buildPluginScaffold({
      name: 'quoted',
      displayName: `Bob's "Pane"} {alert(1)}`,
      dependencies,
    });
    const entry = scaffold.files.find(
      (file) => file.path === 'src/index.tsx',
    )!.contents;
    expect(entry).toContain(
      `<h1>{${JSON.stringify(`Bob's "Pane"} {alert(1)}`)}}</h1>`,
    );
  });
});
