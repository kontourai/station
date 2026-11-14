import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { join } from 'node:path';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import {
  acquireFileMutationLockAsync,
  inspectLock,
  lockOwnerAlive,
} from '@kontourai/station-shared/lifecycle-events';
import {
  publishJsonFileWithOwnedLock,
  readJsonFile,
} from '../../domain/file-storage-helpers.js';
import { SessionStartRefusedError } from '../../providers/adapter-shape.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import type {
  DelegatedTaskHandle,
  DelegateTaskInput,
} from '../../tools/station-control-delegation.js';
import { getStationControlCaller } from '../../tools/station-control-shared.js';
import type {
  ForegroundMessageHandle,
  ForegroundMessageInput,
} from '../execution-target/execution-target-execution.js';
import { isDelegatedTaskSessionId } from './delegated-task-identity.js';
import { bindInheritedDelegationToolIntent } from './delegation-tool-policy.js';
import { chatTurnSubmissionDigest } from './turn-submission-digest.js';

const MAX_CLAIMS = 1024;
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 3 * 1024;
// Starting, completion and retention fields must fit after invocation.
const RECEIPT_BOOKKEEPING_BYTES = 256;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING = Symbol('missing-create-claims');
type CreateHandle = DelegatedTaskHandle | ForegroundMessageHandle;
interface Claim {
  kind: 'delegation' | 'foreground';
  digest: string;
  sessionId: string;
  sessionIdentityOrigin?: 'server' | 'provided';
  starting?: true;
  startedAt?: number;
  tombstoneAt?: number;
  completedAt?: number;
  retention?: { remainingMs: number; observedUptimeMs: number };
  result?: CreateHandle;
}
// Persist elapsed host uptime, never wall-clock deltas. Uptime reset (reboot)
// conservatively preserves the remaining window; legacy rows start a full one.
function observeRetention(claim: Claim, uptimeMs: number): void {
  if (
    claim.tombstoneAt !== undefined ||
    (claim.result ? claim.completedAt : claim.startedAt) === undefined
  )
    return;
  const previous = claim.retention;
  claim.retention = {
    remainingMs: Math.max(
      0,
      (previous?.remainingMs ?? RETENTION_MS) -
        (previous ? Math.max(0, uptimeMs - previous.observedUptimeMs) : 0),
    ),
    observedUptimeMs: uptimeMs,
  };
}
function claimExpired(claim: Claim): boolean {
  return claim.tombstoneAt === undefined && claim.retention?.remainingMs === 0;
}

interface Ledger {
  version: 1;
  claims: Record<string, Claim>;
}

export function isCreateRequestHandle(
  value: unknown,
): value is ForegroundMessageHandle;
export function isCreateRequestHandle(
  value: unknown,
  expected: Pick<Claim, 'kind' | 'sessionId'>,
): value is CreateHandle;
export function isCreateRequestHandle(
  value: unknown,
  expected?: Pick<Claim, 'kind' | 'sessionId'>,
): boolean {
  if (!value || typeof value !== 'object') return false;
  const handle = value as Partial<
    ForegroundMessageHandle & DelegatedTaskHandle
  >;
  if (typeof handle.conversationId !== 'string' || !handle.conversationId)
    return false;
  const turnId =
    expected?.kind === 'delegation' ? handle.turnId : handle.providerTurnId;
  if (typeof turnId !== 'string' || !turnId.trim()) return false;
  if (!expected) return true;
  return (
    handle.conversationId === expected.sessionId &&
    typeof handle.sessionId === 'string' &&
    Boolean(handle.sessionId) &&
    handle.target?.kind === 'agent' &&
    typeof handle.target.id === 'string' &&
    Boolean(handle.resolution) &&
    typeof handle.resolution === 'object' &&
    !Array.isArray(handle.resolution) &&
    (expected.kind === 'foreground' ||
      (handle.status === 'dispatched' &&
        handle.taskId === expected.sessionId &&
        handle.currentSessionId === handle.sessionId))
  );
}

