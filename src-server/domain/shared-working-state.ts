import { createHash } from 'node:crypto';
import { canonicalizeForDigest } from '@kontourai/station-contracts/fleet-routing-receipt';
import { sharedWorkingStateOperations } from '../telemetry/metrics.js';

/** Station-owned semantics. A transport never supplies a library wire format. */
export const SHARED_WORKING_STATE_SCHEMA_VERSION = 1 as const;
export const SHARED_WORKING_STATE_MECHANISM = {
  name: 'station-rga-reference',
  reason:
    'A small reference implementation makes ordering and recovery executable without adopting a vendor CRDT wire format.',
} as const;
export const DEFAULT_RETAINED_WORKING_STATE_OPERATIONS = 256;
export const DEFAULT_DEFERRED_WORKING_STATE_OPERATIONS = 64;
export const DEFAULT_DEFERRED_WORKING_STATE_BYTES = 65_536;

export type DocumentId = string;
export type ReplicaId = string;
export type ActorId = string;
export type OperationId = string;
export type RevisionId = string;
export type AtomId = string;

export interface WorkingStateScope {
  readonly projectId: string;
  readonly taskId: string;
  readonly documentId: DocumentId;
}

/** Display labels are attribution only; authorization always uses actorId. */
export interface WorkingStateActor {
  readonly actorId: ActorId;
  readonly kind: 'human' | 'agent';
  readonly displayLabel?: string;
}

/** Correlation makes edits explainable but never changes convergence identity. */
export interface WorkingStateAttribution {
  readonly projectId?: string;
  readonly taskId?: string;
  readonly agentSessionId?: string;
  readonly runId?: string;
  readonly proposedChangeId?: string;
  readonly correlationId?: string;
}

interface OperationBase {
  readonly schemaVersion: number;
  readonly operationId: OperationId;
  readonly documentId: DocumentId;
  readonly replicaId: ReplicaId;
  readonly actor: WorkingStateActor;
  readonly parents: readonly OperationId[];
  readonly authorizationEpoch: number;
  readonly attribution?: WorkingStateAttribution;
}

export interface InsertTextOperation extends OperationBase {
  readonly kind: 'insert';
  readonly after: AtomId | null;
  readonly text: string;
}

export interface DeleteTextOperation extends OperationBase {
  readonly kind: 'delete';
  readonly target: readonly AtomId[];
}

export type TextDocumentOperation = InsertTextOperation | DeleteTextOperation;

/** Server-derived authority at the exact current Project/Task/document scope. */
export interface WorkingStateWriteAuthorization {
  readonly scope: WorkingStateScope;
  readonly epoch: number;
  readonly allowedActorIds: ReadonlySet<ActorId>;
}

export type OperationRejectionReason =
  | 'malformed'
  | 'unsupported_version'
  | 'wrong_document'
  | 'unauthorized'
  | 'stale_writer'
  | 'operation_equivocation'
  | 'deferred_limit_exceeded';

export interface DeferredRelease {
  readonly operationId: OperationId;
  readonly outcome: 'applied' | 'rejected';
  readonly reason?: OperationRejectionReason;
}

export type ApplyResult =
  | {
      readonly outcome: 'applied' | 'replayed';
      readonly revision: RevisionId;
      readonly releasedOperationIds: readonly OperationId[];
      readonly released: readonly DeferredRelease[];
    }
  | { readonly outcome: 'duplicate'; readonly revision: RevisionId }
  | {
      readonly outcome: 'deferred';
      readonly revision: RevisionId;
      readonly missing: readonly string[];
    }
  | { readonly outcome: 'rejected'; readonly reason: OperationRejectionReason };

interface Atom {
  readonly id: AtomId;
  readonly after: AtomId | null;
  readonly value: string;
  deleted: boolean;
}

interface KnownOperation {
  readonly operationId: OperationId;
  readonly digest: string;
}

interface DeferredOperation {
  readonly operation: TextDocumentOperation;
  readonly digest: string;
  readonly admission: 'live' | 'trusted';
}

interface AppliedOperation {
  readonly operation: TextDocumentOperation;
  readonly priorRevision: RevisionId;
}

