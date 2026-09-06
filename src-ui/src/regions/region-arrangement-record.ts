/**
 * The persisted form of a `RegionArrangement` (#928 slice D): the
 * `regionArrangement` device setting, one record per device.
 *
 * Pure. Two directions:
 *
 * - `toRegionArrangementRecord` serializes live state. An occupant is written
 *   as `{ kind: 'surface', id }` so the pane-host direction
 *   (docs/design/placement.md) can add `{ kind: 'pane-host', documentId }`
 *   beside it without a migration.
 * - `parseRegionArrangementRecord` is the ONLY validation the record gets:
 *   the device-settings store checks a composite for "is a plain object" and
 *   nothing more, so every reader runs this. It never throws and fails closed
 *   per field — an unreadable field takes its default, an unknown surface or
 *   an undeclared placement empties the region, and only an unrecognisable
 *   record (not an object, wrong `version`) is rejected outright so the
 *   caller can fall back to the legacy dock seed.
 */

import {
  DEFAULT_REGION_ARRANGEMENT_RECORD,
  type RegionArrangementRecord,
  type RegionArrangementRecordRegion,
  type RegionOccupantRecord,
} from '@kontourai/station-contracts/device-settings';
import {
  DEFAULT_DEVICE_REGION_ARRANGEMENT,
  REGION_IDS,
  REGION_SURFACE_REGISTRY,
  type RegionArrangement,
  type RegionId,
  type RegionState,
  type RegisteredSurface,
} from './region-model';

export type {
  RegionArrangementRecord,
  RegionArrangementRecordRegion,
  RegionOccupantRecord,
};

export const REGION_ARRANGEMENT_RECORD_VERSION = 1 as const;

/**
 * Size bounds for a persisted dock region, in px along the region's own edge.
 *
 * The floor is the one every dock clamp shares (`DOCK_MIN_HEIGHT` in
 * `dockSnap.ts`, `MIN_DOCK_HEIGHT` in `useDockShellChrome.ts`; side regions
 * clamp higher, to 280, at render time). The live clamps' ceilings depend on
 * the viewport (`innerHeight - 150`, `innerWidth * 0.6`), which a parser of
 * stored bytes does not have, so the ceiling here is a sanity bound no real
 * viewport clamp can exceed; `useDockShellChrome` still clamps to the live
 * viewport when it renders. `main` carries no size (its default is 0 and
 * nothing reads it), so it is only required to be a finite non-negative
 * number.
 */
export const REGION_SIZE_MIN = 200;
export const REGION_SIZE_MAX = 8192;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function toOccupantRecord(
  occupant: string | null,
): RegionOccupantRecord | null {
  return occupant === null ? null : { kind: 'surface', id: occupant };
}

export function toRegionArrangementRecord(
  arrangement: RegionArrangement,
): RegionArrangementRecord {
  const regions = {} as RegionArrangementRecord['regions'];
  for (const id of REGION_IDS) {
    const state = arrangement[id];
    regions[id] = {
      visible: state.visible,
      size: state.size,
      occupant: toOccupantRecord(state.occupant),
      maximized: state.maximized,
    };
  }
  return { version: REGION_ARRANGEMENT_RECORD_VERSION, regions };
}

