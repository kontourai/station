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
  test('creates the default full template scaffold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-create-plugin-'));
    cleanupDirs.push(root);

    const { createPlugin } = await importCommands();
    createPlugin('alpha-plugin', { cwd: root });

    const pluginDir = join(root, 'alpha-plugin');
    const manifest = JSON.parse(
      readFileSync(join(pluginDir, 'plugin.json'), 'utf-8'),
    );
    const layout = JSON.parse(
      readFileSync(join(pluginDir, 'layout.json'), 'utf-8'),
    );

    expect(existsSync(join(pluginDir, 'src', 'index.tsx'))).toBe(true);
    expect(
      existsSync(join(pluginDir, 'agents', 'assistant', 'agent.json')),
    ).toBe(true);
    expect(manifest.entrypoint).toBe('src/index.tsx');
    expect(manifest.layout.slug).toBe('alpha-plugin');
    expect(layout.defaultAgent).toBe('alpha-plugin:assistant');
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
    // devDependencies for external authors. The range must stay public-registry
    // compatible instead of copying the local SDK's unpublished 0.4.2 version.
    expect(pkg.peerDependencies['@kontourai/station-shared']).toBe('^0.4.0');
    expect(pkg.peerDependencies['@kontourai/station-sdk']).toBe('^0.4.0');
    expect(pkg.devDependencies['@kontourai/station-shared']).toBe('^0.4.0');
    expect(pkg.devDependencies['@kontourai/station-sdk']).toBe('^0.4.0');
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

  test('creates a layout template without agent scaffolding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-create-plugin-'));
    cleanupDirs.push(root);

    const { createPlugin } = await importCommands();
    createPlugin('layout-only', { cwd: root, template: 'layout' });

    const pluginDir = join(root, 'layout-only');
    const manifest = JSON.parse(
      readFileSync(join(pluginDir, 'plugin.json'), 'utf-8'),
    );

    expect(existsSync(join(pluginDir, 'layout.json'))).toBe(true);
    expect(existsSync(join(pluginDir, 'agents'))).toBe(false);
    expect(manifest.agents).toBeUndefined();
    expect(manifest.entrypoint).toBe('src/index.tsx');
  });

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
    expect(manifest.serverModule).toBe('plugin.mjs');
    expect(manifest.providers[0].type).toBe('branding');
  });
});
