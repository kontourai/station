import { createHash } from 'node:crypto';
import type {
  ConversationContextBoundaryProjection,
  ConversationContextBoundarySeed,
} from '@kontourai/station-contracts/conversation-context-boundary';
import type { SqliteDatabase } from './sqlite-database.js';

export interface ContextCompactionObservation {
  conversationId: string;
  sessionId: string;
  turnId: string;
  sourceEventId: string;
  sourceRevision: string;
  atRest: boolean;
  approvalPending: boolean;
  compactionOwner: 'station' | 'engine' | 'unknown';
  usage?: {
    confirmed: true;
    sessionId: string;
    turnId: string;
    contextTokens: number;
    contextWindowTokens: number;
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
  mode: 'manual' | 'auto';
  policyRevision?: number;
  operationId: string;
  sourceKey: string;
  requestDigest: string;
  actorId: string;
  observation: ContextCompactionObservation;
  state: 'generating' | 'prepared' | 'reserved' | 'failed' | 'indeterminate';
  seed?: ConversationContextBoundarySeed;
  boundary?: ConversationContextBoundaryProjection;
  attempts: number;
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
  unfinished(): ContextCompactionRecord[];
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
    unfinished() {
      return (
        db
          .prepare(
            "SELECT record_json FROM context_compaction_intents WHERE state IN ('generating','prepared','indeterminate') ORDER BY operation_id LIMIT 64",
          )
          .all() as { record_json: string }[]
      ).map((row) => JSON.parse(row.record_json));
    },
  };
}
export interface ContextCompactionPorts {
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
    | { kind: 'failed'; definite: boolean; reason: string }
  >;
  reserveBoundary(input: {
    conversationId: string;
    expectedCurrentSessionId: string;
    idempotencyKey: string;
    actorId: string;
    policy: 'summary-next-cold-start';
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
  async updatePolicy(input: {
    conversationId: string;
    actorId: string;
    expectedCurrentSessionId: string;
    expectedRevision: number;
    threshold: number;
    autoEnabled: boolean;
  }): Promise<ContextCompactionPolicy> {
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
      !(await this.ports.isCurrent(observed, input.actorId))
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
      Number.isFinite(usage.contextTokens) &&
      usage.contextTokens >= 0 &&
      Number.isFinite(usage.contextWindowTokens) &&
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
      if (record.state === 'prepared') return this.publish(record);
      if (record.state !== 'failed') return { kind: 'record', record };
      if (record.nextEligibleAt > ports.now() || record.attempts >= 3)
        return { kind: 'held', reason: 'backoff' };
      const next = {
        ...record,
        state: 'generating' as const,
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
        !generated.model
      )
        throw new Error(
          'Generator returned an unbounded or missing semantic summary.',
        );
      const seed: ConversationContextBoundarySeed = {
        kind: 'semantic-summary',
        text: generated.text,
        digest: hash(generated.text),
        sourceSessionId: record.observation.sessionId,
        sourceEventId: record.observation.sourceEventId,
        sourceRevision: record.observation.sourceRevision,
        model: generated.model,
        generationUsage: generated.usage,
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
        state: 'indeterminate' as const,
        reason:
          'Summary generation outcome is unknown. Reconcile this operation; do not regenerate under a new identity.',
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
    if (record.mode === 'auto') {
      const policy = this.ports.store.policy(record.observation.conversationId);
      if (
        !policy?.autoEnabled ||
        policy.actorId !== record.actorId ||
        policy.revision !== record.policyRevision
      )
        return { kind: 'held', reason: 'stale' };
    }
    const key = `compact:${record.operationId}`;
    try {
      let boundary = await this.ports.readBoundary(
        record.observation.conversationId,
        key,
        record.actorId,
      );
      if (boundary && boundary.seed?.digest !== record.seed.digest)
        throw new Error('Compaction boundary seed differs.');
      if (!boundary) {
        if (!(await this.ports.isCurrent(record.observation, record.actorId)))
          return { kind: 'held', reason: 'stale' };
        boundary = await this.ports.reserveBoundary({
          conversationId: record.observation.conversationId,
          expectedCurrentSessionId: record.observation.sessionId,
          idempotencyKey: key,
          actorId: record.actorId,
          policy: 'summary-next-cold-start',
          seed: record.seed,
        });
      }
      const next = { ...record, state: 'reserved' as const, boundary };
      this.ports.store.transition(
        record.operationId,
        ['prepared', 'indeterminate'],
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
    for (const record of this.ports.store.unfinished()) {
      if (record.state === 'generating')
        this.ports.store.transition(record.operationId, ['generating'], {
          ...record,
          state: 'indeterminate',
          reason: 'Summary generator was interrupted; its effect is unknown.',
        });
      else if (record.seed) await this.publish(record);
    }
  }
}
