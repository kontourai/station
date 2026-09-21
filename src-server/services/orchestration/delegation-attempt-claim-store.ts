import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  publishJsonFileWithOwnedLock,
  readJsonFile,
} from '../../domain/file-storage-helpers.js';

/**
 * #485 receiver request-claim slice — the small durable execution-domain
 * owner for opt-in portable delegation attempts.
 *
 * What this store IS: the receiver-side durable fact that a specific
 * validated request (under a specific verified caller grant) was ACCEPTED
 * once. It is written BEFORE any admission/resolution/engine-preparation
 * await in the receiver-local `delegateTask` path, and it is the join that
 * makes concurrent or redelivered identical requests unable to start a
 * second session/turn, and a lost acknowledgement lookable-up without
 * executing again.
 *
 * What this store is NOT: a scheduler, a UI ActionOperation ledger (those
 * prune; this store never silently evicts), or an exactly-once guarantee.
 * Bounded and fail-closed by design: ALL accepted keys are retained —
 * including settled tombstones — up to an explicit finite capacity, and at
 * capacity NEW opt-in claims are refused rather than evicting an
 * unresolved (or any) key and risking duplicate execution. This is not a
 * complete production retention policy: a future expiry/retention protocol
 * (bounded claim windows with sender-visible semantics) is REQUIRED before
 * capacity pressure becomes routine, and until then refusal is the honest
 * answer. The receiver never learns whether a SENDER's row was pruned, and
 * never claims otherwise.
 *
 * Crash honesty: a reservation alone does not prove an effect happened or
 * did not. `reserved`/`admitted` claims whose owner died stay exactly
 * there; the lookup projection presents them conservatively and nothing in
 * this store authorizes a resend — absence of evidence is never a replay
 * authorization.
 */

const STORE_VERSION = 1 as const;

/**
 * Explicit finite capacity. Every accepted key — including terminal
 * tombstones — is retained up to this many records; the next NEW claim at
 * capacity is REFUSED (never evicted). See the module docblock: no
 * production retention protocol is claimed here.
 */
export const DELEGATION_ATTEMPT_CLAIM_CAPACITY = 1024;

export type DelegationAttemptClaimState =
  /**
   * Claimed pre-execution: validated raw intent digest is durable, no
   * admitted fact is bound yet. Crashes here leave the claim here.
   */
  | 'reserved'
  /**
   * Server-derived admitted facts (provider/model/Project incarnation)
   * bound under the same claim, after resolution and before any provider
   * effect. #484 admission checks are unchanged and still gate the effect.
   */
  | 'admitted'
  /**
   * The reserved session start is durably accepted (existing
   * SessionStartBoundary/session.started evidence path). Terminal-positive:
   * the taskId is the real receiver task handle.
   */
  | 'accepted'
  /**
   * A CLEAN pre-effect refusal was recorded (resolution/admission refused
   * before any adapter invocation). Terminal tombstone: the key is still
  ﻿ * retained, and a refused key never re-executes under changed intent.
   */
  | 'refused'
  /**
   * The invocation may have happened and completion is not proven
   * (indeterminate start). Revisable only by evidence-bearing follow-up
   * slices; never a resend authorization.
   */
  | 'unresolved';

export interface DelegationAttemptClaimRecord {
  readonly key: string;
  readonly attemptId: string;
  /** Server-resolved verified delegation-device grant id; never body trust. */
  readonly callerDeviceId: string;
  /** SHA-256 over the canonical VALIDATED RAW intent (see `delegationAttemptIntentDigest`). */
  readonly intentDigest: string;
  /**
   * The receiver-minted reserved task id (`task:<uuid>`). Minted AT RESERVE
   * time and used as the actual session id, so this field links the claim
   * to the existing SessionStartBoundary / session.started / turn evidence
   * for the (at most one) session this claim ever allowed.
   */
  readonly taskId: string;
  state: DelegationAttemptClaimState;
  readonly createdAt: string;
  updatedAt: string;
  /** Bound only by the owner, after resolution, before provider effects. */
  admitted?: {
    readonly provider?: string;
    readonly modelId?: string;
    readonly projectSlug?: string;
    /** The receiver-local Project incarnation the admission was captured against. */
    readonly localProjectId?: string;
    readonly portableProjectId: string;
    readonly resourceId: string;
  };
}

interface DelegationAttemptClaimLedger {
  readonly version: typeof STORE_VERSION;
  readonly records: Record<string, DelegationAttemptClaimRecord>;
}

const EMPTY_LEDGER: DelegationAttemptClaimLedger = Object.freeze({
  version: STORE_VERSION,
  records: Object.freeze({}),
});

