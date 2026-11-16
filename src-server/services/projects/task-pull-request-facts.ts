/**
 * The pull request facts a Project's Task board derives its lanes from:
 * every pull request kept on each live Task, read at its exact identity from
 * its provider (derived Task lanes).
 *
 * It is a read, never a reconciliation. It moves no Task (close-on-merge
 * belongs to `task-close-out.ts`), stores nothing, and answers a fact it
 * could not read as `unavailable` with a reason rather than leaving it out,
 * so the board can say "PR status unavailable" instead of claiming none.
 *
 * Bounded per request: at most {@link MAX_TASKS} Tasks and
 * {@link MAX_KEEPS_PER_TASK} kept pull requests each are read, four at a
 * time, within one deadline. Anything past a bound is still listed, as
 * `unavailable`, and its Task is marked `partial`.
 */
import type { TaskKeptDeclaredPullRequest } from '@kontourai/station-contracts';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import type {
  TaskPullRequestFact,
  TaskPullRequestFactsProjection,
} from '@kontourai/station-contracts/task-lane';
import { readPullRequestByIdentity } from '../pull-requests/pull-request-identity-read.js';

const MAX_TASKS = 40;
const MAX_KEEPS_PER_TASK = 5;
const READ_CONCURRENCY = 4;
const DEFAULT_DEADLINE_MS = 8_000;

const TIMED_OUT = 'Timed out reading the provider.';

type Identity = Pick<
  TaskKeptDeclaredPullRequest,
  'provider' | 'host' | 'repository' | 'ref'
>;

const identityKey = (keep: Identity) =>
  [
    keep.provider,
    keep.host.toLowerCase(),
    keep.repository.owner.toLowerCase(),
    keep.repository.name.toLowerCase(),
    keep.ref,
  ].join('\u0000');

const isLive = (task: Pick<TaskRecord, 'status'>) =>
  task.status !== 'done' && task.status !== 'canceled';

export async function readTaskPullRequestFacts(input: {
  tasks: readonly TaskRecord[];
  /** Every keep of these Tasks, in one read. */
  listKept: (taskIds: readonly string[]) => TaskKeptDeclaredPullRequest[];
  /** The request's own session read check, per keep's provenance. */
  canRead: (sessionId: string) => boolean;
  providers: () => IPullRequestProvider[];
  deadlineMs?: number;
  now?: () => Date;
}): Promise<TaskPullRequestFactsProjection> {
  const now = input.now ?? (() => new Date());
  const live = [...input.tasks]
    .filter(isLive)
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  const keepsByTask = new Map<string, TaskKeptDeclaredPullRequest[]>();
  for (const keep of input.listKept(live.map((task) => task.id))) {
    // A keep is visible only to a reader of the session that declared it,
    // exactly as `GET /api/tasks/:taskId/kept-pull-requests` filters.
    if (!input.canRead(keep.provenance.sessionId)) continue;
    const list = keepsByTask.get(keep.taskId) ?? [];
    list.push(keep);
    keepsByTask.set(keep.taskId, list);
  }

  // What to read, once per pull request even when two Tasks keep it.
  const toRead = new Map<string, Identity>();
  const plan = live.map((task, index) => {
    const keeps = (keepsByTask.get(task.id) ?? []).sort((a, b) =>
      a.keptAt.localeCompare(b.keptAt),
    );
    const overTasks = index >= MAX_TASKS;
    const reads = keeps.map((keep, at) => {
      const skipped = overTasks
        ? `Not read: more than ${MAX_TASKS} Tasks on this board.`
        : at >= MAX_KEEPS_PER_TASK
          ? `Not read: more than ${MAX_KEEPS_PER_TASK} pull requests kept on this Task.`
          : undefined;
      if (!skipped) toRead.set(identityKey(keep), keep);
      return { keep, skipped };
    });
    return { task, reads };
  });

  const results = await readBounded(
    [...toRead.entries()],
    input.providers,
    input.deadlineMs ?? DEFAULT_DEADLINE_MS,
    now,
  );

  const tasks: TaskPullRequestFactsProjection['tasks'] = {};
  for (const { task, reads } of plan) {
    const pullRequests = reads.map(({ keep, skipped }) => {
      const identity = {
        provider: keep.provider,
        host: keep.host,
        repository: { ...keep.repository },
        ref: keep.ref,
      };
      if (skipped)
        return {
          ...identity,
          observedAt: now().toISOString(),
          status: { state: 'unavailable', reason: skipped },
        } satisfies TaskPullRequestFact;
      return {
        ...identity,
        ...(results.get(identityKey(keep)) as Omit<
          TaskPullRequestFact,
          keyof Identity
        >),
      };
    });
    tasks[task.id] = {
      taskCreatedAt: task.createdAt,
      pullRequests,
      ...(reads.some((read) => read.skipped) ? { partial: true as const } : {}),
    };
  }
  return { observedAt: now().toISOString(), tasks };
}

/** Reads every identity, {@link READ_CONCURRENCY} at a time, by one deadline. */
async function readBounded(
  entries: readonly [string, Identity][],
  providers: () => IPullRequestProvider[],
  deadlineMs: number,
  now: () => Date,
): Promise<Map<string, Omit<TaskPullRequestFact, keyof Identity>>> {
  const results = new Map<string, Omit<TaskPullRequestFact, keyof Identity>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve('timeout');
    }, deadlineMs);
  });
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const [key, identity] = entries[next++] as [string, Identity];
      if (expired) {
        results.set(key, {
          observedAt: now().toISOString(),
          status: { state: 'unavailable', reason: TIMED_OUT },
        });
        continue;
      }
      const read = await Promise.race([
        readPullRequestByIdentity(providers, identity),
        deadline,
      ]);
      results.set(key, toFact(read, identity, now));
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(READ_CONCURRENCY, entries.length) },
        worker,
      ),
    );
  } finally {
    clearTimeout(timer);
  }
  return results;
}

function toFact(
  read: Awaited<ReturnType<typeof readPullRequestByIdentity>> | 'timeout',
  identity: Identity,
  now: () => Date,
): Omit<TaskPullRequestFact, keyof Identity> {
  const observedAt = now().toISOString();
  if (read === 'timeout')
    return { observedAt, status: { state: 'unavailable', reason: TIMED_OUT } };
  if (read.kind === 'unsupported')
    return {
      observedAt,
      status: {
        state: 'unsupported',
        reason: 'No pull request provider here can read this pull request.',
      },
    };
  if (read.kind === 'unavailable')
    return {
      observedAt,
      status: {
        state: 'unavailable',
        reason: read.thrown
          ? 'The provider read failed.'
          : (read.reason ?? 'The provider did not answer.'),
      },
    };
  const pullRequest = read.pullRequest;
  // The provider must answer for the pull request it was asked about.
  if (pullRequest.ref !== identity.ref)
    return {
      observedAt,
      status: {
        state: 'unavailable',
        reason: 'The provider answered for a different pull request.',
      },
    };
  return {
    url: pullRequest.url,
    observedAt,
    status: {
      state: 'current',
      pullRequestState: pullRequest.state,
      title: pullRequest.title,
      mergeability: pullRequest.mergeability,
      sourceBranch: pullRequest.sourceBranch,
      ...(pullRequest.draft !== undefined ? { draft: pullRequest.draft } : {}),
      ...(pullRequest.reviewDecision
        ? { reviewDecision: pullRequest.reviewDecision }
        : {}),
      ...(pullRequest.mergeReadiness
        ? { readiness: pullRequest.mergeReadiness }
        : {}),
    },
  };
}
