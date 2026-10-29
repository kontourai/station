import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPnpmLockfile } from '../lib/pnpm-lockfile.mjs';

interface PackageManifest {
  dependencies?: Record<string, string>;
  workspaces?: string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

describe('example workspace installation contract', () => {
  it('provisions the Fieldwork review example from the root install', () => {
    const manifest = readJson<PackageManifest>('package.json');
    const example = readJson<PackageManifest>(
      'examples/fieldwork-review/package.json',
    );
    const lock = readPnpmLockfile(process.cwd());
    const fieldworkVersion = example.dependencies?.['@kontourai/fieldwork'];
    expect(fieldworkVersion).toMatch(/^\d+\.\d+\.\d+$/);

    expect(manifest.workspaces).toContain('examples/fieldwork-review');
    // pnpm's importer is the root-install proof. Package paths and npm's
    // link metadata do not exist in Station's canonical lockfile.
    const importer = lock.importers['examples/fieldwork-review'];
    expect(importer?.dependencies?.['@kontourai/fieldwork']?.specifier).toBe(
      fieldworkVersion,
    );
    // A key, not a property path: `toHaveProperty` would split on the dots.
    expect(Object.keys(lock.packages)).toContain(
      `@kontourai/fieldwork@${fieldworkVersion}`,
    );
    expect(existsSync('examples/fieldwork-review/package-lock.json')).toBe(
      false,
    );
  });
});
