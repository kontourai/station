import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { assertExistingPathInside } from '../path-containment.js';

// Real temp-dir fixtures: every shape below is resolved by the filesystem,
// not a mocked `fs`, because the defect (#1502) is a disagreement between
// the JS realpath and what the OS actually opens.
const makeTempDir = trackTempDirs();

function fixture() {
  const base = realpathSync.native(makeTempDir('station-path-containment-'));
  const root = join(base, 'package');
  mkdirSync(join(root, 'dir'), { recursive: true });
  mkdirSync(join(base, 'outside-dir'));
  writeFileSync(join(base, 'outside'), 'outside witness');
  writeFileSync(join(root, 'dir', 'outside'), 'inside decoy');
  writeFileSync(join(root, 'dir', 'file'), 'inside');
  return { base, root };
}

function refusal(root: string, candidate: string): Error {
  try {
    assertExistingPathInside(root, candidate, 'Fixture path');
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the containment check to refuse');
}

describe('assertExistingPathInside', () => {
  test('accepts ordinary contained files, contained links and contained missing leaves', () => {
    const { root } = fixture();
    symlinkSync('dir/file', join(root, 'inside-link'));
    for (const candidate of [
      join(root, 'dir', 'file'),
      join(root, 'inside-link'),
      join(root, 'dir', 'not-yet', 'created.txt'),
      root,
    ]) {
      expect(() =>
        assertExistingPathInside(root, candidate, 'Fixture path'),
      ).not.toThrow();
    }
  });

  test('refuses a symlink chain whose `..` resolves outside even though the JS realpath reports an inside decoy', () => {
    const { base, root } = fixture();
    symlinkSync('..', join(root, 'dir', 'up'));
    symlinkSync('dir/up/../outside', join(root, 'escape'));
    const candidate = join(root, 'escape');
    // The fixture reaches the defect: the OS reads the outside file while
    // the JS realpath names the decoy inside the root.
    expect(readFileSync(candidate, 'utf8')).toBe('outside witness');
    expect(realpathSync(candidate)).toBe(join(root, 'dir', 'outside'));

    const error = refusal(root, candidate);
    expect(error.message).toBe('Fixture path escapes root');
    expect(error.message).not.toContain(base);
  });

  test('refuses an existing leaf beneath a symlinked parent directory that points outside', () => {
    const { base, root } = fixture();
    writeFileSync(join(base, 'outside-dir', 'secret'), 'outside');
    symlinkSync(join(base, 'outside-dir'), join(root, 'linked'));
    expect(refusal(root, join(root, 'linked', 'secret')).message).toBe(
      'Fixture path escapes root',
    );
  });

  test('refuses a missing leaf whose existing parent resolves outside', () => {
    const { base, root } = fixture();
    symlinkSync(join(base, 'outside-dir'), join(root, 'linked'));
    symlinkSync('..', join(root, 'dir', 'up'));
    symlinkSync('dir/up/../outside-dir', join(root, 'chained'));
    for (const candidate of [
      join(root, 'linked', 'new.txt'),
      join(root, 'linked', 'nested', 'new.txt'),
      join(root, 'chained', 'new.txt'),
    ]) {
      expect(refusal(root, candidate).message).toBe(
        'Fixture path escapes root',
      );
    }
  });

  test('refuses dangling and cyclic links instead of treating them as absent', () => {
    const { base, root } = fixture();
    const outsideTarget = join(base, 'created-through-link');
    symlinkSync(outsideTarget, join(root, 'dangling'));
    symlinkSync('cycle-b', join(root, 'cycle-a'));
    symlinkSync('cycle-a', join(root, 'cycle-b'));

    expect(refusal(root, join(root, 'dangling')).message).toBe(
      'Fixture path cannot be resolved (ENOENT)',
    );
    expect(refusal(root, join(root, 'cycle-a')).message).toBe(
      'Fixture path cannot be resolved (ELOOP)',
    );
    expect(refusal(root, join(root, 'cycle-a', 'child')).message).toMatch(
      /^Fixture path cannot be resolved \(E[A-Z]+\)$/,
    );
    // Why a dangling link must not pass as "absent": writing through it
    // creates the outside target.
    writeFileSync(join(root, 'dangling'), 'escaped');
    expect(existsSync(outsideTarget)).toBe(true);
  });

  test('keeps the lexical refusal and allows an absent root', () => {
    const { base, root } = fixture();
    expect(refusal(root, join(root, '..', 'outside')).message).toBe(
      'Fixture path escapes root',
    );
    const absent = join(base, 'absent-root');
    expect(() =>
      assertExistingPathInside(absent, join(absent, 'child'), 'Fixture path'),
    ).not.toThrow();
  });

  test('refuses a root that is itself a dangling link', () => {
    const { base } = fixture();
    const root = join(base, 'dangling-root');
    symlinkSync(join(base, 'missing'), root);
    expect(refusal(root, join(root, 'child')).message).toBe(
      'Fixture path root cannot be resolved (ENOENT)',
    );
  });

  test('compares case-variant spellings on the resolved form on case-insensitive filesystems', (context) => {
    const { root } = fixture();
    if (!existsSync(join(root, 'DIR', 'FILE'))) {
      context.skip();
      return;
    }
    symlinkSync('..', join(root, 'dir', 'up'));
    symlinkSync('DIR/UP/../OUTSIDE', join(root, 'escape'));
    expect(() =>
      assertExistingPathInside(root, join(root, 'DIR', 'FILE'), 'Fixture path'),
    ).not.toThrow();
    expect(refusal(root, join(root, 'escape')).message).toBe(
      'Fixture path escapes root',
    );
  });

  // `junction` is a Windows reparse point; other platforms ignore the type
  // and create a directory symlink, which is the same escape shape.
  test('refuses an existing and a missing leaf beneath a directory junction that points outside', () => {
    const { base, root } = fixture();
    writeFileSync(join(base, 'outside-dir', 'secret'), 'outside');
    symlinkSync(join(base, 'outside-dir'), join(root, 'junction'), 'junction');
    for (const candidate of [
      join(root, 'junction', 'secret'),
      join(root, 'junction', 'new.txt'),
    ]) {
      expect(refusal(root, candidate).message).toBe(
        'Fixture path escapes root',
      );
    }
  });
});
