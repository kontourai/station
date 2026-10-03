import { describe, expect, test, vi } from 'vitest';
import type { readProjectRepository } from '../git-read-repository.js';
import {
  WORKSPACE_FILE_CHANGES_CONCURRENCY,
  WORKSPACE_FILE_CHANGES_MAX_QUEUE,
  WorkspaceFileChangesQueueFullError,
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

describe('WorkspaceFileChangesService: the queue and a reader that leaves', () => {
  /** Reads that block until released, one gate per call. */
  function gated() {
    const gates: Array<() => void> = [];
    const readRepository = vi.fn(
      () =>
        new Promise<Outcome>((resolve) => {
          gates.push(() =>
            resolve({ ok: true, top: '/w', value: { state: 'untracked' } }),
          );
        }),
    ) as unknown as ReadRepository;
    const service = new WorkspaceFileChangesService(preview, readRepository);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { service, readRepository, gates, settle };
  }

  test('beyond the cap and the queue, a request is refused as busy rather than queued without bound', async () => {
    const { service, readRepository, gates, settle } = gated();
    expect(WORKSPACE_FILE_CHANGES_MAX_QUEUE).toBe(8);
    const admitted = Array.from(
      {
        length:
          WORKSPACE_FILE_CHANGES_CONCURRENCY + WORKSPACE_FILE_CHANGES_MAX_QUEUE,
      },
      (_, index) => service.changes('/w', `${index}.ts`),
    );
    await settle();
    expect(readRepository).toHaveBeenCalledTimes(
      WORKSPACE_FILE_CHANGES_CONCURRENCY,
    );

    await expect(
      service.changes('/w', 'one-too-many.ts'),
    ).rejects.toBeInstanceOf(WorkspaceFileChangesQueueFullError);
    // Another workspace has its own cap and queue.
    const elsewhere = service.changes('/elsewhere', 'a.ts');
    await settle();
    expect(readRepository).toHaveBeenCalledTimes(
      WORKSPACE_FILE_CHANGES_CONCURRENCY + 1,
    );

    while (gates.length) gates.shift()?.();
    await settle();
    while (gates.length) gates.shift()?.();
    await settle();
    while (gates.length) gates.shift()?.();
    await settle();
    while (gates.length) gates.shift()?.();
    await settle();
    while (gates.length) gates.shift()?.();
    await settle();
    await expect(Promise.all([...admitted, elsewhere])).resolves.toHaveLength(
      admitted.length + 1,
    );
    expect(readRepository).toHaveBeenCalledTimes(admitted.length + 1);
  });

  test('a queued request whose signal aborts stops waiting at once, never reads, and frees its place', async () => {
    const { service, readRepository, gates, settle } = gated();
    const running = [
      service.changes('/w', 'a.ts'),
      service.changes('/w', 'b.ts'),
    ];
    const controller = new AbortController();
    const queued = service.changes('/w', 'c.ts', { signal: controller.signal });
    const behind = service.changes('/w', 'd.ts');
    await settle();
    expect(readRepository).toHaveBeenCalledTimes(2);

    controller.abort(new Error('the reader left'));

    await expect(queued).rejects.toThrow('the reader left');
    // Its read never started; the one behind it takes the freed turn.
    gates.shift()?.();
    await settle();
    expect(readRepository).toHaveBeenCalledTimes(3);
    expect(
      (
        readRepository as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls.map((call) => call[1]),
    ).toEqual(['/w', '/w', '/w']);
    while (gates.length) gates.shift()?.();
    await settle();
    await expect(Promise.all([...running, behind])).resolves.toHaveLength(3);
  });

  test('a shared read is given up only when every requester has left; one that stays is still answered', async () => {
    const { service, readRepository, gates, settle } = gated();
    service.changes('/w', 'a.ts');
    service.changes('/w', 'b.ts');
    const first = new AbortController();
    const second = new AbortController();
    const one = service.changes('/w', 'c.ts', { signal: first.signal });
    const two = service.changes('/w', 'c.ts', { signal: second.signal });
    await settle();

    first.abort();
    await expect(one).rejects.toMatchObject({ name: 'AbortError' });
    gates.shift()?.();
    await settle();
    // The shared read ran for the requester that stayed.
    expect(readRepository).toHaveBeenCalledTimes(3);
    while (gates.length) gates.shift()?.();
    await expect(two).resolves.toEqual({ state: 'untracked' });
  });

  test('a request already aborted is refused before it is queued, and an aborted requester of a running read is told at once', async () => {
    const { service, readRepository, gates, settle } = gated();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      service.changes('/w', 'a.ts', { signal: aborted.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(readRepository).not.toHaveBeenCalled();

    const controller = new AbortController();
    const running = service.changes('/w', 'b.ts', {
      signal: controller.signal,
    });
    await settle();
    expect(readRepository).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    // The read itself completes; a later identical request is not left
    // waiting on a read nobody will answer.
    gates.shift()?.();
    await settle();
    const again = service.changes('/w', 'b.ts');
    await settle();
    expect(readRepository).toHaveBeenCalledTimes(2);
    gates.shift()?.();
    await expect(again).resolves.toEqual({ state: 'untracked' });
  });
});
