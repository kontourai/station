import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
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
 * did not. `reserved`/`admitted`/`session-started` claims whose owner died
 * stay exactly there; the lookup projection presents them conservatively
 * and nothing in this store authorizes a resend — absence of evidence is
 * never a replay authorization. A started session is NOT an accepted work
 * request: `session-started` means the reserved session exists, while
 * `accepted` additionally carries the real initial provider turn id from
 * the dispatch that durably accepted the requested first turn. A crash
 * between the two leaves the claim at `session-started` — reconcilable via
 * the stable `initialClientTurnId` against existing durable turn evidence
 * (turn.started events, the turn-dedup mapping), never auto-replayed.
 *
 * Ownership: the reserve-time owner secret is a real capability. Only its
 * SHA-256 verifier is persisted; every transition recomputes the verifier
 * from the presented token and compares exactly, so a wrong, random, or
 * other-claim token advances nothing on any store instance sharing the
 * file. The secret itself is never persisted, never projected, and never
 * appears in lookup/409 output.
 *
 * Keys: the storage key is the unambiguous length-prefixed tuple
 * `delegationAttemptClaimKey(callerDeviceId, attemptId)` — opaque device
 * and attempt ids may both contain colons, so naive `${deviceId}:${attemptId}`
 * joins can collide across grants. Reserve and lookup both validate the
 * tuple components, and every persisted record's key must equal the
 * recomputed tuple of its own identity fields.
 */

const STORE_VERSION = 2 as const;

/**
 * Explicit finite capacity. Every accepted key — including terminal
 * tombstones — is retained up to this many records; the next NEW claim at
 * capacity is REFUSED (never evicted). See the module docblock: no
 * production retention protocol is claimed here.
 */
const DELEGATION_ATTEMPT_CLAIM_CAPACITY = 1024;

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
   * The reserved session exists (newly started and durably evidenced, or
   * reattached after a read proved it). NOT an accepted work request: the
   * requested initial turn has not been shown durably accepted yet. A crash
   * here leaves the claim here — reconcilable, never replayed.
   */
  | 'session-started'
  /**
   * The requested initial turn is durably accepted: the dispatch returned
   * the real provider turn id and it is recorded on the claim. Terminal-
   * positive: the taskId is the real receiver task handle and
   * initialTurnId is the real initial turn, so a lost acknowledgement
   * resolves to exactly that task/turn via lookup without re-POSTing.
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
  /** The unambiguous tuple key: `delegationAttemptClaimKey(callerDeviceId, attemptId)`. */
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
   * for the (at most one) session this claim ever allowed. Preserved on the
   * record in every state for honest inspection and reconciliation.
   */
  readonly taskId: string;
  /**
   * Stable initial client-turn identity, minted AT RESERVE time and passed
   * as the `clientTurnId` of the one initial-turn dispatch. It links the
   * claim to existing durable turn evidence (turn.started events and the
   * turn-dedup mapping) so an unknown outcome stays reconcilable without
   * ever authorizing a second dispatch.
   */
  readonly initialClientTurnId: string;
  /**
   * SHA-256 (hex) verifier of the reserve-time owner secret. The secret
   * itself is never persisted — it is returned once to the reserver and
   * recomputed-then-compared on every transition.
   */
  readonly ownerVerifier: string;
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
  /**
   * The real provider turn id returned by the initial-turn dispatch. Set
   * only by the owner when marking `accepted` — never invented, never
   * replayed, never a second scheduler.
   */
  initialTurnId?: string;
}

/**
 * The unambiguous storage key for a (caller grant, attempt) tuple.
 * Length-prefixed so opaque ids containing `:` (or any other character)
 * can never collide across grants: `5:ab:cd:3:ef:g` parses exactly one
 * way. Both components must be nonempty; anything else is a programming
 * error and throws before any claim is read or written.
 */
export function delegationAttemptClaimKey(
  callerDeviceId: string,
  attemptId: string,
): string {
  if (!callerDeviceId || !attemptId) {
    throw new Error(
      'Delegation attempt claim key components must both be nonempty',
    );
  }
  return `${callerDeviceId.length}:${callerDeviceId}:${attemptId.length}:${attemptId}`;
}

interface DelegationAttemptClaimLedger {
  readonly version: typeof STORE_VERSION;
  readonly records: Record<string, DelegationAttemptClaimRecord>;
}

