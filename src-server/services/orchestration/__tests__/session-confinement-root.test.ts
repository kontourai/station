/**
 * #3800: the folder a non-host Codex start is authorized for, from this
 * Station's Project list. It is what the adapter trusts a `.codex` by, so a
 * folder an agent picks (a plain path inside its Project) never becomes its
 * own anchor.
 */
import { describe, expect, test } from 'vitest';
import { sessionConfinementRoot } from '../session-project-identity.js';

const PROJECTS = [
  { slug: 'outer', workingDirectory: '/work/outer' },
  { slug: 'inner', workingDirectory: '/work/outer/packages/inner' },
  { slug: 'dirless' },
];

describe('sessionConfinementRoot', () => {
  test('the named Project when it contains the cwd', () => {
    expect(
      sessionConfinementRoot('/work/outer/packages/inner/src', PROJECTS, {
        projectSlug: 'outer',
      }),
    ).toBe('/work/outer');
  });

  test('a start naming no Project gets the deepest Project around its cwd, not the cwd', () => {
    expect(
      sessionConfinementRoot('/work/outer/packages/inner/D', PROJECTS),
    ).toBe('/work/outer/packages/inner');
    expect(sessionConfinementRoot('/work/outer/sub/D', PROJECTS)).toBe(
      '/work/outer',
    );
  });

  test('a named Project that does not contain the cwd is not used', () => {
    expect(
      sessionConfinementRoot('/work/outer/sub', PROJECTS, {
        projectSlug: 'inner',
      }),
    ).toBe('/work/outer');
  });

  test('a server-admitted workspace outside every Project is its own root', () => {
    expect(
      sessionConfinementRoot('/worktrees/lane', PROJECTS, {
        admittedCwd: '/worktrees/lane',
      }),
    ).toBe('/worktrees/lane');
    // Only that exact folder: a subfolder of it is not admitted.
    expect(
      sessionConfinementRoot('/worktrees/lane/sub', PROJECTS, {
        admittedCwd: '/worktrees/lane',
      }),
    ).toBe('');
  });

  test('a folder outside every Project, or no cwd, trusts nothing', () => {
    expect(sessionConfinementRoot('/elsewhere/repo', PROJECTS)).toBe('');
    expect(sessionConfinementRoot(undefined, PROJECTS)).toBe('');
  });

  test('a sibling sharing a prefix is not inside the Project', () => {
    expect(sessionConfinementRoot('/work/outer-two', PROJECTS)).toBe('');
  });
});