export interface WorkingStateSnapshot {
  readonly schemaVersion: typeof SHARED_WORKING_STATE_SCHEMA_VERSION;
  readonly scope: WorkingStateScope;
  /** A snapshot is a checkpoint of its own exact revision, never a loose hint. */
  readonly checkpointRevision: RevisionId;
  readonly revision: RevisionId;
  readonly atoms: readonly {
    readonly id: AtomId;
    readonly after: AtomId | null;
    readonly value: string;
    readonly deleted: boolean;
  }[];
  readonly knownOperations: readonly KnownOperation[];
  /** Deferred causal work survives snapshot/restore with its admission class. */
  readonly deferred: readonly {
    readonly operation: TextDocumentOperation;
    readonly admission: 'live' | 'trusted';
  }[];
}

export type ResyncResult =
  | {
      readonly outcome: 'delta';
      readonly fromRevision: RevisionId;
      readonly revision: RevisionId;
      readonly operations: readonly TextDocumentOperation[];
    }
  | { readonly outcome: 'snapshot'; readonly snapshot: WorkingStateSnapshot }
  | {
      readonly outcome: 'unsupported_version';
      readonly supportedVersions: readonly number[];
    };

export interface SharedWorkingStateOptions {
  readonly scope: WorkingStateScope;
  readonly snapshot?: WorkingStateSnapshot;
  /** Retained replay payloads; requests cannot widen this local safety bound. */
  readonly maxRetainedOperations?: number;
  /** Hard admission bounds for unready causal work retained in memory/snapshots. */
  readonly maxDeferredOperations?: number;
  readonly maxDeferredBytes?: number;
}

export function negotiateSharedWorkingStateVersion(
  offered: readonly number[],
): number | null {
  return offered.includes(SHARED_WORKING_STATE_SCHEMA_VERSION)
    ? SHARED_WORKING_STATE_SCHEMA_VERSION
    : null;
}

/** Locale-independent UTF-16 code-unit order used by every convergence sort. */
export function compareWorkingStateIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForDigest(value)) ?? 'null')
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function isNonEmpty(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && isWellFormedUnicode(value)
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function stableStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareWorkingStateIds);
}

function atomId(operationId: OperationId, index: number): AtomId {
  return `${operationId}:${index}`;
}

function atomOwner(id: AtomId): OperationId | null {
  const separator = id.lastIndexOf(':');
  if (separator <= 0 || !/^\d+$/.test(id.slice(separator + 1))) return null;
  return id.slice(0, separator);
}

function cloneOperation(
  operation: TextDocumentOperation,
): TextDocumentOperation {
  const common = {
    schemaVersion: operation.schemaVersion,
    operationId: operation.operationId,
    documentId: operation.documentId,
    replicaId: operation.replicaId,
    actor: { ...operation.actor },
    parents: [...operation.parents],
    authorizationEpoch: operation.authorizationEpoch,
    ...(operation.attribution
      ? { attribution: { ...operation.attribution } }
      : {}),
  };
  return operation.kind === 'insert'
    ? {
        ...common,
        kind: 'insert',
        after: operation.after,
        text: operation.text,
      }
    : { ...common, kind: 'delete', target: [...operation.target] };
}

function operationDigest(operation: TextDocumentOperation): string {
  // Display/correlation metadata deliberately do not affect convergence identity.
  return digest(
    operation.kind === 'insert'
      ? {
          schemaVersion: operation.schemaVersion,
          operationId: operation.operationId,
          documentId: operation.documentId,
          replicaId: operation.replicaId,
          actorId: operation.actor.actorId,
          parents: stableStrings(operation.parents),
          authorizationEpoch: operation.authorizationEpoch,
          kind: operation.kind,
          after: operation.after,
          text: operation.text,
        }
      : {
          schemaVersion: operation.schemaVersion,
          operationId: operation.operationId,
          documentId: operation.documentId,
          replicaId: operation.replicaId,
          actorId: operation.actor.actorId,
          parents: stableStrings(operation.parents),
          authorizationEpoch: operation.authorizationEpoch,
          kind: operation.kind,
          target: stableStrings(operation.target),
        },
  );
}

