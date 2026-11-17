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
 * Bounded per request: at most {@link MAX_PULL_REQUESTS} distinct pull
 * requests are read, those kept on the most recently updated Tasks first,
 * four at a time, within one deadline. Tasks with nothing kept cost nothing.
 * Anything past the bound is still listed, as `unavailable`, and its Task is
 * marked `partial`. Reads use the provider's narrow status read, which
 * shares one in-flight forge call per pull request and retains it for 150 s
 * (GitHub), longer than the board's 120 s refresh.
 *
 * The deadline bounds the answer, not the reads. gh cannot be cancelled, and
 * a read that has not started by the deadline is still started afterwards,
 * four at a time in the background, so the cache is warm for the next
 * request: a board with more pull requests than one deadline can read
 * answers some of them `unavailable` once, then all of them on the next
 * refresh. A later request joins those reads rather than repeating them,
 * so refreshes do not pile reads up. Each fact's `observedAt` is when the
 * forge was read, which for a shared answer can be earlier than the request.
 */
import type { TaskKeptDeclaredPullRequest } from '@kontourai/station-contracts';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import type {
  TaskPullRequestFact,
  TaskPullRequestFactsProjection,
  TaskPullRequestFeedbackFact,
} from '@kontourai/station-contracts/task-lane';
import { readPullRequestByIdentity } from '../pull-requests/pull-request-identity-read.js';

const MAX_PULL_REQUESTS = 60;
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
  /**
   * A pull request's agent feedback, as this request may see it: undefined
   * unless the preview is on and the reader may read the chat that gets it.
   */
  feedbackFor?: (
    identity: Identity,
    /** The Task's own run: only it can be fixing on this card. */
    taskSessionId: string | undefined,
  ) => TaskPullRequestFeedbackFact | undefined;
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

  // What to read, once per pull request even when two Tasks keep it, in
  // Task recency order until the bound.
  const toRead = new Map<string, Identity>();
  const plan = live.map((task) => {
    const keeps = (keepsByTask.get(task.id) ?? []).sort((a, b) =>
      a.keptAt.localeCompare(b.keptAt),
    );
    const reads = keeps.map((keep) => {
      const key = identityKey(keep);
      if (!toRead.has(key) && toRead.size >= MAX_PULL_REQUESTS)
        return {
          keep,
          skipped: `Not read: more than ${MAX_PULL_REQUESTS} pull requests on this board.`,
        };
      toRead.set(key, keep);
      return { keep, skipped: undefined };
    });
    return { task, reads };
  });

  const results = await readBounded(
    [...toRead.entries()],
    input.providers,
    input.deadlineMs ?? DEFAULT_DEADLINE_MS,
    now,
  );

  // Once per pull request and Task run, read after the provider so it is
  // as fresh.
  const feedback = new Map<string, TaskPullRequestFeedbackFact | undefined>();
  const feedbackOf = (keep: Identity, taskSessionId: string | undefined) => {
    const key = `${identityKey(keep)}\u0000${taskSessionId ?? ''}`;
    if (!feedback.has(key))
      feedback.set(key, input.feedbackFor?.(keep, taskSessionId));
    return feedback.get(key);
  };
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
      const read = results.get(identityKey(keep)) as Omit<
        TaskPullRequestFact,
        keyof Identity
      >;
      const fed =
        read.status.state === 'current'
          ? feedbackOf(keep, task.sessionId?.trim() || undefined)
          : undefined;
      return { ...identity, ...read, ...(fed ? { feedback: fed } : {}) };
    });
    tasks[task.id] = {
      taskCreatedAt: task.createdAt,
      pullRequests,
      ...(reads.some((read) => read.skipped) ? { partial: true as const } : {}),
    };
  }
  return { observedAt: now().toISOString(), tasks };
}

/**
 * Reads every identity, {@link READ_CONCURRENCY} at a time, and answers with
 * whatever has been read by the deadline. The workers keep going after it,
 * so every read is eventually made (see the module comment).
 */
async function readBounded(
  entries: readonly [string, Identity][],
  providers: () => IPullRequestProvider[],
  deadlineMs: number,
  now: () => Date,
): Promise<Map<string, Omit<TaskPullRequestFact, keyof Identity>>> {
  const results = new Map<string, Omit<TaskPullRequestFact, keyof Identity>>();
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const [key, identity] = entries[next++] as [string, Identity];
      // Never rejects: a provider failure is an `unavailable` read.
      const read = await readPullRequestByIdentity(providers, identity, {
        status: true,
      });
      results.set(key, toFact(read, identity, now));
    }
  };
  const all = Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, entries.length) }, worker),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
    }),
  ]);
  clearTimeout(timer);
  // A snapshot: reads that finish later land in the provider's cache.
  const answered = new Map(results);
  for (const [key] of entries)
    if (!answered.has(key))
      answered.set(key, {
        observedAt: now().toISOString(),
        status: { state: 'unavailable', reason: TIMED_OUT },
      });
  return answered;
}

function toFact(
  read: Awaited<ReturnType<typeof readPullRequestByIdentity>>,
  identity: Identity,
  now: () => Date,
): Omit<TaskPullRequestFact, keyof Identity> {
  // When the forge answered: the provider's stamp for a shared read.
  const observedAt =
    (read.kind === 'current' && read.observedAt) || now().toISOString();
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
      ...(pullRequest.headSha ? { headSha: pullRequest.headSha } : {}),
      ...(pullRequest.draft !== undefined ? { draft: pullRequest.draft } : {}),
      ...(pullRequest.reviewDecision
        ? { reviewDecision: pullRequest.reviewDecision }
        : {}),
      ...(pullRequest.mergeReadiness
        ? { readiness: pullRequest.mergeReadiness }
        : {}),
      ...(pullRequest.landing ? { landing: pullRequest.landing } : {}),
    },
  };
}