function isWellFormedClaimRecord(
  key: string,
  record: unknown,
): record is DelegationAttemptClaimRecord {
  if (!record || typeof record !== 'object') return false;
  const candidate = record as Record<string, unknown>;
  return (
    candidate.key === key &&
    typeof candidate.attemptId === 'string' &&
    candidate.attemptId.length > 0 &&
    typeof candidate.callerDeviceId === 'string' &&
    candidate.callerDeviceId.length > 0 &&
    typeof candidate.intentDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(candidate.intentDigest) &&
    typeof candidate.taskId === 'string' &&
    candidate.taskId.length > 0 &&
    (candidate.state === 'reserved' ||
      candidate.state === 'admitted' ||
      candidate.state === 'accepted' ||
      candidate.state === 'refused' ||
      candidate.state === 'unresolved') &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string'
  );
}

function readLedger(file: string): DelegationAttemptClaimLedger {
  const stored = readJsonFile<DelegationAttemptClaimLedger | null>(file, null, {
    maxBytes: 4 * 1024 * 1024,
    label: 'Delegation attempt claim store',
  });
  if (!stored) return EMPTY_LEDGER;
  if (stored.version !== STORE_VERSION) {
    throw new Error(
      `Delegation attempt claim store version ${String(stored.version)} is not supported`,
    );
  }
  // Fail closed on malformation: a store whose shape is not exactly the
  // v1 ledger (array records, or any record with a key mismatch, a
  // non-digest, or an unknown state) throws rather than forgetting a
  // claim and permitting a duplicate execution. Corrupt JSON already
  // throws inside `readJsonFile` (only a missing file falls back).
  if (
    !stored.records ||
    typeof stored.records !== 'object' ||
    Array.isArray(stored.records)
  ) {
    throw new Error('Delegation attempt claim store records are malformed');
  }
  for (const [key, record] of Object.entries(stored.records)) {
    if (!isWellFormedClaimRecord(key, record)) {
      throw new Error('Delegation attempt claim store records are malformed');
    }
  }
  return stored;
}

/**
 * Canonical JSON with recursively sorted object keys, so the digest of a
 * validated raw intent is stable across key order and harmless insertion
 * differences. The digest covers the RAW (pre-resolution) intent only:
 * prompt, target (agent/environment/model/workspace as validated at the
 * route seam), and parentTaskId. Resolved workspace paths and incarnations
 * CANNOT be in this digest — they do not exist yet when the claim is
 * written; they are bound separately under the same claim after resolution.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface DelegationAttemptIntent {
  readonly prompt: string;
  readonly target: unknown;
  readonly parentTaskId?: string;
}

export function delegationAttemptIntentDigest(
  intent: DelegationAttemptIntent,
): string {
  return createHash('sha256').update(canonicalJson(intent)).digest('hex');
}

export type ReserveDelegationAttemptOutcome =
  | { readonly kind: 'created'; readonly ownerToken: string }
  | { readonly kind: 'existing'; readonly record: DelegationAttemptClaimRecord }
  | { readonly kind: 'conflict'; readonly record: DelegationAttemptClaimRecord }
  | { readonly kind: 'capacity' };

export type OwnerTransitionOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'not-owner' }
  | { readonly kind: 'stale' };

export interface DelegationAttemptClaimStore {
  read(key: string): Promise<DelegationAttemptClaimRecord | undefined>;
  reserve(input: {
    readonly key: string;
    readonly attemptId: string;
    readonly callerDeviceId: string;
    readonly intentDigest: string;
    readonly taskId: string;
  }): Promise<ReserveDelegationAttemptOutcome>;
  bindAdmitted(
    key: string,
    ownerToken: string,
    admitted: DelegationAttemptClaimRecord['admitted'],
  ): Promise<OwnerTransitionOutcome>;
  markAccepted(
    key: string,
    ownerToken: string,
  ): Promise<OwnerTransitionOutcome>;
  markRefused(key: string, ownerToken: string): Promise<OwnerTransitionOutcome>;
  markUnresolved(
    key: string,
    ownerToken: string,
  ): Promise<OwnerTransitionOutcome>;
}

interface FileDelegationAttemptClaimStoreOptions {
  readonly acquireLock?: typeof acquireFileMutationLockAsync;
  /** Fault seam immediately before the atomic rename commit (tests only). */
  readonly beforeCommit?: () => void | Promise<void>;
  readonly capacity?: number;
}

