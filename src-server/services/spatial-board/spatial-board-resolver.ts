import {
  type SpatialBoard,
  type SpatialBoardResolutionState,
  type SpatialBoardResolved,
  type SpatialBoardResolvedPin,
  type WorkReference,
  type WorkReferenceKind,
  workReferenceIdentityKey,
} from '@kontourai/station-contracts';
import {
  spatialBoardResolutionDuration,
  spatialBoardResolutionOutcomes,
} from '../../telemetry/metrics.js';

const MAX_PROJECTION_TEXT_BYTES = 512;
const MAX_HREF_BYTES = 4096;

export type SpatialBoardOwnerProjection = Readonly<{
  reference: WorkReference;
  state: SpatialBoardResolutionState;
  title?: string;
  href?: string;
}>;

/** One owner receives its entire bounded board group in one observation. */
export interface SpatialBoardOwnerResolver {
  resolve(
    references: readonly WorkReference[],
  ): Promise<readonly SpatialBoardOwnerProjection[]>;
}

export type SpatialBoardOwnerResolvers = Partial<
  Record<WorkReferenceKind, SpatialBoardOwnerResolver>
>;

/** Creates one request-local set of owner observations for each board read. */
export type SpatialBoardOwnerResolverFactory = () => SpatialBoardOwnerResolvers;

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximum &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function safeProjection(
  projection: SpatialBoardOwnerProjection,
): Omit<SpatialBoardOwnerProjection, 'reference'> {
  if (projection.state !== 'current') return { state: projection.state };
  return {
    state: 'current',
    ...(boundedText(projection.title, MAX_PROJECTION_TEXT_BYTES)
      ? { title: projection.title }
      : {}),
    ...(boundedText(projection.href, MAX_HREF_BYTES)
      ? { href: projection.href }
      : {}),
  };
}

/**
 * Board-bounded resolver composition. It is not a cross-product query API:
 * it accepts only references already stored in the personal board, groups
 * them by owner kind, and never retains the returned projection.
 */
export class SpatialBoardResolver {
  private readonly ownerFactory: SpatialBoardOwnerResolverFactory;

  constructor(
    owners: SpatialBoardOwnerResolvers | SpatialBoardOwnerResolverFactory,
  ) {
    this.ownerFactory = typeof owners === 'function' ? owners : () => owners;
  }

  async resolve(board: SpatialBoard): Promise<SpatialBoardResolved> {
    const startedAt = performance.now();
    const owners = this.ownerFactory();
    const groups = new Map<WorkReferenceKind, Map<string, WorkReference>>();
    for (const pin of board.pins) {
      const group = groups.get(pin.reference.kind) ?? new Map();
      group.set(workReferenceIdentityKey(pin.reference), pin.reference);
      groups.set(pin.reference.kind, group);
    }
    const resolvedByKey = new Map<
      string,
      Array<Omit<SpatialBoardOwnerProjection, 'reference'>>
    >();
    await Promise.all(
      [...groups].map(async ([kind, referencesByKey]) => {
        const references = [...referencesByKey.values()];
        const owner = owners[kind];
        if (!owner) return;
        try {
          const projections = await owner.resolve(references);
          const allowed = new Set(references.map(workReferenceIdentityKey));
          for (const projection of projections) {
            const key = workReferenceIdentityKey(projection.reference);
            if (!allowed.has(key)) continue;
            const entries = resolvedByKey.get(key) ?? [];
            entries.push(safeProjection(projection));
            resolvedByKey.set(key, entries);
          }
        } catch {
          for (const reference of references) {
            resolvedByKey.set(workReferenceIdentityKey(reference), [
              { state: 'unavailable' },
            ]);
          }
        }
      }),
    );
    const pins: SpatialBoardResolvedPin[] = board.pins.map((pin) => {
      const key = workReferenceIdentityKey(pin.reference);
      const results = resolvedByKey.get(key);
      if (!results || results.length === 0)
        return {
          pinId: pin.id,
          reference: pin.reference,
          state: 'NOT_VERIFIED',
        };
      if (results.length !== 1)
        return { pinId: pin.id, reference: pin.reference, state: 'ambiguous' };
      return { pinId: pin.id, reference: pin.reference, ...results[0] };
    });
    for (const pin of pins) {
      spatialBoardResolutionOutcomes.add(1, {
        kind: pin.reference.kind,
        state: pin.state,
      });
    }
    spatialBoardResolutionDuration.record(performance.now() - startedAt, {
      outcome: 'resolved',
    });
    return { revision: board.revision, pins };
  }
}
