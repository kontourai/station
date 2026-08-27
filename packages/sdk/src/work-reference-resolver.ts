import type {
  WorkReference,
  WorkReferenceKind,
} from '@kontourai/station-contracts/work-reference';

export type WorkReferenceResolutionState =
  | 'current'
  | 'missing'
  | 'stale'
  | 'unavailable'
  | 'ambiguous'
  | 'not_verified';

export interface WorkReferenceResolution {
  reference: WorkReference;
  state: WorkReferenceResolutionState;
  /** Owner-projected data; never persisted by this module. */
  value?: unknown;
}

export type WorkReferenceOwnerAdapter = {
  resolve(
    reference: WorkReference,
  ): Promise<Omit<WorkReferenceResolution, 'reference'>>;
};

/**
 * Bounded owner-adapter dispatcher. It deliberately neither retries nor
 * guesses across owners: unavailable and ambiguous are useful terminal facts.
 */
export function createWorkReferenceResolver(
  adapters: Partial<Record<WorkReferenceKind, WorkReferenceOwnerAdapter>>,
) {
  const MAX_BATCH = 100;
  const MAX_CONCURRENCY = 8;
  async function resolve(
    reference: WorkReference,
  ): Promise<WorkReferenceResolution> {
    const adapter = adapters[reference.kind];
    if (!adapter) return { reference, state: 'not_verified' };
    try {
      return { reference, ...(await adapter.resolve(reference)) };
    } catch {
      return { reference, state: 'unavailable' };
    }
  }
  return {
    resolve,
    async resolveAll(references: readonly WorkReference[]) {
      if (references.length > MAX_BATCH) {
        return references.map((reference) => ({
          reference,
          state: 'not_verified' as const,
        }));
      }
      const results: WorkReferenceResolution[] = Array.from(
        references,
        (reference) => ({ reference, state: 'not_verified' }),
      );
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(MAX_CONCURRENCY, references.length) },
          async () => {
            while (next < references.length) {
              const index = next++;
              results[index] = await resolve(references[index]);
            }
          },
        ),
      );
      return results;
    },
  };
}
