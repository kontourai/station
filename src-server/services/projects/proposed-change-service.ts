import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  ProposedChange,
  ProposedChangeActorType,
  ProposedChangeBulkDecisionInput,
  ProposedChangeCreateInput,
  ProposedChangeDecision,
  ProposedChangeDecisionInput,
  ProposedChangeDecisionStatus,
  ProposedChangeFilters,
  ProposedChangeStatus,
} from '@kontourai/station-contracts/proposed-change';
import {
  canTransitionProposedChangeStatus,
  validateProposedChange,
} from '@kontourai/station-contracts/proposed-change';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  reviewDecisions,
  reviewProposals,
  reviewQueueDepthSamples,
  reviewTimeToDecision,
} from '../../telemetry/metrics.js';
import {
  JsonFileStore,
  type JsonFileStoreOptions,
} from '../infra/json-store.js';

interface ProposedChangeStoreData {
  changes: ProposedChange[];
}

interface ProposedChangeDecisionOutcome {
  actorType: ProposedChangeActorType;
  decidedAt: string;
  updated: ProposedChange;
}

// Async-compatible seam (#2646): the default is the ASYNC cross-process lock
// so a contended acquisition yields the event loop; sync test fakes remain
// assignable (awaiting a non-promise is a no-op).
type ProposedChangeMutationLock = (
  lockPath: string,
) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;

/** Exact lowercase UUID-v4 spelling emitted for decisions by {@link randomUUID}. */
const GENERATED_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ProposedChangeServiceOptions {
  /** Injectable only for deterministic multi-process mutation tests. */
  acquireMutationLock?: ProposedChangeMutationLock;
  /** Test-only extension point; strict durable persistence remains required. */
  storeOptions?: JsonFileStoreOptions;
}

export class ProposedChangeNotFoundError extends Error {
  constructor(id: string) {
    super(`Proposed change not found: ${id}`);
    this.name = 'ProposedChangeNotFoundError';
  }
}

export class ProposedChangeTransitionError extends Error {
  constructor(
    id: string,
    from: ProposedChangeStatus,
    to: ProposedChangeStatus,
  ) {
    super(`Cannot transition proposed change ${id} from ${from} to ${to}`);
    this.name = 'ProposedChangeTransitionError';
  }
}

export class ProposedChangeConflictError extends Error {
  constructor(id: string) {
    super(`Proposed change already exists: ${id}`);
    this.name = 'ProposedChangeConflictError';
  }
}

export class ProposedChangeValidationError extends Error {
  constructor(errors: string[]) {
    super(`Invalid proposed change: ${errors.join(', ')}`);
    this.name = 'ProposedChangeValidationError';
  }
}

function isCanonicalText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function isCanonicalGeneratedId(value: unknown): value is string {
  return typeof value === 'string' && GENERATED_ID_PATTERN.test(value);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateCanonicalChange(change: ProposedChange): void {
  const validation = validateProposedChange(change);
  const errors = [...validation.errors];
  for (const field of [
    'id',
    'sessionId',
    'projectId',
    'path',
    'sourceRuntime',
  ] as const) {
    if (!isCanonicalText(change[field])) {
      errors.push(`${field} must be canonical`);
    }
  }
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (!isCanonicalIsoTimestamp(change[field])) {
      errors.push(`${field} must be a canonical ISO date`);
    }
  }
  if (
    change.supersededById !== undefined &&
    !isCanonicalText(change.supersededById)
  ) {
    errors.push('supersededById must be canonical');
  }
  for (const decision of change.decisions) {
    if (
      !isCanonicalGeneratedId(decision.id) ||
      !isCanonicalText(decision.changeId) ||
      !isCanonicalIsoTimestamp(decision.decidedAt) ||
      (decision.actorId !== undefined && !isCanonicalText(decision.actorId)) ||
      (decision.bulkDecisionId !== undefined &&
        !isCanonicalGeneratedId(decision.bulkDecisionId))
    ) {
      errors.push('decision fields must be canonical');
    }
  }
  if (errors.length > 0) throw new ProposedChangeValidationError(errors);
}

function validateDecisionState(change: ProposedChange): void {
  if (change.status === 'pending') {
    if (change.decisions.length > 0 || change.supersededById !== undefined) {
      throw new Error('Invalid proposed change decision state');
    }
    return;
  }
  if (
    change.decisions.length !== 1 ||
    change.decisions[0]?.decision !== change.status
  ) {
    throw new Error('Invalid proposed change decision state');
  }
  if (change.status === 'superseded') {
    if (
      !isCanonicalText(change.supersededById) ||
      change.supersededById === change.id
    ) {
      throw new Error('Invalid proposed change supersession');
    }
    return;
  }
  if (change.supersededById !== undefined) {
    throw new Error('Invalid proposed change supersession');
  }
}

