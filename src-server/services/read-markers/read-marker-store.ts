import { join } from 'node:path';
import {
  JsonFileStore,
  JsonFileStoreCorruptionError,
} from '../infra/json-store.js';
import { PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY } from '../orchestration/conversation-acknowledgement-store.js';

const STORE_VERSION = 2 as const;
/** The first format: a time baseline only; agent conversation markers lived
 * in the inventory's acknowledgement store as times. */
const LEGACY_STORE_VERSION = 1 as const;
/** Oldest-touched markers beyond this are dropped; a dropped one reads unread. */
export const READ_MARKERS_PER_PERSON_MAX = 5_000;
export const READ_MARKER_STORE_FILE = 'read-markers.json';

interface StoredMarker {
  /** The highest version shown to this person. */
  v: number;
  /** When it last moved, for eviction only. */
  at: string;
}

interface ReadMarkerStoreData {
  version: typeof STORE_VERSION;
  /**
   * The personal owner's baseline for file-backed conversations, in epoch
   * ms: when read state began. Zero on a hosted Station.
   */
  createdAt: number;
  /**
   * The personal owner's baseline for runtime conversations, whose versions
   * are content sequences: the event store's migration cutoff. Zero on a
   * hosted Station.
   */
  baselineSequence: number;
  /**
   * person key -> marker key -> marker. Each person's record is decoded only
   * when that person is read or written ({@link decodePersonMarkers}).
   */
  markers: Record<string, unknown>;
}

interface LegacyReadMarkerStoreData {
  version: typeof LEGACY_STORE_VERSION;
  createdAt?: number;
  markers: Record<string, unknown>;
}

/** Where read state began, in each version space. */
export interface ReadMarkerBaseline {
  /** Runtime conversations: the event store sequence. */
  readonly sequence: number;
  /** File-backed conversations: epoch ms. */
  readonly time: number;
}

/**
 * Every read marker (#3075): agent conversations
 * (`agent-conversation:<id>`, a content version), Project rooms and Task
 * rooms. Keys are opaque here; the service owns their grammar.
 */
export interface ReadMarkerStore {
  /** One fresh read per call; absent keys are omitted, never zero-filled. */
  getMany(
    principalId: string,
    keys: readonly string[],
  ): ReadonlyMap<string, number>;
  /**
   * Monotonic: stores `max(stored, version)` and returns the stored value
   * after the call. An older or equal version writes nothing.
   */
  advance(input: {
    principalId: string;
    key: string;
    version: number;
    now: Date;
  }): number;
  /**
   * Where read state began for `principalId`. Only the personal owner
   * (`personal:owner`, the key Station's own rules give the owner and their
   * owner-standing devices) reads everything up to the migration as seen,
   * because before it there was no unread. Every other key starts at zero:
   * uncertain is unread.
   */
  baselineFor(principalId: string): ReadMarkerBaseline;
}

const isSafeVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Strict decode of the store's envelope: a store whose version, baselines or
 * markers map is not exactly this is corrupt for everyone and is refused
 * (`JsonFileStoreCorruptionError`), never read as "read". It is one file, so
 * a broken envelope cannot be scoped to one person. A first-format store is
 * refused here too until {@link FileReadMarkerStore.completeUpgrade} runs.
 */
export function decodeReadMarkerStore(text: string): ReadMarkerStoreData {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.version !== STORE_VERSION)
    throw new Error('Unsupported read marker store version');
  const { createdAt, baselineSequence, markers } = parsed;
  if (!isSafeVersion(createdAt))
    throw new Error('Invalid read marker store baseline');
  if (!isSafeVersion(baselineSequence))
    throw new Error('Invalid read marker store baseline sequence');
  if (!isRecord(markers)) throw new Error('Invalid read marker store markers');
  return { version: STORE_VERSION, createdAt, baselineSequence, markers };
}

function decodeLegacyReadMarkerStore(text: string): LegacyReadMarkerStoreData {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.version !== LEGACY_STORE_VERSION)
    throw new Error('Not a first-format read marker store');
  const { createdAt, markers } = parsed;
  if (createdAt !== undefined && !isSafeVersion(createdAt))
    throw new Error('Invalid read marker store baseline');
  if (!isRecord(markers)) throw new Error('Invalid read marker store markers');
  return { version: LEGACY_STORE_VERSION, createdAt, markers };
}

/**
 * Strict decode of one person's markers. A record that is not exactly this
 * is corrupt for that person only: their reads and writes are refused, never
 * read as "read", and everyone else's markers stay available. A version that
 * is not a non-negative safe integer would otherwise become NaN and compare
 * as seen.
 */
