import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { writeJsonDurably } from '../durable-json-file.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'durable-json-'));
  roots.push(dir);
  return dir;
}

describe('writeJsonDurably', () => {
  test('the value round-trips', () => {
    const path = join(root(), 'state.json');
    writeJsonDurably(path, { a: 1, nested: { b: [true, null] } });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      a: 1,
      nested: { b: [true, null] },
    });
  });

  test('it replaces existing content rather than appending to it', () => {
    const path = join(root(), 'state.json');
    writeJsonDurably(path, { generation: 1 });
    writeJsonDurably(path, { generation: 2 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ generation: 2 });
  });

  test('it leaves no temporary behind on success', () => {
    // A directory that accumulates one file per write is the failure mode a
    // rename-based writer is most likely to ship unnoticed.
    const directory = root();
    writeJsonDurably(join(directory, 'state.json'), { a: 1 });
    writeJsonDurably(join(directory, 'state.json'), { a: 2 });
    expect(readdirSync(directory)).toEqual(['state.json']);
  });

  test('it creates the containing directory', () => {
    const path = join(root(), 'nested', 'deeper', 'state.json');
    writeJsonDurably(path, { a: 1 });
    expect(existsSync(path)).toBe(true);
  });

  test('a symlinked target is replaced, never written through', () => {
    // O_NOFOLLOW guards the TEMPORARY; the rename then replaces the link
    // itself. Either way the pointed-at file must be untouched: a writer that
    // follows a link writes wherever an attacker aimed it.
    const directory = root();
    const decoy = join(directory, 'decoy.json');
    writeFileSync(decoy, 'ORIGINAL', 'utf8');
    const path = join(directory, 'state.json');
    symlinkSync(decoy, path);

    writeJsonDurably(path, { a: 1 });

    expect(readFileSync(decoy, 'utf8')).toBe('ORIGINAL');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
  });

  test('a symlinked containing DIRECTORY is refused', () => {
    // Recursive mkdir treats an existing symlink-to-directory as success. One
    // caller's directory lives under a world-writable tmpdir() and its own
    // creator is deliberately non-recursive and lstat-checked; a shared
    // primitive must not quietly weaken that.
    const base = root();
    const real = join(base, 'real');
    mkdirSync(real);
    const link = join(base, 'link');
    symlinkSync(real, link);

    expect(() => writeJsonDurably(join(link, 'state.json'), { a: 1 })).toThrow(
      /symlinked directory/,
    );
    expect(existsSync(join(real, 'state.json'))).toBe(false);
  });

  test('a DANGLING symlinked directory is refused by name', () => {
    // existsSync follows the link, so the first version of this guard fell
    // through to mkdir and failed with a bare ENOENT — closed, but reporting
    // the wrong reason for a case it was written to cover.
    const base = root();
    const link = join(base, 'link');
    symlinkSync(join(base, 'never-created'), link);

    expect(() => writeJsonDurably(join(link, 'state.json'), { a: 1 })).toThrow(
      /symlinked directory/,
    );
  });

  test('an unwritable destination throws rather than reporting success', () => {
    expect(() =>
      writeJsonDurably('/dev/null/impossible/state.json', { a: 1 }),
    ).toThrow();
  });
});
