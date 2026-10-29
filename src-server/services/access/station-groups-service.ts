/**
 * #3557: who is in which Station group, keyed by principal id. The ceiling
 * each group applies lives in `@kontourai/station-contracts/station-groups`;
 * this only remembers the assignments the operator made.
 *
 * Read on every scope resolution, so reads are synchronous and served from
 * a cache that is refreshed whenever the file's size or mtime changes. A
 * record that cannot be read fails closed: everyone sits in the default
 * group (Member) until it is repaired, never uncapped.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_STATION_GROUP,
  isStationGroup,
  type StationGroup,
  type StationGroupAssignment,
} from '@kontourai/station-contracts/station-groups';
import {
  mutateJsonFile,
  readJsonFile,
  writeJsonFile,
} from '@kontourai/station-shared/json-file-storage';

export const STATION_GROUPS_FILE = 'station-groups.json';
/**
 * Marks that groups have applied on this Station. Kept apart from the
 * record, so losing the record does not lose it: groups are then never
 * reseeded, and everyone sits in Member until the operator reassigns them.
 */
export const STATION_GROUPS_ACTIVATED_FILE = 'station-groups-activated.json';
const RECORD_VERSION = 1;
const MAX_BYTES = 256 * 1024;
const MAX_PRINCIPAL_ID_LENGTH = 512;

interface StationGroupsRecord {
  version: typeof RECORD_VERSION;
  assignments: Record<string, StationGroup>;
}

function emptyRecord(): StationGroupsRecord {
  return { version: RECORD_VERSION, assignments: {} };
}

/** Keeps only well-formed assignments; anything else is dropped (Member). */
function normalizeRecord(value: unknown): StationGroupsRecord {
  const record = emptyRecord();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return record;
  const assignments = (value as { assignments?: unknown }).assignments;
  if (
    !assignments ||
    typeof assignments !== 'object' ||
    Array.isArray(assignments)
  )
    return record;
  for (const [principalId, group] of Object.entries(assignments)) {
    if (isValidPrincipalId(principalId) && isStationGroup(group))
      record.assignments[principalId] = group;
  }
  return record;
}

function isValidPrincipalId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PRINCIPAL_ID_LENGTH &&
    // A principal id is `<kind>:<components>`; groups are for people.
    value.startsWith('human:') &&
    !/\s/.test(value)
  );
}

export class StationGroupsService {
  readonly #path: string;
  readonly #activatedPath: string;
  #cache: { key: string; record: StationGroupsRecord } | undefined;

  constructor(options: { securityDir: string }) {
    this.#path = join(options.securityDir, STATION_GROUPS_FILE);
    this.#activatedPath = join(
      options.securityDir,
      STATION_GROUPS_ACTIVATED_FILE,
    );
  }

  get path(): string {
    return this.#path;
  }

  /** Whether the record exists yet (first use seeds it; see `seed`). */
  exists(): boolean {
    try {
      statSync(this.#path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether groups have ever applied here. Only the file's presence counts,
   * so an unreadable marker still reads as applied (fail closed).
   */
  activated(): boolean {
    try {
      statSync(this.#activatedPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Marks groups as applied; the time is kept only for the operator. */
  async markActivated(at: number): Promise<void> {
    await writeJsonFile(
      this.#activatedPath,
      { activatedAt: at },
      { maxBytes: 1024, label: 'Station groups activation' },
    );
  }

  /** The group `principalId` sits in: its assignment, or Member. */
  groupOf(principalId: string): StationGroup {
    return this.#read().assignments[principalId] ?? DEFAULT_STATION_GROUP;
  }

  /** Every explicit assignment, for the operator's People page. */
  assignments(): StationGroupAssignment[] {
    return Object.entries(this.#read().assignments)
      .map(([principalId, group]) => ({ principalId, group, assigned: true }))
      .sort((left, right) => left.principalId.localeCompare(right.principalId));
  }

  /**
   * Puts a person in a group; Member removes the assignment, since Member is
   * what an unassigned person already is. Refuses anything that is not a
   * person's principal id.
   */
  async assign(
    principalId: string,
    group: StationGroup,
    expectedGroup?: StationGroup,
    assertCurrent?: () => void,
  ): Promise<void> {
    if (!isValidPrincipalId(principalId) || !isStationGroup(group))
      throw new StationGroupsError('invalid_assignment');
    await this.#mutate((record) => {
      assertCurrent?.();
      if (
        expectedGroup !== undefined &&
        (record.assignments[principalId] ?? DEFAULT_STATION_GROUP) !==
          expectedGroup
      )
        throw new StationGroupsError('invalid_assignment');
      if (group === DEFAULT_STATION_GROUP)
        delete record.assignments[principalId];
      else record.assignments[principalId] = group;
      return record;
    });
  }

  /**
   * First use only: records `admins` as Admin so people whose devices already
   * held a governed elevated grant keep it when groups start applying. A
   * record that already exists is left alone.
   */
  async seed(admins: readonly string[]): Promise<void> {
    if (this.exists()) return;
    // Decided again under the record's lock: another Station process
    // starting on this home may have seeded, and the operator assigned
    // someone, since the check above.
    await mutateJsonFile<unknown>(
      this.#path,
      null,
      (current) => {
        if (current !== null) return current;
        const record = emptyRecord();
        for (const principalId of admins)
          if (isValidPrincipalId(principalId))
            record.assignments[principalId] = 'admin';
        return record;
      },
      { maxBytes: MAX_BYTES, label: 'Station groups record' },
    );
    this.#cache = undefined;
  }

  async #mutate(
    update: (record: StationGroupsRecord) => StationGroupsRecord,
  ): Promise<void> {
    await mutateJsonFile<unknown>(
      this.#path,
      emptyRecord(),
      (current) => update(normalizeRecord(current)),
      { maxBytes: MAX_BYTES, label: 'Station groups record' },
    );
    this.#cache = undefined;
  }

  #read(): StationGroupsRecord {
    let key: string;
    try {
      const status = statSync(this.#path);
      // Atomic replacement changes the inode, so a rewrite of equal size
      // within the mtime granularity still invalidates the cache.
      key = `${status.ino}:${status.size}:${status.mtimeMs}:${status.ctimeMs}`;
    } catch {
      return emptyRecord();
    }
    if (this.#cache?.key === key) return this.#cache.record;
    let record: StationGroupsRecord;
    try {
      record = normalizeRecord(
        readJsonFile<unknown>(this.#path, null, {
          maxBytes: MAX_BYTES,
          label: 'Station groups record',
        }),
      );
    } catch {
      // Fail closed: an unreadable record places everyone in Member. Not
      // cached, so a transient read failure ends with the next read.
      return emptyRecord();
    }
    this.#cache = { key, record };
    return record;
  }
}

export class StationGroupsError extends Error {
  constructor(readonly code: 'invalid_assignment') {
    super(code);
    this.name = 'StationGroupsError';
  }
}
