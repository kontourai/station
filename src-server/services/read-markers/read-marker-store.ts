import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonFileStoreCorruptionError,
} from '../infra/json-store.js';

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
  /** Epoch ms this store was first written: the file-conversation baseline. */
  createdAt: number;
  /**
   * The event store's `global_sequence` when read state began being kept:
   * the baseline for runtime conversations, whose versions are content
   * sequences.
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
   * When read state began being kept. Before it nothing recorded what anyone
   * had seen, and most conversations were never acknowledged at all; reading
   * every one of them as unread would bury the real signal under history. An
   * agent conversation therefore reads as seen through this point, and
   * unread once its content moves past it.
   */
  baseline(): ReadMarkerBaseline;
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
  if (!isSafeVersion(parsed.createdAt))
    throw new Error('Invalid read marker store baseline');
  if (!isSafeVersion(parsed.baselineSequence))
    throw new Error('Invalid read marker store baseline sequence');
  if (!isRecord(parsed.markers))
    throw new Error('Invalid read marker store markers');
  return parsed as unknown as ReadMarkerStoreData;
}

function decodeLegacyReadMarkerStore(text: string): LegacyReadMarkerStoreData {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.version !== LEGACY_STORE_VERSION)
    throw new Error('Not a first-format read marker store');
  if (parsed.createdAt !== undefined && !isSafeVersion(parsed.createdAt))
    throw new Error('Invalid read marker store baseline');
  if (!isRecord(parsed.markers))
    throw new Error('Invalid read marker store markers');
  return parsed as unknown as LegacyReadMarkerStoreData;
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
  private readonly path: string;

  /**
   * `currentSequence` is the event store's high-water `global_sequence`; a
   * new store starts its runtime baseline there.
   */
  constructor(
    dataDir: string,
    now: () => Date = () => new Date(),
    currentSequence: () => number = () => 0,
  ) {
    const path = join(dataDir, READ_MARKER_STORE_FILE);
    this.path = path;
    const fresh = !existsSync(path) && !existsSync(`${path}.previous`);
    // A torn write is never acceptable; losing the newest mark to a power cut
    // is: the conversation reads unread again, the safe direction.
    this.store = new JsonFileStore(
      path,
      {
        version: STORE_VERSION,
        createdAt: 0,
        baselineSequence: 0,
        markers: {},
      },
      {
        durableAtomicWrite: true,
        atomicWriteDurability: 'tear-safe',
        onCorruption: 'throw',
      },
    );
    if (fresh)
      this.store.write({
        version: STORE_VERSION,
        createdAt: now().getTime(),
        baselineSequence: currentSequence(),
        markers: {},
      });
  }

  /**
   * A first-format store waiting for {@link completeUpgrade}: its time
   * baseline. `undefined` when the store is current (or not that format).
   */
  pendingUpgrade(): { createdAt: number } | undefined {
    try {
      const legacy = this.store.read(decodeLegacyReadMarkerStore);
      return { createdAt: legacy.createdAt ?? 0 };
    } catch {
      return undefined;
    }
  }

  /**
   * Converts a first-format store once (#3075 content versions): the
   * runtime baseline becomes the sequence it maps to, and each converted
   * agent conversation marker is added (never lowering a stored one). Room
   * markers and the time baseline carry over unchanged.
   */
  completeUpgrade(input: {
    baselineSequence: number;
    markers: ReadonlyArray<{
      principalId: string;
      key: string;
      version: number;
    }>;
    now: Date;
  }): void {
    const legacy = this.store.read(decodeLegacyReadMarkerStore);
    const markers: Record<string, unknown> = { ...legacy.markers };
    for (const marker of input.markers) {
      const forPerson = decodePersonMarkers(
        this.path,
        markers[marker.principalId],
      );
      const stored = forPerson[marker.key]?.v;
      if (stored !== undefined && stored >= marker.version) continue;
      markers[marker.principalId] = evict({
        ...forPerson,
        [marker.key]: { v: marker.version, at: input.now.toISOString() },
      });
    }
    this.store.write({
      version: STORE_VERSION,
      createdAt: legacy.createdAt ?? 0,
      baselineSequence: input.baselineSequence,
      markers,
    });
  }

  baseline(): ReadMarkerBaseline {
    const data = this.store.read(decodeReadMarkerStore);
    return { sequence: data.baselineSequence, time: data.createdAt };
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
