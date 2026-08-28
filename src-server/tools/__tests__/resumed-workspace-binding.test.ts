import { describe, expect, test } from 'vitest';
import { resumedWorkspaceBinding } from '../station-control-delegation.js';

/**
 * archive#3421: `station chat` prints a `Resume:` command in its own success
 * output, and that command could never work. A continuation names a
 * conversation, so the CLI deliberately sends no workspace and refuses
 * workspace flags there — the server rebuilds the binding instead. It rebuilt
 * only the PROJECT shape, so a conversation bound to a plain directory (every
 * chat started outside a registered project) came back with no workspace at
 * all, and the continuation guard reads an absent workspace beside a bound cwd
 * as a mismatch.
 */
describe('the workspace a resumed conversation inherits', () => {
  test('rebuilds a directory binding from the session cwd', () => {
    expect(resumedWorkspaceBinding({}, '/private/tmp/glm-workspace')).toEqual({
      workspace: { kind: 'directory', cwd: '/private/tmp/glm-workspace' },
    });
  });

  test('still rebuilds a project binding, isolation included', () => {
    expect(
      resumedWorkspaceBinding(
        { projectSlug: 'station', workspaceIsolation: { mode: 'worktree' } },
        '/repos/station',
      ),
    ).toEqual({
      workspace: {
        kind: 'project',
        projectSlug: 'station',
        workspaceIsolation: { mode: 'worktree' },
      },
    });
  });

  test('a project binding wins over the session cwd', () => {
    // The project IS the binding; its cwd is resolved from the project, not
    // from wherever this session happened to be started.
    expect(
      resumedWorkspaceBinding({ projectSlug: 'station' }, '/somewhere/else'),
    ).toEqual({ workspace: { kind: 'project', projectSlug: 'station' } });
  });

  test('an unrecognized isolation mode is dropped rather than passed through', () => {
    expect(
      resumedWorkspaceBinding(
        { projectSlug: 'station', workspaceIsolation: { mode: 'nonsense' } },
        '/repos/station',
      ),
    ).toEqual({ workspace: { kind: 'project', projectSlug: 'station' } });
  });

  test('a conversation with no binding at all yields no workspace key', () => {
    // The one shape the continuation guard accepts as legitimately absent: a
    // direct chat that never had a workspace. It must stay absent, not become
    // an empty directory binding.
    expect(resumedWorkspaceBinding(undefined, undefined)).toEqual({});
    expect(resumedWorkspaceBinding({}, '   ')).toEqual({});
  });
});
