import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  isDirectoryPhysicallyWithin,
  isDirectoryWithin,
  resolveSkillDirectory,
} from '../skill-paths.js';

let home: string;
let outside: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skill-paths-'));
  outside = mkdtempSync(join(tmpdir(), 'skill-paths-outside-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('isDirectoryPhysicallyWithin', () => {
  test('a real child is inside', () => {
    mkdirSync(join(home, 'skills', 'alpha'), { recursive: true });
    expect(
      isDirectoryPhysicallyWithin(
        join(home, 'skills'),
        join(home, 'skills', 'alpha'),
      ),
    ).toBe(true);
  });

  test('a skill directory that does not exist yet is inside', () => {
    mkdirSync(join(home, 'skills'), { recursive: true });
    expect(
      isDirectoryPhysicallyWithin(
        join(home, 'skills'),
        join(home, 'skills', 'new'),
      ),
    ).toBe(true);
  });

  test('a symlink pointing out of the root is NOT inside, though it looks it', () => {
    // The exact gap: lexically `<root>/aliased` is a child, so the string
    // comparison passes while every write to it lands in `outside`.
    mkdirSync(join(home, 'skills'), { recursive: true });
    symlinkSync(outside, join(home, 'skills', 'aliased'), 'dir');

    expect(
      isDirectoryWithin(join(home, 'skills'), join(home, 'skills', 'aliased')),
    ).toBe(true);
    expect(
      isDirectoryPhysicallyWithin(
        join(home, 'skills'),
        join(home, 'skills', 'aliased'),
      ),
    ).toBe(false);
  });

  test('a symlinked ROOT is fine — the tree itself may legitimately be a link', () => {
    const realSkills = join(outside, 'real-skills');
    mkdirSync(realSkills, { recursive: true });
    mkdirSync(join(realSkills, 'alpha'), { recursive: true });
    mkdirSync(home, { recursive: true });
    symlinkSync(realSkills, join(home, 'skills'), 'dir');

    expect(
      isDirectoryPhysicallyWithin(
        join(home, 'skills'),
        join(home, 'skills', 'alpha'),
      ),
    ).toBe(true);
  });

  test('a root that does not exist yet has nothing aliased', () => {
    expect(
      isDirectoryPhysicallyWithin(
        join(home, 'skills'),
        join(home, 'skills', 'alpha'),
      ),
    ).toBe(true);
  });
});

describe('resolveSkillDirectory refuses a symlinked-out skill directory', () => {
  test('the write seam refuses it, not just the predicate', () => {
    mkdirSync(join(home, 'skills'), { recursive: true });
    symlinkSync(outside, join(home, 'skills', 'aliased'), 'dir');
    writeFileSync(join(outside, 'canary.txt'), 'untouched', 'utf-8');

    expect(() => resolveSkillDirectory(home, 'aliased')).toThrow(
      /resolves outside/,
    );
  });

  test('an ordinary name still resolves', () => {
    expect(resolveSkillDirectory(home, 'alpha')).toBe(
      join(home, 'skills', 'alpha'),
    );
  });
});
