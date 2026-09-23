import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const cleanupDirs: string[] = [];

afterEach(async () => {
  vi.resetModules();
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function importCommands() {
  return import('../commands/init.js');
}

describe('createPlugin', () => {
  test('creates the default full template as an Agent Plugins manifest', async () => {
    // The legacy scaffold wrote root `entrypoint`/`layout` fields plus a
    // `layout.json`; the shared parser now refuses `layout` outright, so a
    // fresh scaffold could not install. The same builder backs the in-app
    // "New plugin" action.
    const root = mkdtempSync(join(tmpdir(), 'station-create-plugin-'));
    cleanupDirs.push(root);

    const { createPlugin } = await importCommands();
    createPlugin('alpha-plugin', { cwd: root });

    const pluginDir = join(root, 'alpha-plugin');
    const manifest = JSON.parse(
      readFileSync(join(pluginDir, 'plugin.json'), 'utf-8'),
    );
    const station = manifest.extensions['io.kontourai.station'];

    expect(manifest.$schema).toBe(
      'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    );
    expect(manifest.layout).toBeUndefined();
    expect(manifest.entrypoint).toBeUndefined();
    expect(existsSync(join(pluginDir, 'layout.json'))).toBe(false);
    expect(existsSync(join(pluginDir, 'src', 'index.tsx'))).toBe(true);
    expect(
      existsSync(join(pluginDir, 'agents', 'assistant', 'agent.json')),
    ).toBe(true);
    expect(station.entrypoint).toBe('./src/index.tsx');
    expect(station.agents).toEqual([
      { slug: 'assistant', source: './agents/assistant/agent.json' },
    ]);
    expect(
      station.workspacePanes.map((pane: { id: string }) => pane.id),
    ).toEqual([
      'pane:plugin%3Aalpha-plugin:main:workspace',
      'pane:plugin%3Aalpha-plugin:main:notes',
    ]);
  });

  test('scaffolds a build an author outside this repo can run', async () => {
    // `station plugin build` was the scaffolded build script, but the Station
    // CLI is `private` and never reaches npm — so `npm run build` failed for
    // anyone who did not already have a Station checkout on their PATH. The
    // scaffold now drives `buildPlugin()` from the published shared package.
    const root = mkdtempSync(join(tmpdir(), 'station-create-plugin-'));
    cleanupDirs.push(root);

    const { createPlugin } = await importCommands();
    createPlugin('outside-plugin', { cwd: root });

    const pluginDir = join(root, 'outside-plugin');
    const pkg = JSON.parse(
      readFileSync(join(pluginDir, 'package.json'), 'utf-8'),
    );
    const buildScript = readFileSync(join(pluginDir, 'build.ts'), 'utf-8');
    const readme = readFileSync(join(pluginDir, 'README.md'), 'utf-8');

    expect(pkg.scripts.build).toBe('tsx build.ts');
    expect(pkg.scripts.dev).toBe('tsx build.ts --dev');
    expect(JSON.stringify(pkg)).not.toContain('station plugin');
    // These packages are peer dependencies at runtime and published
    // devDependencies for external authors. The checked-in dependency
    // authority is independently verified against the public registry.
    const dependencyAuthority = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          '..',
          '..',
          '..',
          '..',
          'config',
          'plugin-scaffold-dependencies.json',
        ),
        'utf8',
      ),
    );
    expect(pkg.peerDependencies['@kontourai/station-shared']).toBe(
      dependencyAuthority['@kontourai/station-shared'],
    );
    expect(pkg.peerDependencies['@kontourai/station-sdk']).toBe(
      dependencyAuthority['@kontourai/station-sdk'],
    );
    expect(pkg.devDependencies['@kontourai/station-shared']).toBe(
      dependencyAuthority['@kontourai/station-shared'],
    );
    expect(pkg.devDependencies['@kontourai/station-sdk']).toBe(
      dependencyAuthority['@kontourai/station-sdk'],
    );
    expect(JSON.stringify(pkg)).not.toContain('workspace:');
    expect(pkg.devDependencies.tsx).toBeTruthy();
    expect(buildScript).toContain("from '@kontourai/station-shared/build'");
    expect(buildScript).toContain('buildPlugin(process.cwd(), mode)');
    expect(readme).toContain('npm run build');
    expect(readme).not.toContain('station plugin build');
  });

  test('scaffolded build entry point is a real subpath of the shared package', async () => {
    // The scaffold is only usable if `@kontourai/station-shared/build` is
    // declared in that package's `exports` map and inside its `files`
    // allowlist. Both are read from the manifest, not assumed.
    const shared = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', '..', 'shared', 'package.json'),
        'utf-8',
      ),
    );
    expect(shared.private).not.toBe(true);
    expect(shared.exports['./build']).toBe('./src/build.ts');
    expect(shared.files).toContain('src');
  });

  test.each(['pane', 'layout'] as const)(
    'the %s template creates one Workspace Pane without agent scaffolding',
    async (template) => {
      const root = mkdtempSync(join(tmpdir(), 'station-create-plugin-'));
      cleanupDirs.push(root);

      const { createPlugin } = await importCommands();
      createPlugin('layout-only', { cwd: root, template });

      const pluginDir = join(root, 'layout-only');
      const manifest = JSON.parse(
        readFileSync(join(pluginDir, 'plugin.json'), 'utf-8'),
      );
      const station = manifest.extensions['io.kontourai.station'];

      expect(existsSync(join(pluginDir, 'layout.json'))).toBe(false);
      expect(existsSync(join(pluginDir, 'src', 'pane.css'))).toBe(true);
      expect(existsSync(join(pluginDir, 'agents'))).toBe(false);
      expect(station.agents).toBeUndefined();
      expect(station.entrypoint).toBe('./src/index.tsx');
      expect(station.workspacePanes).toHaveLength(1);
      expect(station.workspacePanes[0].renderer).toEqual({
        kind: 'plugin-component',
        name: 'workspace',
      });
    },
  );

  test('creates a provider template with a server module and provider files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-create-plugin-'));
    cleanupDirs.push(root);

    const { createPlugin } = await importCommands();
    createPlugin('provider-kit', { cwd: root, template: 'provider' });

    const pluginDir = join(root, 'provider-kit');
    const manifest = JSON.parse(
      readFileSync(join(pluginDir, 'plugin.json'), 'utf-8'),
    );

    expect(existsSync(join(pluginDir, 'plugin.mjs'))).toBe(true);
    expect(existsSync(join(pluginDir, 'providers', 'branding.js'))).toBe(true);
    expect(existsSync(join(pluginDir, 'src', 'index.tsx'))).toBe(false);
    const station = manifest.extensions['io.kontourai.station'];
    expect(station.serverModule).toBe('./plugin.mjs');
    expect(station.providers[0].type).toBe('branding');
    // Enforced at runtime; without them the provider never loads.
    expect(station.permissions).toEqual([
      'providers.register',
      'plugin.server',
    ]);
  });

  test('refuses a name outside the Agent Plugins grammar before writing anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-create-plugin-'));
    cleanupDirs.push(root);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { createPlugin } = await importCommands();
      expect(() => createPlugin('My Plugin', { cwd: root })).toThrow('exit 1');
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('Plugin name must be'),
      );
      expect(existsSync(join(root, 'My Plugin'))).toBe(false);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