const EMPTY_LEDGER: DelegationAttemptClaimLedger = Object.freeze({
  version: STORE_VERSION,
  records: Object.freeze({}),
});

function isWellFormedAdmitted(
  admitted: unknown,
): admitted is NonNullable<DelegationAttemptClaimRecord['admitted']> {
  if (!admitted || typeof admitted !== 'object') return false;
  const candidate = admitted as Record<string, unknown>;
  for (const field of [
    'provider',
    'modelId',
    'projectSlug',
    'localProjectId',
  ] as const) {
    const value = candidate[field];
    if (value !== undefined && typeof value !== 'string') return false;
  }
  return (
    typeof candidate.portableProjectId === 'string' &&
    candidate.portableProjectId.length > 0 &&
    typeof candidate.resourceId === 'string' &&
    candidate.resourceId.length > 0
  );
}

function isWellFormedClaimRecord(
  key: string,
  record: unknown,
): record is DelegationAttemptClaimRecord {
  if (!record || typeof record !== 'object') return false;
  const candidate = record as Record<string, unknown>;
  if (candidate.key !== key) return false;
  if (
    typeof candidate.attemptId !== 'string' ||
    candidate.attemptId.length === 0 ||
    typeof candidate.callerDeviceId !== 'string' ||
    candidate.callerDeviceId.length === 0
  ) {
    return false;
  }
  // The persisted key must be exactly the unambiguous tuple of the
  // record's own identity fields — a hand-moved record under a colliding
  // naive-joined key is malformation, not a claim.
  let expectedKey: string;
  try {
    expectedKey = delegationAttemptClaimKey(
      candidate.callerDeviceId,
      candidate.attemptId,
    );
  } catch {
    return false;
  }
  if (candidate.key !== expectedKey) return false;
  if (
    typeof candidate.intentDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.intentDigest) ||
    typeof candidate.taskId !== 'string' ||
    candidate.taskId.length === 0 ||
    typeof candidate.initialClientTurnId !== 'string' ||
    candidate.initialClientTurnId.length === 0 ||
    typeof candidate.ownerVerifier !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.ownerVerifier)
  ) {
    return false;
  }
  const state = candidate.state;
  if (
    state !== 'reserved' &&
    state !== 'admitted' &&
    state !== 'session-started' &&
    state !== 'accepted' &&
    state !== 'refused' &&
    state !== 'unresolved'
  ) {
    return false;
  }
  if (
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string'
  ) {
    return false;
  }
  // State-dependent required data, not just the root shape: an `admitted`
  // payload that is present must be well-formed whenever it is present,
  // and the post-resolution states require what their meaning promises —
  // `admitted` facts for `admitted` and later, the real initial turn id
  // for `accepted`. A record claiming a state without its evidence is
  // malformation and fails closed.
  if (
    candidate.admitted !== undefined &&
    !isWellFormedAdmitted(candidate.admitted)
  ) {
    return false;
  }
  if (
    (state === 'admitted' ||
      state === 'session-started' ||
      state === 'accepted') &&
    !isWellFormedAdmitted(candidate.admitted)
  ) {
    return false;
  }
  if (candidate.initialTurnId !== undefined) {
    if (
      typeof candidate.initialTurnId !== 'string' ||
      candidate.initialTurnId.length === 0
    ) {
      return false;
    }
  }
  if (
    state === 'accepted' &&
    (typeof candidate.initialTurnId !== 'string' ||
      candidate.initialTurnId.length === 0)
  ) {
    return false;
  }
  return true;
}

/**
 * Unique missing-file sentinel: only ENOENT falls back (inside
 * `readJsonFile`), so reaching this comparison means the file is absent.
 * EVERY present value — including JSON `null`/`false`/`0`/`""`, which are
 * not ledgers — goes through full validation below and fails closed
 * rather than being mistaken for a missing ledger with no claims.
 */
const MISSING_LEDGER: unique symbol = Symbol('missing-delegation-ledger');

