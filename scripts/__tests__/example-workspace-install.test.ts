import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  workspaces?: string[];
}

interface LockPackage {
  dependencies?: Record<string, string>;
  link?: boolean;
  resolved?: string;
  version?: string;
}

interface PackageLock {
  packages?: Record<string, LockPackage>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

describe('example workspace installation contract', () => {
  it('provisions the Fieldwork review example from the root install', () => {
    const manifest = readJson<PackageManifest>('package.json');
    const lock = readJson<PackageLock>('package-lock.json');
    const packages = lock.packages ?? {};

    expect(manifest.workspaces).toContain('examples/fieldwork-review');
    expect(packages['examples/fieldwork-review']?.dependencies).toMatchObject({
      '@kontourai/fieldwork': '0.6.1',
    });
    expect(
      packages['node_modules/@kontourai/station-fieldwork-review'],
    ).toMatchObject({
      link: true,
      resolved: 'examples/fieldwork-review',
    });
    expect(packages['node_modules/@kontourai/fieldwork']?.version).toBe(
      '0.6.1',
    );
    expect(existsSync('examples/fieldwork-review/package-lock.json')).toBe(
      false,
    );
  });
});