export class CreateRequestConflictError extends Error {
  readonly code = 'create_request_conflict';
  constructor() {
    super('This request key is already bound to different input.');
  }
}
export class CreateRequestCapacityError extends Error {
  readonly code = 'create_request_capacity';
  readonly retryable = true;
  constructor(readonly limit: 'records' | 'bytes') {
    super(
      'Create request storage is full. Retry after completed receipts expire, or inspect unresolved requests. Nothing new was started.',
    );
  }
}
export class CreateRequestIndeterminateError extends Error {
  readonly code = 'create_request_indeterminate';
  readonly outcome = 'indeterminate';
  constructor(
    readonly sessionId: string,
    readonly clientTurnId: string,
    expired = false,
  ) {
    super(
      expired
        ? 'Creation remains indeterminate because a durable Session start exists. Inspect the returned conversationId with get_session or the Session API. This key is refused while its tombstone remains; capacity pressure may prune that protection. A new key is permitted for a deliberate separate request, which may duplicate the original effect.'
        : 'Creation may have started. Inspect the returned conversationId with get_session or the Session API and retain the original request key. Station cannot automatically reconcile an absent Session. Do not resend under a new key within seven days. After seven days this key can retry only when no durable Session start exists; otherwise it remains indeterminate. A separate new request may duplicate the original effect.',
    );
  }
}

const activeCreate = new AsyncLocalStorage<{
  open: boolean;
  kind: Claim['kind'];
  request?: Request;
  principalId: string | null;
  callerSessionId: string | null;
  sessionIdentityOrigin: Claim['sessionIdentityOrigin'];
  sessionId: string;
  mark: () => Promise<void>;
  refused: () => Promise<void>;
}>();

/** Creation identity only, not source or execution authority. The Request must
 * be the route-owned object currently inside the durable delegation claim. */
export function captureDelegationCreateCustody(request: Request) {
  const active = activeCreate.getStore();
  if (!active) throw new Error('delegation_create_custody_unavailable');
  const assertCurrent = () => {
    if (
      !(request instanceof Request) ||
      !active.open ||
      active.kind !== 'delegation' ||
      active.sessionIdentityOrigin !== 'server' ||
      active.request !== request ||
      activeCreate.getStore() !== active ||
      !isDelegatedTaskSessionId(active.sessionId)
    )
      throw new Error('delegation_create_custody_unavailable');
  };
  assertCurrent();
  return Object.freeze({
    taskId: active.sessionId,
    principalId: active.principalId,
    callerSessionId: active.callerSessionId,
    assertCurrent,
  });
}
/** Called immediately before session start or an initial turn on an existing session. */
export async function markCreateRequestStarting(
  sessionId: string,
): Promise<void> {
  const active = activeCreate.getStore();
  if (!active?.open) return;
  if (active.sessionId !== sessionId)
    throw new Error('Create request session identity changed.');
  await active.mark();
}
/** A typed rejected start proves that the starting mark did not become an effect. */
export async function recordCreateRequestStartResult(
  sessionId: string,
  status: 'accepted' | 'rejected' | 'indeterminate' | 'failed',
): Promise<void> {
  const active = activeCreate.getStore();
  if (!active?.open || status !== 'rejected') return;
  if (active.sessionId !== sessionId)
    throw new Error('Create request session identity changed.');
  await active.refused();
}

export async function createRequestCallerSession(
  request?: Request,
): Promise<string | undefined> {
  const bound = request && stationControlRequestAuthority(request);
  return bound?.kind === 'caller'
    ? bound.caller.sessionId
    : (await getStationControlCaller())?.sessionId;
}

