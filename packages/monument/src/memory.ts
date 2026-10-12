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
  RequestKeyId,
  RequestKeyRecord,
  TurnBoundaryRecord,
  TurnDedupRecord,
} from './records.js';
import { runKernelTransactionStep } from './step.js';

interface MemoryImage {
  readonly turnDedup: Map<string, TurnDedupRecord>;
  readonly turnBoundaries: Map<string, TurnBoundaryRecord>;
  readonly turnTerminals: Map<string, Set<string>>;
  /** Map insertion order is the request keys' insertion order. */
  readonly requestKeys: Map<string, RequestKeyRecord>;
}

function emptyImage(): MemoryImage {
  return {
    turnDedup: new Map(),
    turnBoundaries: new Map(),
    turnTerminals: new Map(),
    requestKeys: new Map(),
  };
}

/**
 * What survives a "process": the committed image. Opening a storage on the
 * same volume again is the in-memory equivalent of reopening a database file.
 * A volume holds nothing a transaction did not commit.
 */
export class MemoryKernelVolume {
  /** @internal Replaced wholesale at each commit; never mutated in place. */
  committed: MemoryImage = emptyImage();
}

const requestKeyId = (id: RequestKeyId): string =>
  JSON.stringify([id.callerSessionId, id.tool, id.key]);

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
        for (const key of [...image.turnDedup.keys()])
          if (key.startsWith(prefix)) {
            image.turnDedup.delete(key);
            removed += 1;
          }
        return removed;
      },
      pruneResolved: (maxEntries) => {
        const excess = image.turnDedup.size - maxEntries;
        if (excess <= 0) return;
        const victims = [...image.turnDedup.values()]
          .filter((record) => record.value !== null)
          .sort(
            (a, b) =>
              a.createdAt - b.createdAt || compareCodePoints(a.key, b.key),
          )
          .slice(0, excess);
        for (const victim of victims) image.turnDedup.delete(victim.key);
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
      deleteCreatedBefore: (cutoff) => {
        for (const [key, record] of [...image.requestKeys])
          if (record.createdAt < cutoff) image.requestKeys.delete(key);
      },
      countCaller: (caller) =>
        [...image.requestKeys.values()].filter(
          (record) => record.id.callerSessionId === caller,
        ).length,
      countCallerCompleted: (caller) =>
        [...image.requestKeys.values()].filter(
          (record) =>
            record.id.callerSessionId === caller && record.result !== null,
        ).length,
      countAll: () => image.requestKeys.size,
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
  const participants = options.participants ?? [];
  let closed = false;
  return {
    async execute<C extends KernelCommand>(
      command: C,
      context: KernelContext,
    ): Promise<KernelResult<C>> {
      if (closed) throw new KernelStorageClosedError();
      const working = copy(volume.committed);
      const result = runKernelTransactionStep(
        command,
        context,
        transactionOver(working),
        participants,
        undefined,
      );
      volume.committed = working;
      return copy(result);
    },
    async close() {
      closed = true;
    },
  };
}
