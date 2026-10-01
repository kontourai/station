import { describe, expect, test, vi } from 'vitest';
import {
  WORKSPACE_FILE_CHANGES_CONCURRENCY,
  WorkspaceFileChangesService,
} from '../workspace-file-changes-service.js';

/**
 * Request cost of the Changes read: the File Preview asks for it as each
 * file opens, so identical requests share one read and one workspace runs
 * at most WORKSPACE_FILE_CHANGES_CONCURRENCY at once. The git runner is a
 * gate the test releases; nothing here spawns git.
 */
function harness() {
  const preview = {
    changesTarget: (root: string, path: string) => ({
      root,
      target: `${root}/${path}`,
      existingAncestor: root,
    }),
  };
  let active = 0;
  let peak = 0;
  const pending: Array<() => void> = [];
  const git = vi.fn(async (args: string[]) => {
    // The discovery call: the work tree's start and the git directory.
    if (args[0] !== 'rev-parse' || !args.includes('--show-toplevel'))
      throw Object.assign(new Error('unexpected'), { stderr: '' });
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => pending.push(resolve));
    active -= 1;
    throw Object.assign(new Error('git failed'), {
      stderr: 'fatal: not a git repository (or any of the parent directories)',
    });
  });
  const service = new WorkspaceFileChangesService(preview, git);
  const releaseAll = async () => {
    while (pending.length || active) {
      pending.splice(0).forEach((resolve) => {
        resolve();
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  return { service, git, releaseAll, peak: () => peak };
}

describe('WorkspaceFileChangesService request cost', () => {
  test('identical concurrent requests share one read', async () => {
    const { service, git, releaseAll } = harness();
    const first = service.changes('/w', 'a.ts');
    const second = service.changes('/w', 'a.ts');
    expect(second).toBe(first);
    await releaseAll();
    await expect(first).resolves.toEqual({ state: 'not-a-repository' });
    expect(git).toHaveBeenCalledTimes(1);
    // Settled reads are not cached: the next request reads again.
    const third = service.changes('/w', 'a.ts');
    expect(third).not.toBe(first);
    await releaseAll();
    await third;
    expect(git).toHaveBeenCalledTimes(2);
  });

  test('one workspace runs at most the cap at once; the rest queue', async () => {
    expect(WORKSPACE_FILE_CHANGES_CONCURRENCY).toBe(2);
    const { service, git, releaseAll, peak } = harness();
    const reads = ['a', 'b', 'c', 'd', 'e'].map((name) =>
      service.changes('/w', `${name}.ts`),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(git).toHaveBeenCalledTimes(2);
    await releaseAll();
    await Promise.all(reads);
    expect(git).toHaveBeenCalledTimes(5);
    expect(peak()).toBe(2);
  });

  test.each([
    [
      "fatal: detected dubious ownership in repository at '/w'",
      { state: 'refused' },
    ],
    [
      'fatal: not a git repository (or any of the parent directories): .git',
      { state: 'not-a-repository' },
    ],
  ])(
    'classifies a discovery failure by its cause (%s)',
    async (stderr, expected) => {
      const service = new WorkspaceFileChangesService(
        {
          changesTarget: (root: string) => ({
            root,
            target: `${root}/a`,
            existingAncestor: root,
          }),
        },
        async () => {
          throw Object.assign(new Error('git failed'), { stderr });
        },
      );
      await expect(service.changes('/w', 'a')).resolves.toMatchObject(expected);
    },
  );

  test('a discovery deadline or unknown failure is an error, not "no repository"', async () => {
    for (const failure of [
      Object.assign(new Error('killed'), { killed: true, stderr: '' }),
      Object.assign(new Error('odd'), { stderr: 'fatal: something else' }),
    ]) {
      const service = new WorkspaceFileChangesService(
        {
          changesTarget: (root: string) => ({
            root,
            target: `${root}/a`,
            existingAncestor: root,
          }),
        },
        async () => {
          throw failure;
        },
      );
      await expect(service.changes('/w', 'a')).rejects.toBe(failure);
    }
  });
});
