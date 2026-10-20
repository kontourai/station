import type { KernelCommand, KernelResult } from './commands.js';
import { compareCodePoints } from './decisions/order.js';
import {
  type CommitParticipant,
  type KernelContext,
  type KernelStorage,
  KernelStorageClosedError,
  type KernelTransaction,
} from './port.js';
import type {
  InboxEntryRecord,
  RequestKeyId,
  RequestKeyRecord,
  TurnBoundaryRecord,
  TurnDedupRecord,
} from './records.js';
import { isParticipantRefusal, runKernelTransactionStep } from './step.js';

interface MemoryImage {
  readonly turnDedup: Map<string, TurnDedupRecord>;
  /** Evicted keys and when they were evicted. */
  readonly turnDedupExpired: Map<string, number>;
  readonly turnBoundaries: Map<string, TurnBoundaryRecord>;
  readonly turnTerminals: Map<string, Set<string>>;
  /** Map insertion order is the request keys' insertion order. */
  readonly requestKeys: Map<string, RequestKeyRecord>;
  readonly inbox: Map<string, InboxEntryRecord>;
}

function emptyImage(): MemoryImage {
  return {
    turnDedup: new Map(),
    turnDedupExpired: new Map(),
    turnBoundaries: new Map(),
    turnTerminals: new Map(),
    requestKeys: new Map(),
    inbox: new Map(),
  };
}

/**
 * What survives a "process": the committed image. Opening a storage on the
 * same volume again is the in-memory equivalent of reopening a database file.
 * A volume holds nothing a transaction did not commit.
 */
export class MemoryKernelVolume {
  /** Brands the class: a plain object or a string is not a volume. */
  readonly #volume = true;

  /** Whether `value` is a volume this module made. */
  static isVolume(value: unknown): value is MemoryKernelVolume {
    return typeof value === 'object' && value !== null && #volume in value;
  }
}

interface VolumeState {
  /** Replaced wholesale at each commit; never mutated in place. */
  committed: MemoryImage;
  /**
   * A command is running against this volume. Per volume, not per handle: a
   * nested command through a second handle would commit first and then be
   * overwritten by the outer commit.
   */
  inFlight: boolean;
}

/** Held here, not on the volume, so nothing outside this module can reach it. */
const volumes = new WeakMap<MemoryKernelVolume, VolumeState>();

function stateOf(volume: MemoryKernelVolume): VolumeState {
  let state = volumes.get(volume);
  if (!state) {
    state = { committed: emptyImage(), inFlight: false };
    volumes.set(volume, state);
  }
  return state;
}

const requestKeyId = (id: RequestKeyId): string =>
  JSON.stringify([id.callerSessionId, id.tool, id.key]);

const inboxEntryId = (inboxId: string, key: string): string =>
  JSON.stringify([inboxId, key]);

const OPEN_INBOX_STATES: ReadonlySet<InboxEntryRecord['state']> = new Set([
  'queued',
  'placing',
  'unconfirmed',
]);
const SETTLED_INBOX_STATES: ReadonlySet<InboxEntryRecord['state']> = new Set([
  'placed',
  'refused',
  'cancelled',
]);

const copy = <T>(value: T): T => structuredClone(value);