function parseOperation(value: unknown): TextDocumentOperation | null {
  if (!isRecord(value) || !isRecord(value.actor)) return null;
  const actor = value.actor;
  const attribution = value.attribution;
  if (
    value.schemaVersion !== SHARED_WORKING_STATE_SCHEMA_VERSION ||
    !isNonEmpty(value.operationId) ||
    !isNonEmpty(value.documentId) ||
    !isNonEmpty(value.replicaId) ||
    !isNonEmpty(actor.actorId) ||
    (actor.kind !== 'human' && actor.kind !== 'agent') ||
    (actor.displayLabel !== undefined &&
      (typeof actor.displayLabel !== 'string' ||
        !isWellFormedUnicode(actor.displayLabel))) ||
    typeof value.authorizationEpoch !== 'number' ||
    !Number.isSafeInteger(value.authorizationEpoch) ||
    value.authorizationEpoch < 0 ||
    !Array.isArray(value.parents) ||
    value.parents.some((parent) => !isNonEmpty(parent)) ||
    new Set(value.parents).size !== value.parents.length ||
    value.parents.includes(value.operationId) ||
    (attribution !== undefined &&
      (!isRecord(attribution) ||
        Object.values(attribution).some(
          (field) =>
            field !== undefined &&
            (typeof field !== 'string' || !isWellFormedUnicode(field)),
        )))
  ) {
    return null;
  }
  const common = {
    schemaVersion: value.schemaVersion,
    operationId: value.operationId,
    documentId: value.documentId,
    replicaId: value.replicaId,
    actor: {
      actorId: actor.actorId,
      kind: actor.kind,
      ...(actor.displayLabel === undefined
        ? {}
        : { displayLabel: actor.displayLabel }),
    } as WorkingStateActor,
    parents: [...value.parents] as string[],
    authorizationEpoch: value.authorizationEpoch,
    ...(attribution === undefined
      ? {}
      : { attribution: { ...attribution } as WorkingStateAttribution }),
  };
  if (value.kind === 'insert') {
    return typeof value.text === 'string' &&
      value.text.length > 0 &&
      isWellFormedUnicode(value.text) &&
      (value.after === null ||
        (isNonEmpty(value.after) &&
          atomOwner(value.after) !== value.operationId))
      ? { ...common, kind: 'insert', after: value.after, text: value.text }
      : null;
  }
  return value.kind === 'delete' &&
    Array.isArray(value.target) &&
    value.target.length > 0 &&
    value.target.every(isNonEmpty) &&
    new Set(value.target).size === value.target.length &&
    value.target.every((target) => atomOwner(target) !== value.operationId)
    ? { ...common, kind: 'delete', target: [...value.target] }
    : null;
}

function validScope(value: unknown): value is WorkingStateScope {
  return (
    isRecord(value) &&
    isNonEmpty(value.projectId) &&
    isNonEmpty(value.taskId) &&
    isNonEmpty(value.documentId)
  );
}

function validAuthorization(
  value: unknown,
): value is WorkingStateWriteAuthorization {
  return (
    isRecord(value) &&
    validScope(value.scope) &&
    typeof value.epoch === 'number' &&
    Number.isSafeInteger(value.epoch) &&
    value.epoch >= 0 &&
    value.allowedActorIds instanceof Set
  );
}

/**
 * Private shared implementation behind distinct live and recovery capabilities.
 */
class SharedWorkingStateCore {
  readonly #scope: WorkingStateScope;
  readonly #atoms = new Map<AtomId, Atom>();
  readonly #knownOperations = new Map<OperationId, string>();
  readonly #deferred = new Map<OperationId, DeferredOperation>();
  readonly #maxRetainedOperations: number;
  readonly #maxDeferredOperations: number;
  readonly #maxDeferredBytes: number;
  #deferredBytes = 0;
  #history: AppliedOperation[] = [];
  #revision: RevisionId | undefined;
  /** Earliest revision from which retained operation deltas may be complete. */
  #replayCheckpointRevision: RevisionId;

