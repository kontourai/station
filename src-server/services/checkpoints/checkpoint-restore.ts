import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { execGit } from '../../utils/git-exec.js';
import { JsonFileStore } from '../infra/json-store.js';
import type {
  CheckpointIndexStore,
  TurnCheckpointPhase,
} from './checkpoint-index-store.js';
import type { CheckpointRefStore } from './checkpoint-ref-store.js';
import { CHECKPOINT_MUTATION_LOCK } from './checkpoint-retention.js';

const RESTORE_GIT_TIMEOUT_MS = 60_000;
export const RESTORE_LOCK_TIMEOUT_MS = 15 * 60_000;
type AcquireRestoreLock = typeof acquireFileMutationLockAsync;

export type CheckpointRestoreEvent = {
  id: string;
  threadId: string;
  turnId: string;
  phase: TurnCheckpointPhase;
  checkpointId: string;
  commitSha: string;
  treeSha: string;
  repoRoot: string;
  restoredAt: string;
};

export type CheckpointRestoreReceipt = CheckpointRestoreEvent & {
  restored: boolean;
};

type RestoreDocument = { version: 1; events: CheckpointRestoreEvent[] };

export class CheckpointRestoreService {
  private readonly audit: JsonFileStore<RestoreDocument>;
  private readonly lockPath: string;
  private readonly acquireLock: AcquireRestoreLock;

  constructor(
    private readonly indexStore: Pick<CheckpointIndexStore, 'readTurn'>,
    private readonly refStore: Pick<CheckpointRefStore, 'readCheckpoint'>,
    dataDir: string,
    options: { acquireLock?: AcquireRestoreLock } = {},
  ) {
    this.audit = new JsonFileStore(
      join(dataDir, 'checkpoint-restores.json'),
      {
        version: 1,
        events: [],
      },
      { durableAtomicWrite: true, atomicWriteDurability: 'crash-safe' },
    );
    this.lockPath = join(dataDir, CHECKPOINT_MUTATION_LOCK);
    this.acquireLock = options.acquireLock ?? acquireFileMutationLockAsync;
  }

  async restore(input: {
    threadId: string;
    turnId: string;
    phase: TurnCheckpointPhase;
    confirmed: true;
  }): Promise<CheckpointRestoreReceipt> {
    // One restore can legitimately spend several bounded 60s Git calls
    // resolving, snapshotting, materializing, and verifying. The shared
    // lock must wait longer than that transaction or a duplicate request
    // fails at the old generic 10s default instead of serializing to the
    // same audited no-op receipt.
    const release = await this.acquireLock(this.lockPath, {
      timeoutMs: RESTORE_LOCK_TIMEOUT_MS,
    });
    try {
      return await this.restoreExclusive(input);
    } finally {
      await release();
    }
  }

  listEvents(threadId: string): CheckpointRestoreEvent[] {
    return this.audit
      .read()
      .events.filter((event) => event.threadId === threadId)
      .map((event) => structuredClone(event));
  }

  private async restoreExclusive(input: {
    threadId: string;
    turnId: string;
    phase: TurnCheckpointPhase;
    confirmed: true;
  }): Promise<CheckpointRestoreReceipt> {
    if (input.confirmed !== true)
      throw new CheckpointRestoreError('confirmation_required');
    const record = this.indexStore.readTurn(input.threadId, input.turnId);
    const phase = record?.[input.phase];
    if (!phase) throw new CheckpointRestoreError('checkpoint_missing');
    if (phase.status === 'failed')
      throw new CheckpointRestoreError('checkpoint_failed');
    if (phase.status !== 'captured')
      throw new CheckpointRestoreError('checkpoint_missing');

    const live = await this.refStore.readCheckpoint({
      repoDir: phase.repoRoot,
      threadId: input.threadId,
      checkpointId: phase.checkpointId,
    });
    if (live.status === 'object_pruned')
      throw new CheckpointRestoreError('checkpoint_pruned');
    if (live.status !== 'ok' || !live.checkpoint)
      throw new CheckpointRestoreError('checkpoint_missing');
    if (
      live.checkpoint.commitSha !== phase.commitSha ||
      live.checkpoint.treeSha !== phase.treeSha
    )
      throw new CheckpointRestoreError('checkpoint_identity_mismatch');

    const currentTree = await snapshotWorkingTree(phase.repoRoot);
    const previous = [...this.audit.read().events]
      .reverse()
      .find(
        (event: CheckpointRestoreEvent) =>
          event.threadId === input.threadId &&
          event.turnId === input.turnId &&
          event.phase === input.phase &&
          event.checkpointId === phase.checkpointId &&
          event.treeSha === phase.treeSha,
      );
    if (currentTree === phase.treeSha && previous)
      return { ...previous, restored: false };
    if (currentTree !== phase.treeSha)
      await materializeTree(phase.repoRoot, phase.commitSha);

    const verifiedTree = await snapshotWorkingTree(phase.repoRoot);
    if (verifiedTree !== phase.treeSha)
      throw new CheckpointRestoreError('restore_verification_failed');
    const event: CheckpointRestoreEvent = {
      id: randomUUID(),
      threadId: input.threadId,
      turnId: input.turnId,
      phase: input.phase,
      checkpointId: phase.checkpointId,
      commitSha: phase.commitSha,
      treeSha: phase.treeSha,
      repoRoot: phase.repoRoot,
      restoredAt: new Date().toISOString(),
    };
    const document = this.audit.read();
    document.events.push(event);
    this.audit.write(document);
    return { ...event, restored: currentTree !== phase.treeSha };
  }
}

async function withTemporaryIndex<T>(
  run: (index: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'station-restore-'));
  try {
    return await run(join(dir, 'index'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function snapshotWorkingTree(repoRoot: string): Promise<string> {
  return withTemporaryIndex(async (index) => {
    const options = {
      cwd: repoRoot,
      encoding: 'utf-8' as const,
      timeout: RESTORE_GIT_TIMEOUT_MS,
      env: { GIT_INDEX_FILE: index },
    };
    await execGit(['read-tree', 'HEAD'], options);
    await execGit(['add', '-A', '--', '.'], options);
    return (await execGit(['write-tree'], options)).stdout.trim();
  });
}

async function materializeTree(
  repoRoot: string,
  commitSha: string,
): Promise<void> {
  await withTemporaryIndex(async (index) => {
    const options = {
      cwd: repoRoot,
      encoding: 'utf-8' as const,
      timeout: RESTORE_GIT_TIMEOUT_MS,
      env: { GIT_INDEX_FILE: index },
    };
    await execGit(['read-tree', 'HEAD'], options);
    // Remove only untracked, non-ignored files. Ignored build/config material is not part of checkpoints.
    await execGit(['clean', '-fd', '--', '.'], options);
    await execGit(
      ['read-tree', '--reset', '-u', `${commitSha}^{tree}`],
      options,
    );
  });
}

export class CheckpointRestoreError extends Error {
  constructor(
    readonly reason:
      | 'confirmation_required'
      | 'checkpoint_missing'
      | 'checkpoint_failed'
      | 'checkpoint_pruned'
      | 'checkpoint_identity_mismatch'
      | 'restore_verification_failed',
  ) {
    super(reason);
  }
}