function transactionOver(image: MemoryImage): KernelTransaction {
  const threadRows = (threadId: string) =>
    [...image.turnBoundaries.values()]
      .filter((row) => row.threadId === threadId)
      .map(copy);
  return {
    turnDedup: {
      get: (key) => {
        const record = image.turnDedup.get(key);
        return record && copy(record);
      },
      put: (record) => {
        image.turnDedup.set(record.key, copy(record));
      },
      delete: (key) => {
        image.turnDedup.delete(key);
      },
      deletePrefix: (prefix) => {
        let removed = 0;
        for (const table of [image.turnDedup, image.turnDedupExpired])
          for (const key of [...table.keys()])
            if (key.startsWith(prefix)) {
              table.delete(key);
              removed += 1;
            }
        return removed;
      },
      pruneResolved: (maxEntries, now) => {
        const excess = image.turnDedup.size - maxEntries;
        if (excess <= 0) return;
        const victims = [...image.turnDedup.values()]
          .filter((record) => record.value !== null)
          .sort(
            (a, b) =>
              a.createdAt - b.createdAt || compareCodePoints(a.key, b.key),
          )
          .slice(0, excess);
        for (const victim of victims) {
          image.turnDedup.delete(victim.key);
          // An existing tombstone keeps its original time.
          if (!image.turnDedupExpired.has(victim.key))
            image.turnDedupExpired.set(victim.key, now);
        }
      },
      expiredAt: (key) => image.turnDedupExpired.get(key),
      deleteTombstonesBefore: (keyPrefix, cutoff) => {
        for (const [key, expiredAt] of [...image.turnDedupExpired])
          if (key.startsWith(keyPrefix) && expiredAt < cutoff)
            image.turnDedupExpired.delete(key);
      },
    },
    turnBoundary: {
      get: (boundaryId) => {
        const record = image.turnBoundaries.get(boundaryId);
        return record && copy(record);
      },
      listThread: threadRows,
      listAll: () => [...image.turnBoundaries.values()].map(copy),
      put: (record) => {
        image.turnBoundaries.set(record.boundaryId, copy(record));
      },
      delete: (boundaryId) => {
        image.turnBoundaries.delete(boundaryId);
      },
    },
    turnTerminals: {
      has: (threadId, providerTurnId) =>
        image.turnTerminals.get(threadId)?.has(providerTurnId) ?? false,
      add: (threadId, providerTurnId) => {
        let turns = image.turnTerminals.get(threadId);
        if (!turns) {
          turns = new Set();
          image.turnTerminals.set(threadId, turns);
        }
        turns.add(providerTurnId);
      },
      deleteThread: (threadId) => {
        image.turnTerminals.delete(threadId);
      },
    },
    requestKeys: {
      get: (id) => {
        const record = image.requestKeys.get(requestKeyId(id));
        return record && copy(record);
      },
      // Map.set on an existing key keeps its position: insertion order holds.
      put: (record) => {
        image.requestKeys.set(requestKeyId(record.id), copy(record));
      },
      delete: (id) => {
        image.requestKeys.delete(requestKeyId(id));
      },
      deleteCompletedCreatedBefore: (cutoff) => {
        for (const [key, record] of [...image.requestKeys])
          if (record.result !== null && record.createdAt < cutoff)
            image.requestKeys.delete(key);
      },
      countCaller: (caller, countedSince) =>
        [...image.requestKeys.values()].filter(
          (record) =>
            record.id.callerSessionId === caller &&
            (record.result !== null || record.createdAt >= countedSince),
        ).length,
      countCallerCompleted: (caller) =>
        [...image.requestKeys.values()].filter(
          (record) =>
            record.id.callerSessionId === caller && record.result !== null,
        ).length,
      countAll: (countedSince) =>
        [...image.requestKeys.values()].filter(
          (record) =>
            record.result !== null || record.createdAt >= countedSince,
        ).length,
      evictOldestCompleted: (caller, count) => {
        // A stable sort keeps insertion order among equal timestamps.
        const victims = [...image.requestKeys.entries()]
          .filter(
            ([, record]) =>
              record.id.callerSessionId === caller && record.result !== null,
          )
          .sort(([, a], [, b]) => a.createdAt - b.createdAt)
          .slice(0, count);
        for (const [key] of victims) image.requestKeys.delete(key);
      },
    },
    inbox: {
      get: (inboxId, key) => {
        const record = image.inbox.get(inboxEntryId(inboxId, key));
        return record && copy(record);
      },
      listInbox: (inboxId) =>
        [...image.inbox.values()]
          .filter((record) => record.inboxId === inboxId)
          .sort((a, b) => a.sequence - b.sequence)
          .map(copy),
      listOpen: () =>
        [...image.inbox.values()]
          .filter((record) => OPEN_INBOX_STATES.has(record.state))
          .sort(
            (a, b) =>
              compareCodePoints(a.inboxId, b.inboxId) ||
              a.sequence - b.sequence,
          )
          .map(copy),
      put: (record) => {
        image.inbox.set(inboxEntryId(record.inboxId, record.key), copy(record));
      },
      deleteSettledBefore: (inboxId, cutoff) => {
        for (const [id, record] of [...image.inbox])
          if (
            record.inboxId === inboxId &&
            SETTLED_INBOX_STATES.has(record.state) &&
            record.updatedAt < cutoff
          )
            image.inbox.delete(id);
      },
      deleteInbox: (inboxId) => {
        let removed = 0;
        for (const [id, record] of [...image.inbox])
          if (record.inboxId === inboxId) {
            image.inbox.delete(id);
            removed += 1;
          }
        return removed;
      },
    },
  };
}

export interface MemoryKernelStorageOptions {
  readonly volume?: MemoryKernelVolume;
  /** Memory participants receive no host transaction handle. */
  readonly participants?: readonly CommitParticipant<undefined>[];
}

/**
 * The in-memory adapter. Each command runs against a private copy of the
 * committed image; the copy replaces the image only if the command and every
 * participant returned. Nothing awaits inside a command, so commands are
 * serialized. Each command copies the whole image, so this adapter is for
 * tests and small embedded use, not for large stores.
 */
export function openMemoryKernelStorage(
  options: MemoryKernelStorageOptions = {},
): KernelStorage {
  const volume = options.volume ?? new MemoryKernelVolume();
  if (!MemoryKernelVolume.isVolume(volume))
    throw new TypeError('volume must be a MemoryKernelVolume.');
  const participants = options.participants ?? [];
  let closed = false;
  return {
    async execute<C extends KernelCommand>(
      command: C,
      context: KernelContext,
    ): Promise<KernelResult<C>> {
      if (closed) throw new KernelStorageClosedError();
      const state = stateOf(volume);
      // A participant that issued a command from inside this one would
      // commit first and then be overwritten by the outer commit.
      if (state.inFlight)
        throw new Error('monument commands cannot run inside another command.');
      state.inFlight = true;
      try {
        const working = copy(state.committed);
        const result = runKernelTransactionStep(
          command,
          context,
          transactionOver(working),
          participants,
          undefined,
        );
        // A refusal keeps nothing.
        if (!isParticipantRefusal(result)) state.committed = working;
        return copy(result);
      } finally {
        state.inFlight = false;
      }
    },
    async close() {
      closed = true;
    },
  };
}