function readLedger(file: string): DelegationAttemptClaimLedger {
  const stored = readJsonFile<
    DelegationAttemptClaimLedger | typeof MISSING_LEDGER
  >(file, MISSING_LEDGER, {
    maxBytes: 4 * 1024 * 1024,
    label: 'Delegation attempt claim store',
  });
  if (stored === MISSING_LEDGER) return EMPTY_LEDGER;
  // Fail closed on malformation: a store whose shape is not exactly the
  // v2 ledger (a present null/falsy non-object, array records, a key that
  // is not the tuple of the record's own identity fields, a non-digest, a
  // bad owner verifier, an unknown state, or a state without its required
  // evidence) throws rather than forgetting a claim and permitting a
  // duplicate execution. Corrupt JSON already throws inside `readJsonFile`
  // (only a missing file falls back); a version mismatch (including every
  // v1 ledger, which has no verifier, no tuple key, and no turn split)
  // throws rather than being reinterpreted.
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error('Delegation attempt claim store is malformed');
  }
  if (stored.version !== STORE_VERSION) {
    throw new Error(
      `Delegation attempt claim store version ${String(stored.version)} is not supported`,
    );
  }
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
  | {
      readonly kind: 'created';
      /** The reserve-time owner secret — returned exactly once, never persisted. */
      readonly ownerToken: string;
      /** The minted stable initial client-turn identity, persisted on the record. */
      readonly initialClientTurnId: string;
    }
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
  markSessionStarted(
    key: string,
    ownerToken: string,
  ): Promise<OwnerTransitionOutcome>;
  markAccepted(
    key: string,
    ownerToken: string,
    initialTurnId: string,
  ): Promise<OwnerTransitionOutcome>;
  markRefused(key: string, ownerToken: string): Promise<OwnerTransitionOutcome>;
  markUnresolved(
    key: string,
    ownerToken: string,
  ): Promise<OwnerTransitionOutcome>;
}

/**
 * SHA-256 (hex) verifier of an owner token. The token is a 256-bit secret
 * returned exactly once at reserve; only this verifier is persisted.
 */
function ownerVerifierFor(ownerToken: string): string {
  return createHash('sha256').update(ownerToken, 'utf8').digest('hex');
}

function isOwnerTokenValid(
  record: DelegationAttemptClaimRecord,
  ownerToken: string,
): boolean {
  if (ownerToken.length === 0) return false;
  const presented = ownerVerifierFor(ownerToken);
  const expected = record.ownerVerifier;
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
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
        // The key is caller-supplied storage addressing: it must be exactly
        // the unambiguous tuple of the claimed identity, or the reserve is
        // a programming error and nothing is written.
        const expectedKey = delegationAttemptClaimKey(
          input.callerDeviceId,
          input.attemptId,
        );
        if (input.key !== expectedKey) {
          throw new Error(
            'Delegation attempt claim key does not match the caller/attempt tuple',
          );
        }
        const existing = current.records[input.key];
        if (existing) {
          // Same tuple key: identical validated intent joins the existing
          // claim (no second effect is ever launched from here); a
          // different validated intent under the same correlation key is a
          // conflict — the first accepted request owns the key outright.
          // The record's own identity fields are rechecked against the
          // claimed tuple (fail closed on any mismatch, however
          // unreachable under length-prefixed keys), so a key-boundary
          // collision across two delegation grants can never disclose
          // another grant's record or coalesce two grants into one claim.
          if (
            existing.callerDeviceId !== input.callerDeviceId ||
            existing.attemptId !== input.attemptId
          ) {
            throw new Error(
              'Delegation attempt claim identity does not match the caller/attempt tuple',
            );
          }
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
        const ownerToken = randomBytes(32).toString('hex');
        const initialClientTurnId = randomUUID();
        const record: DelegationAttemptClaimRecord = {
          key: input.key,
          attemptId: input.attemptId,
          callerDeviceId: input.callerDeviceId,
          intentDigest: input.intentDigest,
          taskId: input.taskId,
          initialClientTurnId,
          ownerVerifier: ownerVerifierFor(ownerToken),
          state: 'reserved',
          createdAt: now,
          updatedAt: now,
        };
        return {
          result: {
            kind: 'created',
            ownerToken,
            initialClientTurnId,
          } as const,
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
        // The owner secret is issued EXACTLY once, at reserve, and is
        // threaded server-internally only (never persisted, never public
        // JSON, never accepted from any request): a duplicate reserve never
        // receives one — it joins or throws — so no second owner exists to
        // advance the claim, and after an owner crash nobody holds one, so
        // the claim stays put. Only the SHA-256 verifier is persisted, and
        // EVERY transition recomputes it from the presented token and
        // compares exactly: a wrong, random, empty, or other-claim token
        // yields `not-owner` with no mutation, on every store instance
        // sharing the file. The state machine below (allowedFrom) is what
        // makes re-application go `stale`. `refused` is terminal for every
        // caller including the owner.
        if (!isOwnerTokenValid(record, ownerToken)) {
          return { result: { kind: 'not-owner' } as const };
        }
        if (record.state === 'refused') {
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

  async markSessionStarted(
    key: string,
    ownerToken: string,
  ): Promise<OwnerTransitionOutcome> {
    // The reserved session exists (durably evidenced start, or a read that
    // proved it for the reattach path). This is NOT an accepted work
    // request — the initial turn is still unproven.
    return this.#transition(key, ownerToken, ['admitted'], (record) => {
      record.state = 'session-started';
    });
  }

  async markAccepted(
    key: string,
    ownerToken: string,
    initialTurnId: string,
  ): Promise<OwnerTransitionOutcome> {
    // Only from `session-started` and only with the real provider turn id
    // the initial-turn dispatch returned: a started session alone never
    // becomes `accepted`, and the turn id is recorded, never invented.
    if (typeof initialTurnId !== 'string' || initialTurnId.length === 0) {
      throw new Error(
        'Delegation attempt claim acceptance requires the real initial turn id',
      );
    }
    return this.#transition(key, ownerToken, ['session-started'], (record) => {
      record.state = 'accepted';
      record.initialTurnId = initialTurnId;
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
    // Reachable from `session-started` too: the session exists but the
    // initial turn's fate is unknown (invocation may have happened). Never
    // a resend authorization — only the owner advances here, and only
    // forward into the unknown.
    return this.#transition(
      key,
      ownerToken,
      ['reserved', 'admitted', 'session-started'],
      (record) => {
        record.state = 'unresolved';
      },
    );
  }
}

