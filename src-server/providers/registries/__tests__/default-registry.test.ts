import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REGISTRY_MANIFEST_PATH,
  resolveDefaultRegistryManifest,
  resolveRegistrySource,
} from '../default-registry.js';

let sandbox: string | undefined;

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

function appRootWithManifest(): string {
  sandbox = mkdtempSync(join(tmpdir(), 'default-registry-spec-'));
  const dir = join(sandbox, 'examples', 'registry');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'default.json'),
    JSON.stringify({ version: 1, plugins: [], tools: [] }),
  );
  return sandbox;
}

function appRootWithoutManifest(): string {
  sandbox = mkdtempSync(join(tmpdir(), 'default-registry-empty-'));
  return sandbox;
}

describe('resolveDefaultRegistryManifest', () => {
  it('finds the bundled manifest under the install root', () => {
    const root = appRootWithManifest();
    expect(resolveDefaultRegistryManifest(root)).toBe(
      resolve(root, DEFAULT_REGISTRY_MANIFEST_PATH),
    );
  });

  it('returns null when the installation has no bundled manifest', () => {
    // An image or checkout without examples/ must degrade to "no registry",
    // never fail to boot.
    expect(resolveDefaultRegistryManifest(appRootWithoutManifest())).toBeNull();
  });
});

describe('resolveRegistrySource', () => {
  it('falls back to the bundled manifest when nothing is configured', () => {
    const root = appRootWithManifest();
    expect(resolveRegistrySource(undefined, root)).toEqual({
      source: resolve(root, DEFAULT_REGISTRY_MANIFEST_PATH),
      origin: 'bundled',
    });
  });

  it('treats blank configuration as unconfigured', () => {
    const root = appRootWithManifest();
    expect(resolveRegistrySource('   ', root)?.origin).toBe('bundled');
  });

  it('lets a configured remote URL win over the bundled manifest', () => {
    const root = appRootWithManifest();
    expect(resolveRegistrySource('https://example.test/r.json', root)).toEqual({
      source: 'https://example.test/r.json',
      origin: 'configured',
    });
  });

  it('resolves a configured relative path against the install root', () => {
    const root = appRootWithManifest();
    expect(
      resolveRegistrySource('examples/registry/manifest.json', root),
    ).toEqual({
      source: resolve(root, 'examples/registry/manifest.json'),
      origin: 'configured',
    });
  });

  it('passes a configured absolute path through unchanged', () => {
    const root = appRootWithManifest();
    const absolute = resolve(root, 'elsewhere.json');
    expect(resolveRegistrySource(absolute, root)).toEqual({
      source: absolute,
      origin: 'configured',
    });
  });

  it('returns null when nothing is configured and nothing is bundled', () => {
    expect(
      resolveRegistrySource(undefined, appRootWithoutManifest()),
    ).toBeNull();
  });
});

describe('the shipped default manifest', () => {
  const manifest = JSON.parse(
    readFileSync('examples/registry/default.json', 'utf8'),
  ) as {
    version: number;
    plugins: Array<{ id: string; source: string; version: string }>;
    tools: unknown[];
  };

  it('is present at the path the resolver looks for', () => {
    expect(existsSync(DEFAULT_REGISTRY_MANIFEST_PATH)).toBe(true);
  });

  it('lists at least one plugin — an empty default registry is the bug this fixes', () => {
    expect(manifest.plugins.length).toBeGreaterThan(0);
  });

  it('resolves every source to a real example with a plugin manifest', () => {
    for (const plugin of manifest.plugins) {
      const dir = resolve('examples/registry', plugin.source);
      expect(existsSync(dir), `${plugin.id} source`).toBe(true);
      const pluginManifest = JSON.parse(
        readFileSync(join(dir, 'plugin.json'), 'utf8'),
      );
      expect(pluginManifest.name, `${plugin.id} manifest name`).toBe(plugin.id);
    }
  });

  it('stays installable offline: no listed plugin declares dependencies', () => {
    // A first run should never need the network to install a starter. Examples
    // that pull npm dependencies belong in the fuller manifest.json instead.
    for (const plugin of manifest.plugins) {
      const packagePath = join(
        resolve('examples/registry', plugin.source),
        'package.json',
      );
      if (!existsSync(packagePath)) continue;
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      expect(
        Object.keys(pkg.dependencies ?? {}),
        `${plugin.id} must not declare runtime dependencies`,
      ).toEqual([]);
    }
  });

  it('lists no plugin that declares a host build command', () => {
    // buildPlugin rejects manifest.build outright, so such a plugin can never
    // be installed and must not be advertised as installable.
    for (const plugin of manifest.plugins) {
      const pluginManifest = JSON.parse(
        readFileSync(
          join(resolve('examples/registry', plugin.source), 'plugin.json'),
          'utf8',
        ),
      );
      expect(pluginManifest.build, `${plugin.id}`).toBeUndefined();
    }
  });

  it('is a subset of the fuller catalog, so the two cannot drift apart', () => {
    const full = JSON.parse(
      readFileSync('examples/registry/manifest.json', 'utf8'),
    ) as { plugins: Array<{ id: string }> };
    const fullIds = new Set(full.plugins.map((p) => p.id));
    for (const plugin of manifest.plugins) {
      expect(fullIds, `${plugin.id} missing from manifest.json`).toContain(
        plugin.id,
      );
    }
  });
});
