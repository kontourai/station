import { createHash } from 'node:crypto';
import type {
  ContextSummaryGenerationAttempt,
  ConversationCompactionOperationView,
  ConversationContextBoundaryProjection,
  ConversationContextBoundarySeed,
} from '@kontourai/station-contracts/conversation-context-boundary';
import type { SqliteDatabase } from './sqlite-database.js';

export interface ContextCompactionObservation {
  contextKind?: 'semantic-summary' | 'task-state';
  taskStateRevision?: string;
  conversationId: string;
  sessionId: string;
  turnId: string;
  sourceEventId: string;
  sourceRevision: string;
  sourceCutoffs?: { sessionId: string; throughSequence: number }[];
  sourceMessageCount?: number;
  atRest: boolean;
  approvalPending: boolean;
  compactionOwner: 'station' | 'engine' | 'unknown';
  usage?: {
    confirmed: true;
    sessionId: string;
    turnId: string;
    contextTokens: number;
    contextWindowTokens: number;
    modelId?: string;
  };
}
export interface ContextCompactionRequest {
  conversationId: string;
  expectedSessionId: string;
  operationId: string;
  actorId: string;
  mode: 'manual' | 'auto';
  threshold?: number;
}
export interface ContextCompactionRecord {
  activationOperationId?: string;
  mode: 'manual' | 'auto';
  policyRevision?: number;
  operationId: string;
  sourceKey: string;
  requestDigest: string;
  actorId: string;
  observation: ContextCompactionObservation;
  state:
    | 'generating'
    | 'prepared'
    | 'reserved'
    | 'consumed'
    | 'failed'
    | 'indeterminate';
  seed?: ConversationContextBoundarySeed;
  boundary?: ConversationContextBoundaryProjection;
  attempts: number;
  generationAttempts?: ContextSummaryGenerationAttempt[];
  nextEligibleAt: number;
  reason?: string;
}
export interface ContextCompactionStore {
  latest(
    conversationId: string,
    actorId: string,
  ): ContextCompactionRecord | undefined;
  policy(conversationId: string): ContextCompactionPolicy | undefined;
  policies(): ContextCompactionPolicy[];
  updatePolicy(
    policy: ContextCompactionPolicy,
    expectedRevision: number,
  ): boolean;
  read(operationId: string): ContextCompactionRecord | undefined;
  reserve(record: ContextCompactionRecord): {
    record: ContextCompactionRecord;
    created: boolean;
  };
  transition(
    operationId: string,
    from: readonly ContextCompactionRecord['state'][],
    next: ContextCompactionRecord,
  ): boolean;
  unfinished(afterOperationId?: string): ContextCompactionRecord[];
}
/** One projection for every public operation response; seed text never crosses this boundary. */
export function projectContextCompactionOperation(
  record: ContextCompactionRecord,
): ConversationCompactionOperationView {
  const seed = record.seed;
  return {
    operationId: record.operationId,
    state: record.state,
    reason: record.reason,
    nextEligibleAt: record.nextEligibleAt,
    model: seed?.model,
    generationUsage: seed?.generationUsage,
    generationAttempts: record.generationAttempts,
    contextKind: seed?.kind ?? record.observation.contextKind,
    boundaryId: record.boundary?.boundaryId,
    ...(seed
      ? {
          seed: {
            kind: seed.kind,
            digest: seed.digest,
            length: seed.text.length,
            sourceSessionId: seed.sourceSessionId,
            sourceEventId: seed.sourceEventId,
            sourceRevision: seed.sourceRevision,
            ...(seed.task ? { task: { ...seed.task } } : {}),
            ...(seed.taskStateRevision
              ? { taskStateRevision: seed.taskStateRevision }
              : {}),
          },
        }
      : {}),
  };
}
export interface ContextCompactionPolicy {
  conversationId: string;
  actorId: string;
  revision: number;
  threshold: number;
  autoEnabled: boolean;
  updatedForSessionId: string;
}
export function createSqliteContextCompactionStore(
  db: SqliteDatabase,
): ContextCompactionStore {
  db.exec(
    `CREATE TABLE IF NOT EXISTS context_compaction_intents(operation_id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL,record_json TEXT NOT NULL);`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS context_compaction_policies(conversation_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,record_json TEXT NOT NULL);`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_context_compaction_active_conversation ON context_compaction_intents(json_extract(record_json,'$.observation.conversationId')) WHERE state IN ('generating','prepared','indeterminate');`,
  );
  const read = (operationId: string) => {
    const row = db
      .prepare(
        'SELECT record_json FROM context_compaction_intents WHERE operation_id=?',
      )
      .get(operationId) as { record_json: string } | undefined;
    return row
      ? (JSON.parse(row.record_json) as ContextCompactionRecord)
      : undefined;
  };
  return {
    latest(conversationId, actorId) {
      const row = db
        .prepare(
          "SELECT record_json FROM context_compaction_intents WHERE json_extract(record_json,'$.observation.conversationId')=? AND json_extract(record_json,'$.actorId')=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(conversationId, actorId) as { record_json: string } | undefined;
      return row ? JSON.parse(row.record_json) : undefined;
    },
    policy(conversationId) {
      const row = db
        .prepare(
          'SELECT record_json FROM context_compaction_policies WHERE conversation_id=?',
        )
        .get(conversationId) as { record_json: string } | undefined;
      return row ? JSON.parse(row.record_json) : undefined;
    },
    policies() {
      return (
        db
          .prepare(
            'SELECT record_json FROM context_compaction_policies ORDER BY conversation_id LIMIT 128',
          )
          .all() as { record_json: string }[]
      ).map((row) => JSON.parse(row.record_json));
    },
    updatePolicy(policy, expectedRevision) {
      if (
        expectedRevision === 0 &&
        (
          db
            .prepare(
              'SELECT COUNT(*) AS count FROM context_compaction_policies',
            )
            .get() as { count: number }
        ).count >= 128
      )
        throw new Error('Compaction policy capacity reached.');
      const result =
        expectedRevision === 0
          ? db
              .prepare(
                'INSERT OR IGNORE INTO context_compaction_policies(conversation_id,revision,record_json) VALUES(?,?,?)',
              )
              .run(
                policy.conversationId,
                policy.revision,
                JSON.stringify(policy),
              )
          : db
              .prepare(
                'UPDATE context_compaction_policies SET revision=?,record_json=? WHERE conversation_id=? AND revision=?',
              )
              .run(
                policy.revision,
                JSON.stringify(policy),
                policy.conversationId,
                expectedRevision,
              );
      return (result as { changes: number }).changes === 1;
    },
    read,
    reserve(record) {
      const result = db
        .prepare(
          'INSERT OR IGNORE INTO context_compaction_intents(operation_id,source_key,state,record_json) VALUES(?,?,?,?)',
        )
        .run(
          record.operationId,
          record.sourceKey,
          record.state,
          JSON.stringify(record),
        ) as { changes: number };
      const row = db
        .prepare(
          "SELECT record_json FROM context_compaction_intents WHERE operation_id=? OR source_key=? OR (state IN ('generating','prepared','indeterminate') AND json_extract(record_json,'$.observation.conversationId')=?) ORDER BY CASE WHEN operation_id=? THEN 0 ELSE 1 END LIMIT 1",
        )
        .get(
          record.operationId,
          record.sourceKey,
          record.observation.conversationId,
          record.operationId,
        ) as { record_json: string };
      return {
        record: JSON.parse(row.record_json),
        created: result.changes === 1,
      };
    },
    transition(id, from, next) {
      return (
        (
          db
            .prepare(
              `UPDATE context_compaction_intents SET state=?,record_json=? WHERE operation_id=? AND state IN (${from.map(() => '?').join(',')})`,
            )
            .run(next.state, JSON.stringify(next), id, ...from) as {
            changes: number;
          }
        ).changes === 1
      );
    },
    unfinished(afterOperationId = '') {
      return (
        db
          .prepare(
            "SELECT record_json FROM context_compaction_intents WHERE state IN ('generating','prepared','reserved','indeterminate') AND operation_id>? ORDER BY operation_id LIMIT 64",
          )
          .all(afterOperationId) as { record_json: string }[]
      ).map((row) => JSON.parse(row.record_json));
    },
  };
}
export interface ContextCompactionPorts {
  isPolicyCurrent?(
    observation: ContextCompactionObservation,
    actorId: string,
  ): Promise<boolean>;
  store: ContextCompactionStore;
  now(): number;
  enabled(): boolean;
  observe(
    conversationId: string,
    actorId: string,
  ): Promise<ContextCompactionObservation | undefined>;
  isCurrent(
    observation: ContextCompactionObservation,
    actorId: string,
  ): Promise<boolean>;
  /** Root uses generateSessionSummary/framework model; clipping is not a semantic summary. */
  generate(input: {
    observation: ContextCompactionObservation;
    operationId: string;
    actorId: string;
  }): Promise<
    | {
        kind: 'generated';
        text: string;
        model: string;
        usage: ConversationContextBoundarySeed['generationUsage'];
      }
    | {
        kind: 'task-state';
        text: string;
        task: { taskId: string; taskCreatedAt: string; projectId: string };
        taskStateRevision: string;
        taskBriefDigest: string;
        mandatoryContextDigest: string;
        learningContributions: ConversationContextBoundarySeed['learningContributions'];
      }
    | {
        kind: 'failed';
        definite: boolean;
        reason: string;
        model?: string;
        usage?: ConversationContextBoundarySeed['generationUsage'];
      }
  >;
  reserveBoundary(input: {
    conversationId: string;
    expectedCurrentSessionId: string;
    idempotencyKey: string;
    actorId: string;
    policy: 'summary-next-cold-start' | 'task-state-next-cold-start';
    seed: ConversationContextBoundarySeed;
  }): Promise<ConversationContextBoundaryProjection>;
  readBoundary(
    conversationId: string,
    idempotencyKey: string,
    actorId: string,
  ): Promise<ConversationContextBoundaryProjection | undefined>;
}
export type ContextCompactionResult =
  | {
      kind: 'held';
      reason:
        | 'disabled'
        | 'unsupported'
        | 'engine-owned'
        | 'busy'
        | 'unconfirmed-usage'
        | 'below-threshold'
        | 'stale'
        | 'backoff';
    }
  | { kind: 'record'; record: ContextCompactionRecord };
const hash = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export class ContextCompactionService {
  private reconcileCursor = '';
  constructor(private readonly ports: ContextCompactionPorts) {}
  policy(conversationId: string): ContextCompactionPolicy | undefined {
    return this.ports.store.policy(conversationId);
  }
  latest(
    conversationId: string,
    actorId: string,
  ): ContextCompactionRecord | undefined {
    return this.ports.store.latest(conversationId, actorId);
  }
  async updatePolicy(
    input: {
      conversationId: string;
      actorId: string;
      expectedCurrentSessionId: string;
      expectedRevision: number;
      threshold: number;
      autoEnabled: boolean;
    },
    current?: () => boolean,
  ): Promise<ContextCompactionPolicy> {
    if (!this.ports.enabled())
      throw new Error('Context compaction preview is disabled.');
    if (
      !Number.isInteger(input.threshold) ||
      input.threshold < 5 ||
      input.threshold > 90 ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      typeof input.autoEnabled !== 'boolean'
    )
      throw new Error('Compaction threshold must be an integer from 5 to 90.');
    const observed = await this.ports.observe(
      input.conversationId,
      input.actorId,
    );
    if (
      !observed ||
      observed.sessionId !== input.expectedCurrentSessionId ||
      !(await (this.ports.isPolicyCurrent ?? this.ports.isCurrent)(
        observed,
        input.actorId,
      ))
    )
      throw new Error('Compaction policy Session or authority changed.');
    const policy = {
      conversationId: input.conversationId,
      actorId: input.actorId,
      revision: input.expectedRevision + 1,
      threshold: input.threshold,
      autoEnabled: input.autoEnabled,
      updatedForSessionId: observed.sessionId,
    };
    if (current && !current())
      throw new Error('Compaction policy request authority ended.');
    if (!this.ports.store.updatePolicy(policy, input.expectedRevision))
      throw new Error(
        'Compaction policy revision changed. Reload before applying.',
      );
    return policy;
  }
  status(
    operationId: string,
    actorId: string,
  ): ContextCompactionRecord | undefined {
    const record = this.ports.store.read(operationId);
    return record?.actorId === actorId ? record : undefined;
  }
  /** Manual and automatic requests share one durable generator/reservation owner. */
  async request(
    request: ContextCompactionRequest,
  ): Promise<ContextCompactionResult> {
    const { ports } = this;
    if (!ports.enabled()) return { kind: 'held', reason: 'disabled' };
    const policy = ports.store.policy(request.conversationId);
    if (
      request.mode === 'auto' &&
      (!policy?.autoEnabled || policy.actorId !== request.actorId)
    )
      return { kind: 'held', reason: 'disabled' };
    const threshold =
      request.mode === 'auto'
        ? policy!.threshold
        : (request.threshold ?? policy?.threshold ?? 90);
    if (!Number.isInteger(threshold) || threshold < 5 || threshold > 90)
      throw new Error('Compaction threshold must be an integer from 5 to 90.');
    if (!request.operationId || request.operationId.length > 256)
      throw new Error('Compaction operation identity is invalid.');
    const observed = await ports.observe(
      request.conversationId,
      request.actorId,
    );
    if (!observed || observed.sessionId !== request.expectedSessionId)
      return { kind: 'held', reason: 'stale' };
    if (observed.compactionOwner === 'engine')
      return { kind: 'held', reason: 'engine-owned' };
    if (observed.compactionOwner !== 'station')
      return { kind: 'held', reason: 'unsupported' };
    if (!observed.atRest || observed.approvalPending)
      return { kind: 'held', reason: 'busy' };
    const usage = observed.usage;
    const confirmed =
      usage?.confirmed === true &&
      usage.sessionId === observed.sessionId &&
      usage.turnId === observed.turnId &&
      Number.isSafeInteger(usage.contextTokens) &&
      usage.contextTokens >= 0 &&
      Number.isSafeInteger(usage.contextWindowTokens) &&
      usage.contextWindowTokens > 0;
    if (request.mode === 'auto' && !confirmed)
      return { kind: 'held', reason: 'unconfirmed-usage' };
    if (
      request.mode === 'auto' &&
      usage &&
      (usage.contextTokens / usage.contextWindowTokens) * 100 < threshold
    )
      return { kind: 'held', reason: 'below-threshold' };
    const requestDigest = hash({ ...request, threshold });
    const prior = ports.store.read(request.operationId);
    if (prior && prior.requestDigest !== requestDigest)
      throw new Error('Compaction identity names another request.');
    const reserved = ports.store.reserve({
      operationId: request.operationId,
      sourceKey: hash([
        request.conversationId,
        observed.sessionId,
        observed.sourceRevision,
        observed.sourceEventId,
      ]),
      requestDigest,
      actorId: request.actorId,
      observation: observed,
      mode: request.mode,
      ...(request.mode === 'auto' ? { policyRevision: policy!.revision } : {}),
      state: 'generating',
      attempts: 1,
      nextEligibleAt: 0,
    });
    let record = reserved.record;
    if (record.actorId !== request.actorId)
      return { kind: 'held', reason: 'stale' };
    if (!reserved.created) {
      if (
        request.mode === 'manual' &&
        record.state === 'failed' &&
        record.seed
      ) {
        const next = {
          ...record,
          state: 'prepared' as const,
          mode: 'manual' as const,
          activationOperationId: request.operationId,
          reason: undefined,
        };
        if (!ports.store.transition(record.operationId, ['failed'], next))
          return { kind: 'held', reason: 'backoff' };
        return this.publish(next);
      }
      if (record.state === 'prepared') return this.publish(record);
      if (record.state !== 'failed') return { kind: 'record', record };
      if (record.nextEligibleAt > ports.now() || record.attempts >= 3)
        return { kind: 'held', reason: 'backoff' };
      const next = {
        ...record,
        state: 'generating' as const,
        ...(request.mode === 'manual'
          ? {
              mode: 'manual' as const,
              activationOperationId: request.operationId,
            }
          : {}),
        attempts: record.attempts + 1,
        reason: undefined,
      };
      if (!ports.store.transition(record.operationId, ['failed'], next))
        return { kind: 'held', reason: 'backoff' };
      record = next;
    }
    try {
      const generated = await ports.generate({
        observation: record.observation,
        operationId: record.operationId,
        actorId: record.actorId,
      });
      if (
        generated.kind !== 'task-state' &&
        record.observation.contextKind !== 'task-state'
      ) {
        record = {
          ...record,
          generationAttempts: [
            ...(record.generationAttempts ?? []),
            {
              attempt: record.attempts,
              model: generated.model,
              usage: generated.usage ?? { state: 'unknown' },
              outcome:
                generated.kind === 'generated'
                  ? 'generated'
                  : generated.definite
                    ? 'refused'
                    : 'unknown',
            },
          ],
        };
      }
      if (generated.kind === 'failed') {
        const next = {
          ...record,
          state: generated.definite
            ? ('failed' as const)
            : ('indeterminate' as const),
          reason: generated.reason,
          nextEligibleAt: ports.now() + 60_000 * record.attempts,
        };
        ports.store.transition(record.operationId, ['generating'], next);
        return { kind: 'record', record: next };
      }
      if (
        !generated.text.trim() ||
        generated.text.length > 16000 ||
        (generated.kind === 'generated' && !generated.model)
      )
        throw new Error(
          'Generator returned an unbounded or missing semantic summary.',
        );
      const seed: ConversationContextBoundarySeed = {
        kind:
          generated.kind === 'task-state' ? 'task-state' : 'semantic-summary',
        text: generated.text,
        digest: hash(generated.text),
        sourceSessionId: record.observation.sessionId,
        sourceEventId: record.observation.sourceEventId,
        sourceRevision: record.observation.sourceRevision,
        ...(record.observation.sourceCutoffs
          ? { sourceCutoffs: record.observation.sourceCutoffs }
          : {}),
        ...(record.observation.sourceMessageCount !== undefined
          ? { sourceMessageCount: record.observation.sourceMessageCount }
          : {}),
        ...(generated.kind === 'task-state'
          ? {
              task: generated.task,
              taskStateRevision: generated.taskStateRevision,
              taskBriefDigest: generated.taskBriefDigest,
              mandatoryContextDigest: generated.mandatoryContextDigest,
              learningContributions: generated.learningContributions,
            }
          : { model: generated.model }),
        generationUsage:
          generated.kind === 'task-state'
            ? { state: 'unknown' }
            : generated.usage,
        ...(confirmed && usage
          ? {
              contextTokensBefore: usage.contextTokens,
              contextWindowTokens: usage.contextWindowTokens,
            }
          : {}),
      };
      const next = { ...record, state: 'prepared' as const, seed };
      if (!ports.store.transition(record.operationId, ['generating'], next))
        return {
          kind: 'record',
          record: ports.store.read(record.operationId)!,
        };
      return this.publish(next);
    } catch {
      const next = {
        ...record,
        ...(record.observation.contextKind !== 'task-state' &&
        !record.generationAttempts?.some(
          (attempt) => attempt.attempt === record.attempts,
        )
          ? {
              generationAttempts: [
                ...(record.generationAttempts ?? []),
                {
                  attempt: record.attempts,
                  usage: { state: 'unknown' as const },
                  outcome: 'unknown' as const,
                },
              ],
            }
          : {}),
        state:
          record.observation.contextKind === 'task-state'
            ? ('failed' as const)
            : ('indeterminate' as const),
        reason:
          record.observation.contextKind === 'task-state'
            ? 'Task context read failed; no model generation was attempted.'
            : 'Summary generation outcome is unknown. Reconcile this operation; do not regenerate under a new identity.',
      };
      ports.store.transition(record.operationId, ['generating'], next);
      return { kind: 'record', record: next };
    }
  }
  private async publish(
    record: ContextCompactionRecord,
  ): Promise<ContextCompactionResult> {
    if (!record.seed) throw new Error('Compaction has no pinned summary.');
    if (!this.ports.enabled()) return { kind: 'held', reason: 'disabled' };
    const key = `compact:${record.activationOperationId ?? record.operationId}`;
    try {
      let boundary = await this.ports.readBoundary(
        record.observation.conversationId,
        key,
        record.actorId,
      );
      if (boundary && boundary.seed?.digest !== record.seed.digest)
        throw new Error('Compaction boundary seed differs.');
      if (boundary?.status === 'cancelled') {
        const next = {
          ...record,
          state: 'failed' as const,
          boundary,
          nextEligibleAt: Number.MAX_SAFE_INTEGER,
          reason:
            'The unstarted summary boundary was cancelled; the generated summary remains retained.',
        };
        this.ports.store.transition(
          record.operationId,
          ['prepared', 'reserved', 'indeterminate'],
          next,
        );
        return { kind: 'record', record: next };
      }
      if (!boundary) {
        const policy = this.ports.store.policy(
          record.observation.conversationId,
        );
        if (
          record.mode === 'auto' &&
          (!policy?.autoEnabled ||
            policy.actorId !== record.actorId ||
            policy.revision !== record.policyRevision)
        ) {
          const next = {
            ...record,
            state: 'failed' as const,
            nextEligibleAt: Number.MAX_SAFE_INTEGER,
            reason:
              'Context policy changed after generation; no boundary was reserved.',
          };
          this.ports.store.transition(
            record.operationId,
            ['prepared', 'indeterminate'],
            next,
          );
          return { kind: 'record', record: next };
        }
        if (!(await this.ports.isCurrent(record.observation, record.actorId))) {
          const next = {
            ...record,
            state: 'failed' as const,
            nextEligibleAt: Number.MAX_SAFE_INTEGER,
            reason:
              'The context source changed after generation; no boundary was reserved.',
          };
          this.ports.store.transition(
            record.operationId,
            ['prepared', 'indeterminate'],
            next,
          );
          return { kind: 'record', record: next };
        }
        boundary = await this.ports.reserveBoundary({
          conversationId: record.observation.conversationId,
          expectedCurrentSessionId: record.observation.sessionId,
          idempotencyKey: key,
          actorId: record.actorId,
          policy:
            record.seed.kind === 'task-state'
              ? 'task-state-next-cold-start'
              : 'summary-next-cold-start',
          seed: record.seed,
        });
      }
      const next = {
        ...record,
        state:
          boundary.status === 'consumed'
            ? ('consumed' as const)
            : ('reserved' as const),
        boundary,
      };
      this.ports.store.transition(
        record.operationId,
        ['prepared', 'reserved', 'indeterminate'],
        next,
      );
      return { kind: 'record', record: next };
    } catch {
      const next = {
        ...record,
        state: 'indeterminate' as const,
        reason:
          'Boundary reservation is unconfirmed. Inspect its original compaction key.',
      };
      this.ports.store.transition(record.operationId, ['prepared'], next);
      return { kind: 'record', record: next };
    }
  }
  /** No generator is replayed after restart. Only persisted seeds may reconcile. */
  async reconcile(): Promise<void> {
    let records = this.ports.store.unfinished(this.reconcileCursor);
    if (!records.length) {
      this.reconcileCursor = '';
      records = this.ports.store.unfinished();
    }
    for (const record of records) {
      this.reconcileCursor = record.operationId;
      if (record.state === 'generating')
        this.ports.store.transition(record.operationId, ['generating'], {
          ...record,
          state:
            record.observation.contextKind === 'task-state'
              ? 'failed'
              : 'indeterminate',
          nextEligibleAt:
            record.observation.contextKind === 'task-state'
              ? this.ports.now()
              : record.nextEligibleAt,
          reason:
            record.observation.contextKind === 'task-state'
              ? 'Read-only Task context preparation was interrupted; the original identity is retryable.'
              : 'Summary generator was interrupted; its effect is unknown.',
        });
      else if (record.seed) await this.publish(record);
    }
  }
}
