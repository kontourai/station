import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
    const lock = readFileSync('pnpm-lock.yaml', 'utf8');
    const fieldworkVersion = example.dependencies?.['@kontourai/fieldwork'];
    expect(fieldworkVersion).toMatch(/^\d+\.\d+\.\d+$/);

    expect(manifest.workspaces).toContain('examples/fieldwork-review');
    // pnpm's importer is the root-install proof. Package paths and npm's
    // link metadata do not exist in Station's canonical lockfile.
    expect(lock).toContain('  examples/fieldwork-review:\n');
    expect(lock).toContain(
      `      '@kontourai/fieldwork':\n        specifier: ${fieldworkVersion}`,
    );
    expect(lock).toContain(`  '@kontourai/fieldwork@${fieldworkVersion}':`);
    expect(existsSync('examples/fieldwork-review/package-lock.json')).toBe(
      false,
    );
  });
});
