import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The directory fsync is the step both seams exist to stop callers forgetting
 * (`durable-json-file.ts`'s docblock: two hand-rolled copies skipped it, and
 * its absence is invisible until a machine loses power). Both seams reach it
 * through this one helper, and BOTH now swallow a failure from it -- which
 * means deleting the call outright is silent. So these tests assert the call
 * happens, and separately that its failure is tolerated. One without the
 * other proves nothing: the swallow test alone stays green when the fsync is
 * removed entirely.
 */
const fsyncDirectorySync = vi.hoisted(() => vi.fn());
vi.mock('../fs-windows-compat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fs-windows-compat.js')>()),
  fsyncDirectorySync,
}));

import { writeJsonDurably } from '../durable-json-file.js';
import { publishJsonFileWithOwnedLock } from '../json-file-storage.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  fsyncDirectorySync.mockReset();
  fsyncDirectorySync.mockImplementation(() => {});
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'durable-json-dirfsync-'));
  roots.push(dir);
  return dir;
}

/**
 * Ordering, without mocking `node:fs` underneath the code under test: the spy
 * records what the directory looked like AT THE MOMENT it was called. If the
 * rename has already happened the target holds the new bytes and the
 * temporary is gone; if the fsync ran first it would see the old bytes (or no
 * file) and a stray `.tmp`.
 */
function observeAtFsync(path: string, directory: string) {
  const seen: { entries: string[]; content: string | null }[] = [];
  fsyncDirectorySync.mockImplementation((argument: string) => {
    expect(argument).toBe(directory);
    let content: string | null = null;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      // Recorded as null: the assertion below is what reports it.
    }
    seen.push({ entries: readdirSync(directory).sort(), content });
  });
  return seen;
}

describe('writeJsonDurably directory durability', () => {
  test('fsyncs the containing directory AFTER the rename commits', () => {
    const directory = root();
    const path = join(directory, 'state.json');
    const seen = observeAtFsync(path, directory);

    writeJsonDurably(path, { generation: 2 });

    expect(fsyncDirectorySync).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      {
        entries: ['state.json'],
        content: `${JSON.stringify({ generation: 2 }, null, 2)}\n`,
      },
    ]);
  });

  test('a directory fsync that fails AFTER the rename does not report a failed write', () => {
    // The rename already published the bytes. Throwing here tells the caller
    // the write did not happen when a reader can already see it -- and
    // callers act on that (the plugin install transaction rolls plugin state
    // back, `recordCorruptionObserved` returns "this call did not write it",
    // the import CLI prints "registration is unconfirmed").
    const directory = root();
    const path = join(directory, 'state.json');
    writeFileSync(path, 'PREVIOUS', 'utf8');
    fsyncDirectorySync.mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    });

    expect(() => writeJsonDurably(path, { generation: 2 })).not.toThrow();

    expect(fsyncDirectorySync).toHaveBeenCalledTimes(1);
    expect(readFileSync(path, 'utf8')).toBe(
      `${JSON.stringify({ generation: 2 }, null, 2)}\n`,
    );
  });
});

describe('publishJsonFileWithOwnedLock directory durability', () => {
  test('fsyncs the containing directory AFTER the rename commits', async () => {
    const directory = root();
    const path = join(directory, 'state.json');
    const seen = observeAtFsync(path, directory);

    await publishJsonFileWithOwnedLock(path, { generation: 2 });

    expect(fsyncDirectorySync).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      {
        entries: ['state.json'],
        content: JSON.stringify({ generation: 2 }, null, 2),
      },
    ]);
  });

  test('a directory fsync that fails AFTER the rename does not report a failed write', async () => {
    const directory = root();
    const path = join(directory, 'state.json');
    writeFileSync(path, 'PREVIOUS', 'utf8');
    fsyncDirectorySync.mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    });

    await expect(
      publishJsonFileWithOwnedLock(path, { generation: 2 }),
    ).resolves.toBeUndefined();

    expect(fsyncDirectorySync).toHaveBeenCalledTimes(1);
    expect(readFileSync(path, 'utf8')).toBe(
      JSON.stringify({ generation: 2 }, null, 2),
    );
  });
});
