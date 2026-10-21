import type {
  KernelCommand,
  KernelResult,
  ParticipantRefusal,
} from './commands.js';
import type { OwnerLiveness } from './owner.js';
import type {
  InboxEntryRecord,
  InvocationTerminalFact,
  InvocationTerminalQuery,
  InvocationTerminalRead,
  InvocationTerminalRetirement,
  RequestKeyId,
  RequestKeyRecord,
  TurnBoundaryRecord,
  TurnDedupRecord,
} from './records.js';

/**
 * How long a dedup tombstone answers `expired`. Retention evicts a resolved
 * row and leaves its key behind, so a late retry is refused instead of being
 * claimed afresh. A tombstone no rule covers lasts until `forgetPrefix`.
 */
export interface TurnDedupTombstoneRule {
  /** Exact string prefix; the first rule that matches decides. */
  readonly keyPrefix: string;
  /** Forgotten on the next dedup write after it is this old. */
  readonly maxAgeMs: number;
}

/** Retention and capacity policy the decisions apply. */
export interface KernelLimits {
  /**
   * Soft cap on dedup rows; only resolved rows are ever evicted, and each
   * eviction leaves a tombstone, which does not count toward the cap.
   */
  readonly turnDedupMaxEntries: number;
  readonly turnDedupTombstoneRetention: readonly TurnDedupTombstoneRule[];
  /** Most boundary rows one thread may hold before new turns are refused. */
  readonly turnBoundaryAcceptedCapacity: number;
  /**
   * A completed request key older than this is forgotten on the next claim.
   * An unresolved one is kept, however old: its attempt may have had its
   * effect. Past this age it stops counting toward the caps below.
   */
  readonly requestKeyTtlMs: number;
  readonly requestKeyMaxRowsPerCaller: number;
  readonly requestKeyMaxRows: number;
  /**
   * Most unsettled (`queued`, `placing`, `unconfirmed`) entries one inbox may
   * hold. A submission past it is refused, never truncated.
   */
  readonly inboxMaxUnsettled: number;
  /** A settled inbox entry older than this is forgotten on the inbox's next submit. */
  readonly inboxSettledRetentionMs: number;
}

/** The values Station uses today. */
export const DEFAULT_KERNEL_LIMITS: KernelLimits = Object.freeze({
  turnDedupMaxEntries: 2000,
  turnDedupTombstoneRetention: Object.freeze([]),
  turnBoundaryAcceptedCapacity: 64,
  requestKeyTtlMs: 7 * 24 * 60 * 60 * 1000,
  requestKeyMaxRowsPerCaller: 300,
  requestKeyMaxRows: 10_000,
  inboxMaxUnsettled: 50,
  inboxSettledRetentionMs: 7 * 24 * 60 * 60 * 1000,
});

/** What a decision needs besides the stored records. */
export interface KernelContext {
  readonly liveness: OwnerLiveness;
  readonly limits?: Partial<KernelLimits>;
}

/** Private storage composition: all operations join the same transaction. */
export interface KernelInvocationTerminalFacts {
  readObservation(
    threadId: string,
    terminalEventId: string,
  ): InvocationTerminalFact | undefined;
  find(query: InvocationTerminalQuery): InvocationTerminalRead;
  readRetirement(
    threadId: string,
    boundaryId: string,
  ): InvocationTerminalRetirement | undefined;
  recordRetirement(witness: InvocationTerminalRetirement): void;
}

