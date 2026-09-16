/**
 * The persisted form of a `RegionArrangement` (#928 slice D): the
 * `regionArrangement` device setting, one record per device.
 *
 * Pure. Two directions:
 *
 * - `toRegionArrangementRecord` serializes live state. A region holding one
 *   surface is written as `{ kind: 'surface', id }`; one holding two or more
 *   as `{ kind: 'pane-host', panes, selected }` (#2046 2a, decisions 1 and
 *   2): the surfaces inline in tab order, so the arrangement never depends
 *   on the region's localStorage pane-host document to be readable, and the
 *   single-pane form unchanged, so a build that predates `pane-host` still
 *   reads every single-pane region in the same-device stale-tab window. The
 *   variant names no document: `RegionPaneHost` derives the region's
 *   document id from the region (`ambient:<region>`), so a `documentId`
 *   field carried nothing the region id does not and was dropped (2b).
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
  normalizeRegionPanes,
  REGION_IDS,
  REGION_SURFACE_REGISTRY,
  type RegionArrangement,
  type RegionId,
  type RegionState,
  type RegisteredSurface,
  resolveRegionSurface,
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

function toOccupantRecord(state: RegionState): RegionOccupantRecord | null {
  const [first] = state.panes;
  if (first === undefined) return null;
  if (state.panes.length === 1) return { kind: 'surface', id: first };
  return {
    kind: 'pane-host',
    panes: state.panes.map((pane) => ({ kind: 'surface', id: pane })),
    ...(state.occupant === null ? {} : { selected: state.occupant }),
  };
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
      occupant: toOccupantRecord(state),
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
 * One stored `{ kind: 'surface', id }` entry as a surface id this region may
 * hold, or null: not that shape, a surface this build no longer has (retired
 * since it was written), or one that does not declare this region. Resolved
 * through `resolveRegionSurface`, so a stored instance-keyed pane (#2049: a
 * pull request, a file preview) reads back as the pane it names rather than
 * as an unknown id — and is dropped by the same region rule as any other.
 */
function parseSurfaceEntry(
  value: unknown,
  id: RegionId,
  registry: ReadonlyMap<string, RegisteredSurface>,
): string | null {
  if (!isPlainObject(value)) return null;
  if (value.kind !== 'surface' || typeof value.id !== 'string') return null;
  if (!resolveRegionSurface(value.id, registry)?.regions.includes(id))
    return null;
  return value.id;
}

/**
 * The panes a stored occupant names, in tab order, and the selected one; an
 * empty set when the region reads as empty: no occupant, an occupant of a
 * `kind` this reader does not know (the additive extension point — a newer
 * writer's variant is empty here, not a failure), or nothing usable inside
 * it. Per entry the rules of `parseSurfaceEntry` apply, so a `pane-host`
 * region keeps the panes it can and drops the rest; a `selected` that is not
 * one of the kept panes falls back to the first (`normalizeRegionPanes`,
 * which also gives a `surface` occupant its one pane as the selection). A
 * `documentId` an earlier 2a build wrote is ignored.
 */
function parseOccupant(
  value: unknown,
  id: RegionId,
  registry: ReadonlyMap<string, RegisteredSurface>,
): Pick<RegionState, 'panes' | 'occupant'> {
  const entries: unknown[] = !isPlainObject(value)
    ? []
    : value.kind === 'surface'
      ? [value]
      : value.kind === 'pane-host' && Array.isArray(value.panes)
        ? value.panes
        : [];
  const selected = isPlainObject(value) ? value.selected : undefined;
  return normalizeRegionPanes(
    id,
    entries.flatMap((entry) => {
      const surface = parseSurfaceEntry(entry, id, registry);
      return surface === null ? [] : [surface];
    }),
    typeof selected === 'string' ? selected : null,
  );
}

/**
 * Reads a stored record back into live state, or returns null for a record
 * the caller should treat as absent. See the module comment for the
 * per-field fail-closed rules; in addition, a surface named by two regions
 * keeps the first in `REGION_IDS` order and is dropped from the later
 * regions' panes — a region left with nothing reads as empty, with the
 * visibility the record stored (#2153).
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
          ...parseOccupant(stored.occupant, id, registry),
          maximized: parseMaximized(stored.maximized),
        }
      : { ...fallback };
    if (state.panes.some((pane) => seen.has(pane))) {
      // A duplicate is dropped from the later region, which may empty it —
      // and an emptied region KEEPS THE VISIBILITY THE RECORD STORED (#2153):
      // a dock region may be visible and empty, so coercing it to hidden here
      // would close a region the record says is open on the strength of a
      // pane it does not get to keep. This matches the live model's CLOSE
      // rule (`removeRegionPane` keeps an emptied region's visibility); a
      // MOVE hides, but a parse is neither. The maximize clamp below still
      // applies: an empty region is never maximized.
      Object.assign(
        state,
        normalizeRegionPanes(
          id,
          state.panes.filter((pane) => !seen.has(pane)),
          state.occupant,
        ),
      );
    }
    for (const pane of state.panes) seen.add(pane);
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

/**
 * Both sides are canonical records — `toRegionArrangementRecord`'s output,
 * or a stored value re-serialised through it (`recordOf`) — so the writer's
 * key order holds on both and a serialised comparison is a field-by-field
 * one: kind and id for a surface; panes in order and the selection for a
 * pane host.
 */
function occupantsEqual(
  a: RegionOccupantRecord | null,
  b: RegionOccupantRecord | null,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
