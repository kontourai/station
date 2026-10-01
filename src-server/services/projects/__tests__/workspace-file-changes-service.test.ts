import { describe, expect, test, vi } from 'vitest';
import type { readProjectRepository } from '../git-read-repository.js';
import {
  WORKSPACE_FILE_CHANGES_CONCURRENCY,
  WorkspaceFileChangesService,
} from '../workspace-file-changes-service.js';

type ReadRepository = typeof readProjectRepository;
type Outcome = Awaited<ReturnType<ReadRepository>>;

const preview = {
  changesTarget: (root: string, path: string) => ({
    root,
    target: `${root}/${path}`,
    existingAncestor: root,
  }),
};

/**
 * Request cost of the Changes read: the File Preview asks for it as each
 * file opens, so identical requests share one read and one workspace runs
 * at most WORKSPACE_FILE_CHANGES_CONCURRENCY at once. The shared repository
 * read (`readProjectRepository`) is a gate the test releases; nothing here
 * spawns git.
 */
function harness() {
  let active = 0;
  let peak = 0;
  const pending: Array<() => void> = [];
  const readRepository = vi.fn(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => pending.push(resolve));
    active -= 1;
    return { ok: false, state: 'not-a-repository' } as const;
  }) as unknown as ReadRepository;
  const service = new WorkspaceFileChangesService(preview, readRepository);
  const releaseAll = async () => {
    while (pending.length || active) {
      pending.splice(0).forEach((resolve) => {
        resolve();
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  return { service, readRepository, releaseAll, peak: () => peak };
}

describe('WorkspaceFileChangesService request cost', () => {
  test('identical concurrent requests share one read', async () => {
    const { service, readRepository, releaseAll } = harness();
    const first = service.changes('/w', 'a.ts');
    const second = service.changes('/w', 'a.ts');
    expect(second).toBe(first);
    await releaseAll();
    await expect(first).resolves.toEqual({ state: 'not-a-repository' });
    expect(readRepository).toHaveBeenCalledTimes(1);
    // Settled reads are not cached: the next request reads again.
    const third = service.changes('/w', 'a.ts');
    expect(third).not.toBe(first);
    await releaseAll();
    await third;
    expect(readRepository).toHaveBeenCalledTimes(2);
  });

  test('one workspace runs at most the cap at once; the rest queue', async () => {
    expect(WORKSPACE_FILE_CHANGES_CONCURRENCY).toBe(2);
    const { service, readRepository, releaseAll, peak } = harness();
    const reads = ['a', 'b', 'c', 'd', 'e'].map((name) =>
      service.changes('/w', `${name}.ts`),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readRepository).toHaveBeenCalledTimes(2);
    await releaseAll();
    await Promise.all(reads);
    expect(readRepository).toHaveBeenCalledTimes(5);
    expect(peak()).toBe(2);
  });

  test("asks the shared resolver for the file's folder within the workspace root, with a discovery deadline", async () => {
    const readRepository = vi.fn(async () => ({
      ok: false,
      state: 'not-a-repository',
    })) as unknown as ReadRepository;
    const service = new WorkspaceFileChangesService(
      {
        changesTarget: () => ({
          root: '/w',
          target: '/w/src/a.ts',
          existingAncestor: '/w/src',
        }),
      },
      readRepository,
    );
    await service.changes('/w', 'src/a.ts');
    expect(readRepository).toHaveBeenCalledWith(
      '/w',
      '/w/src',
      { timeoutMs: 10_000 },
      expect.any(Function),
    );
  });
});

describe("WorkspaceFileChangesService: the shared resolver's answers", () => {
  const service = (outcome: Outcome) =>
    new WorkspaceFileChangesService(
      preview,
      (async () => outcome) as unknown as ReadRepository,
    );

  test.each<[Outcome, unknown]>([
    [{ ok: false, state: 'not-a-repository' }, { state: 'not-a-repository' }],
    [
      { ok: false, state: 'refused', reason: '.git is a symbolic link' },
      {
        state: 'refused',
        reason:
          "This file's git directory is not the Project's own (.git is a symbolic link), so Station does not read it.",
      },
    ],
    [
      {
        ok: false,
        state: 'config-refused',
        keys: ['diff.external', 'filter.evil.clean'],
      },
      {
        state: 'refused',
        reason:
          "This repository's own configuration sets diff.external, filter.evil.clean, which Station does not run git with, so it does not diff this file.",
      },
    ],
    [
      { ok: false, state: 'config-unreadable' },
      {
        state: 'refused',
        reason: "git could not read this repository's configuration.",
      },
    ],
    // Not a refusal: the route answers it with a retryable status.
    [{ ok: false, state: 'busy' }, { state: 'busy' }],
    [
      { ok: true, top: '/w', value: { state: 'unchanged', base: 'HEAD' } },
      { state: 'unchanged', base: 'HEAD' },
    ],
  ])('maps %o to %o', async (outcome, expected) => {
    await expect(service(outcome).changes('/w', 'a')).resolves.toEqual(
      expected,
    );
  });

  test('a discovery deadline or unknown failure is an error, not "no repository"', async () => {
    for (const failure of [
      Object.assign(new Error('killed'), { killed: true }),
      new Error('odd'),
    ]) {
      const failing = new WorkspaceFileChangesService(preview, (async () => {
        throw failure;
      }) as unknown as ReadRepository);
      await expect(failing.changes('/w', 'a')).rejects.toBe(failure);
    }
  });
});
