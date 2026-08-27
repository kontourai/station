import { describe, expect, it } from 'vitest';
import { createWorkReferenceResolver } from '../work-reference-resolver.js';

describe('WorkReferenceResolver', () => {
  it('isolates owner failures and does not guess an unowned reference', async () => {
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

  it('dispatches Session identity only to the Session owner adapter', async () => {
    const resolver = createWorkReferenceResolver({
      session: {
        resolve: async (reference) => ({
          state: reference.kind === 'session' ? 'current' : 'ambiguous',
          value: { threadId: reference.id },
        }),
      },
    });
    await expect(
      resolver.resolve({ kind: 'session', id: 'session-1' }),
    ).resolves.toEqual({
      reference: { kind: 'session', id: 'session-1' },
      state: 'current',
      value: { threadId: 'session-1' },
    });
  });
});
