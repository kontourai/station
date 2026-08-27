import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  CHECKPOINT_RETENTION_DETAIL_MAX_LENGTH,
  type CheckpointRetentionAudit,
  type CheckpointRetentionAuditEvent,
} from '@kontourai/station-shared/checkpoints';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { JsonFileStore } from '../infra/json-store.js';
import type {
  CheckpointIndexStore,
  TurnPhaseCheckpoint,
} from './checkpoint-index-store.js';
import type {
  CapturedCheckpoint,
  CheckpointRefStore,
} from './checkpoint-ref-store.js';

export const CHECKPOINT_RETENTION_MAX_REFS_PER_THREAD = 400;
export const CHECKPOINT_MUTATION_LOCK = 'checkpoint-mutations.lock';

export type CheckpointRetentionResult = CheckpointRetentionAuditEvent;
type RetentionDocument = CheckpointRetentionAudit;
type AcquireLock = typeof acquireFileMutationLockAsync;

export class CheckpointRetentionService {
  private readonly audit: Pick<
    JsonFileStore<RetentionDocument>,
    'read' | 'write'
  >;
  private readonly acquireLock: AcquireLock;
  private readonly maxRefs: number;
  private readonly lockPath: string;

  constructor(
    private readonly indexStore: Pick<
      CheckpointIndexStore,
      'listThreadDiscovery'
    >,
    private readonly refStore: Pick<
      CheckpointRefStore,
      'listCheckpointsForRetention' | 'deleteCheckpointForRetention'
    >,
    dataDir: string,
    options: {
      maxRefsPerThread?: number;
      acquireLock?: AcquireLock;
      auditStore?: Pick<JsonFileStore<RetentionDocument>, 'read' | 'write'>;
    } = {},
  ) {
    this.maxRefs =
      options.maxRefsPerThread ?? CHECKPOINT_RETENTION_MAX_REFS_PER_THREAD;
    this.acquireLock = options.acquireLock ?? acquireFileMutationLockAsync;
    this.lockPath = join(dataDir, CHECKPOINT_MUTATION_LOCK);
    this.audit =
      options.auditStore ??
      new JsonFileStore(
        join(dataDir, 'checkpoint-retention.json'),
        { version: 1, events: [] },
        { durableAtomicWrite: true, atomicWriteDurability: 'crash-safe' },
      );
  }

  async sweepThread(threadId: string): Promise<CheckpointRetentionResult> {
    const release = await this.acquireLock(this.lockPath, {
      timeoutMs: 15 * 60_000,
    });
    try {
      return await this.sweepExclusive(threadId);
    } finally {
      await release();
    }
  }

  listEvents(threadId: string): CheckpointRetentionResult[] {
    return this.audit
      .read()
      .events.filter((event) => event.threadId === threadId)
      .map((event) => structuredClone(event));
  }

  private async sweepExclusive(
    threadId: string,
  ): Promise<CheckpointRetentionResult> {
    const discovery = this.indexStore.listThreadDiscovery(threadId);
    if (discovery.status !== 'ok') {
      return this.record(threadId, 'deferred', 0, discovery.reason);
    }
    const captured = discovery.records.flatMap((record) =>
      [record.baseline, record.settle].filter(isCaptured),
    );
    const repos = new Set(captured.map((phase) => phase.repoRoot));
    const actual: CapturedCheckpoint[] = [];
    try {
      for (const repoDir of repos) {
        actual.push(
          ...(await this.refStore.listCheckpointsForRetention({
            repoDir,
            threadId,
          })),
        );
      }
    } catch (error) {
      return this.record(threadId, 'deferred', 0, message(error));
    }
    if (actual.length <= this.maxRefs) {
      return this.record(threadId, 'no_op', 0);
    }
    const known = new Map(captured.map((phase) => [phase.checkpointId, phase]));
    if (actual.some((checkpoint) => !known.has(checkpoint.checkpointId))) {
      return this.record(threadId, 'deferred', 0, 'unindexed_checkpoint_ref');
    }
    const protectedBaseline = [...discovery.records]
      .map((record) => record.baseline)
      .filter(isCaptured)
      .sort((a, b) =>
        b.capturedAt.localeCompare(a.capturedAt),
      )[0]?.checkpointId;
    const candidates = actual
      .filter((checkpoint) => checkpoint.checkpointId !== protectedBaseline)
      .sort(
        (a, b) =>
          a.capturedAt.localeCompare(b.capturedAt) ||
          a.checkpointId.localeCompare(b.checkpointId),
      )
      .slice(0, actual.length - this.maxRefs);
    // Persist mutation intent before the first unlink. If the process dies or
    // the completion write fails, inspection retains a durable failed/in-
    // progress receipt rather than a later retry falsely becoming the only
    // no-op history after refs already disappeared.
    const eventId = this.startMutation(threadId);
    let removed = 0;
    try {
      for (const checkpoint of candidates) {
        const outcome = await this.refStore.deleteCheckpointForRetention({
          repoDir: checkpoint.repoRoot,
          threadId,
          checkpointId: checkpoint.checkpointId,
        });
        if (outcome === 'deleted') removed += 1;
      }
    } catch (error) {
      return this.finishMutation(
        eventId,
        threadId,
        'failed',
        removed,
        message(error),
      );
    }
    return this.finishMutation(
      eventId,
      threadId,
      removed > 0 ? 'reclaimed' : 'no_op',
      removed,
    );
  }

  private startMutation(threadId: string): string {
    const event = this.newEvent(threadId, 'failed', 0, 'retention_in_progress');
    const document = this.audit.read();
    document.events.push(event);
    this.audit.write(document);
    return event.id;
  }

  private finishMutation(
    id: string,
    threadId: string,
    status: CheckpointRetentionResult['status'],
    removed: number,
    detail?: string,
  ): CheckpointRetentionResult {
    const document = this.audit.read();
    const index = document.events.findIndex((event) => event.id === id);
    const event = this.newEvent(threadId, status, removed, detail, id);
    if (index < 0) document.events.push(event);
    else document.events[index] = event;
    this.audit.write(document);
    return event;
  }

  private record(
    threadId: string,
    status: CheckpointRetentionResult['status'],
    removed: number,
    detail?: string,
  ): CheckpointRetentionResult {
    const event = this.newEvent(threadId, status, removed, detail);
    const document = this.audit.read();
    document.events.push(event);
    this.audit.write(document);
    return event;
  }

  private newEvent(
    threadId: string,
    status: CheckpointRetentionResult['status'],
    removed: number,
    detail?: string,
    id: string = randomUUID(),
  ): CheckpointRetentionResult {
    return {
      id,
      threadId,
      status,
      removed,
      recordedAt: new Date().toISOString(),
      ...(detail
        ? { detail: detail.slice(0, CHECKPOINT_RETENTION_DETAIL_MAX_LENGTH) }
        : {}),
    };
  }
}

function isCaptured(
  phase: TurnPhaseCheckpoint | undefined,
): phase is Extract<TurnPhaseCheckpoint, { status: 'captured' }> {
  return phase?.status === 'captured';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error);
}
