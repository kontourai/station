import type {
  TurnChangedFile,
  TurnChangedFiles,
} from '@kontourai/station-contracts/turn-changed-files';
import { mapWithConcurrency } from '../../utils/bounded-async.js';
import { execGit } from '../../utils/git-exec.js';
import type {
  TurnCheckpointRecord,
  TurnPhaseCheckpoint,
} from './checkpoint-index-store.js';
import type { CheckpointRefStore } from './checkpoint-ref-store.js';

const MAX_SERVED_TURN_RECORDS = 200;
const CHANGED_FILE_READ_CONCURRENCY = 4;
const MAX_CHANGED_FILES_PER_TURN = 500;
const MAX_DIFF_OUTPUT_BYTES = 512 * 1024;

type GitDiffRunner = typeof execGit;

interface CheckpointReadBounds {
  maxRecords?: number;
  diffConcurrency?: number;
  maxChangedFiles?: number;
  runGit?: GitDiffRunner;
}

/**
 * archive#2802 fix round (M3): the read path composes the home index with
 * live object verification. The index alone cannot be served as truth for
 * `captured` records — after `gc.reflogExpire` (default 90 days) the
 * reflog entry goes away, `git gc` prunes the checkpoint commit, and the
 * index still says `captured` with a commitSha that no longer resolves. A
 * durability bound you do not observe on read is indistinguishable from no
 * bound, so every `captured` phase served to a caller carries a computed
 * `objectStatus`:
 *
 * - `ok` — ref present, object present (a real, restorable checkpoint)
 * - `object_pruned` — ref present, object gone (expired + gced)
 * - `missing` — no ref (deleted/pruned thread, or the repository is
 *   unreachable)
 *
 * Non-captured phases (skipped/failed/not_applicable) are facts about the
 * past, not claims about present git state — they are served verbatim
 * with no annotation.
 */
export type ServedTurnPhaseCheckpoint = TurnPhaseCheckpoint & {
  objectStatus?: 'ok' | 'missing' | 'object_pruned';
};

export type ServedTurnCheckpointRecord = Omit<
  TurnCheckpointRecord,
  'baseline' | 'settle'
> & {
  baseline?: ServedTurnPhaseCheckpoint;
  settle?: ServedTurnPhaseCheckpoint;
  changedFiles: TurnChangedFiles;
};

export async function listThreadRecordsWithObjectStatus(
  indexStore: { listThread(threadId: string): TurnCheckpointRecord[] },
  refStore: CheckpointRefStore,
  threadId: string,
  bounds: CheckpointReadBounds = {},
): Promise<ServedTurnCheckpointRecord[]> {
  const maxRecords = bounds.maxRecords ?? MAX_SERVED_TURN_RECORDS;
  const records = indexStore.listThread(threadId).slice(-maxRecords);
  if (records.length === 0) return [];

  // Captured phases grouped by the repo they were captured in (a project
  // can move or be re-bound between turns; each repo verifies its own).
  const byRepo = new Map<
    string,
    Array<{ checkpointId: string; commitSha: string }>
  >();
  for (const record of records) {
    for (const phase of [record.baseline, record.settle]) {
      if (phase?.status === 'captured') {
        const group = byRepo.get(phase.repoRoot) ?? [];
        group.push({
          checkpointId: phase.checkpointId,
          commitSha: phase.commitSha,
        });
        byRepo.set(phase.repoRoot, group);
      }
    }
  }
  const verdicts = new Map<
    string,
    Map<string, 'ok' | 'missing' | 'object_pruned'>
  >();
  await Promise.all(
    [...byRepo.entries()].map(async ([repoRoot, checkpoints]) => {
      verdicts.set(
        repoRoot,
        await refStore.verifyThreadCheckpoints({
          repoDir: repoRoot,
          threadId,
          checkpoints,
        }),
      );
    }),
  );

  return mapWithConcurrency(
    records,
    bounds.diffConcurrency ?? CHANGED_FILE_READ_CONCURRENCY,
    async (record) => {
      const baseline = annotatePhase(record.baseline, verdicts);
      const settle = annotatePhase(record.settle, verdicts);
      return {
        ...record,
        baseline,
        settle,
        changedFiles: await changedFilesBetween(baseline, settle, {
          maxChangedFiles: bounds.maxChangedFiles ?? MAX_CHANGED_FILES_PER_TURN,
          runGit: bounds.runGit ?? execGit,
        }),
      };
    },
  );
}