function validateStoreData(value: unknown): ProposedChangeStoreData {
  if (!isRecord(value)) {
    throw new Error('Invalid proposed change store');
  }
  const data = value;
  if (
    Object.keys(data).some((key) => key !== 'changes') ||
    !Array.isArray(data.changes)
  ) {
    throw new Error('Invalid proposed change store');
  }
  const changes = data.changes.map(validatePersistedChange);
  if (new Set(changes.map((change) => change.id)).size !== changes.length) {
    throw new Error('Duplicate proposed change id');
  }
  const decisionIds = changes.flatMap((change) =>
    change.decisions.map((decision) => decision.id),
  );
  if (new Set(decisionIds).size !== decisionIds.length) {
    throw new Error('Duplicate proposed change decision id');
  }
  validateDocumentRelationships(changes);
  return { changes };
}

function validateDocumentRelationships(changes: ProposedChange[]): void {
  const byId = new Map(changes.map((change) => [change.id, change]));
  const bulkDecisions = new Map<string, ProposedChangeDecision>();

  for (const change of changes) {
    if (change.status !== 'pending') {
      const effective = change.decisions[0]!;
      if (change.updatedAt !== effective.decidedAt) {
        throw new Error('Invalid proposed change decision timestamp');
      }
      if (effective.bulkDecisionId !== undefined) {
        const existing = bulkDecisions.get(effective.bulkDecisionId);
        if (existing) {
          if (
            existing.decision !== effective.decision ||
            existing.decidedAt !== effective.decidedAt ||
            existing.actorType !== effective.actorType ||
            existing.actorId !== effective.actorId ||
            existing.reason !== effective.reason
          ) {
            throw new Error('Invalid proposed change bulk decision');
          }
        } else {
          bulkDecisions.set(effective.bulkDecisionId, effective);
        }
      }
    }

    if (change.status !== 'superseded') continue;
    const target = byId.get(change.supersededById!);
    if (
      !target ||
      target.sessionId !== change.sessionId ||
      target.projectId !== change.projectId ||
      target.path !== change.path
    ) {
      throw new Error('Invalid proposed change supersession target');
    }
  }

  for (const change of changes) {
    const seen = new Set<string>();
    let current: ProposedChange | undefined = change;
    while (current?.status === 'superseded') {
      if (seen.has(current.id)) {
        throw new Error('Invalid proposed change supersession cycle');
      }
      seen.add(current.id);
      current = byId.get(current.supersededById!);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function requirePersistedString(value: unknown): value is string {
  return typeof value === 'string';
}

function validatePersistedSnapshot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ['content'], ['hash', 'language', 'metadata'])) {
    return false;
  }
  return (
    (typeof value.content === 'string' || value.content === null) &&
    (!Object.hasOwn(value, 'hash') || requirePersistedString(value.hash)) &&
    (!Object.hasOwn(value, 'language') ||
      requirePersistedString(value.language)) &&
    (!Object.hasOwn(value, 'metadata') || isRecord(value.metadata))
  );
}

function validatePersistedDecision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(
      value,
      ['id', 'changeId', 'decision', 'actorType', 'decidedAt'],
      ['reason', 'actorId', 'bulkDecisionId'],
    )
  ) {
    return false;
  }
  return (
    requirePersistedString(value.id) &&
    requirePersistedString(value.changeId) &&
    requirePersistedString(value.decision) &&
    requirePersistedString(value.actorType) &&
    requirePersistedString(value.decidedAt) &&
    (!Object.hasOwn(value, 'reason') || requirePersistedString(value.reason)) &&
    (!Object.hasOwn(value, 'actorId') ||
      requirePersistedString(value.actorId)) &&
    (!Object.hasOwn(value, 'bulkDecisionId') ||
      requirePersistedString(value.bulkDecisionId))
  );
}