export class CreateRequestClaims {
  readonly #file: string;
  constructor(dataDir: string) {
    this.#file = join(dataDir, 'create-request-claims.json');
  }
  #read(): Ledger {
    let value: Ledger | typeof MISSING;
    try {
      value = readJsonFile<Ledger | typeof MISSING>(this.#file, MISSING, {
        maxBytes: MAX_LEDGER_BYTES,
        label: 'Create request claims',
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Create request claims exceeds the byte limit.'
      )
        throw new CreateRequestCapacityError('bytes');
      throw error;
    }
    if (value === MISSING) return { version: 1, claims: {} };
    if (
      !value ||
      typeof value !== 'object' ||
      value.version !== 1 ||
      !value.claims ||
      typeof value.claims !== 'object' ||
      Array.isArray(value.claims)
    )
      throw new Error('Malformed create request claims');
    for (const claim of Object.values(value.claims)) {
      if (
        !claim ||
        !/^station-chat-submission\/v1:sha256:[a-f0-9]{64}$/.test(
          claim.digest,
        ) ||
        typeof claim.sessionId !== 'string' ||
        !claim.sessionId ||
        (claim.sessionIdentityOrigin !== undefined &&
          claim.sessionIdentityOrigin !== 'server' &&
          claim.sessionIdentityOrigin !== 'provided') ||
        !['delegation', 'foreground'].includes(claim.kind) ||
        (claim.starting !== undefined && claim.starting !== true) ||
        (claim.tombstoneAt !== undefined &&
          (!Number.isFinite(claim.tombstoneAt) ||
            claim.starting !== undefined ||
            claim.result !== undefined)) ||
        (claim.startedAt !== undefined && !Number.isFinite(claim.startedAt)) ||
        (claim.completedAt !== undefined &&
          !Number.isFinite(claim.completedAt)) ||
        (claim.retention !== undefined &&
          (!Number.isFinite(claim.retention.remainingMs) ||
            claim.retention.remainingMs < 0 ||
            claim.retention.remainingMs > RETENTION_MS ||
            !Number.isFinite(claim.retention.observedUptimeMs) ||
            claim.retention.observedUptimeMs < 0)) ||
        (claim.result !== undefined &&
          !isCreateRequestHandle(claim.result, claim))
      )
        throw new Error('Malformed create request claim');
    }
    return value;
  }
  async #withLockedLedger<T>(
    use: (ledger: Ledger) => T | Promise<T>,
  ): Promise<T> {
    const release = await acquireFileMutationLockAsync(
      `${this.#file}.mutation`,
    );
    try {
      const ledger = this.#read();
      return await use(ledger);
    } finally {
      await release();
    }
  }
  async #update<T>(change: (ledger: Ledger) => T | Promise<T>): Promise<T> {
    return this.#withLockedLedger(async (ledger) => {
      const uptimeMs = os.uptime() * 1000;
      for (const row of Object.values(ledger.claims))
        observeRetention(row, uptimeMs);
      const result = await change(ledger);
      await publishJsonFileWithOwnedLock(this.#file, ledger, {
        maxBytes: MAX_LEDGER_BYTES,
        label: 'Create request claims',
        indent: null,
        trailingNewline: true,
      });
      return result;
    });
  }
  async run<T extends CreateHandle>(
    input: {
      kind: 'delegation' | 'foreground';
      principal: PrincipalRef | undefined;
      authority: SessionReadAuthority;
      callerSessionId?: string;
      request?: Request;
      requestKey: string;
      intent: unknown;
      sessionId?: string;
      hasSessionStartRecord: (sessionId: string) => Promise<boolean> | boolean;
    },
    effect: (sessionId: string) => Promise<T>,
  ): Promise<T> {
    if (!input.authority.userId || !input.requestKey)
      throw new Error(
        'Create requires authenticated caller scope and a request key.',
      );
    const callerSessionId =
      input.callerSessionId ?? (await createRequestCallerSession());
    const scope = [
      input.authority.mode,
      input.authority.tenantExecutionContext?.tenantId ?? null,
      input.authority.userId,
      input.principal?.id ?? null,
      callerSessionId ?? null,
    ];
    const key = createHash('sha256')
      .update(JSON.stringify([input.kind, scope, input.requestKey]))
      .digest('hex');
    const digest = chatTurnSubmissionDigest(input.intent);
    // Reject changed input before waiting for the live request's ownership lock.
    const known = await this.#update((ledger) => ledger.claims[key]);
    let reclaimable = false;
    if (
      known &&
      !known.result &&
      !known.starting &&
      known.tombstoneAt === undefined
    ) {
      try {
        const owner = inspectLock(`${this.#file}.${key}.owner`);
        reclaimable = !owner || !lockOwnerAlive(owner.owner);
      } catch {
        // Unreadable ownership is not proof of a dead owner.
      }
    }
    if (
      known &&
      (!known.result || !claimExpired(known)) &&
      known.digest !== digest &&
      !reclaimable
    )
      throw new CreateRequestConflictError();

    // A live owner retains its per-request lock; only a dead owner's reservation can be reclaimed.
    const release = await acquireFileMutationLockAsync(
      `${this.#file}.${key}.owner`,
    );
    try {
      const claim = await this.#update(async (ledger) => {
        const now = Date.now();
        for (const [id, row] of Object.entries(ledger.claims)) {
          const unmarked =
            !row.result && !row.starting && row.tombstoneAt === undefined;
          if (unmarked && id === key && row.digest === digest) continue;
          if (!unmarked && !claimExpired(row)) continue;
          if (!row.result && id !== key) {
            const owner = inspectLock(`${this.#file}.${id}.owner`);
            if (owner && lockOwnerAlive(owner.owner)) continue;
          }
          if (unmarked) {
            delete ledger.claims[id];
            continue;
          }
          if (row.result) delete ledger.claims[id];
          else if (await input.hasSessionStartRecord(row.sessionId)) {
            row.tombstoneAt = now;
            delete row.starting;
            delete row.startedAt;
            delete row.retention;
          } else if (id === key) {
            delete row.starting;
            delete row.startedAt;
            delete row.retention;
          } else delete ledger.claims[id];
        }
        const existing = ledger.claims[key];
        if (existing) {
          if (existing.digest !== digest)
            throw new CreateRequestConflictError();
          return existing;
        }
        const row: Claim = {
          kind: input.kind,
          digest,
          sessionIdentityOrigin:
            input.sessionId === undefined ? 'server' : 'provided',
          sessionId:
            input.sessionId ??
            `${input.kind === 'delegation' ? 'task' : 'conversation'}:${randomUUID()}`,
        };
        ledger.claims[key] = row;
        const capacity = (): 'records' | 'bytes' | undefined => {
          if (Object.keys(ledger.claims).length > MAX_CLAIMS) return 'records';
          const reservedBytes =
            Buffer.byteLength(JSON.stringify(ledger) + '\n') +
            Object.values(ledger.claims).filter(
              (r) => !r.result && r.tombstoneAt === undefined,
            ).length *
              (MAX_RECEIPT_BYTES + RECEIPT_BOOKKEEPING_BYTES);
          return reservedBytes > MAX_LEDGER_BYTES ? 'bytes' : undefined;
        };
        let limit = capacity();
        if (limit) {
          const tombstones = Object.entries(ledger.claims).flatMap(
            ([id, row]) =>
              row.tombstoneAt === undefined
                ? []
                : [{ id, at: row.tombstoneAt }],
          );
          tombstones.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
          for (const tombstone of tombstones) {
            delete ledger.claims[tombstone.id];
            limit = capacity();
            if (!limit) break;
          }
        }
        if (limit) throw new CreateRequestCapacityError(limit);
        return row;
      });
      if (claim.tombstoneAt !== undefined)
        throw new CreateRequestIndeterminateError(
          claim.sessionId,
          input.requestKey,
          true,
        );
      if (claim.result) return claim.result as T;
      if (claim.starting)
        throw new CreateRequestIndeterminateError(
          claim.sessionId,
          input.requestKey,
        );
      let starting = false;
      try {
        const active = {
          open: true,
          kind: input.kind,
          request: input.request,
          principalId: input.principal?.id ?? null,
          callerSessionId: callerSessionId ?? null,
          sessionIdentityOrigin: claim.sessionIdentityOrigin,
          sessionId: claim.sessionId,
          refused: async () => {
            await this.#update((ledger) => {
              delete ledger.claims[key].starting;
              delete ledger.claims[key].startedAt;
              delete ledger.claims[key].retention;
            });
            starting = false;
          },
          mark: async () => {
            if (starting) return;
            await this.#update((ledger) => {
              ledger.claims[key].starting = true;
              ledger.claims[key].startedAt = Date.now();
              delete ledger.claims[key].retention;
              observeRetention(ledger.claims[key], os.uptime() * 1000);
            });
            starting = true;
          },
        };
        let result: T;
        try {
          result = await activeCreate.run(active, () =>
            effect(claim.sessionId),
          );
        } finally {
          active.open = false;
        }
        const bytes = JSON.stringify(result);
        const receipt: unknown =
          typeof bytes === 'string' ? JSON.parse(bytes) : undefined;
        if (
          !isCreateRequestHandle(receipt, claim) ||
          Buffer.byteLength(bytes) > MAX_RECEIPT_BYTES
        ) {
          await this.#update((ledger) => {
            ledger.claims[key].starting = true;
            ledger.claims[key].startedAt ??= Date.now();
            observeRetention(ledger.claims[key], os.uptime() * 1000);
          });
          starting = true;
          throw new CreateRequestIndeterminateError(
            claim.sessionId,
            input.requestKey,
          );
        }
        await this.#update((ledger) => {
          ledger.claims[key].result = receipt as T;
          ledger.claims[key].completedAt = Date.now();
          delete ledger.claims[key].retention;
          observeRetention(ledger.claims[key], os.uptime() * 1000);
        });
        return receipt as T;
      } catch (error) {
        if (
          !starting ||
          (error instanceof SessionStartRefusedError &&
            !(await input.hasSessionStartRecord(claim.sessionId)))
        )
          await this.#update((ledger) => {
            delete ledger.claims[key];
          });
        throw error;
      }
    } finally {
      await release();
    }
  }
}