/**
 * The bounded closed lookup projection: never a raw provider output,
 * transcript, error, prompt, path, digest, owner verifier, or client-turn
 * identity — only the claim state, the reserved receiver task reference
 * (every known claim, for honest inspection and reconciliation against
 * session/turn evidence), and, when evidenced, the real initial turn id.
 * `none` (claim absent as observed NOW) is explicitly NOT a resend
 * authorization: a delayed original request can still arrive.
 */
export interface DelegationAttemptProjection {
  readonly attemptId: string;
  readonly state: 'none' | 'preparing' | 'accepted' | 'unresolved' | 'refused';
  /**
   * The reserved receiver task reference. Present for every KNOWN claim
   * (including `preparing`/`unresolved`/`refused`) so an unknown outcome
   * stays reconcilable against session/turn evidence; it is a reference,
   * never a resend authorization and never proof the turn was accepted.
   */
  readonly taskId?: string;
  /** Present only when `state === 'accepted'`: the real initial turn id. */
  readonly turnId?: string;
}

export function projectDelegationAttemptClaim(
  record: DelegationAttemptClaimRecord | undefined,
  attemptId: string,
): DelegationAttemptProjection {
  if (!record) return { attemptId, state: 'none' };
  switch (record.state) {
    case 'reserved':
    case 'admitted':
    case 'session-started':
      // Claimed, initial-turn acceptance not yet durably evidenced (a
      // started session alone is NOT acceptance). Conservative by
      // construction (a dead owner's claim stays here); never a resend
      // authorization. The reserved task reference is preserved so the
      // unknown outcome stays reconcilable.
      return { attemptId, state: 'preparing', taskId: record.taskId };
    case 'accepted':
      // The one real execution, resolved to exactly this task AND this
      // initial turn: a lost acknowledgement settles here without re-POST.
      return {
        attemptId,
        state: 'accepted',
        taskId: record.taskId,
        turnId: record.initialTurnId,
      };
    case 'refused':
      return { attemptId, state: 'refused', taskId: record.taskId };
    case 'unresolved':
      return { attemptId, state: 'unresolved', taskId: record.taskId };
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
    /** The real initial turn id — the exact turn the lost ACK can resolve to. */
    readonly turnId: string,
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