function validatePersistedChange(value: unknown): ProposedChange {
  if (!isRecord(value)) {
    throw new Error('Invalid proposed change store');
  }
  const required = [
    'id',
    'sessionId',
    'projectId',
    'path',
    'changeType',
    'contentKind',
    'baseSnapshot',
    'proposedSnapshot',
    'createdAt',
    'updatedAt',
    'sourceRuntime',
    'status',
    'decisions',
  ];
  if (!hasExactKeys(value, required, ['supersededById', 'metadata'])) {
    throw new Error('Invalid proposed change store');
  }
  const scalarKeys = [
    'id',
    'sessionId',
    'projectId',
    'path',
    'changeType',
    'contentKind',
    'createdAt',
    'updatedAt',
    'sourceRuntime',
    'status',
  ];
  if (
    scalarKeys.some((key) => !requirePersistedString(value[key])) ||
    (value.baseSnapshot !== null &&
      !validatePersistedSnapshot(value.baseSnapshot)) ||
    (value.proposedSnapshot !== null &&
      !validatePersistedSnapshot(value.proposedSnapshot)) ||
    !Array.isArray(value.decisions) ||
    !value.decisions.every(validatePersistedDecision) ||
    (Object.hasOwn(value, 'supersededById') &&
      !requirePersistedString(value.supersededById)) ||
    (Object.hasOwn(value, 'metadata') && !isRecord(value.metadata))
  ) {
    throw new Error('Invalid proposed change store');
  }
  const change = value as unknown as ProposedChange;
  validateCanonicalChange(change);
  validateDecisionState(change);
  return change;
}

export class ProposedChangeService {
  private readonly filePath: string;
  private readonly store: JsonFileStore<ProposedChangeStoreData>;
  private readonly acquireMutationLock: ProposedChangeMutationLock;

  constructor(dataDir: string, options: ProposedChangeServiceOptions = {}) {
    this.filePath = join(dataDir, 'proposed-changes.json');
    this.store = new JsonFileStore(
      this.filePath,
      { changes: [] },
      {
        ...options.storeOptions,
        onCorruption: 'throw',
        durableAtomicWrite: true,
      },
    );
    this.acquireMutationLock =
      options.acquireMutationLock ?? acquireFileMutationLockAsync;
  }