export async function runDelegationCreate(
  input: DelegateTaskInput,
  authority: SessionReadAuthority,
  existingAttemptSessionId: string | undefined,
  create: (sessionId: string) => Promise<DelegatedTaskHandle>,
  hasSessionStartRecord: (sessionId: string) => Promise<boolean>,
): Promise<DelegatedTaskHandle> {
  const claims = input.delegationAttemptClaimStore?.createRequests;
  if (!claims)
    throw new Error('Durable create request claims are unavailable.');
  return claims.run(
    {
      kind: 'delegation',
      principal: input.principal,
      authority,
      callerSessionId: input.createRequestCallerSessionId,
      request: input.createRequestAuthority,
      requestKey: input.clientTurnId!,
      intent: bindInheritedDelegationToolIntent(
        input.createRequestIntent ?? {
          prompt: input.prompt,
          attemptId: input.delegationAttemptId ?? null,
          target: input.target,
          parentTaskId: input.parentTaskId ?? null,
          sessionId: input.sessionId ?? null,
          attachments: input.taskRoomAttachments ?? null,
        },
        input.delegation,
      ),
      sessionId: existingAttemptSessionId ?? input.sessionId,
      hasSessionStartRecord,
    },
    create,
  );
}
export async function runForegroundCreateClaim(
  claims: CreateRequestClaims | undefined,
  input: ForegroundMessageInput,
  authority: SessionReadAuthority,
  intent: unknown,
  execute: (input: ForegroundMessageInput) => Promise<unknown>,
  hasSessionStartRecord: (sessionId: string) => Promise<boolean>,
  callerSessionId?: string,
): Promise<ForegroundMessageHandle> {
  if (input.conversationId) {
    const result = await execute(input);
    if (!isCreateRequestHandle(result))
      throw new CreateRequestIndeterminateError(
        input.conversationId,
        input.clientTurnId!,
      );
    return result;
  }
  if (!claims || !input.clientTurnId)
    throw new Error('Durable foreground create claims are unavailable.');
  return claims.run(
    {
      kind: 'foreground',
      principal: input.principal,
      authority,
      callerSessionId,
      requestKey: input.clientTurnId,
      intent: bindInheritedDelegationToolIntent(intent, input.delegation),
      hasSessionStartRecord,
    },
    async (conversationId) =>
      (await execute({ ...input, conversationId })) as ForegroundMessageHandle,
  );
}
