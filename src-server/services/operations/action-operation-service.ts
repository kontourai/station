import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  ACTION_OPERATION_MAX_ACTIVE,
  ACTION_OPERATION_MAX_PAGE_SIZE,
  ACTION_OPERATION_MAX_RETAINED_TERMINALS,
  ACTION_OPERATION_MAX_STORE_BYTES,
  ACTION_OPERATION_SCHEMA_VERSION,
  type ActionOperation,
  type ActionOperationDomainRef,
  type ActionOperationPage,
  type ActionOperationProgress,
  type ActionOperationReentry,
  type ActionOperationScope,
  type ActionOperationStatus,
  type ActionOperationWatchSnapshot,
  isTerminalActionOperation,
  parseActionOperation,
} from '@kontourai/station-contracts/action-operation';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  publishJsonFileWithOwnedLock,
  readJsonFile,
} from '../../domain/file-storage-helpers.js';
import { actionOperationOutcomes } from '../../telemetry/metrics.js';

const STORE_VERSION = 1 as const;
const MAX_CURSOR = 32;
const STALE_ACTIVE_MS = 30 * 60 * 1000;

export interface ActionOperationLedger {
  readonly version: typeof STORE_VERSION;
  readonly creationSequence: number;
  readonly changeSequence: number;
  readonly records: readonly ActionOperation[];
}

const EMPTY_LEDGER: ActionOperationLedger = Object.freeze({
  version: STORE_VERSION,
  creationSequence: 0,
  changeSequence: 0,
  records: Object.freeze([]),
});

export interface ActionOperationTransaction<T> {
  readonly result: T;
  /** Omit for a read-only transaction. */
  readonly next?: ActionOperationLedger;
}

/** Read and mutation are fresh, async capabilities; no service caches a ledger. */
export interface ActionOperationStore {
  read(): Promise<ActionOperationLedger>;
  transact<T>(
    update: (current: ActionOperationLedger) => ActionOperationTransaction<T>,
  ): Promise<T>;
}

export interface FileActionOperationStoreOptions {
  readonly acquireLock?: typeof acquireFileMutationLockAsync;
  /** Fault seam immediately before the atomic rename commit. */
  readonly beforeCommit?: () => void | Promise<void>;
}

export class FileActionOperationStore implements ActionOperationStore {
  readonly #file: string;
  readonly #acquireLock: typeof acquireFileMutationLockAsync;
  readonly #beforeCommit?: () => void | Promise<void>;

  constructor(dataDir: string, options: FileActionOperationStoreOptions = {}) {
    this.#file = join(dataDir, 'action-operations.json');
    this.#acquireLock = options.acquireLock ?? acquireFileMutationLockAsync;
    this.#beforeCommit = options.beforeCommit;
  }

  async read(): Promise<ActionOperationLedger> {
    return readLedger(this.#file);
  }

  async transact<T>(
    update: (current: ActionOperationLedger) => ActionOperationTransaction<T>,
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
        const next = validateLedger(structuredClone(outcome.next));
        await publishJsonFileWithOwnedLock(this.#file, next, {
          maxBytes: ACTION_OPERATION_MAX_STORE_BYTES,
          label: 'Action operation store',
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
      // Publication is the commit point. A lock-cleanup fault after it cannot
      // turn a committed operation into a retryable, apparently failed write.
      if (!committed && operationError === undefined) operationError = error;
    }
    if (operationError !== undefined) throw operationError;
    return result as T;
  }
}

export interface ActionOperationActor {
  readonly accountId: string;
  readonly machineId?: string;
  readonly canReadSession?: (sessionId: string) => boolean | Promise<boolean>;
}

export interface CreateActionOperation {
  readonly id?: string;
  readonly scope: ActionOperationScope;
  readonly title: string;
  readonly cancellation: 'supported' | 'unsupported';
  readonly domain: ActionOperationDomainRef;
  readonly reentry: ActionOperationReentry;
  readonly progress?: ActionOperationProgress;
}

export interface UpdateActionOperation {
  readonly expectedRevision: number;
  readonly status?: ActionOperationStatus;
  readonly progress?: ActionOperationProgress;
  readonly errorSummary?: string;
  readonly domain?: ActionOperationDomainRef;
  readonly reentry?: ActionOperationReentry;
}

export type ActionOperationUpdateResult =
  | { readonly kind: 'updated'; readonly operation: ActionOperation }
  | { readonly kind: 'stale'; readonly operation: ActionOperation }
  | { readonly kind: 'terminal'; readonly operation: ActionOperation }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid' };

export interface ActionOperationListOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export type ActionOperationCancellationOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'indeterminate' }
  | { readonly kind: 'refused' };

