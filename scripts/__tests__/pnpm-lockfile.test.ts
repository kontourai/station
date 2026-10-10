import { createRequire } from 'node:module';
import { describe, expect, test, vi } from 'vitest';
import { readPnpmLockfile, readPnpmWorkspace } from '../lib/pnpm-lockfile.mjs';

const require = createRequire(import.meta.url);

function lock(version: string) {
  return JSON.stringify({
    lockfileVersion: '9.0',
    importers: {
      '.': { dependencies: { datum: { specifier: version, version } } },
    },
    packages: {
      [`datum@${version}`]: { resolution: { integrity: 'sha512-x' } },
    },
  });
}

describe('live pnpm YAML reads', () => {
  test('reuses parsing while reading current bytes and keeping caller mutations isolated', () => {
    const yaml = require('yaml');
    const parse = vi.spyOn(yaml, 'parseDocument');
    let text = lock('4.0.0');
    const read = vi.fn(() => text);
    try {
      const first = readPnpmLockfile('/first', read);
      first.importers['.'].dependencies.datum.version = 'broken';
      expect(
        readPnpmLockfile('/second', read).importers['.'].dependencies.datum
          .version,
      ).toBe('4.0.0');
      expect(read).toHaveBeenCalledTimes(2);
      expect(parse).toHaveBeenCalledTimes(1);
      text = lock('5.0.0');
      expect(
        readPnpmLockfile('/first', read).importers['.'].dependencies.datum
          .version,
      ).toBe('5.0.0');
      expect(parse).toHaveBeenCalledTimes(2);
      expect(() =>
        readPnpmLockfile('/first', () => {
          throw new Error('unreadable');
        }),
      ).toThrow('unreadable');
    } finally {
      parse.mockRestore();
    }
  });

  test('rejects invalid or unsupported replacements and recovers on valid bytes', () => {
    let text = lock('6.0.0');
    const read = () => text;
    expect(readPnpmLockfile('/root', read).lockfileVersion).toBe('9.0');
    for (const invalid of [
      "lockfileVersion: '9.0'\nlockfileVersion: '8.0'\nimporters: {}\npackages: {}\n",
      "lockfileVersion: '8.0'\nimporters: {}\npackages: {}\n",
      "lockfileVersion: '9.0'\nimporters: []\npackages: {}\n",
      'value: [unterminated',
    ]) {
      text = invalid;
      expect(() => readPnpmLockfile('/root', read)).toThrow();
    }
    text = lock('6.0.0');
    expect(readPnpmLockfile('/root', read).lockfileVersion).toBe('9.0');
  });

  test('normalizes link-only locks without leaking synthetic maps to another read', () => {
    const text =
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      local: {specifier: 'workspace:*', version: 'link:packages/local'}\n";
    const first = readPnpmLockfile('/root', () => text);
    first.packages.injected = {};
    first.snapshots.injected = {};
    expect(readPnpmLockfile('/root', () => text)).toMatchObject({
      packages: {},
      snapshots: {},
    });
  });

  test('evicts old parsed inputs and does not retain oversized documents', () => {
    const yaml = require('yaml');
    const parse = vi.spyOn(yaml, 'parseDocument');
    try {
      for (const version of ['7.0.0', '8.0.0', '9.0.0', '7.0.0'])
        readPnpmLockfile('/root', () => lock(version));
      expect(parse).toHaveBeenCalledTimes(4);
      const oversized = `packages: [packages/*]\n# ${'x'.repeat(3 * 1024 * 1024)}\n`;
      expect(readPnpmWorkspace('/root', () => oversized).packages).toEqual([
        'packages/*',
      ]);
      expect(readPnpmWorkspace('/root', () => oversized).packages).toEqual([
        'packages/*',
      ]);
      expect(parse).toHaveBeenCalledTimes(6);
    } finally {
      parse.mockRestore();
    }
  });

  test('preserves YAML scalar types and validates each workspace read', () => {
    const text = 'packages: [packages/*]\nbuiltAt: !!timestamp 2026-10-10\n';
    const first = readPnpmWorkspace('/root', () => text);
    first.packages.push('injected/*');
    expect(first.builtAt).toBeInstanceOf(Date);
    expect(readPnpmWorkspace('/other', () => text).builtAt.getTime()).toBe(
      Date.UTC(2026, 9, 10),
    );
    expect(readPnpmWorkspace('/other', () => text).packages).toEqual([
      'packages/*',
    ]);
    expect(() => readPnpmWorkspace('/root', () => '[]')).toThrow(
      'unsupported shape',
    );
  });
});
