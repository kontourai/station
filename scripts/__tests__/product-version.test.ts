import {
  cpSync,
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
  assertProductVersion,
  checkProductVersion,
  syncProductVersion,
} from '../product-version.mjs';

const root = resolve(import.meta.dirname, '../..');
const temporaryRoots = new Set<string>();

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'station-product-version-'));
  temporaryRoots.add(directory);
  cpSync(join(root, 'package.json'), join(directory, 'package.json'));
  const desktopDirectory = join(directory, 'src-desktop');
  mkdirSync(desktopDirectory, { recursive: true });
  for (const filename of ['tauri.conf.json', 'Cargo.toml', 'Cargo.lock']) {
    cpSync(
      join(root, 'src-desktop', filename),
      join(desktopDirectory, filename),
    );
  }
  return directory;
}

afterEach(() => {
  for (const directory of temporaryRoots) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

function rootCargoLockVersion(lock: string): string {
  const match = /\[\[package\]\]\nname = "station"\nversion = "([^"]+)"/.exec(
    lock,
  );
  if (!match) throw new Error('Expected Station root package in Cargo.lock');
  return match[1];
}

describe('product version authority', () => {
  it('keeps checked-in Tauri and Cargo versions equal to root package.json', () => {
    expect(checkProductVersion(root)).toBe(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    );
  });

  it.each(['minified', 'pretty'])(
    'synchronizes a %s Tauri config by parsing JSON, not formatting',
    (format) => {
      const directory = fixture();
      const version = JSON.parse(
        readFileSync(join(directory, 'package.json'), 'utf8'),
      ).version;
      const tauriPath = join(directory, 'src-desktop/tauri.conf.json');
      const tauri = JSON.parse(readFileSync(tauriPath, 'utf8'));
      writeFileSync(
        tauriPath,
        JSON.stringify(
          { ...tauri, version: '9.9.9' },
          null,
          format === 'pretty' ? 2 : undefined,
        ),
      );

      expect(syncProductVersion(directory)).toBe(version);
      expect(JSON.parse(readFileSync(tauriPath, 'utf8')).version).toBe(version);
    },
  );

  it('synchronizes Tauri, Cargo.toml, and the exact Cargo.lock root package', () => {
    const directory = fixture();
    const version = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    ).version;
    const tauriPath = join(directory, 'src-desktop/tauri.conf.json');
    const cargoPath = join(directory, 'src-desktop/Cargo.toml');
    const cargoLockPath = join(directory, 'src-desktop/Cargo.lock');
    const tauri = JSON.parse(readFileSync(tauriPath, 'utf8'));
    writeFileSync(tauriPath, JSON.stringify({ ...tauri, version: '9.9.9' }));
    writeFileSync(
      cargoPath,
      readFileSync(cargoPath, 'utf8').replace(
        `version = "${version}"`,
        'version = "9.9.9"',
      ),
    );
    writeFileSync(
      cargoLockPath,
      readFileSync(cargoLockPath, 'utf8').replace(
        `name = "station"\nversion = "${version}"`,
        'name = "station"\nversion = "9.9.9"',
      ),
    );

    expect(() => checkProductVersion(directory)).toThrow(
      /Native product version is out of sync/,
    );
    expect(syncProductVersion(directory)).toBe(version);
    expect(checkProductVersion(directory)).toBe(version);
    expect(rootCargoLockVersion(readFileSync(cargoLockPath, 'utf8'))).toBe(
      version,
    );
  });

  it.each([
    [
      'missing',
      (source: string) =>
        source.replace('name = "station"', 'name = "station-missing"'),
    ],
    [
      'duplicate',
      (source: string) =>
        `${source}\n[[package]]\nname = "station"\nversion = "0.0.0"\n`,
    ],
  ])('rejects a %s Station root package in Cargo.lock', (_case, mutate) => {
    const directory = fixture();
    const cargoLockPath = join(directory, 'src-desktop/Cargo.lock');
    writeFileSync(cargoLockPath, mutate(readFileSync(cargoLockPath, 'utf8')));

    expect(() => checkProductVersion(directory)).toThrow(
      /Cargo\.lock must contain exactly one \[\[package\]\] name = "station"/,
    );
    expect(() => syncProductVersion(directory)).toThrow(
      /Cargo\.lock must contain exactly one \[\[package\]\] name = "station"/,
    );
  });

  it.each(['1.2', '01.2.3', '1.2.3-preview.1', ''])(
    'rejects non-stable release authority %s',
    (version) =>
      expect(() => assertProductVersion(version)).toThrow(/Product version/),
  );
});