async function changedFilesBetween(
  baseline: ServedTurnPhaseCheckpoint | undefined,
  settle: ServedTurnPhaseCheckpoint | undefined,
  options: { maxChangedFiles: number; runGit: GitDiffRunner },
): Promise<TurnChangedFiles> {
  if (!baseline || !settle)
    return { status: 'unavailable', reason: 'checkpoint_missing' };
  if (baseline.status === 'failed' || settle.status === 'failed')
    return { status: 'unavailable', reason: 'checkpoint_failed' };
  if (baseline.status !== 'captured' || settle.status !== 'captured')
    return { status: 'unavailable', reason: 'checkpoint_missing' };
  if (
    baseline.objectStatus === 'object_pruned' ||
    settle.objectStatus === 'object_pruned'
  )
    return { status: 'unavailable', reason: 'checkpoint_pruned' };
  if (baseline.objectStatus !== 'ok' || settle.objectStatus !== 'ok')
    return { status: 'unavailable', reason: 'checkpoint_missing' };
  if (baseline.repoRoot !== settle.repoRoot)
    return { status: 'unavailable', reason: 'repository_changed' };
  if (
    !/^[0-9a-f]{40,64}$/.test(baseline.commitSha) ||
    !/^[0-9a-f]{40,64}$/.test(settle.commitSha)
  )
    return { status: 'unavailable', reason: 'checkpoint_identity_invalid' };

  try {
    const { stdout } = await options.runGit(
      [
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        '--end-of-options',
        baseline.commitSha,
        settle.commitSha,
      ],
      {
        cwd: baseline.repoRoot,
        encoding: 'utf-8',
        timeout: 60_000,
        maxBuffer: MAX_DIFF_OUTPUT_BYTES,
      },
    );
    const fields = stdout.split('\0');
    if (fields.at(-1) === '') fields.pop();
    const files: TurnChangedFile[] = [];
    for (let index = 0; index < fields.length; ) {
      const code = fields[index++];
      if (!code) throw new Error('missing diff status');
      if (code.startsWith('R')) {
        const previousPath = fields[index++];
        const path = fields[index++];
        if (!previousPath || !path) throw new Error('malformed rename');
        files.push({ status: 'renamed', previousPath, path });
        if (files.length > options.maxChangedFiles) {
          return {
            status: 'unavailable',
            reason: 'diff_output_limit_exceeded',
          };
        }
        continue;
      }
      const path = fields[index++];
      if (!path) throw new Error('malformed changed path');
      const status =
        code === 'A'
          ? 'added'
          : code === 'D'
            ? 'deleted'
            : code === 'M' || code === 'T'
              ? 'modified'
              : null;
      if (!status) throw new Error(`unsupported diff status: ${code}`);
      files.push({ status, path });
      if (files.length > options.maxChangedFiles) {
        return {
          status: 'unavailable',
          reason: 'diff_output_limit_exceeded',
        };
      }
    }
    files.sort((left, right) =>
      left.path.localeCompare(right.path, 'en', { sensitivity: 'variant' }),
    );
    return { status: 'available', files };
  } catch {
    return { status: 'unavailable', reason: 'diff_failed' };
  }
}

function annotatePhase(
  phase: TurnPhaseCheckpoint | undefined,
  verdicts: Map<string, Map<string, 'ok' | 'missing' | 'object_pruned'>>,
): ServedTurnPhaseCheckpoint | undefined {
  if (!phase) return phase;
  if (phase.status !== 'captured') return phase;
  return {
    ...phase,
    objectStatus:
      verdicts.get(phase.repoRoot)?.get(phase.checkpointId) ?? 'missing',
  };
}
