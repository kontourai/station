import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { assertPluginBundleAssetsContained } from '../plugin-bundles.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function pluginFixture() {
  const base = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'station-plugin-bundle-containment-')),
  );
  roots.push(base);
  const pluginDir = join(base, 'plugin');
  mkdirSync(join(pluginDir, 'x', 'evil-dist'), { recursive: true });
  mkdirSync(join(base, 'evil-dist'));
  writeFileSync(join(base, 'evil-dist', 'bundle.js'), 'outside witness');
  writeFileSync(join(pluginDir, 'x', 'evil-dist', 'bundle.js'), 'inside decoy');
  return { base, pluginDir };
}

test('accepts a bundle in the plugin dist directory', () => {
  const { pluginDir } = pluginFixture();
  mkdirSync(join(pluginDir, 'dist'));
  writeFileSync(join(pluginDir, 'dist', 'bundle.js'), 'bundle');
  expect(() => assertPluginBundleAssetsContained(pluginDir)).not.toThrow();
});

// #1502: `x/up -> ..` makes `x/up/../evil-dist` the plugin's sibling to the
// OS, while the JS realpath names the inside decoy.
test('refuses a dist directory whose symlink chain resolves outside the plugin root', () => {
  const { pluginDir } = pluginFixture();
  symlinkSync('..', join(pluginDir, 'x', 'up'));
  symlinkSync('x/up/../evil-dist', join(pluginDir, 'dist'));
  expect(readFileSync(join(pluginDir, 'dist', 'bundle.js'), 'utf8')).toBe(
    'outside witness',
  );
  expect(() => assertPluginBundleAssetsContained(pluginDir)).toThrow(
    'Plugin bundle asset escapes plugin root: bundle.js',
  );
});