/**
 * File-backed implementation. The mutation lock is held ONLY around the
 * local read-modify-publish (the atomic rename is the commit point) — never
 * across HTTP, provider calls, or any async execution preparation. One
 * lock, one reserve: `reserve` returns exactly ONE owner token on creation
 * and the EXISTING record for a same-key/same-digest redelivery — the
 * duplicate never launches another effect.
 */
export class FileDelegationAttemptClaimStore
  implements DelegationAttemptClaimStore
{
  readonly #file: string;
  readonly #acquireLock: typeof acquireFileMutationLockAsync;
  readonly #beforeCommit?: () => void | Promise<void>;
  readonly #capacity: number;

  constructor(
    dataDir: string,
    options: FileDelegationAttemptClaimStoreOptions = {},
  ) {
    this.#file = join(dataDir, 'delegation-attempt-claims.json');
    this.#acquireLock = options.acquireLock ?? acquireFileMutationLockAsync;
    this.#beforeCommit = options.beforeCommit;
    this.#capacity = options.capacity ?? DELEGATION_ATTEMPT_CLAIM_CAPACITY;
  }

  async read(key: string): Promise<DelegationAttemptClaimRecord | undefined> {
    return readLedger(this.#file).records[key];
  }

  async transact<T>(
    update: (current: DelegationAttemptClaimLedger) => {
      result: T;
      next?: DelegationAttemptClaimLedger;
    },
  ): Promise<T> {
    const release = await this.#acquireLock(`${this.#file}.mutation`);
    let committed = false;
    let result: T | undefined;
    let operationError: unknown;
    try {
      const current = readLedger(this.#file);
      const outcome = update(structuredClone(current));
      result = outcome.result;
      if (outcome.next) {
        await publishJsonFileWithOwnedLock(this.#file, outcome.next, {
          maxBytes: 4 * 1024 * 1024,
          label: 'Delegation attempt claim store',
          beforeCommit: this.#beforeCommit,
        });
      }
      committed = true;
    } catch (error) {
      operationError = error;
    }
    try {
      await release();
    } catch (error) {
      // Publication is the commit point; a lock-cleanup fault after it
      // cannot turn a committed claim into an apparently failed write.
      if (!committed && operationError === undefined) operationError = error;
    }
    if (operationError !== undefined) throw operationError;
    return result as T;
  }

  async reserve(input: {
    readonly key: string;
    readonly attemptId: string;
    readonly callerDeviceId: string;
    readonly intentDigest: string;
    readonly taskId: string;
  }): Promise<ReserveDelegationAttemptOutcome> {
    return this.transact(
      (
        current,
      ): {
        result: ReserveDelegationAttemptOutcome;
        next?: DelegationAttemptClaimLedger;
      } => {
        const existing = current.records[input.key];
        if (existing) {
          // Same key: identical validated intent joins the existing claim (no
          // second effect is ever launched from here); a different validated
          // intent under the same correlation key is a conflict — the first
          // accepted request owns the key outright.
          return existing.intentDigest === input.intentDigest
            ? { result: { kind: 'existing', record: existing } as const }
            : { result: { kind: 'conflict', record: existing } as const };
        }
        // Fail closed at capacity: refuse the NEW claim rather than evict an
        // unresolved/old key and risk duplicate execution. See module docblock.
        if (Object.keys(current.records).length >= this.#capacity) {
          return { result: { kind: 'capacity' } as const };
        }
        const now = new Date().toISOString();
        const record: DelegationAttemptClaimRecord = {
          key: input.key,
          attemptId: input.attemptId,
          callerDeviceId: input.callerDeviceId,
          intentDigest: input.intentDigest,
          taskId: input.taskId,
          state: 'reserved',
          createdAt: now,
          updatedAt: now,
        };
        return {
          result: { kind: 'created', ownerToken: randomUUID() } as const,
          next: {
            version: STORE_VERSION,
            records: { ...current.records, [input.key]: record },
          },
        };
      },
    );
  }

  async #transition(
    key: string,
    ownerToken: string,
    allowedFrom: readonly DelegationAttemptClaimState[],
    apply: (record: DelegationAttemptClaimRecord) => void,
  ): Promise<OwnerTransitionOutcome> {
    return this.transact(
      (
        current,
      ): {
        result: OwnerTransitionOutcome;
        next?: DelegationAttemptClaimLedger;
      } => {
        const record = current.records[key];
        if (!record) return { result: { kind: 'not-owner' } as const };
        // The owner token is issued EXACTLY once, at reserve, and is threaded
        // server-internally only (never persisted, never public JSON, never
        // accepted from any request): a duplicate reserve never receives one —
        // it joins or throws — so no second owner exists to advance the claim,
        // and after an owner crash nobody holds one, so the claim stays put.
        // The token itself is an issuance marker, not a capability secret: the
        // state machine below (allowedFrom) is what makes re-application go
        // `stale`. An empty token is rejected as a programming-error guard;
        // `refused` is terminal for every caller including the owner.
        if (ownerToken.length === 0 || record.state === 'refused') {
          return { result: { kind: 'not-owner' } as const };
        }
        if (!allowedFrom.includes(record.state)) {
          return { result: { kind: 'stale' } as const };
        }
        apply(record);
        record.updatedAt = new Date().toISOString();
        return { result: { kind: 'applied' } as const, next: current };
      },
    );
  }

  async bindAdmitted(
    key: string,
    ownerToken: string,
    admitted: NonNullable<DelegationAttemptClaimRecord['admitted']>,
  ): Promise<OwnerTransitionOutcome> {
    return this.#transition(key, ownerToken, ['reserved'], (record) => {
      record.state = 'admitted';
      record.admitted = admitted;
    });
  }

  async markAccepted(
    key: string,
    ownerToken: string,
  ): Promise<OwnerTransitionOutcome> {
    return this.#transition(key, ownerToken, ['admitted'], (record) => {
      record.state = 'accepted';
    });
  }

  async markRefused(
    key: string,
    ownerToken: string,
  ): Promise<OwnerTransitionOutcome> {
    // A clean pre-effect refusal is terminal: the key is retained as a
    // tombstone and can never execute again under changed intent.
    return this.#transition(
      key,
      ownerToken,
      ['reserved', 'admitted'],
      (record) => {
        record.state = 'refused';
      },
    );
  }

  async markUnresolved(
    key: string,
    ownerToken: string,
  ): Promise<OwnerTransitionOutcome> {
    return this.#transition(
      key,
      ownerToken,
      ['reserved', 'admitted'],
      (record) => {
        record.state = 'unresolved';
      },
    );
  }
}