/** A host terminal authority fixed when its adapter opens storage. */
export interface KernelTerminalFacts {
  readonly invocationTerminals?: KernelInvocationTerminalFacts;
  /** Read-only host facts, called synchronously inside the command transaction.
   * When supplied, the host replaces the kernel's terminal table entirely. */
  readonly terminalSeen: (threadId: string, providerTurnId: string) => boolean;
  /** Event-retired rows excluded only from possible-effect reads. Raw records,
   * listing and recovery remain unchanged; the host owns physical retirement. */
  readonly retiredBoundaryIds?: (threadId: string) => readonly string[];
  /** Persisted ordering for session terminals. Missing facts keep fenced rows. */
  readonly terminalSequence?: (
    threadId: string,
    terminalEventId: string | undefined,
  ) => number | undefined;
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
 *   the adapter rolls the transaction back, so nothing is written (including
 *   any earlier participant's `admit` writes) and the command answers
 *   `refused`.
 * - `commit` runs after the decision's writes. Throwing aborts the whole
 *   transaction, kernel writes included, and the command rejects. It is not
 *   called for read-only commands (`turnDedup.read`, `turnBoundary.list`,
 *   `turnBoundary.hasPossibleEffect`, `inbox.read`, `inbox.list`,
 *   `inbox.listOpen`) unless the participant sets
 *   `observeReads`, and neither is `admit`; on node:sqlite an observed read
 *   takes the write lock.
 *
 * A participant must not issue a kernel command itself: adapters refuse a
 * command started inside another.
 */
export interface CommitParticipant<HostTransaction = unknown> {
  readonly name: string;
  /** Also call `commit` for read-only commands. */
  readonly observeReads?: boolean;
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
    /**
     * Delete every row and tombstone whose key starts with `prefix`; return
     * how many keys were forgotten.
     */
    deletePrefix(prefix: string): number;
    /**
     * While more than `maxEntries` rows exist, delete the oldest resolved row
     * (`createdAt` ascending, then key in code-point order) and leave a
     * tombstone for its key, stamped `now`. Unresolved rows are never
     * deleted, so the cap is soft. Tombstones do not count toward it.
     */
    pruneResolved(maxEntries: number, now: number): void;
    /** When the key's resolved row was evicted; undefined if it was not. */
    expiredAt(key: string): number | undefined;
    /**
     * Delete the tombstones whose key starts with `keyPrefix` and whose
     * `expiredAt` is before `cutoff`.
     */
    deleteTombstonesBefore(keyPrefix: string, cutoff: number): void;
  };
  readonly turnBoundary: {
    get(boundaryId: string): TurnBoundaryRecord | undefined;
    listThread(threadId: string): TurnBoundaryRecord[];
    listAll(): TurnBoundaryRecord[];
    put(record: TurnBoundaryRecord): void;
    delete(boundaryId: string): void;
  };
  readonly turnTerminals: {
    findInvocation(query: InvocationTerminalQuery): InvocationTerminalRead;
    addInvocation(fact: InvocationTerminalFact): void;
    readRetirement(
      threadId: string,
      boundaryId: string,
    ): InvocationTerminalRetirement | undefined;
    recordRetirement(witness: InvocationTerminalRetirement): void;
    has(threadId: string, providerTurnId: string): boolean;
    add(threadId: string, providerTurnId: string): void;
    deleteThread(threadId: string): void;
  };
  readonly requestKeys: {
    get(id: RequestKeyId): RequestKeyRecord | undefined;
    /** Insert, or update in place keeping the row's insertion position. */
    put(record: RequestKeyRecord): void;
    delete(id: RequestKeyId): void;
    /** Delete the rows that have a result and were created before `cutoff`. */
    deleteCompletedCreatedBefore(cutoff: number): void;
    /**
     * The caller's rows that hold a quota slot: every row with a result, and
     * every unresolved row created at or after `countedSince`.
     */
    countCaller(callerSessionId: string, countedSince: number): number;
    /** The caller's rows that have a result. */
    countCallerCompleted(callerSessionId: string): number;
    /** Every row that holds a quota slot, as for `countCaller`. */
    countAll(countedSince: number): number;
    /**
     * Delete up to `count` of the caller's rows that have a result, oldest
     * first (`createdAt` ascending, then insertion order).
     */
    evictOldestCompleted(callerSessionId: string, count: number): void;
  };
  readonly inbox: {
    get(inboxId: string, key: string): InboxEntryRecord | undefined;
    /** One inbox's entries, `sequence` ascending. */
    listInbox(inboxId: string): InboxEntryRecord[];
    /**
     * Every `queued`, `placing` or `unconfirmed` entry, `inboxId` in
     * code-point order, then `sequence` ascending.
     */
    listOpen(): InboxEntryRecord[];
    /** Insert, or replace the entry with the same inbox and key. */
    put(record: InboxEntryRecord): void;
    /**
     * Delete the inbox's `placed`, `refused` and `cancelled` entries last
     * updated before `cutoff`.
     */
    deleteSettledBefore(inboxId: string, cutoff: number): void;
    /** Delete every entry of the inbox; return how many there were. */
    deleteInbox(inboxId: string): number;
  };
}

export class KernelStorageClosedError extends Error {
  readonly code = 'MONUMENT_STORAGE_CLOSED';
  constructor() {
    super('The monument storage is closed.');
    this.name = 'KernelStorageClosedError';
  }
}