  constructor(options: SharedWorkingStateOptions) {
    if (!isRecord(options) || !validScope(options.scope))
      throw new Error('shared working-state scope is malformed');
    this.#scope = { ...options.scope };
    this.#maxRetainedOperations =
      options.maxRetainedOperations ??
      DEFAULT_RETAINED_WORKING_STATE_OPERATIONS;
    this.#maxDeferredOperations =
      options.maxDeferredOperations ??
      DEFAULT_DEFERRED_WORKING_STATE_OPERATIONS;
    this.#maxDeferredBytes =
      options.maxDeferredBytes ?? DEFAULT_DEFERRED_WORKING_STATE_BYTES;
    if (
      !Number.isSafeInteger(this.#maxRetainedOperations) ||
      this.#maxRetainedOperations < 0
    ) {
      throw new Error(
        'shared working-state retained-operation limit is malformed',
      );
    }
    if (
      !Number.isSafeInteger(this.#maxDeferredOperations) ||
      this.#maxDeferredOperations < 0 ||
      !Number.isSafeInteger(this.#maxDeferredBytes) ||
      this.#maxDeferredBytes < 0
    ) {
      throw new Error('shared working-state deferred limits are malformed');
    }
    if (options.snapshot) this.#restore(options.snapshot);
    this.#replayCheckpointRevision = this.revision;
  }

  get scope(): WorkingStateScope {
    return { ...this.#scope };
  }

  get revision(): RevisionId {
    if (this.#revision) return this.#revision;
    this.#revision = `swsr-v1:${digest({
      schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
      documentId: this.#scope.documentId,
      atoms: [...this.#atoms.values()]
        .map((atom) => ({ ...atom }))
        .sort((left, right) => compareWorkingStateIds(left.id, right.id)),
      knownOperations: this.#knownOperationProjection(),
      deferredOperations: this.#deferredProjection(),
    })}`;
    return this.#revision;
  }

  text(): string {
    const children = new Map<AtomId | null, Atom[]>();
    for (const atom of this.#atoms.values()) {
      const siblings = children.get(atom.after) ?? [];
      siblings.push(atom);
      children.set(atom.after, siblings);
    }
    for (const siblings of children.values())
      siblings.sort((left, right) => compareWorkingStateIds(left.id, right.id));
    const output: string[] = [];
    const stack = [...(children.get(null) ?? [])].reverse();
    while (stack.length > 0) {
      const atom = stack.pop()!;
      if (!atom.deleted) output.push(atom.value);
      const descendants = children.get(atom.id) ?? [];
      for (let index = descendants.length - 1; index >= 0; index -= 1)
        stack.push(descendants[index]);
    }
    return output.join('');
  }

  apply(operation: unknown, authorization: unknown): ApplyResult {
    if (
      isRecord(operation) &&
      typeof operation.schemaVersion === 'number' &&
      operation.schemaVersion !== SHARED_WORKING_STATE_SCHEMA_VERSION
    ) {
      return this.#record({
        outcome: 'rejected',
        reason: 'unsupported_version',
      });
    }
    const parsed = parseOperation(operation);
    if (!parsed)
      return this.#record({ outcome: 'rejected', reason: 'malformed' });
    const rejection = this.#liveRejection(parsed, authorization);
    if (rejection)
      return this.#record({ outcome: 'rejected', reason: rejection });
    return this.#admit(
      parsed,
      'live',
      authorization as WorkingStateWriteAuthorization,
    );
  }

  replay(operation: unknown, liveAuthorization?: unknown): ApplyResult {
    if (
      isRecord(operation) &&
      typeof operation.schemaVersion === 'number' &&
      operation.schemaVersion !== SHARED_WORKING_STATE_SCHEMA_VERSION
    ) {
      return this.#record({
        outcome: 'rejected',
        reason: 'unsupported_version',
      });
    }
    const parsed = parseOperation(operation);
    if (!parsed)
      return this.#record({ outcome: 'rejected', reason: 'malformed' });
    if (parsed.documentId !== this.#scope.documentId)
      return this.#record({ outcome: 'rejected', reason: 'wrong_document' });
    return this.#admit(
      parsed,
      'trusted',
      validAuthorization(liveAuthorization) ? liveAuthorization : undefined,
    );
  }

  reconcile(currentLiveAuthorization?: unknown): readonly DeferredRelease[] {
    return this.#reconcileDeferred(
      validAuthorization(currentLiveAuthorization)
        ? currentLiveAuthorization
        : undefined,
    );
  }

  resync(
    afterRevision: RevisionId | null,
    maxOperations: number,
    offeredVersions: readonly number[],
  ): ResyncResult {
    if (negotiateSharedWorkingStateVersion(offeredVersions) === null) {
      this.#telemetry('resync', 'unsupported_version');
      return { outcome: 'unsupported_version', supportedVersions: [1] };
    }
    if (
      afterRevision === null ||
      !Number.isSafeInteger(maxOperations) ||
      maxOperations < 0
    )
      return this.#snapshotResync();
    if (afterRevision === this.revision) {
      this.#telemetry('resync', 'delta');
      return {
        outcome: 'delta',
        fromRevision: afterRevision,
        revision: this.revision,
        operations: [],
      };
    }
    if (
      afterRevision !== this.#replayCheckpointRevision &&
      this.#history.length === 0
    ) {
      return this.#snapshotResync();
    }
    const start = this.#history.findIndex(
      (entry) => entry.priorRevision === afterRevision,
    );
    if (start < 0 || this.#history.length - start > maxOperations)
      return this.#snapshotResync();
    this.#telemetry('resync', 'delta');
    return {
      outcome: 'delta',
      fromRevision: afterRevision,
      revision: this.revision,
      operations: this.#history
        .slice(start)
        .map((entry) => cloneOperation(entry.operation)),
    };
  }

  /** Drops only bounded delta payloads; snapshot preserves all deferred work. */
  compact(): WorkingStateSnapshot {
    this.#history = [];
    this.#replayCheckpointRevision = this.revision;
    this.#telemetry('compact', 'applied');
    return this.snapshot();
  }

  snapshot(): WorkingStateSnapshot {
    const revision = this.revision;
    return {
      schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
      scope: { ...this.#scope },
      checkpointRevision: revision,
      revision,
      atoms: [...this.#atoms.values()]
        .map((atom) => ({ ...atom }))
        .sort((left, right) => compareWorkingStateIds(left.id, right.id)),
      knownOperations: this.#knownOperationProjection(),
      deferred: [...this.#deferred.values()]
        .sort((left, right) =>
          compareWorkingStateIds(
            left.operation.operationId,
            right.operation.operationId,
          ),
        )
        .map((entry) => ({
          operation: cloneOperation(entry.operation),
          admission: entry.admission,
        })),
    };
  }

  #admit(
    operation: TextDocumentOperation,
    admission: 'live' | 'trusted',
    authorization?: WorkingStateWriteAuthorization,
  ): ApplyResult {
    const cloned = cloneOperation(operation);
    const operationHash = operationDigest(cloned);
    const deferred = this.#deferred.get(cloned.operationId);
    const existing =
      this.#knownOperations.get(cloned.operationId) ?? deferred?.digest;
    if (existing) {
      if (
        admission === 'trusted' &&
        deferred?.admission === 'live' &&
        existing === operationHash
      ) {
        // A source delta is authority to settle the same locally deferred
        // payload. Promotion changes revision state before unified drain.
        this.#deferred.set(cloned.operationId, {
          ...deferred,
          admission: 'trusted',
        });
        this.#invalidateRevision();
        const released = this.#reconcileDeferred(authorization);
        return this.#record({
          outcome: 'replayed',
          revision: this.revision,
          releasedOperationIds: released
            .filter((entry) => entry.outcome === 'applied')
            .map((entry) => entry.operationId),
          released,
        });
      }
      return this.#record(
        existing === operationHash
          ? { outcome: 'duplicate', revision: this.revision }
          : { outcome: 'rejected', reason: 'operation_equivocation' },
      );
    }
    const missing = this.#missing(cloned);
    if (missing.length > 0) {
      if (!this.#defer(cloned, operationHash, admission)) {
        return this.#record({
          outcome: 'rejected',
          reason: 'deferred_limit_exceeded',
        });
      }
      return this.#record({
        outcome: 'deferred',
        revision: this.revision,
        missing,
      });
    }
    this.#applyReady(cloned, operationHash);
    const released = this.#reconcileDeferred(authorization);
    // Rejected live deferred work is a current-grant settlement, not an
    // authoritative operation. Never advertise a delta that omits it.
    if (released.some((entry) => entry.outcome === 'rejected')) {
      this.#history = [];
      this.#replayCheckpointRevision = this.revision;
    }
    return this.#record({
      outcome: admission === 'trusted' ? 'replayed' : 'applied',
      revision: this.revision,
      releasedOperationIds: released
        .filter((entry) => entry.outcome === 'applied')
        .map((entry) => entry.operationId),
      released,
    });
  }

  #liveRejection(
    operation: TextDocumentOperation,
    authorization: unknown,
  ): OperationRejectionReason | null {
    if (!validAuthorization(authorization)) return 'unauthorized';
    if (operation.documentId !== this.#scope.documentId)
      return 'wrong_document';
    if (
      authorization.scope.documentId !== this.#scope.documentId ||
      authorization.scope.projectId !== this.#scope.projectId ||
      authorization.scope.taskId !== this.#scope.taskId ||
      !authorization.allowedActorIds.has(operation.actor.actorId)
    )
      return 'unauthorized';
    return operation.authorizationEpoch === authorization.epoch
      ? null
      : 'stale_writer';
  }

  #missing(operation: TextDocumentOperation): string[] {
    const missing = operation.parents.filter(
      (parent) => !this.#knownOperations.has(parent),
    );
    if (
      operation.kind === 'insert' &&
      operation.after &&
      !this.#atoms.has(operation.after)
    )
      missing.push(operation.after);
    if (operation.kind === 'delete')
      missing.push(
        ...operation.target.filter((target) => !this.#atoms.has(target)),
      );
    return stableStrings(missing);
  }

  #applyReady(operation: TextDocumentOperation, operationHash: string): void {
    const priorRevision = this.revision;
    if (operation.kind === 'insert') {
      let after = operation.after;
      for (const [index, value] of [...operation.text].entries()) {
        const id = atomId(operation.operationId, index);
        this.#atoms.set(id, { id, after, value, deleted: false });
        after = id;
      }
    } else
      for (const target of operation.target)
        this.#atoms.get(target)!.deleted = true;
    this.#knownOperations.set(operation.operationId, operationHash);
    this.#invalidateRevision();
    this.#history.push({ operation: cloneOperation(operation), priorRevision });
    if (this.#history.length > this.#maxRetainedOperations)
      this.#history.shift();
  }

  #defer(
    operation: TextDocumentOperation,
    operationHash: string,
    admission: 'live' | 'trusted',
  ): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(operation), 'utf8');
    if (
      this.#deferred.size >= this.#maxDeferredOperations ||
      bytes > this.#maxDeferredBytes - this.#deferredBytes
    ) {
      return false;
    }
    this.#deferred.set(operation.operationId, {
      operation,
      digest: operationHash,
      admission,
    });
    this.#invalidateRevision();
    this.#deferredBytes += bytes;
    return true;
  }

  #removeDeferred(operationId: OperationId): DeferredOperation {
    const entry = this.#deferred.get(operationId)!;
    this.#deferred.delete(operationId);
    this.#invalidateRevision();
    this.#deferredBytes -= Buffer.byteLength(
      JSON.stringify(entry.operation),
      'utf8',
    );
    return entry;
  }

  #reconcileDeferred(
    liveAuthorization?: WorkingStateWriteAuthorization,
  ): DeferredRelease[] {
    const released: DeferredRelease[] = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const entry of this.#orderedDeferred()) {
        if (entry.admission === 'live') {
          // A recovery replay without a current grant leaves ready live work
          // explicitly pending; snapshot/restore preserves that state.
          if (!liveAuthorization) continue;
          const rejection = this.#liveRejection(
            entry.operation,
            liveAuthorization,
          );
          if (rejection) {
            this.#removeDeferred(entry.operation.operationId);
            released.push({
              operationId: entry.operation.operationId,
              outcome: 'rejected',
              reason: rejection,
            });
            progressed = true;
            continue;
          }
        }
        if (this.#missing(entry.operation).length > 0) continue;
        this.#removeDeferred(entry.operation.operationId);
        this.#applyReady(entry.operation, entry.digest);
        released.push({
          operationId: entry.operation.operationId,
          outcome: 'applied',
        });
        progressed = true;
      }
    }
    return released;
  }

  #orderedDeferred(): DeferredOperation[] {
    return [...this.#deferred.values()].sort((left, right) =>
      compareWorkingStateIds(
        left.operation.operationId,
        right.operation.operationId,
      ),
    );
  }

  #knownOperationProjection(): KnownOperation[] {
    return [...this.#knownOperations.entries()]
      .map(([operationId, operationDigest]) => ({
        operationId,
        digest: operationDigest,
      }))
      .sort((left, right) =>
        compareWorkingStateIds(left.operationId, right.operationId),
      );
  }

  #deferredProjection(): readonly {
    operationId: OperationId;
    digest: string;
    admission: 'live' | 'trusted';
  }[] {
    return [...this.#deferred.values()]
      .map((entry) => ({
        operationId: entry.operation.operationId,
        digest: entry.digest,
        admission: entry.admission,
      }))
      .sort((left, right) =>
        compareWorkingStateIds(left.operationId, right.operationId),
      );
  }

  #snapshotResync(): ResyncResult {
    this.#telemetry('resync', 'snapshot');
    return { outcome: 'snapshot', snapshot: this.snapshot() };
  }

  #record(result: ApplyResult): ApplyResult {
    this.#telemetry('apply', result.outcome);
    return result;
  }

  #telemetry(operation: 'apply' | 'resync' | 'compact', outcome: string): void {
    sharedWorkingStateOperations.add(1, { operation, outcome });
  }

  #invalidateRevision(): void {
    this.#revision = undefined;
  }

  #restore(snapshot: unknown): void {
    this.#invalidateRevision();
    if (
      !isRecord(snapshot) ||
      snapshot.schemaVersion !== SHARED_WORKING_STATE_SCHEMA_VERSION ||
      !validScope(snapshot.scope) ||
      snapshot.scope.documentId !== this.#scope.documentId ||
      snapshot.scope.projectId !== this.#scope.projectId ||
      snapshot.scope.taskId !== this.#scope.taskId ||
      !isNonEmpty(snapshot.revision) ||
      snapshot.checkpointRevision !== snapshot.revision ||
      !Array.isArray(snapshot.atoms) ||
      !Array.isArray(snapshot.knownOperations) ||
      !Array.isArray(snapshot.deferred)
    )
      throw new Error('shared working-state snapshot is malformed');
    const atomIds = new Set<string>();
    for (const rawAtom of snapshot.atoms) {
      if (
        !isRecord(rawAtom) ||
        !isNonEmpty(rawAtom.id) ||
        (rawAtom.after !== null && !isNonEmpty(rawAtom.after)) ||
        typeof rawAtom.value !== 'string' ||
        !isWellFormedUnicode(rawAtom.value) ||
        [...rawAtom.value].length !== 1 ||
        typeof rawAtom.deleted !== 'boolean' ||
        atomIds.has(rawAtom.id)
      )
        throw new Error('shared working-state snapshot is malformed');
      atomIds.add(rawAtom.id);
      this.#atoms.set(rawAtom.id, {
        id: rawAtom.id,
        after: rawAtom.after,
        value: rawAtom.value,
        deleted: rawAtom.deleted,
      });
    }
    const colors = new Map<AtomId, 'visiting' | 'visited'>();
    for (const atom of this.#atoms.values()) {
      if (atom.after !== null && !this.#atoms.has(atom.after)) {
        throw new Error(
          'shared working-state snapshot lacks predecessor closure',
        );
      }
      if (colors.get(atom.id) === 'visited') continue;
      const path: AtomId[] = [];
      for (
        let cursor: AtomId | null = atom.id;
        cursor !== null;
        cursor = this.#atoms.get(cursor)!.after
      ) {
        if (colors.get(cursor) === 'visiting') {
          throw new Error(
            'shared working-state snapshot has cyclic predecessors',
          );
        }
        if (colors.get(cursor) === 'visited') break;
        colors.set(cursor, 'visiting');
        path.push(cursor);
      }
      for (const id of path) colors.set(id, 'visited');
    }
    for (const rawKnown of snapshot.knownOperations) {
      if (
        !isRecord(rawKnown) ||
        !isNonEmpty(rawKnown.operationId) ||
        !isDigest(rawKnown.digest) ||
        this.#knownOperations.has(rawKnown.operationId)
      )
        throw new Error(
          'shared working-state snapshot has invalid known operations',
        );
      this.#knownOperations.set(rawKnown.operationId, rawKnown.digest);
    }
    for (const atom of this.#atoms.values()) {
      const owner = atomOwner(atom.id);
      if (!owner || !this.#knownOperations.has(owner))
        throw new Error(
          'shared working-state snapshot atom lacks known operation',
        );
    }
    for (const rawDeferred of snapshot.deferred) {
      if (
        !isRecord(rawDeferred) ||
        (rawDeferred.admission !== 'live' &&
          rawDeferred.admission !== 'trusted')
      )
        throw new Error(
          'shared working-state snapshot has malformed deferred operation',
        );
      const operation = parseOperation(rawDeferred.operation);
      if (
        !operation ||
        operation.documentId !== this.#scope.documentId ||
        this.#knownOperations.has(operation.operationId) ||
        this.#deferred.has(operation.operationId)
      )
        throw new Error(
          'shared working-state snapshot has invalid deferred operation',
        );
      if (
        rawDeferred.admission === 'trusted' &&
        this.#missing(operation).length === 0
      )
        throw new Error(
          'shared working-state snapshot retains ready deferred operation',
        );
      if (
        !this.#defer(
          operation,
          operationDigest(operation),
          rawDeferred.admission,
        )
      ) {
        throw new Error(
          'shared working-state snapshot exceeds deferred limits',
        );
      }
    }
    if (snapshot.revision !== this.revision)
      throw new Error('shared working-state snapshot revision is not provable');
  }
}

/** The only port ordinary writers receive. It has no recovery operation. */
export interface SharedWorkingStateLivePort {
  readonly scope: WorkingStateScope;
  readonly revision: RevisionId;
  text(): string;
  apply(operation: unknown, authorization: unknown): ApplyResult;
  resync(
    afterRevision: RevisionId | null,
    maxOperations: number,
    offeredVersions: readonly number[],
  ): ResyncResult;
  compact(): WorkingStateSnapshot;
  snapshot(): WorkingStateSnapshot;
}

/** Adapter-owned capability for already-admitted authoritative recovery facts. */
export interface SharedWorkingStateRecoveryPort {
  replay(operation: unknown, currentLiveAuthorization?: unknown): ApplyResult;
  reconcile(currentLiveAuthorization?: unknown): readonly DeferredRelease[];
}

export interface SharedWorkingStatePorts {
  readonly live: SharedWorkingStateLivePort;
  readonly recovery: SharedWorkingStateRecoveryPort;
}

class LiveWorkingStatePort implements SharedWorkingStateLivePort {
  readonly #core: SharedWorkingStateCore;

  constructor(core: SharedWorkingStateCore) {
    this.#core = core;
  }

  get scope(): WorkingStateScope {
    return this.#core.scope;
  }
  get revision(): RevisionId {
    return this.#core.revision;
  }
  text(): string {
    return this.#core.text();
  }
  apply(operation: unknown, authorization: unknown): ApplyResult {
    return this.#core.apply(operation, authorization);
  }
  resync(
    afterRevision: RevisionId | null,
    maxOperations: number,
    offeredVersions: readonly number[],
  ): ResyncResult {
    return this.#core.resync(afterRevision, maxOperations, offeredVersions);
  }
  compact(): WorkingStateSnapshot {
    return this.#core.compact();
  }
  snapshot(): WorkingStateSnapshot {
    return this.#core.snapshot();
  }
}

/** Convenience live-only construction for callers that do not compose recovery. */
export class SharedWorkingState extends LiveWorkingStatePort {
  constructor(options: SharedWorkingStateOptions) {
    super(new SharedWorkingStateCore(options));
  }
}

/**
 * Composition seam: persistence/transport keeps `recovery` private and gives
 * editor/UI callers only `live`. The ports share one convergence authority.
 */
export function createSharedWorkingState(
  options: SharedWorkingStateOptions,
): SharedWorkingStatePorts {
  const core = new SharedWorkingStateCore(options);
  return {
    live: new LiveWorkingStatePort(core),
    recovery: {
      replay: (operation, currentLiveAuthorization) =>
        core.replay(operation, currentLiveAuthorization),
      reconcile: (currentLiveAuthorization) =>
        core.reconcile(currentLiveAuthorization),
    },
  };
}
