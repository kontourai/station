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

  // The document format is a store's on-disk contract, so the default is
  // pinned as exact text rather than as a parsed value: every caller that
  // passes no options must keep the bytes it had before options existed.
  test('the default document is two-space JSON with a trailing newline', () => {
    const path = join(root(), 'state.json');
    writeJsonDurably(path, { a: 1, nested: { b: [true, null] } });
    expect(readFileSync(path, 'utf8')).toBe(
      `${JSON.stringify({ a: 1, nested: { b: [true, null] } }, null, 2)}\n`,
    );
  });

  test('indent: null writes the compact form', () => {
    const path = join(root(), 'state.json');
    writeJsonDurably(
      path,
      { a: 1, nested: { b: [true, null] } },
      {
        indent: null,
      },
    );
    expect(readFileSync(path, 'utf8')).toBe(
      '{"a":1,"nested":{"b":[true,null]}}\n',
    );
  });

  // `null` and "not supplied" are different answers, and a `?? 2` read of the
  // option collapses them -- which is the whole defect this asserts against.
  test('indent: null is not read as "no answer"', () => {
    const path = join(root(), 'state.json');
    writeJsonDurably(path, { a: 1 }, { indent: null });
    expect(readFileSync(path, 'utf8')).not.toContain('\n  ');
  });

  test('indent: 4 writes four-space JSON', () => {
    const path = join(root(), 'state.json');
    writeJsonDurably(path, { a: 1 }, { indent: 4 });
    expect(readFileSync(path, 'utf8')).toBe('{\n    "a": 1\n}\n');
  });

  test('trailingNewline: false omits the newline', () => {
    const path = join(root(), 'state.json');
    writeJsonDurably(path, { a: 1 }, { trailingNewline: false });
    expect(readFileSync(path, 'utf8')).toBe('{\n  "a": 1\n}');
  });

  test('the two options compose', () => {
    const path = join(root(), 'state.json');
    writeJsonDurably(path, { a: 1 }, { indent: null, trailingNewline: false });
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}');
  });
});