/**
 * The bounded closed lookup projection: never a raw provider output,
 * transcript, error, prompt, path, or digest — only the claim state and,
 * when evidenced, the real receiver task handle. `none` (claim absent as
 * observed NOW) is explicitly NOT a resend authorization: a delayed
 * original request can still arrive.
 */
export interface DelegationAttemptProjection {
  readonly attemptId: string;
  readonly state: 'none' | 'preparing' | 'accepted' | 'unresolved' | 'refused';
  /** Present only when `state === 'accepted'`: the real receiver task handle. */
  readonly taskId?: string;
}

export function projectDelegationAttemptClaim(
  record: DelegationAttemptClaimRecord | undefined,
  attemptId: string,
): DelegationAttemptProjection {
  if (!record) return { attemptId, state: 'none' };
  switch (record.state) {
    case 'reserved':
    case 'admitted':
      // Claimed, execution not yet durably evidenced. Conservative by
      // construction (a dead owner's claim stays here); never a resend
      // authorization.
      return { attemptId, state: 'preparing' };
    case 'accepted':
      return { attemptId, state: 'accepted', taskId: record.taskId };
    case 'refused':
      return { attemptId, state: 'refused' };
    case 'unresolved':
      return { attemptId, state: 'unresolved' };
  }
}

/** Typed outcomes the delegation route maps to explicit 409 projections. */
export class DelegationAttemptPendingError extends Error {
  readonly code = 'delegation_attempt_pending' as const;
  constructor(readonly attemptId: string) {
    super(
      'A request with this attempt id is already claimed and its outcome is not yet available. Look it up; do not resend it.',
    );
    this.name = 'DelegationAttemptPendingError';
  }
}

export class DelegationAttemptExistsError extends Error {
  readonly code = 'delegation_attempt_exists' as const;
  constructor(
    readonly attemptId: string,
    readonly taskId: string,
  ) {
    super(
      'A request with this attempt id was already accepted. The referenced task is the one and only execution.',
    );
    this.name = 'DelegationAttemptExistsError';
  }
}

export class DelegationAttemptConflictError extends Error {
  readonly code = 'delegation_attempt_conflict' as const;
  constructor(readonly attemptId: string) {
    super(
      'A different validated request is already claimed under this attempt id. The original claim stands.',
    );
    this.name = 'DelegationAttemptConflictError';
  }
}

export class DelegationAttemptCapacityError extends Error {
  readonly code = 'delegation_attempt_capacity' as const;
  constructor() {
    super(
      'This Station is at its delegation attempt claim capacity and is refusing new opt-in attempts (fail-closed; nothing was evicted).',
    );
    this.name = 'DelegationAttemptCapacityError';
  }
}
