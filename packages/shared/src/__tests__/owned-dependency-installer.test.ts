/**
 * The one check both `station upgrade` (packages/cli lifecycle.ts) and the
 * server's core-update route run after `git pull`, before spawning
 * `npm run dependencies:install`. Driven against real temp trees.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  OWNED_DEPENDENCY_INSTALL_SCRIPT,
  ownedDependencyInstallerUnavailable,
} from '../owned-dependency-installer';

const makeTempDir = trackTempDirs();

function tree(options: { manifest?: string; lifecycle?: boolean } = {}) {
  const root = makeTempDir('owned-installer-');
  if (options.manifest !== undefined) {
    writeFileSync(join(root, 'package.json'), options.manifest);
  }
  if (options.lifecycle) {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'dependency-lifecycle.mjs'), '');
  }
  return root;
}

const bound = JSON.stringify({
  scripts: {
    'dependencies:install': 'node scripts/dependency-lifecycle.mjs install',
  },
});

describe('ownedDependencyInstallerUnavailable', () => {
  it('names the script both callers run', () => {
    expect(OWNED_DEPENDENCY_INSTALL_SCRIPT).toBe('dependencies:install');
  });

  it('is available (null) when the binding and the lifecycle script exist', () => {
    expect(
      ownedDependencyInstallerUnavailable(
        tree({ manifest: bound, lifecycle: true }),
      ),
    ).toBeNull();
  });

  it('refuses a manifest without the dependencies:install binding', () => {
    const root = tree({
      manifest: JSON.stringify({ scripts: {} }),
      lifecycle: true,
    });
    expect(ownedDependencyInstallerUnavailable(root)).toBe(
      `${join(root, 'package.json')} does not define the "dependencies:install" script`,
    );
  });

  it('refuses a non-string binding', () => {
    const root = tree({
      manifest: JSON.stringify({ scripts: { 'dependencies:install': 1 } }),
      lifecycle: true,
    });
    expect(ownedDependencyInstallerUnavailable(root)).toBe(
      `${join(root, 'package.json')} does not define the "dependencies:install" script`,
    );
  });

  it('refuses when the lifecycle script is missing', () => {
    const root = tree({ manifest: bound });
    expect(ownedDependencyInstallerUnavailable(root)).toBe(
      `${join(root, 'scripts', 'dependency-lifecycle.mjs')} is missing`,
    );
  });

  it('reports an unreadable manifest with the raw error by default', () => {
    const root = tree({ lifecycle: true });
    const result = ownedDependencyInstallerUnavailable(root);
    expect(result).toMatch(
      new RegExp(
        `^${join(root, 'package.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} could not be read as JSON \\(ENOENT`,
      ),
    );
  });

  it('renders a parse failure through the caller-supplied describer', () => {
    const root = tree({ manifest: '{not json', lifecycle: true });
    expect(
      ownedDependencyInstallerUnavailable(root, (error) =>
        error instanceof SyntaxError ? 'described' : 'wrong',
      ),
    ).toBe(
      `${join(root, 'package.json')} could not be read as JSON (described)`,
    );
  });
});
