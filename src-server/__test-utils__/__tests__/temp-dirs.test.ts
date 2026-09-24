import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { removeTempDirs, trackTempDirs } from '../temp-dirs.js';

/**
 * Each case creates a directory in one test and checks it in the NEXT one:
 * the hook under test runs between them, so a same-test assertion could only
 * ever prove creation. Order matters here; vitest runs a file's tests in
 * declaration order.
 */

describe('per-test lifetime', () => {
  const makeTempDir = trackTempDirs();
  let passed = '';
  let failed = '';
  let readOnly = '';

  test('creates the directory under the system temp dir with the prefix', () => {
    passed = makeTempDir('temp-dirs-helper-');
    expect(existsSync(passed)).toBe(true);
    expect(passed.startsWith(join(tmpdir(), 'temp-dirs-helper-'))).toBe(true);
  });

  test('removed it after the test that made it', () => {
    expect(passed).not.toBe('');
    expect(existsSync(passed)).toBe(false);
  });

  test.fails('a failing test still gets its cleanup', () => {
    failed = makeTempDir('temp-dirs-helper-');
    throw new Error('assertion failure before any in-body cleanup');
  });

  test('removed the failing test’s directory too', () => {
    expect(failed).not.toBe('');
    expect(existsSync(failed)).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'a read-only subtree does not defeat removal',
    () => {
      readOnly = makeTempDir('temp-dirs-helper-');
      const locked = join(readOnly, 'locked');
      mkdirSync(locked);
      writeFileSync(join(locked, 'file.txt'), 'x');
      chmodSync(locked, 0o500);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'removed the read-only tree',
    () => {
      expect(readOnly).not.toBe('');
      expect(existsSync(readOnly)).toBe(false);
    },
  );
});

describe('file lifetime', () => {
  let shared = '';

  describe('scope sharing one directory', () => {
    const makeTempDir = trackTempDirs({ lifetime: 'file' });

    beforeAll(() => {
      shared = makeTempDir('temp-dirs-helper-');
    });

    test('first test sees it', () => {
      expect(existsSync(shared)).toBe(true);
    });

    test('second test still sees it', () => {
      expect(existsSync(shared)).toBe(true);
    });
  });

  test('removed once its scope finished', () => {
    expect(shared).not.toBe('');
    expect(existsSync(shared)).toBe(false);
  });
});

describe('removeTempDirs', () => {
  test('one directory that will not go does not leak the others', () => {
    const attempted: string[] = [];
    const stuck = new Error('EBUSY');
    expect(() =>
      removeTempDirs(['a', 'b', 'c'], (directory) => {
        attempted.push(directory);
        if (directory === 'a') throw stuck;
      }),
    ).toThrow(stuck);
    expect(attempted).toEqual(['a', 'b', 'c']);
  });

  test('several failures are reported together', () => {
    expect(() =>
      removeTempDirs(['a', 'b'], () => {
        throw new Error('EBUSY');
      }),
    ).toThrow(AggregateError);
  });
});