function decodePersonMarkers(
  path: string,
  value: unknown,
): Record<string, StoredMarker> {
  if (value === undefined) return {};
  if (!isRecord(value))
    throw new JsonFileStoreCorruptionError(
      path,
      new Error('Invalid read marker person'),
    );
  for (const marker of Object.values(value))
    if (
      !isRecord(marker) ||
      !isSafeVersion(marker.v) ||
      typeof marker.at !== 'string'
    )
      throw new JsonFileStoreCorruptionError(
        path,
        new Error('Invalid read marker'),
      );
  return value as Record<string, StoredMarker>;
}

export class FileReadMarkerStore implements ReadMarkerStore {
  private readonly store: JsonFileStore<ReadMarkerStoreData>;
  /** The same file, read as the first format only by the upgrade. */
  private readonly legacy: JsonFileStore<LegacyReadMarkerStoreData>;
  private readonly path: string;

  /**
   * A store that does not exist yet, like a first-format one, waits for
   * {@link completeUpgrade}: until then nobody has a baseline and every
   * conversation reads unread, the safe direction.
   */
  constructor(dataDir: string) {
    const path = join(dataDir, READ_MARKER_STORE_FILE);
    this.path = path;
    // A torn write is never acceptable; losing the newest mark to a power cut
    // is: the conversation reads unread again, the safe direction.
    const options = {
      durableAtomicWrite: true,
      atomicWriteDurability: 'tear-safe',
      onCorruption: 'throw',
    } as const;
    this.store = new JsonFileStore(
      path,
      {
        version: STORE_VERSION,
        createdAt: 0,
        baselineSequence: 0,
        markers: {},
      },
      options,
    );
    this.legacy = new JsonFileStore(
      path,
      { version: LEGACY_STORE_VERSION, markers: {} },
      options,
    );
  }

  /**
   * A store waiting for {@link completeUpgrade}: a first-format one, or none
   * at all (a home from before read state). Its time baseline; `undefined`
   * when the store is current.
   */
  pendingUpgrade(): { createdAt: number } | undefined {
    try {
      return {
        createdAt: this.legacy.read(decodeLegacyReadMarkerStore).createdAt ?? 0,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Begins read state once (#3075 owner design), at the migration cutoff.
   * The personal owner reads every runtime conversation's content up to
   * `baselineSequence` and every file-backed one's up to `baselineTime` as
   * seen, which is what they saw before server-kept unread existed; a
   * hosted Station passes zeros. Nothing is inferred from timestamps. Room
   * markers carry over unchanged.
   */
  completeUpgrade(input: {
    baselineSequence: number;
    baselineTime: number;
  }): void {
    this.store.write({
      version: STORE_VERSION,
      createdAt: input.baselineTime,
      baselineSequence: input.baselineSequence,
      markers: this.legacy.read(decodeLegacyReadMarkerStore).markers,
    });
  }

  baselineFor(principalId: string): ReadMarkerBaseline {
    const data = this.store.read(decodeReadMarkerStore);
    return principalId === PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY
      ? { sequence: data.baselineSequence, time: data.createdAt }
      : { sequence: 0, time: 0 };
  }

  getMany(
    principalId: string,
    keys: readonly string[],
  ): ReadonlyMap<string, number> {
    const result = new Map<string, number>();
    if (keys.length === 0) return result;
    const forPerson = this.personMarkers(
      this.store.read(decodeReadMarkerStore),
      principalId,
    );
    for (const key of keys) {
      const marker = Object.hasOwn(forPerson, key) ? forPerson[key] : undefined;
      if (marker) result.set(key, marker.v);
    }
    return result;
  }

  advance({
    principalId,
    key,
    version,
    now,
  }: {
    principalId: string;
    key: string;
    version: number;
    now: Date;
  }): number {
    if (!Number.isSafeInteger(version) || version < 0)
      throw new RangeError('A read marker version is a non-negative integer');
    const data = this.store.read(decodeReadMarkerStore);
    const forPerson = this.personMarkers(data, principalId);
    const stored = Object.hasOwn(forPerson, key)
      ? forPerson[key]?.v
      : undefined;
    // The monotonic guard: a late, replayed or older mark never moves it.
    if (stored !== undefined && stored >= version) return stored;
    this.store.write({
      ...data,
      version: STORE_VERSION,
      markers: {
        ...data.markers,
        [principalId]: evict({
          ...forPerson,
          [key]: { v: version, at: now.toISOString() },
        }),
      },
    });
    return version;
  }

  private personMarkers(
    data: ReadMarkerStoreData,
    principalId: string,
  ): Record<string, StoredMarker> {
    return decodePersonMarkers(
      this.path,
      Object.hasOwn(data.markers, principalId)
        ? data.markers[principalId]
        : undefined,
    );
  }
}

function evict(
  markers: Record<string, StoredMarker>,
): Record<string, StoredMarker> {
  const entries = Object.entries(markers);
  if (entries.length <= READ_MARKERS_PER_PERSON_MAX) return markers;
  entries.sort(([, a], [, b]) => b.at.localeCompare(a.at));
  return Object.fromEntries(entries.slice(0, READ_MARKERS_PER_PERSON_MAX));
}
