import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Simulates a swap between the reader's lstat and its open: when `swapTo` is
// set, lstat reports THAT file's stat for the manifest path, so the open
// lands on a different regular file than the one the lstat approved.
const swap = vi.hoisted(() => ({ to: null as string | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: vi.fn((path: Parameters<typeof actual.lstatSync>[0]) =>
      actual.lstatSync(swap.to ?? path),
    ),
  };
});

const { readPluginManifestBytesBounded } = await import(
  '../plugin-manifest-bounded-read.js'
);

const cleanup: string[] = [];
afterEach(async () => {
  swap.to = null;
  await Promise.all(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-bounded-read-'));
  cleanup.push(root);
  const manifest = join(root, 'plugin.json');
  writeFileSync(manifest, JSON.stringify({ name: 'real', version: '1.0.0' }));
  const other = join(root, 'other.json');
  writeFileSync(other, JSON.stringify({ name: 'other', version: '1.0.0' }));
  return { manifest, other };
}

describe('readPluginManifestBytesBounded descriptor identity (#2342 review)', () => {
  test('reads the file the lstat approved', () => {
    const { manifest } = fixture();
    expect(readPluginManifestBytesBounded(manifest)).toEqual({
      ok: true,
      raw: JSON.stringify({ name: 'real', version: '1.0.0' }),
    });
  });

  test('refuses when the opened file is not the one the lstat saw', () => {
    const { manifest, other } = fixture();
    // Both are regular files, so only the inode/device comparison can tell
    // the opened descriptor from the approved path.
    swap.to = other;
    expect(readPluginManifestBytesBounded(manifest)).toEqual({
      ok: false,
      code: 'manifest-not-regular-file',
      message: 'plugin.json is not a regular file.',
    });
  });
});