function parseVisible(
  value: unknown,
  id: RegionId,
  fallback: boolean,
): boolean {
  // `main` is the primary area and is never hidden, whatever was stored.
  if (id === 'main') return true;
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * `maximized` is additive (#928 slice iii): absent in a record written before
 * it existed, and false then. Only a literal `true` maximizes; the arrangement
 * invariants below (`main` never, a hidden or empty region never, one region
 * at most) are applied after every region is read.
 */
function parseMaximized(value: unknown): boolean {
  return value === true;
}

function parseSize(value: unknown, id: RegionId, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (id === 'main') return value >= 0 ? value : fallback;
  return value >= REGION_SIZE_MIN && value <= REGION_SIZE_MAX
    ? value
    : fallback;
}

/**
 * The surface id a stored occupant names, or null when the region reads as
 * empty: no occupant, an occupant of a `kind` this reader does not know (the
 * additive extension point — a newer writer's variant is empty here, not a
 * failure), a surface the registry no longer has (retired since it was
 * written), or a surface that does not declare this region.
 */
function parseOccupant(
  value: unknown,
  id: RegionId,
  registry: ReadonlyMap<string, RegisteredSurface>,
): string | null {
  if (!isPlainObject(value)) return null;
  if (value.kind !== 'surface' || typeof value.id !== 'string') return null;
  if (!registry.get(value.id)?.regions.includes(id)) return null;
  return value.id;
}

/**
 * Reads a stored record back into live state, or returns null for a record
 * the caller should treat as absent. See the module comment for the
 * per-field fail-closed rules; in addition, a surface named by two regions
 * keeps the first in `REGION_IDS` order and the later regions read as empty
 * and hidden.
 */
export function parseRegionArrangementRecord(
  value: unknown,
  registry: ReadonlyMap<string, RegisteredSurface> = REGION_SURFACE_REGISTRY,
): RegionArrangement | null {
  if (!isPlainObject(value)) return null;
  if (value.version !== REGION_ARRANGEMENT_RECORD_VERSION) return null;
  const storedRegions = isPlainObject(value.regions) ? value.regions : {};
  const seen = new Set<string>();
  const arrangement = {} as RegionArrangement;
  for (const id of REGION_IDS) {
    const fallback = DEFAULT_DEVICE_REGION_ARRANGEMENT[id];
    const stored = storedRegions[id];
    // A region the record does not describe at all takes its whole default,
    // occupant included; a region it does describe is read field by field,
    // and an unreadable occupant there is an EMPTY region, not the default
    // one — the record said something about it, just nothing usable.
    const state: RegionState = isPlainObject(stored)
      ? {
          visible: parseVisible(stored.visible, id, fallback.visible),
          size: parseSize(stored.size, id, fallback.size),
          occupant: parseOccupant(stored.occupant, id, registry),
          maximized: parseMaximized(stored.maximized),
        }
      : { ...fallback };
    if (state.occupant !== null) {
      if (seen.has(state.occupant)) {
        // A duplicate's later region is emptied AND hidden: an empty dock
        // region is never shown (`placeSurface` hides a vacated one).
        state.occupant = null;
        state.visible = false;
      } else seen.add(state.occupant);
    }
    // The same invariants `updateRegion` holds for live state: `main` is
    // never maximized, nor is a hidden or empty region. Stored bytes can say
    // anything; the shell must never mount a blank full-height panel from
    // them (archive#795's shape).
    if (
      state.maximized &&
      (id === 'main' || !state.visible || state.occupant === null)
    ) {
      state.maximized = false;
    }
    arrangement[id] = state;
  }
  // At most one region is maximized: the first in `REGION_IDS` order keeps
  // it, matching the duplicate-occupant rule above.
  let maximizedSeen = false;
  for (const id of REGION_IDS) {
    if (!arrangement[id].maximized) continue;
    if (maximizedSeen) arrangement[id].maximized = false;
    maximizedSeen = true;
  }
  return arrangement;
}

function occupantsEqual(
  a: RegionOccupantRecord | null,
  b: RegionOccupantRecord | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.id === b.id;
}

/** Field-by-field equality of two records — the byte-identical skip the provider uses to tell its own write coming back from another tab's. */
export function regionArrangementRecordsEqual(
  a: RegionArrangementRecord,
  b: RegionArrangementRecord,
): boolean {
  if (a.version !== b.version) return false;
  return REGION_IDS.every((id) => {
    const left = a.regions[id];
    const right = b.regions[id];
    return (
      left.visible === right.visible &&
      left.size === right.size &&
      occupantsEqual(left.occupant, right.occupant) &&
      // Additive field: a record written before `maximized` existed reads
      // equal to one that spells out `false`.
      (left.maximized ?? false) === (right.maximized ?? false)
    );
  });
}

/**
 * Whether a stored value is the record a device that has never written one
 * holds: the registry default. The provider treats that as "no record", so
 * the legacy dock keys keep governing a first run and older devices whose
 * only state is Chat's.
 */
export function isDefaultRegionArrangementRecord(
  record: RegionArrangementRecord,
): boolean {
  return regionArrangementRecordsEqual(
    record,
    DEFAULT_REGION_ARRANGEMENT_RECORD,
  );
}
