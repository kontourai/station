/**
 * #2377 slice C2a: a plain folder's scope, on the real filesystem. The route
 * tests (`runtime-routes-station-control-dispatch-scope.test.ts`) drive the
 * same function through the dispatch routes; this pins the path edges.
 */
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { stationControlDirectoryScope } from '../station-control-dispatch-scope.js';

const makeTempDir = trackTempDirs();

function tree() {
  const root = realpathSync(makeTempDir('folder-scope-'));
  const project = join(root, 'proj');
  const nested = join(project, 'inner');
  for (const dir of [
    join(project, 'sub'),
    join(nested, 'deep'),
    join(root, 'proj-2'),
    join(root, 'elsewhere'),
  ])
    mkdirSync(dir, { recursive: true });
  symlinkSync(project, join(root, 'alias'));
  return { root, project, nested };
}

describe('stationControlDirectoryScope', () => {
  test('whole path segments, canonical paths, the deepest Project', () => {
    const { root, project, nested } = tree();
    const projects = [
      { id: 'p', workingDirectory: `${project}/` },
      { id: 'n', workingDirectory: nested },
    ];
    const scope = (cwd: string) => stationControlDirectoryScope(cwd, projects);
    expect(scope(project)).toEqual({ kind: 'project', id: 'p' });
    expect(scope(`${project}/sub/`)).toEqual({ kind: 'project', id: 'p' });
    expect(scope(join(project, 'sub', '..', 'sub'))).toEqual({
      kind: 'project',
      id: 'p',
    });
    expect(scope(join(root, 'proj-2'))).toEqual({ kind: 'global' });
    expect(scope(root)).toEqual({ kind: 'global' });
    expect(scope(join(nested, 'deep'))).toEqual({ kind: 'project', id: 'n' });
    // A symlink resolves to where it points, either side.
    expect(scope(join(root, 'alias', 'sub'))).toEqual({
      kind: 'project',
      id: 'p',
    });
    expect(
      stationControlDirectoryScope(join(project, 'sub'), [
        { id: 'via-alias', workingDirectory: join(root, 'alias') },
      ]),
    ).toEqual({ kind: 'project', id: 'via-alias' });
    // A folder that cannot be resolved is unreadable.
    expect(scope(join(root, 'missing'))).toEqual({ kind: 'unreadable' });
  });

  test('a Project whose directory is gone contains nothing; a folder under it cannot resolve', () => {
    const { root } = tree();
    const projects = [{ id: 'gone', workingDirectory: join(root, 'gone') }];
    expect(
      stationControlDirectoryScope(join(root, 'elsewhere'), projects),
    ).toEqual({ kind: 'global' });
    // A folder under a vanished Project cannot itself resolve.
    expect(
      stationControlDirectoryScope(join(root, 'gone', 'x'), projects),
    ).toEqual({ kind: 'unreadable' });
  });
});
