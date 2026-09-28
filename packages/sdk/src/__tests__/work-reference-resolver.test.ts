import type { WorkReference } from '@kontourai/station-contracts/work-reference';
import { describe, expect, it, vi } from 'vitest';
import { createWorkReferenceResolver } from '../work-reference-resolver.js';

function ownerSpies() {
  const task = vi.fn(async (_reference: WorkReference) => ({
    state: 'current' as const,
    value: 'task-owner',
  }));
  const session = vi.fn(async (_reference: WorkReference) => ({
    state: 'current' as const,
    value: 'session-owner',
  }));
  return {
    task,
    session,
    resolver: createWorkReferenceResolver({
      task: { resolve: task },
      session: { resolve: session },
    }),
  };
}

describe('WorkReferenceResolver', () => {
  it('maps an owner failure to unavailable without failing the batch', async () => {
    const resolver = createWorkReferenceResolver({
      task: {
        resolve: async () => {
          throw new Error('offline');
        },
      },
    });
    await expect(
      resolver.resolveAll([{ kind: 'task', id: 't', projectId: 'p' }]),
    ).resolves.toEqual([
      {
        reference: { kind: 'task', id: 't', projectId: 'p' },
        state: 'unavailable',
      },
    ]);
  });

  it('dispatches each reference only to the adapter that owns its kind', async () => {
    const { task, session, resolver } = ownerSpies();
    const reference = { kind: 'session', id: 'session-1' } as const;

    await expect(resolver.resolve(reference)).resolves.toEqual({
      reference,
      state: 'current',
      value: 'session-owner',
    });
    expect(session).toHaveBeenCalledExactlyOnceWith(reference);
    expect(task).not.toHaveBeenCalled();
  });

  it('reports an unowned kind as not verified instead of guessing an owner', async () => {
    const { task, session, resolver } = ownerSpies();
    const reference = { kind: 'approval', id: 'approval-1' } as const;

    await expect(resolver.resolve(reference)).resolves.toEqual({
      reference,
      state: 'not_verified',
    });
    expect(task).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  });

  it('refuses a batch over 100 references without calling any owner', async () => {
    const { task, session, resolver } = ownerSpies();
    const references = Array.from({ length: 101 }, (_, index) => ({
      kind: 'session' as const,
      id: `session-${index}`,
    }));

    const results = await resolver.resolveAll(references);

    expect(results).toHaveLength(101);
    expect(results.every((result) => result.state === 'not_verified')).toBe(
      true,
    );
    expect(session).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
    // The bound is 100: a full batch still reaches the owner.
    await resolver.resolveAll(references.slice(0, 100));
    expect(session).toHaveBeenCalledTimes(100);
  });
});