  async create(input: ProposedChangeCreateInput): Promise<ProposedChange> {
    const now = new Date().toISOString();
    const change: ProposedChange = {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId,
      projectId: input.projectId,
      path: input.path,
      changeType: input.changeType,
      contentKind: input.contentKind,
      baseSnapshot: input.baseSnapshot ?? null,
      proposedSnapshot: input.proposedSnapshot ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      sourceRuntime: input.sourceRuntime,
      status: 'pending',
      decisions: [],
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    validateCanonicalChange(change);

    await this.mutate((data) => {
      if (data.changes.some((item) => item.id === change.id)) {
        throw new ProposedChangeConflictError(change.id);
      }
      return {
        result: undefined,
        next: { changes: [change, ...data.changes] },
      };
    });
    reviewProposals.add(1, {
      content_kind: change.contentKind,
      runtime_kind: change.sourceRuntime,
      source: 'api',
    });
    this.recordQueueDepth(change.projectId);
    return change;
  }

  list(filters: ProposedChangeFilters = {}): ProposedChange[] {
    const statusSet = filters.status?.length
      ? new Set(filters.status)
      : undefined;
    const changes = this.read().changes.filter((change) => {
      if (statusSet && !statusSet.has(change.status)) return false;
      if (filters.sessionId && change.sessionId !== filters.sessionId) {
        return false;
      }
      if (filters.projectId && change.projectId !== filters.projectId) {
        return false;
      }
      return true;
    });
    reviewQueueDepthSamples.add(this.pendingCount(filters.projectId), {
      project_scope: filters.projectId ? 'project' : 'global',
    });
    return changes;
  }

  get(id: string): ProposedChange | null {
    return this.read().changes.find((change) => change.id === id) ?? null;
  }

  async approve(
    id: string,
    input: ProposedChangeDecisionInput = {},
  ): Promise<ProposedChange> {
    return this.decide(id, 'approved', input);
  }

  async reject(
    id: string,
    input: ProposedChangeDecisionInput = {},
  ): Promise<ProposedChange> {
    return this.decide(id, 'rejected', input);
  }

  async bulkApprove(
    input: ProposedChangeBulkDecisionInput,
  ): Promise<ProposedChange[]> {
    return this.bulkDecide('approved', input);
  }

  async bulkReject(
    input: ProposedChangeBulkDecisionInput,
  ): Promise<ProposedChange[]> {
    return this.bulkDecide('rejected', input);
  }

  private async bulkDecide(
    decision: ProposedChangeDecisionStatus,
    input: ProposedChangeBulkDecisionInput,
  ): Promise<ProposedChange[]> {
    const bulkDecisionId = randomUUID();
    if (new Set(input.ids).size !== input.ids.length) {
      throw new ProposedChangeValidationError(['ids must be unique']);
    }
    const outcomes = await this.mutate((data) => {
      const current = input.ids.map((id) => {
        const change = data.changes.find((item) => item.id === id);
        if (!change) throw new ProposedChangeNotFoundError(id);
        if (
          change.status !== 'pending' ||
          !canTransitionProposedChangeStatus(change.status, decision)
        ) {
          throw new ProposedChangeTransitionError(id, change.status, decision);
        }
        return change;
      });
      const decidedAt = new Date().toISOString();
      const outcomes = current.map((change) =>
        this.transition(change, decision, input, bulkDecisionId, decidedAt),
      );
      const byId = new Map(
        outcomes.map((outcome) => [outcome.updated.id, outcome.updated]),
      );
      return {
        result: outcomes,
        next: {
          changes: data.changes.map((change) => byId.get(change.id) ?? change),
        },
      };
    });
    for (const outcome of outcomes)
      this.recordDecision(decision, outcome, true);
    return outcomes.map((outcome) => outcome.updated);
  }

  private async decide(
    id: string,
    decision: ProposedChangeDecisionStatus,
    input: ProposedChangeDecisionInput,
    bulkDecisionId?: string,
  ): Promise<ProposedChange> {
    const outcome = await this.mutate((data) => {
      const current = data.changes.find((change) => change.id === id);
      if (!current) throw new ProposedChangeNotFoundError(id);
      const outcome = this.transition(current, decision, input, bulkDecisionId);
      return {
        result: outcome,
        next: {
          changes: data.changes.map((change) =>
            change.id === outcome.updated.id ? outcome.updated : change,
          ),
        },
      };
    });
    this.recordDecision(decision, outcome, bulkDecisionId !== undefined);
    return outcome.updated;
  }

  private transition(
    current: ProposedChange,
    decision: ProposedChangeDecisionStatus,
    input: ProposedChangeDecisionInput,
    bulkDecisionId?: string,
    decidedAt = new Date().toISOString(),
  ): ProposedChangeDecisionOutcome {
    if (
      current.status !== 'pending' ||
      !canTransitionProposedChangeStatus(current.status, decision)
    ) {
      throw new ProposedChangeTransitionError(
        current.id,
        current.status,
        decision,
      );
    }
    const actorType: ProposedChangeActorType = input.actorType ?? 'human';
    const updated: ProposedChange = {
      ...current,
      status: decision,
      updatedAt: decidedAt,
      decisions: [
        ...current.decisions,
        {
          id: randomUUID(),
          changeId: current.id,
          decision,
          actorType,
          decidedAt,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
          ...(bulkDecisionId === undefined ? {} : { bulkDecisionId }),
        },
      ],
    };
    validateCanonicalChange(updated);
    validateDecisionState(updated);
    return { updated, actorType, decidedAt };
  }

  private recordDecision(
    decision: ProposedChangeDecisionStatus,
    { updated, actorType, decidedAt }: ProposedChangeDecisionOutcome,
    bulk: boolean,
  ): void {
    reviewDecisions.add(1, {
      decision,
      content_kind: updated.contentKind,
      actor_type: actorType,
      bulk: bulk ? 'true' : 'false',
    });
    const elapsed = Date.parse(decidedAt) - Date.parse(updated.createdAt);
    if (!Number.isNaN(elapsed) && elapsed >= 0) {
      reviewTimeToDecision.record(elapsed, {
        content_kind: updated.contentKind,
        runtime_kind: updated.sourceRuntime,
      });
    }
    this.recordQueueDepth(updated.projectId);
  }

  private recordQueueDepth(projectId?: string): void {
    reviewQueueDepthSamples.add(this.pendingCount(projectId), {
      project_scope: projectId ? 'project' : 'global',
    });
  }

  private pendingCount(projectId?: string): number {
    return this.read().changes.filter(
      (change) =>
        change.status === 'pending' &&
        (!projectId || change.projectId === projectId),
    ).length;
  }

  private read(): ProposedChangeStoreData {
    return validateStoreData(this.store.read());
  }

  /** Each transition owns a fresh persisted snapshot before it decides. */
  private async mutate<T>(
    mutation: (data: ProposedChangeStoreData) => {
      result: T;
      next?: ProposedChangeStoreData;
    },
  ): Promise<T> {
    const release = await this.acquireMutationLock(`${this.filePath}.mutation`);
    try {
      const outcome = mutation(this.read());
      if (outcome.next) this.store.write(validateStoreData(outcome.next));
      return outcome.result;
    } finally {
      await release();
    }
  }
}