/** Domain owner returns `cancelled` only after its own durable cancellation fact. */
export interface ActionOperationCancellationAdapter {
  readonly domainKind: ActionOperationDomainRef['kind'];
  cancel(
    operation: ActionOperation,
  ): Promise<ActionOperationCancellationOutcome>;
}

export interface ActionOperationServiceOptions {
  readonly now?: () => Date;
  readonly staleActiveMs?: number;
  readonly cancellationAdapters?: readonly ActionOperationCancellationAdapter[];
}

export class ActionOperationCursorError extends Error {
  constructor() {
    super('Invalid action operation cursor');
    this.name = 'ActionOperationCursorError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  );
}
function integer(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
function validateLedger(value: unknown): ActionOperationLedger {
  if (
    !record(value) ||
    !exactFields(value, [
      'version',
      'creationSequence',
      'changeSequence',
      'records',
    ]) ||
    value.version !== STORE_VERSION ||
    !integer(value.creationSequence, 0) ||
    !integer(value.changeSequence, 0) ||
    !Array.isArray(value.records)
  ) {
    throw new Error('Action operation store is unavailable');
  }
  const records = value.records.map(parseActionOperation);
  if (records.some((operation) => !operation)) {
    throw new Error('Action operation store is unavailable');
  }
  const typed = records as ActionOperation[];
  const ids = new Set<string>();
  const creationSequences = new Set<number>();
  const changeSequences = new Set<number>();
  for (const operation of typed) {
    if (
      ids.has(operation.id) ||
      creationSequences.has(operation.sequence) ||
      changeSequences.has(operation.changeSequence)
    ) {
      throw new Error('Action operation store is unavailable');
    }
    ids.add(operation.id);
    creationSequences.add(operation.sequence);
    changeSequences.add(operation.changeSequence);
  }
  const active = typed.filter(
    (operation) => !isTerminalActionOperation(operation.status),
  );
  const terminals = typed.filter((operation) =>
    isTerminalActionOperation(operation.status),
  );
  if (
    active.length > ACTION_OPERATION_MAX_ACTIVE ||
    terminals.length > ACTION_OPERATION_MAX_RETAINED_TERMINALS ||
    Math.max(0, ...typed.map((operation) => operation.sequence)) >
      value.creationSequence ||
    Math.max(0, ...typed.map((operation) => operation.changeSequence)) >
      value.changeSequence ||
    Buffer.byteLength(JSON.stringify(value)) > ACTION_OPERATION_MAX_STORE_BYTES
  ) {
    throw new Error('Action operation store capacity is invalid');
  }
  return {
    version: STORE_VERSION,
    creationSequence: value.creationSequence,
    changeSequence: value.changeSequence,
    records: typed.map((operation) => structuredClone(operation)),
  };
}
function readLedger(file: string): ActionOperationLedger {
  const value = readJsonFile(file, EMPTY_LEDGER, {
    maxBytes: ACTION_OPERATION_MAX_STORE_BYTES,
    label: 'Action operation store',
  });
  return validateLedger(value);
}
function parseCursor(value: string | undefined, expected: 'list' | 'watch') {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > MAX_CURSOR) {
    throw new ActionOperationCursorError();
  }
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const [version, kind, raw, extra] = decoded.split(':');
    if (
      version !== 'v1' ||
      kind !== expected ||
      extra !== undefined ||
      !/^\d+$/.test(raw ?? '')
    ) {
      throw new ActionOperationCursorError();
    }
    const sequence = Number(raw);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new ActionOperationCursorError();
    }
    return sequence;
  } catch (error) {
    if (error instanceof ActionOperationCursorError) throw error;
    throw new ActionOperationCursorError();
  }
}
function cursorFor(kind: 'list' | 'watch', sequence: number): string {
  return Buffer.from(`v1:${kind}:${sequence}`, 'utf8').toString('base64url');
}
function parseCreateInput(value: unknown): CreateActionOperation | undefined {
  if (!record(value)) return undefined;
  const fields = [
    ...(Object.getOwnPropertyDescriptor(value, 'id') ? ['id'] : []),
    'scope',
    'title',
    'cancellation',
    'domain',
    'reentry',
    ...(Object.getOwnPropertyDescriptor(value, 'progress') ? ['progress'] : []),
  ];
  return exactFields(value, fields)
    ? (value as unknown as CreateActionOperation)
    : undefined;
}
function parseUpdateInput(value: unknown): UpdateActionOperation | undefined {
  if (!record(value)) return undefined;
  const optional = ['status', 'progress', 'errorSummary', 'domain', 'reentry'];
  const fields = [
    'expectedRevision',
    ...optional.filter((field) =>
      Object.getOwnPropertyDescriptor(value, field),
    ),
  ];
  return exactFields(value, fields) && integer(value.expectedRevision, 1)
    ? (value as unknown as UpdateActionOperation)
    : undefined;
}
function sameCreateIdentity(
  operation: ActionOperation,
  input: CreateActionOperation,
): boolean {
  const domainMatches =
    operation.domain.kind === input.domain.kind &&
    (operation.domain.kind === 'session-handoff' &&
    input.domain.kind === 'session-handoff'
      ? operation.domain.sourceSessionId === input.domain.sourceSessionId
      : operation.domain.kind === 'fleet-dispatch' &&
          input.domain.kind === 'fleet-dispatch'
        ? operation.domain.sessionId === input.domain.sessionId &&
          operation.domain.correlationId === input.domain.correlationId
        : JSON.stringify(operation.domain) === JSON.stringify(input.domain));
  return (
    domainMatches &&
    JSON.stringify(operation.scope) === JSON.stringify(input.scope) &&
    operation.title === input.title &&
    operation.cancellation === input.cancellation &&
    (input.domain.kind === 'session-handoff' ||
      JSON.stringify(operation.reentry) === JSON.stringify(input.reentry))
  );
}
function trimTerminals(records: readonly ActionOperation[]) {
  const active = records.filter(
    (operation) => !isTerminalActionOperation(operation.status),
  );
  const terminals = records
    .filter((operation) => isTerminalActionOperation(operation.status))
    .sort((left, right) => right.changeSequence - left.changeSequence)
    .slice(0, ACTION_OPERATION_MAX_RETAINED_TERMINALS);
  return [...active, ...terminals].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export class ActionOperationService {
  readonly #now: () => Date;
  readonly #staleActiveMs: number;
  readonly #cancellationAdapters: ReadonlyMap<
    ActionOperationDomainRef['kind'],
    ActionOperationCancellationAdapter
  >;

  constructor(
    private readonly store: ActionOperationStore,
    options: ActionOperationServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#staleActiveMs = options.staleActiveMs ?? STALE_ACTIVE_MS;
    const adapters = new Map<
      ActionOperationDomainRef['kind'],
      ActionOperationCancellationAdapter
    >();
    for (const adapter of options.cancellationAdapters ?? []) {
      if (adapters.has(adapter.domainKind)) {
        throw new Error('Duplicate action operation cancellation adapter');
      }
      adapters.set(adapter.domainKind, adapter);
    }
    this.#cancellationAdapters = adapters;
  }

  async create(
    actor: ActionOperationActor,
    unsafeInput: CreateActionOperation,
  ): Promise<ActionOperation | undefined> {
    const input = parseCreateInput(unsafeInput);
    if (!input || !(await this.canAccessScope(actor, input.scope)))
      return undefined;
    if (
      input.cancellation === 'supported' &&
      !this.#cancellationAdapters.has(input.domain.kind)
    ) {
      return undefined;
    }
    const id = input.id ?? randomUUID();
    const now = this.#now().toISOString();
    const result = await this.store.transact<ActionOperation | undefined>(
      (ledger) => {
        const existing = ledger.records.find(
          (operation) => operation.id === id,
        );
        if (existing) {
          return {
            result: sameCreateIdentity(existing, input)
              ? structuredClone(existing)
              : undefined,
          };
        }
        const activeCount = ledger.records.filter(
          (operation) => !isTerminalActionOperation(operation.status),
        ).length;
        if (activeCount >= ACTION_OPERATION_MAX_ACTIVE) {
          throw new Error('Action operation active capacity is exhausted');
        }
        const sequence = ledger.creationSequence + 1;
        const changeSequence = ledger.changeSequence + 1;
        const candidate = parseActionOperation({
          schemaVersion: ACTION_OPERATION_SCHEMA_VERSION,
          id,
          sequence,
          changeSequence,
          revision: 1,
          scope: input.scope,
          status: 'accepted',
          title: input.title,
          progress: input.progress ?? { kind: 'indeterminate' },
          cancellation: input.cancellation,
          domain: input.domain,
          reentry: input.reentry,
          acceptedAt: now,
          updatedAt: now,
        });
        if (!candidate) return { result: undefined };
        const next: ActionOperationLedger = {
          version: STORE_VERSION,
          creationSequence: sequence,
          changeSequence,
          records: [...ledger.records, candidate],
        };
        return { result: structuredClone(candidate), next };
      },
    );
    if (result) {
      actionOperationOutcomes.add(1, {
        operation: 'create',
        outcome: 'accepted',
      });
    }
    return result && (await this.canAccess(actor, result)) ? result : undefined;
  }

  async get(actor: ActionOperationActor, id: string) {
    const observed = (await this.store.read()).records.find(
      (candidate) => candidate.id === id,
    );
    if (!observed || !(await this.canAccess(actor, observed))) return undefined;
    await this.reconcileStaleActiveOperations(new Set([id]));
    const operation = (await this.store.read()).records.find(
      (candidate) => candidate.id === id,
    );
    return operation && (await this.canAccess(actor, operation))
      ? structuredClone(operation)
      : undefined;
  }

  async update(
    actor: ActionOperationActor,
    id: string,
    unsafeInput: UpdateActionOperation,
  ): Promise<ActionOperationUpdateResult> {
    const input = parseUpdateInput(unsafeInput);
    if (!input) return { kind: 'invalid' };
    const observed = await this.get(actor, id);
    if (!observed) return { kind: 'not-found' };
    const result = await this.store.transact<ActionOperationUpdateResult>(
      (ledger) => this.updateInTransaction(ledger, id, input),
    );
    if (result.kind === 'updated') {
      actionOperationOutcomes.add(1, {
        operation: 'update',
        outcome: result.operation.status,
      });
    }
    return result;
  }

  async cancel(
    actor: ActionOperationActor,
    id: string,
  ): Promise<
    | { readonly kind: 'cancelled'; readonly operation: ActionOperation }
    | { readonly kind: 'already-terminal'; readonly operation: ActionOperation }
    | { readonly kind: 'unsupported'; readonly operation: ActionOperation }
    | { readonly kind: 'indeterminate'; readonly operation: ActionOperation }
    | { readonly kind: 'refused'; readonly operation: ActionOperation }
    | { readonly kind: 'not-found' }
  > {
    const operation = await this.get(actor, id);
    if (!operation) return { kind: 'not-found' };
    if (isTerminalActionOperation(operation.status)) {
      return { kind: 'already-terminal', operation };
    }
    if (operation.cancellation === 'unsupported') {
      return { kind: 'unsupported', operation };
    }
    const adapter = this.#cancellationAdapters.get(operation.domain.kind);
    if (!adapter) return { kind: 'unsupported', operation };
    let ownerOutcome: ActionOperationCancellationOutcome;
    try {
      ownerOutcome = await adapter.cancel(structuredClone(operation));
    } catch {
      // The domain owner may have crossed its own consequential boundary
      // before its transport/persistence failed. Treat that as possible effect
      // and route to reconciliation; returning the pre-await operation as a
      // harmless refusal would invite an unsafe retry.
      ownerOutcome = { kind: 'indeterminate' };
    }
    const result = await this.store.transact<
      | { kind: 'cancelled'; operation: ActionOperation }
      | { kind: 'already-terminal'; operation: ActionOperation }
      | { kind: 'indeterminate'; operation: ActionOperation }
      | { kind: 'refused'; operation: ActionOperation }
      | { kind: 'not-found' }
    >((ledger) => {
      const current = ledger.records.find((candidate) => candidate.id === id);
      if (!current) return { result: { kind: 'not-found' } };
      if (isTerminalActionOperation(current.status)) {
        return {
          result: {
            kind: 'already-terminal',
            operation: structuredClone(current),
          },
        };
      }
      if (ownerOutcome.kind === 'refused') {
        return {
          result: { kind: 'refused', operation: structuredClone(current) },
        };
      }
      const status =
        ownerOutcome.kind === 'cancelled' ? 'cancelled' : 'running';
      const update = this.updateInTransaction(ledger, id, {
        expectedRevision: current.revision,
        status,
        ...(ownerOutcome.kind === 'indeterminate'
          ? {
              progress: {
                kind: 'phase' as const,
                code: 'reconciliation-required' as const,
              },
            }
          : {}),
      });
      if (update.result.kind !== 'updated') {
        return { result: { kind: 'not-found' } };
      }
      return {
        result: {
          kind:
            ownerOutcome.kind === 'cancelled' ? 'cancelled' : 'indeterminate',
          operation: update.result.operation,
        },
        next: update.next,
      };
    });
    return result;
  }

  async list(
    actor: ActionOperationActor,
    options: ActionOperationListOptions = {},
  ): Promise<ActionOperationPage> {
    const cursor = parseCursor(options.cursor, 'list');
    const limit = Math.max(
      1,
      Math.min(
        options.limit ?? ACTION_OPERATION_MAX_PAGE_SIZE,
        ACTION_OPERATION_MAX_PAGE_SIZE,
      ),
    );
    const visible = await this.visible(actor);
    const candidates = visible
      .filter(
        (operation) => cursor === undefined || operation.sequence < cursor,
      )
      .sort((left, right) => right.sequence - left.sequence);
    const items = candidates.slice(0, limit);
    const tail = items.at(-1);
    return {
      schemaVersion: ACTION_OPERATION_SCHEMA_VERSION,
      items,
      ...(tail && candidates.length > items.length
        ? { nextCursor: cursorFor('list', tail.sequence) }
        : {}),
    };
  }

  async watch(
    actor: ActionOperationActor,
    encodedCursor?: string,
  ): Promise<ActionOperationWatchSnapshot> {
    const cursor = parseCursor(encodedCursor, 'watch');
    const visible = await this.visible(actor);
    const candidates = (
      cursor === undefined
        ? visible.sort((left, right) => right.sequence - left.sequence)
        : visible
            .filter((operation) => operation.changeSequence > cursor)
            .sort((left, right) => left.changeSequence - right.changeSequence)
    ).slice(0, ACTION_OPERATION_MAX_PAGE_SIZE);
    const visibleChangeSequence = Math.max(
      cursor ?? 0,
      ...candidates.map((operation) => operation.changeSequence),
    );
    return {
      schemaVersion: ACTION_OPERATION_SCHEMA_VERSION,
      items: candidates,
      cursor: cursorFor('watch', visibleChangeSequence),
      mode: cursor === undefined ? 'snapshot' : 'delta',
    };
  }

  private updateInTransaction(
    ledger: ActionOperationLedger,
    id: string,
    input: UpdateActionOperation,
  ): ActionOperationTransaction<ActionOperationUpdateResult> {
    const index = ledger.records.findIndex((operation) => operation.id === id);
    const current = ledger.records[index];
    if (!current) return { result: { kind: 'not-found' } };
    if (input.expectedRevision !== current.revision) {
      return { result: { kind: 'stale', operation: structuredClone(current) } };
    }
    if (isTerminalActionOperation(current.status)) {
      return {
        result: { kind: 'terminal', operation: structuredClone(current) },
      };
    }
    const status = input.status ?? current.status;
    if (status === 'accepted' && current.status !== 'accepted') {
      return {
        result: { kind: 'terminal', operation: structuredClone(current) },
      };
    }
    const updatedAt = this.#now().toISOString();
    const changeSequence = ledger.changeSequence + 1;
    const terminal = isTerminalActionOperation(status);
    const candidate = parseActionOperation({
      ...current,
      revision: current.revision + 1,
      changeSequence,
      status,
      ...(input.progress ? { progress: input.progress } : {}),
      ...(input.domain ? { domain: input.domain } : {}),
      ...(input.reentry ? { reentry: input.reentry } : {}),
      ...(status === 'failed' && input.errorSummary
        ? { errorSummary: input.errorSummary }
        : {}),
      updatedAt,
      ...(terminal ? { completedAt: updatedAt } : {}),
    });
    if (!candidate) return { result: { kind: 'invalid' } };
    const records = [...ledger.records];
    records[index] = candidate;
    const next: ActionOperationLedger = {
      ...ledger,
      changeSequence,
      records: trimTerminals(records),
    };
    return {
      result: { kind: 'updated', operation: structuredClone(candidate) },
      next,
    };
  }

  private async visible(actor: ActionOperationActor) {
    const observed = (await this.store.read()).records;
    const visibleIds = new Set(
      (
        await Promise.all(
          observed.map(async (operation) =>
            (await this.canAccess(actor, operation)) ? operation.id : undefined,
          ),
        )
      ).filter((id): id is string => id !== undefined),
    );
    await this.reconcileStaleActiveOperations(visibleIds);
    const records = (await this.store.read()).records;
    const visible = await Promise.all(
      records.map(async (operation) =>
        (await this.canAccess(actor, operation))
          ? structuredClone(operation)
          : undefined,
      ),
    );
    return visible.filter(
      (operation): operation is ActionOperation => operation !== undefined,
    );
  }

  private async canAccessScope(
    actor: ActionOperationActor,
    scope: ActionOperationScope,
  ) {
    if (
      actor.accountId !== scope.accountId ||
      (scope.machineId !== undefined && actor.machineId !== scope.machineId)
    ) {
      return false;
    }
    return (
      scope.sessionId === undefined ||
      (await actor.canReadSession?.(scope.sessionId)) === true
    );
  }

  private canAccess(actor: ActionOperationActor, operation: ActionOperation) {
    return this.canAccessScope(actor, operation.scope);
  }

  /**
   * A stale active operation is not merely a display concern. Persisting its
   * reconciliation-needed transition gives it one new changeSequence, so a
   * reconnecting watcher can observe the same state a fresh list reader sees.
   * The current progress marker makes this idempotent: after one successful
   * transaction, later reads do not keep rewriting the row or moving cursors.
   */
  private async reconcileStaleActiveOperations(
    visibleIds: ReadonlySet<string>,
  ): Promise<void> {
    const observedAt = this.#now();
    const observedAtMs = observedAt.getTime();
    const observedAtIso = observedAt.toISOString();
    await this.store.transact<void>((ledger) => {
      let changeSequence = ledger.changeSequence;
      let changed = false;
      const records = ledger.records.map((operation) => {
        const alreadyReconciliationNeeded =
          operation.progress.kind === 'phase' &&
          operation.progress.code === 'reconciliation-required';
        if (
          !visibleIds.has(operation.id) ||
          isTerminalActionOperation(operation.status) ||
          alreadyReconciliationNeeded ||
          observedAtMs - Date.parse(operation.updatedAt) <= this.#staleActiveMs
        ) {
          return operation;
        }
        const candidate = parseActionOperation({
          ...operation,
          revision: operation.revision + 1,
          changeSequence: ++changeSequence,
          progress: { kind: 'phase', code: 'reconciliation-required' },
          updatedAt: observedAtIso,
        });
        if (!candidate) {
          throw new Error('Unable to reconcile stale action operation');
        }
        changed = true;
        return candidate;
      });
      if (!changed) return { result: undefined };
      return {
        result: undefined,
        next: {
          ...ledger,
          changeSequence,
          records: trimTerminals(records),
        },
      };
    });
  }
}
