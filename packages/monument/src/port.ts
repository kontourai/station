import type {
  KernelCommand,
  KernelResult,
  ParticipantRefusal,
} from './commands.js';
import type { OwnerLiveness } from './owner.js';
import type {
  RequestKeyId,
  RequestKeyRecord,
  TurnBoundaryRecord,
  TurnDedupRecord,
} from './records.js';

/** Retention and capacity policy the decisions apply. */
export interface KernelLimits {
  /** Soft cap on dedup rows; only resolved rows are ever evicted. */
  readonly turnDedupMaxEntries: number;
  /** Most boundary rows one thread may hold before new turns are refused. */
  readonly turnBoundaryAcceptedCapacity: number;
  /** Request keys older than this are forgotten on the next claim. */
  readonly requestKeyTtlMs: number;
  readonly requestKeyMaxRowsPerCaller: number;
  readonly requestKeyMaxRows: number;
}

/** The values Station uses today. */
export const DEFAULT_KERNEL_LIMITS: KernelLimits = Object.freeze({
  turnDedupMaxEntries: 2000,
  turnBoundaryAcceptedCapacity: 64,
  requestKeyTtlMs: 7 * 24 * 60 * 60 * 1000,
  requestKeyMaxRowsPerCaller: 300,
  requestKeyMaxRows: 10_000,
});

/** What a decision needs besides the stored records. */
export interface KernelContext {
  readonly liveness: OwnerLiveness;
  readonly limits?: Partial<KernelLimits>;
}

/**
 * The portable port. One `execute` call is one atomic transaction: the
 * adapter runs the command's synchronous decision inside its transaction and
 * commits all of its writes, together with every participant's writes, or
 * none of them. The Promise settles after the commit (or rollback).
 */
export interface KernelStorage {
  execute<C extends KernelCommand>(
    command: C,
    context: KernelContext,
  ): Promise<KernelResult<C>>;
  /** Later `execute` calls reject with {@link KernelStorageClosedError}. */
  close(): Promise<void>;
}

/**
 * A host projection that joins the kernel's transaction. Both hooks are
 * synchronous and run inside the transaction, with the adapter's host
 * transaction handle (`node:sqlite`: the open `DatabaseSync`).
 *
 * - `admit` runs before the decision. Returning a reason refuses the command:
 *   nothing is written and the command answers `refused`.
 * - `commit` runs after the decision's writes, for read-only commands too.
 *   Throwing aborts the whole transaction, kernel writes included, and the
 *   command rejects.
 *
 * A participant must not issue a kernel command itself: adapters refuse a
 * command started inside another.
 */
export interface CommitParticipant<HostTransaction = unknown> {
  readonly name: string;
  admit?(
    command: KernelCommand,
    host: HostTransaction,
  ): { readonly refuse: string } | undefined;
  commit?(
    committed: {
      readonly command: KernelCommand;
      readonly result: Exclude<KernelResult<KernelCommand>, ParticipantRefusal>;
    },
    host: HostTransaction,
  ): void;
}

/**
 * Adapter SPI: the record operations a decision may use inside one
 * transaction. Reads see the transaction's own earlier writes. Adapters
 * implement this; consumers use {@link KernelStorage}.
 */
export interface KernelTransaction {
  readonly turnDedup: {
    get(key: string): TurnDedupRecord | undefined;
    put(record: TurnDedupRecord): void;
    delete(key: string): void;
    /** Delete every row whose key starts with `prefix`; return the count. */
    deletePrefix(prefix: string): number;
    /**
     * While more than `maxEntries` rows exist, delete the oldest resolved row
     * (`createdAt` ascending, then key in code-point order). Unresolved rows
     * are never deleted, so the cap is soft.
     */
    pruneResolved(maxEntries: number): void;
  };
  readonly turnBoundary: {
    get(boundaryId: string): TurnBoundaryRecord | undefined;
    listThread(threadId: string): TurnBoundaryRecord[];
    listAll(): TurnBoundaryRecord[];
    put(record: TurnBoundaryRecord): void;
    delete(boundaryId: string): void;
  };
  readonly turnTerminals: {
    has(threadId: string, providerTurnId: string): boolean;
    add(threadId: string, providerTurnId: string): void;
    deleteThread(threadId: string): void;
  };
  readonly requestKeys: {
    get(id: RequestKeyId): RequestKeyRecord | undefined;
    /** Insert, or update in place keeping the row's insertion position. */
    put(record: RequestKeyRecord): void;
    delete(id: RequestKeyId): void;
    deleteCreatedBefore(cutoff: number): void;
    countCaller(callerSessionId: string): number;
    /** The caller's rows that have a result. */
    countCallerCompleted(callerSessionId: string): number;
    countAll(): number;
    /**
     * Delete up to `count` of the caller's rows that have a result, oldest
     * first (`createdAt` ascending, then insertion order).
     */
    evictOldestCompleted(callerSessionId: string, count: number): void;
  };
}

export class KernelStorageClosedError extends Error {
  readonly code = 'MONUMENT_STORAGE_CLOSED';
  constructor() {
    super('The monument storage is closed.');
    this.name = 'KernelStorageClosedError';
  }
}
