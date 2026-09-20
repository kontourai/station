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
const RESTORE_PREVIEW_TTL_MS = 5 * 60_000;
const RESTORE_PREVIEW_PATH_LIMIT = 200;
export const RESTORE_LOCK_TIMEOUT_MS = 15 * 60_000;
type AcquireRestoreLock = typeof acquireFileMutationLockAsync;

type CheckpointRestoreEvent = {
  id: string;
  threadId: string;
  turnId: string;
  phase: TurnCheckpointPhase;
  checkpointId: string;
  commitSha: string;
  treeSha: string;
  repoRoot: string;
  restoredAt: string;
  previewId: string;
  previousTreeSha: string;
  recoveryRef: string;
};

type CheckpointRestoreReceipt = CheckpointRestoreEvent & {
  restored: boolean;
};

type RestoreDocument = { version: 1; events: CheckpointRestoreEvent[] };

export type CheckpointRestorePreview = {
  previewId: string;
  threadId: string;
  turnId: string;
  phase: TurnCheckpointPhase;
  checkpointId: string;
  repoRoot: string;
  targetTreeSha: string;
  currentTreeSha: string;
  paths: Array<{ path: string; status: string }>;
  pathsTruncated: boolean;
  expiresAt: string;
};

type StoredPreview = CheckpointRestorePreview & { ownerKey: string };

export class CheckpointRestoreService {
  private readonly audit: JsonFileStore<RestoreDocument>;
  private readonly lockPath: string;
  private readonly acquireLock: AcquireRestoreLock;
  private readonly previews = new Map<string, StoredPreview>();

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

  async preview(input: {
    threadId: string;
    turnId: string;
    phase: TurnCheckpointPhase;
    ownerKey: string;
  }): Promise<CheckpointRestorePreview> {
    const target = await this.resolveTarget(input);
    const currentTreeSha = await snapshotWorkingTree(target.repoRoot);
    const paths = await changedPaths(
      target.repoRoot,
      currentTreeSha,
      target.treeSha,
    );
    const preview: StoredPreview = {
      previewId: randomUUID(),
      ...input,
      checkpointId: target.checkpointId,
      repoRoot: target.repoRoot,
      targetTreeSha: target.treeSha,
      currentTreeSha,
      paths: paths.slice(0, RESTORE_PREVIEW_PATH_LIMIT),
      pathsTruncated: paths.length > RESTORE_PREVIEW_PATH_LIMIT,
      expiresAt: new Date(Date.now() + RESTORE_PREVIEW_TTL_MS).toISOString(),
    };
    this.previews.set(preview.previewId, preview);
    const { ownerKey: _ownerKey, ...publicPreview } = preview;
    return publicPreview;
  }

  async restore(input: {
    threadId: string;
    turnId: string;
    previewId: string;
    expectedCurrentTreeSha: string;
    ownerKey: string;
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

  workspaceForPreview(previewId: string, ownerKey: string): string {
    const preview = this.previews.get(previewId);
    if (
      !preview ||
      preview.ownerKey !== ownerKey ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      throw new CheckpointRestoreError('preview_invalid');
    return preview.repoRoot;
  }

  private async restoreExclusive(input: {
    threadId: string;
    turnId: string;
    previewId: string;
    expectedCurrentTreeSha: string;
    ownerKey: string;
    confirmed: true;
  }): Promise<CheckpointRestoreReceipt> {
    if (input.confirmed !== true)
      throw new CheckpointRestoreError('confirmation_required');
    const preview = this.previews.get(input.previewId);
    this.previews.delete(input.previewId);
    if (
      !preview ||
      preview.ownerKey !== input.ownerKey ||
      preview.threadId !== input.threadId ||
      preview.turnId !== input.turnId ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      throw new CheckpointRestoreError('preview_invalid');
    if (input.expectedCurrentTreeSha !== preview.currentTreeSha)
      throw new CheckpointRestoreError('workspace_changed');
    const target = await this.resolveTarget(preview);
    if (
      target.checkpointId !== preview.checkpointId ||
      target.treeSha !== preview.targetTreeSha ||
      target.repoRoot !== preview.repoRoot
    )
      throw new CheckpointRestoreError('checkpoint_identity_mismatch');
    const currentTree = await snapshotWorkingTree(preview.repoRoot);
    if (currentTree !== preview.currentTreeSha)
      throw new CheckpointRestoreError('workspace_changed');
    const recoveryRef = `refs/station/restore-recovery/${input.previewId}`;
    await execGit(['update-ref', recoveryRef, currentTree], {
      cwd: preview.repoRoot,
      timeout: RESTORE_GIT_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    const previous = [...this.audit.read().events]
      .reverse()
      .find((event) => event.previewId === input.previewId);
    if (currentTree === preview.targetTreeSha && previous)
      return { ...previous, restored: false };
    if (currentTree !== preview.targetTreeSha)
      await materializeTree(preview.repoRoot, target.commitSha);

    const verifiedTree = await snapshotWorkingTree(preview.repoRoot);
    if (verifiedTree !== preview.targetTreeSha)
      throw new CheckpointRestoreError('restore_verification_failed');
    const event: CheckpointRestoreEvent = {
      id: randomUUID(),
      threadId: preview.threadId,
      turnId: preview.turnId,
      phase: preview.phase,
      checkpointId: preview.checkpointId,
      commitSha: target.commitSha,
      treeSha: preview.targetTreeSha,
      repoRoot: preview.repoRoot,
      restoredAt: new Date().toISOString(),
      previewId: preview.previewId,
      previousTreeSha: currentTree,
      recoveryRef,
    };
    const document = this.audit.read();
    document.events.push(event);
    this.audit.write(document);
    return { ...event, restored: currentTree !== preview.targetTreeSha };
  }

  private async resolveTarget(input: {
    threadId: string;
    turnId: string;
    phase: TurnCheckpointPhase;
  }) {
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

    return phase;
  }
}

async function changedPaths(repoRoot: string, current: string, target: string) {
  const output = await execGit(
    ['diff', '--name-status', '--no-renames', current, target, '--'],
    { cwd: repoRoot, timeout: RESTORE_GIT_TIMEOUT_MS, encoding: 'utf-8' },
  );
  return output.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status = 'M', ...parts] = line.split('\t');
      return { status, path: parts.join('\t') };
    });
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

class CheckpointRestoreError extends Error {
  constructor(
    readonly reason:
      | 'confirmation_required'
      | 'checkpoint_missing'
      | 'checkpoint_failed'
      | 'checkpoint_pruned'
      | 'checkpoint_identity_mismatch'
      | 'restore_verification_failed'
      | 'preview_invalid'
      | 'workspace_changed',
  ) {
    super(reason);
  }
}
