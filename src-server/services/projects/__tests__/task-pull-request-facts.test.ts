import type { TaskKeptDeclaredPullRequest } from '@kontourai/station-contracts';
import type {
  IPullRequestProvider,
  PullRequest,
} from '@kontourai/station-contracts/pull-request-provider';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { describe, expect, test, vi } from 'vitest';
import { readTaskPullRequestFacts } from '../task-pull-request-facts.js';

const NOW = new Date('2026-11-15T12:00:00.000Z');

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    projectId: 'demo',
    title: id,
    description: '',
    priority: 'normal',
    status: 'in_progress',
    createdBy: 'user',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    ...overrides,
  };
}

/** The shape `TaskGraphService.listKeptDeclaredPullRequests*` returns. */
function keep(
  taskId: string,
  ref: string,
  sessionId = 'run-a',
): TaskKeptDeclaredPullRequest {
  return {
    schemaVersion: 1,
    taskId,
    provider: 'github',
    host: 'github.com',
    repository: { owner: 'acme', name: 'app' },
    ref,
    nativeId: ref,
    provenance: {
      sessionId,
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      declarationId: `decl-${taskId}-${ref}`,
      eventId: `event-${taskId}-${ref}`,
    },
    keptAt: `2026-11-10T00:00:0${ref.length}.000Z`,
  };
}

function pullRequest(ref: string, overrides: Partial<PullRequest> = {}) {
  return {
    provider: 'github',
    host: 'github.com',
    ref,
    url: `https://github.com/acme/app/pull/${ref}`,
    repository: { owner: 'acme', name: 'app' },
    title: `PR ${ref}`,
    body: null,
    state: 'OPEN',
    author: { login: 'casey' },
    sourceBranch: `station/task/${ref}`,
    targetBranch: 'main',
    commits: 1,
    reviewStatus: 'NONE',
    comments: 0,
    nativeId: ref,
    mergeability: 'mergeable',
    mergeReadiness: 'clean',
    ...overrides,
  } satisfies PullRequest;
}

function provider(
  read: (ref: string) => Promise<PullRequest>,
): IPullRequestProvider {
  return {
    id: 'github',
    canServeHost: () => true,
    getPullRequestByIdentity: vi.fn(async (_context: unknown, ref: string) => ({
      available: true,
      data: await read(ref),
      effectiveCapabilities: {},
      effectiveMergeMethods: [],
      mergeMethodsSource: 'provider-default',
    })),
  } as unknown as IPullRequestProvider;
}

const read = (
  tasks: TaskRecord[],
  keeps: TaskKeptDeclaredPullRequest[],
  providers: IPullRequestProvider[],
  extra: Partial<Parameters<typeof readTaskPullRequestFacts>[0]> = {},
) =>
  readTaskPullRequestFacts({
    tasks,
    listKept: (taskIds) => keeps.filter((k) => taskIds.includes(k.taskId)),
    canRead: () => true,
    providers: () => providers,
    now: () => NOW,
    ...extra,
  });

