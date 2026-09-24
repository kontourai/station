import { describe, expect, test } from 'vitest';
import { sessionRunsInProjectDirectory } from '../sessionDirectory';

describe('whether a session runs in its project checkout', () => {
  test('the same directory, with or without a trailing slash or a ~/ project path', () => {
    expect(sessionRunsInProjectDirectory('/u/me/repo', '/u/me/repo/')).toBe(
      true,
    );
    expect(sessionRunsInProjectDirectory('/u/me/dev/repo', '~/dev/repo')).toBe(
      true,
    );
    // Unknown is not a mismatch: nothing says the session is elsewhere.
    expect(sessionRunsInProjectDirectory('', '/u/me/repo')).toBe(true);
    expect(sessionRunsInProjectDirectory('/u/me/repo', null)).toBe(true);
  });

  test('an isolated worktree, or a sibling with a longer name, is elsewhere', () => {
    expect(
      sessionRunsInProjectDirectory(
        '/u/me/.t3/worktrees/repo/lane',
        '/u/me/repo',
      ),
    ).toBe(false);
    expect(sessionRunsInProjectDirectory('/u/me/repo-2', '/u/me/repo')).toBe(
      false,
    );
  });
});
