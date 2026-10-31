import { createHash } from 'node:crypto';
import { canonicalizeForDigest } from '@kontourai/station-contracts/fleet-routing-receipt';
import { sharedWorkingStateOperations } from '../telemetry/metrics.js';
import { isRecord } from '../utils/is-record.js';

/**
 * Station-owned semantics. A transport never supplies a library wire format:
 * this small RGA reference implementation makes ordering and recovery
 * executable without adopting a vendor CRDT wire format.
 */
export const SHARED_WORKING_STATE_SCHEMA_VERSION = 2 as const;
export const MAX_WORKING_STATE_SNAPSHOT_BYTES = 512 * 1024;
export const DEFAULT_RETAINED_WORKING_STATE_OPERATIONS = 256;
const DEFAULT_DEFERRED_WORKING_STATE_OPERATIONS = 64;
const DEFAULT_DEFERRED_WORKING_STATE_BYTES = 65_536;

type DocumentId = string;
type ReplicaId = string;
type ActorId = string;
type OperationId = string;
export type RevisionId = string;
type AtomId = string;

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

interface DeleteTextOperation extends OperationBase {
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

type OperationRejectionReason =
  | 'malformed'
  | 'unsupported_version'
  | 'wrong_document'
  | 'unauthorized'
  | 'stale_writer'
  | 'operation_equivocation'
  | 'deferred_limit_exceeded';

interface DeferredRelease {
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

interface WorkingStateSnapshotBase {
  readonly scope: WorkingStateScope;
  /** A snapshot is a checkpoint of its own exact revision, never a loose hint. */
  readonly checkpointRevision: RevisionId;
  readonly revision: RevisionId;
  readonly knownOperations: readonly KnownOperation[];
  /** Deferred causal work survives snapshot/restore with its admission class. */
  readonly deferred: readonly {
    readonly operation: TextDocumentOperation;
    readonly admission: 'live' | 'trusted';
  }[];
}

/** v1 is retained verbatim until the next accepted mutation, including old receipts. */
export type WorkingStateSnapshot = WorkingStateSnapshotBase &
  (
    | {
        readonly schemaVersion: 1;
        readonly atoms: readonly {
          readonly id: AtomId;
          readonly after: AtomId | null;
          readonly value: string;
          readonly deleted: boolean;
        }[];
      }
    | { readonly schemaVersion: 2; readonly runs: readonly TextRun[] }
  );

type ResyncResult =
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

interface SharedWorkingStateOptions {
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
    (value.schemaVersion !== 1 &&
      value.schemaVersion !== SHARED_WORKING_STATE_SCHEMA_VERSION) ||
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

/** Contiguous scalar positions from one insert; null text is a deleted range. */
interface TextRun {
  readonly operationId: OperationId;
  readonly start: number;
  readonly after: AtomId | null;
  readonly length: number;
  readonly text: string | null;
}

function atomPosition(
  id: string,
): { operationId: string; index: number } | null {
  const operationId = atomOwner(id);
  if (!operationId) return null;
  const index = Number(id.slice(operationId.length + 1));
  return Number.isSafeInteger(index) &&
    index >= 0 &&
    atomId(operationId, index) === id
    ? { operationId, index }
    : null;
}

function runId(run: TextRun): string {
  return atomId(run.operationId, run.start);
}

function normalizeRuns(runs: readonly TextRun[]): TextRun[] {
  const result: TextRun[] = [];
  for (const run of [...runs].sort(
    (a, b) =>
      compareWorkingStateIds(a.operationId, b.operationId) || a.start - b.start,
  )) {
    const prior = result.at(-1);
    if (
      prior &&
      prior.operationId === run.operationId &&
      prior.start + prior.length === run.start &&
      run.after === atomId(prior.operationId, run.start - 1) &&
      (prior.text === null) === (run.text === null)
    ) {
      result[result.length - 1] = {
        ...prior,
        length: prior.length + run.length,
        text: prior.text === null ? null : prior.text + run.text,
      };
    } else result.push({ ...run });
  }
  return result;
}

function atomRuns(atoms: readonly Atom[]): TextRun[] {
  return normalizeRuns(
    atoms.map((atom) => {
      const position = atomPosition(atom.id);
      if (!position)
        throw new Error('shared working-state atom id is malformed');
      return {
        operationId: position.operationId,
        start: position.index,
        after: atom.after,
        length: 1,
        text: atom.deleted ? null : atom.value,
      };
    }),
  );
}

function containingRun(
  runs: readonly TextRun[],
  index: number,
): TextRun | undefined {
  // Runs within an insertion are sorted and non-overlapping.
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const run = runs[middle];
    if (index < run.start) high = middle - 1;
    else if (index >= run.start + run.length) low = middle + 1;
    else return run;
  }
  return undefined;
}

function runSlice(
  run: TextRun,
  start: number,
  end: number,
  scalars?: readonly string[],
): TextRun {
  return {
    operationId: run.operationId,
    start,
    after: start === run.start ? run.after : atomId(run.operationId, start - 1),
    length: end - start,
    text:
      run.text === null
        ? null
        : (scalars ?? [...run.text])
            .slice(start - run.start, end - run.start)
            .join(''),
  };
}

/** Split only at branch anchors, so even huge tombstone ranges need no atom expansion. */
function orderedRuns(runs: readonly TextRun[]): TextRun[] {
  const boundaries = new Map<string, Set<number>>();
  for (const run of runs) {
    if (run.after === null) continue;
    const position = atomPosition(run.after)!;
    const offsets = boundaries.get(position.operationId) ?? new Set<number>();
    offsets.add(position.index + 1);
    boundaries.set(position.operationId, offsets);
  }
  const children = new Map<string | null, TextRun[]>();
  for (const run of runs) {
    const cuts = [...(boundaries.get(run.operationId) ?? [])]
      .filter((offset) => offset > run.start && offset < run.start + run.length)
      .sort((a, b) => a - b);
    const scalars = run.text === null ? undefined : [...run.text];
    let start = run.start;
    for (const end of [...cuts, run.start + run.length]) {
      const part = runSlice(run, start, end, scalars);
      const siblings = children.get(part.after) ?? [];
      siblings.push(part);
      children.set(part.after, siblings);
      start = end;
    }
  }
  for (const siblings of children.values())
    siblings.sort((a, b) => compareWorkingStateIds(runId(a), runId(b)));
  const stack = [...(children.get(null) ?? [])].reverse();
  const result: TextRun[] = [];
  while (stack.length > 0) {
    const run = stack.pop()!;
    result.push(run);
    const descendants =
      children.get(atomId(run.operationId, run.start + run.length - 1)) ?? [];
    for (let index = descendants.length - 1; index >= 0; index -= 1)
      stack.push(descendants[index]);
  }
  return result;
}

/** Ordered visible scalar identities for the editor; tombstones remain private. */
export function* workingStateVisibleAtoms(
  snapshot: WorkingStateSnapshot,
): Generator<{ readonly id: string; readonly value: string }> {
  const runs =
    snapshot.schemaVersion === 1 ? atomRuns(snapshot.atoms) : snapshot.runs;
  for (const run of orderedRuns(runs)) {
    if (run.text === null) continue;
    let index = run.start;
    for (const value of run.text)
      yield { id: atomId(run.operationId, index++), value };
  }
}

/**
 * Private shared implementation behind distinct live and recovery capabilities.
 */
class SharedWorkingStateCore {
  readonly #scope: WorkingStateScope;
  readonly #runs = new Map<OperationId, TextRun[]>();
  #legacyAtoms: readonly Atom[] | undefined;
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
    const schemaVersion = this.#legacyAtoms ? 1 : 2;
    this.#revision = `swsr-v${schemaVersion}:${digest({
      schemaVersion,
      documentId: this.#scope.documentId,
      ...(this.#legacyAtoms
        ? { atoms: this.#legacyAtoms }
        : { runs: this.#runProjection() }),
      knownOperations: this.#knownOperationProjection(),
      deferredOperations: this.#deferredProjection(),
    })}`;
    return this.#revision;
  }

  text(): string {
    return orderedRuns(this.#runProjection())
      .map((run) => run.text ?? '')
      .join('');
  }

  #runProjection(): TextRun[] {
    return normalizeRuns([...this.#runs.values()].flat());
  }

  #hasAtom(id: AtomId): boolean {
    const position = atomPosition(id);
    return (
      position !== null &&
      containingRun(
        this.#runs.get(position.operationId) ?? [],
        position.index,
      ) !== undefined
    );
  }

  #upgrade(): void {
    this.#legacyAtoms = undefined;
  }

  apply(operation: unknown, authorization: unknown): ApplyResult {
    if (
      isRecord(operation) &&
      typeof operation.schemaVersion === 'number' &&
      operation.schemaVersion !== 1 &&
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
      operation.schemaVersion !== 1 &&
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
      return {
        outcome: 'unsupported_version',
        supportedVersions: [SHARED_WORKING_STATE_SCHEMA_VERSION],
      };
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
    for (const [owner, runs] of this.#runs)
      this.#runs.set(owner, normalizeRuns(runs));
    this.#history = [];
    this.#replayCheckpointRevision = this.revision;
    this.#telemetry('compact', 'applied');
    return this.snapshot();
  }

  snapshot(): WorkingStateSnapshot {
    const revision = this.revision;
    return {
      ...(this.#legacyAtoms
        ? {
            schemaVersion: 1 as const,
            atoms: this.#legacyAtoms.map((atom) => ({ ...atom })),
          }
        : { schemaVersion: 2 as const, runs: this.#runProjection() }),
      scope: { ...this.#scope },
      checkpointRevision: revision,
      revision,
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
        this.#upgrade();
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
      !this.#hasAtom(operation.after)
    )
      missing.push(operation.after);
    if (operation.kind === 'delete')
      missing.push(
        ...operation.target.filter((target) => !this.#hasAtom(target)),
      );
    return stableStrings(missing);
  }

  #applyReady(operation: TextDocumentOperation, operationHash: string): void {
    const priorRevision = this.revision;
    this.#upgrade();
    if (operation.kind === 'insert') {
      this.#runs.set(operation.operationId, [
        {
          operationId: operation.operationId,
          start: 0,
          after: operation.after,
          length: [...operation.text].length,
          text: operation.text,
        },
      ]);
    } else {
      const targets = new Map<OperationId, Set<number>>();
      for (const target of operation.target) {
        const position = atomPosition(target)!;
        const indices = targets.get(position.operationId) ?? new Set<number>();
        indices.add(position.index);
        targets.set(position.operationId, indices);
      }
      for (const [owner, indices] of targets) {
        const changed: TextRun[] = [];
        const sorted = [...indices].sort((a, b) => a - b);
        for (const run of this.#runs.get(owner)!) {
          const deleted = sorted.filter(
            (index) => index >= run.start && index < run.start + run.length,
          );
          if (run.text === null || deleted.length === 0) {
            changed.push(run);
            continue;
          }
          const scalars = [...run.text];
          let start = run.start;
          for (let cursor = 0; cursor < deleted.length; ) {
            const first = deleted[cursor];
            if (start < first)
              changed.push(runSlice(run, start, first, scalars));
            let end = first + 1;
            while (++cursor < deleted.length && deleted[cursor] === end) end++;
            changed.push({ ...runSlice(run, first, end, scalars), text: null });
            start = end;
          }
          if (start < run.start + run.length)
            changed.push(runSlice(run, start, run.start + run.length, scalars));
        }
        this.#runs.set(owner, normalizeRuns(changed));
      }
    }
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
    this.#upgrade();
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
    this.#upgrade();
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
      (snapshot.schemaVersion !== 1 && snapshot.schemaVersion !== 2) ||
      !validScope(snapshot.scope) ||
      snapshot.scope.documentId !== this.#scope.documentId ||
      snapshot.scope.projectId !== this.#scope.projectId ||
      snapshot.scope.taskId !== this.#scope.taskId ||
      !isNonEmpty(snapshot.revision) ||
      snapshot.checkpointRevision !== snapshot.revision ||
      (snapshot.schemaVersion === 1
        ? !Array.isArray(snapshot.atoms)
        : !Array.isArray(snapshot.runs)) ||
      !Array.isArray(snapshot.knownOperations) ||
      !Array.isArray(snapshot.deferred)
    )
      throw new Error('shared working-state snapshot is malformed');
    if (snapshot.schemaVersion === 1) {
      if (!Array.isArray(snapshot.atoms))
        throw new Error('shared working-state snapshot is malformed');
      const atoms = new Map<AtomId, Atom>();
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
        atoms.set(rawAtom.id, {
          id: rawAtom.id,
          after: rawAtom.after,
          value: rawAtom.value,
          deleted: rawAtom.deleted,
        });
      }
      const colors = new Map<AtomId, 'visiting' | 'visited'>();
      for (const atom of atoms.values()) {
        if (atom.after !== null && !atoms.has(atom.after)) {
          throw new Error(
            'shared working-state snapshot lacks predecessor closure',
          );
        }
        if (colors.get(atom.id) === 'visited') continue;
        const path: AtomId[] = [];
        for (
          let cursor: AtomId | null = atom.id;
          cursor !== null;
          cursor = atoms.get(cursor)!.after
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
      this.#legacyAtoms = [...atoms.values()].sort((a, b) =>
        compareWorkingStateIds(a.id, b.id),
      );
      for (const run of atomRuns(this.#legacyAtoms)) {
        const group = this.#runs.get(run.operationId) ?? [];
        group.push(run);
        this.#runs.set(run.operationId, group);
      }
    } else {
      if (!Array.isArray(snapshot.runs))
        throw new Error('shared working-state snapshot is malformed');
      for (const raw of snapshot.runs) {
        if (
          !isRecord(raw) ||
          !isNonEmpty(raw.operationId) ||
          !Number.isSafeInteger(raw.start) ||
          Number(raw.start) < 0 ||
          !Number.isSafeInteger(raw.length) ||
          Number(raw.length) < 1 ||
          !Number.isSafeInteger(Number(raw.start) + Number(raw.length)) ||
          (raw.after !== null && !isNonEmpty(raw.after)) ||
          (raw.text !== null &&
            (typeof raw.text !== 'string' ||
              !isWellFormedUnicode(raw.text) ||
              [...raw.text].length !== raw.length))
        )
          throw new Error('shared working-state snapshot has malformed run');
        const run: TextRun = {
          operationId: raw.operationId,
          start: Number(raw.start),
          after: raw.after,
          length: Number(raw.length),
          text: raw.text,
        };
        const group = this.#runs.get(run.operationId) ?? [];
        group.push(run);
        this.#runs.set(run.operationId, group);
      }
      for (const [owner, group] of this.#runs) {
        group.sort((a, b) => a.start - b.start);
        let end = 0;
        for (const run of group) {
          if (
            run.start !== end ||
            (run.start > 0 && run.after !== atomId(owner, run.start - 1))
          )
            throw new Error(
              'shared working-state snapshot has overlapping or missing run positions',
            );
          end += run.length;
        }
      }
      const parents = new Map<string, string | null>();
      for (const run of [...this.#runs.values()].flat()) {
        let parent: TextRun | undefined;
        if (run.after !== null) {
          const position = atomPosition(run.after);
          if (position)
            parent = containingRun(
              this.#runs.get(position.operationId) ?? [],
              position.index,
            );
          if (!parent)
            throw new Error(
              'shared working-state snapshot lacks predecessor closure',
            );
        }
        parents.set(runId(run), parent ? runId(parent) : null);
      }
      const visited = new Set<string>();
      for (const id of parents.keys()) {
        const path = new Set<string>();
        for (
          let cursor: string | null = id;
          cursor !== null && !visited.has(cursor);
          cursor = parents.get(cursor)!
        ) {
          if (path.has(cursor))
            throw new Error(
              'shared working-state snapshot has cyclic predecessors',
            );
          path.add(cursor);
        }
        for (const entry of path) visited.add(entry);
      }
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
    for (const owner of this.#runs.keys()) {
      if (!this.#knownOperations.has(owner))
        throw new Error(
          'shared working-state snapshot atom lacks known operation',
        );
    }
    const legacyAtoms = this.#legacyAtoms;
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
    this.#legacyAtoms = legacyAtoms;
    this.#invalidateRevision();
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

interface SharedWorkingStatePorts {
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
 * No production caller composes recovery yet (production builds the live-only
 * `SharedWorkingState`); see "Ordering and outcomes" in
 * docs/design/shared-working-state.md.
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