describe('readTaskPullRequestFacts', () => {
  test('reads each kept pull request at its identity and carries the board facts', async () => {
    const facts = await read(
      [task('a')],
      [keep('a', '7')],
      [
        provider(async (ref) =>
          pullRequest(ref, { draft: false, reviewDecision: 'approved' }),
        ),
      ],
    );
    expect(facts.tasks.a).toEqual({
      taskCreatedAt: '2026-11-01T00:00:00.000Z',
      pullRequests: [
        {
          provider: 'github',
          host: 'github.com',
          repository: { owner: 'acme', name: 'app' },
          ref: '7',
          url: 'https://github.com/acme/app/pull/7',
          observedAt: NOW.toISOString(),
          status: {
            state: 'current',
            pullRequestState: 'OPEN',
            title: 'PR 7',
            mergeability: 'mergeable',
            sourceBranch: 'station/task/7',
            draft: false,
            reviewDecision: 'approved',
            readiness: 'clean',
          },
        },
      ],
    });
  });

  test('never has more than four provider reads in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = provider(async (ref) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return pullRequest(ref);
    });
    const tasks = Array.from({ length: 6 }, (_, i) => task(`t${i}`));
    const keeps = tasks.flatMap((t, i) => [
      keep(t.id, `${i}1`),
      keep(t.id, `${i}2`),
    ]);
    const facts = await read(tasks, keeps, [slow]);
    expect(peak).toBe(4);
    expect(
      Object.values(facts.tasks).flatMap((entry) =>
        entry.pullRequests.map((fact) => fact.status.state),
      ),
    ).toEqual(Array(12).fill('current'));
  });

  test('omits keeps whose declaring session the request cannot read', async () => {
    const facts = await read(
      [task('a')],
      [keep('a', '7', 'readable'), keep('a', '8', 'hidden')],
      [provider(async (ref) => pullRequest(ref))],
      { canRead: (sessionId) => sessionId === 'readable' },
    );
    expect(facts.tasks.a?.pullRequests.map((fact) => fact.ref)).toEqual(['7']);
  });

  test('reads only live Tasks', async () => {
    const facts = await read(
      [
        task('done', { status: 'done' }),
        task('gone', { status: 'canceled' }),
        task('live'),
      ],
      [keep('done', '1'), keep('gone', '2'), keep('live', '3')],
      [provider(async (ref) => pullRequest(ref))],
    );
    expect(Object.keys(facts.tasks)).toEqual(['live']);
  });

  test('Tasks with nothing kept cost nothing against the bound', () => {
    // A backlog-heavy board: 45 newer Tasks with no pull requests, then one
    // older Task with one. Its pull request is read.
    const tasks = [
      ...Array.from({ length: 45 }, (_, i) =>
        task(`b${String(i).padStart(2, '0')}`, {
          updatedAt: `2026-11-12T00:00:${String(i).padStart(2, '0')}.000Z`,
        }),
      ),
      task('old', { updatedAt: '2026-11-01T00:00:00.000Z' }),
    ];
    return read(
      tasks,
      [keep('old', '7')],
      [provider(async (ref) => pullRequest(ref))],
    ).then((facts) => {
      expect(facts.tasks.old).toEqual({
        taskCreatedAt: '2026-11-01T00:00:00.000Z',
        pullRequests: [
          expect.objectContaining({
            status: expect.objectContaining({ state: 'current' }),
          }),
        ],
      });
    });
  });

  test('past 60 distinct pull requests, the rest are listed unread and their Task is partial', async () => {
    const getPullRequest = vi.fn(async (ref: string) => pullRequest(ref));
    const tasks = Array.from({ length: 31 }, (_, i) =>
      task(`t${String(i).padStart(2, '0')}`, {
        updatedAt: `2026-11-10T00:00:${String(59 - i).padStart(2, '0')}.000Z`,
      }),
    );
    // Two pull requests per Task, newest Task first: 62 in all.
    const keeps = tasks.flatMap((t, i) => [
      keep(t.id, `${i}a`),
      keep(t.id, `${i}b`),
    ]);
    const facts = await read(tasks, keeps, [provider(getPullRequest)]);
    expect(getPullRequest).toHaveBeenCalledTimes(60);
    expect(facts.tasks.t00).not.toHaveProperty('partial');
    expect(facts.tasks.t30).toMatchObject({
      partial: true,
      pullRequests: [
        { status: { state: 'unavailable' } },
        { status: { state: 'unavailable' } },
      ],
    });
    // A pull request kept again after the bound is still read once.
    expect(facts.tasks.t29).not.toHaveProperty('partial');
  });

  test('uses the provider’s narrow status read when it offers one', async () => {
    const full = vi.fn();
    const status = vi.fn(async (_c: unknown, ref: string) => ({
      available: true,
      data: pullRequest(ref),
      effectiveCapabilities: {},
      effectiveMergeMethods: [],
      mergeMethodsSource: 'provider-default',
    }));
    const facts = await read(
      [task('a')],
      [keep('a', '7')],
      [
        {
          id: 'github',
          canServeHost: () => true,
          getPullRequestByIdentity: full,
          getPullRequestStatusByIdentity: status,
        } as unknown as IPullRequestProvider,
      ],
    );
    expect(status).toHaveBeenCalledOnce();
    expect(full).not.toHaveBeenCalled();
    expect(facts.tasks.a?.pullRequests[0]?.status.state).toBe('current');
  });

  test('a read past the deadline is unavailable, not missing', async () => {
    vi.useFakeTimers();
    try {
      const never = provider(() => new Promise<PullRequest>(() => {}));
      const pending = read(
        [task('a')],
        [keep('a', '7'), keep('a', '8')],
        [never],
        {
          deadlineMs: 50,
        },
      );
      await vi.advanceTimersByTimeAsync(60);
      const facts = await pending;
      expect(facts.tasks.a?.pullRequests.map((fact) => fact.status)).toEqual([
        { state: 'unavailable', reason: 'Timed out reading the provider.' },
        { state: 'unavailable', reason: 'Timed out reading the provider.' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a provider that throws yields unavailable, and its siblings still read', async () => {
    const facts = await read(
      [task('a')],
      [keep('a', '7'), keep('a', '8')],
      [
        provider(async (ref) => {
          if (ref === '7') throw new Error('gh exploded');
          return pullRequest(ref);
        }),
      ],
    );
    expect(
      facts.tasks.a?.pullRequests.map((fact) => fact.status.state),
    ).toEqual(['unavailable', 'current']);
    expect(facts.tasks.a?.pullRequests[0]?.status).toEqual({
      state: 'unavailable',
      reason: 'The provider read failed.',
    });
  });

  test('a pull request no provider serves is unsupported', async () => {
    const facts = await read([task('a')], [keep('a', '7')], []);
    expect(facts.tasks.a?.pullRequests[0]?.status.state).toBe('unsupported');
  });

  test('one pull request kept on two Tasks is read once', async () => {
    const getPullRequest = vi.fn(async (ref: string) => pullRequest(ref));
    const facts = await read(
      [task('a'), task('b')],
      [keep('a', '7'), keep('b', '7')],
      [provider(getPullRequest)],
    );
    expect(getPullRequest).toHaveBeenCalledTimes(1);
    expect(facts.tasks.b?.pullRequests[0]?.status.state).toBe('current');
  });
});
