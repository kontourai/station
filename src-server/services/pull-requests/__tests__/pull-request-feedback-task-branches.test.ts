/**
 * Project defaults' Task-branch discovery against a real store file: only
 * an open pull request whose head is exactly the Task's own recorded
 * branch, in the Project's own repository and not from a fork, becomes a
 * derived link; it is claimed only when no claim row exists, it was never
 * removed from the chat, and the defaults' setter may continue the lead's
 * chat. The defaults' later changes never touch a claim, and reads stay
 * inside their bounds (3 a tick, a Task at most every 10 minutes after its
 * lead's turn, otherwise every 30).
 */
import { join } from 'node:path';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  type PullRequestByHead,
  type PullRequestsByHeadResult,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import type { WorktreeSessionMetadata } from '@kontourai/station-contracts/workspace-isolation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { PullRequestFeedbackStore } from '../pull-request-feedback-store.js';
import {
  PullRequestFeedbackTaskBranches,
  type TaskBranchTask,
} from '../pull-request-feedback-task-branches.js';

const MINUTE = 60_000;
const T0 = Date.parse('2026-11-16T12:00:00.000Z');
const BRANCH = 'station/task/t-91';
const PR: PullRequestLinkIdentity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const PR_KEY = pullRequestFeedbackKey(PR);
const PROJECT = {
  id: 'p-1',
  slug: 'widgets',
  createdAt: '2026-01-01T00:00:00.000Z',
  workingDirectory: '/repos/widgets',
};
const tempDir = trackTempDirs();
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const own = (
  overrides: Partial<PullRequestByHead> = {},
): PullRequestByHead => ({
  ref: '42',
  headRefName: BRANCH,
  headOwner: 'Acme',
  crossRepository: false,
  url: 'https://github.com/acme/widgets/pull/42',
  ...overrides,
});

function worktreeFor(taskId: string, branch = BRANCH): WorktreeSessionMetadata {
  return {
    mode: 'worktree',
    repoPath: '/repos/widgets',
    path: `/worktrees/${taskId}`,
    branch,
    baseRef: 'main',
    cleanupPolicy: 'cleanup',
    preserveOnFailure: false,
    createdAt: '2026-11-16T10:00:00.000Z',
    owner: { kind: 'task', taskId },
  };
}

function setup(
  options: {
    answer?: (branch: string) => PullRequestsByHeadResult;
    tasks?: TaskBranchTask[];
    /** Runs during the forge read, before it answers. */
    duringRead?: () => void;
  } = {},
) {
  const store = new PullRequestFeedbackStore(
    join(tempDir('pr-feedback-branches-'), 'pull-request-feedback.sqlite'),
  );
  closers.push(() => store.close());
  const state = {
    project: { ...PROJECT },
    now: T0,
    /** The head review preview. */
    headReview: false,
    mayContinue: true,
    stopped: false,
    repositories: {
      '/repos/widgets': 'github.com/acme/widgets',
    } as Record<string, string>,
    tasks: options.tasks ?? [
      {
        id: 't-91',
        createdAt: '2026-11-16T09:00:00.000Z',
        projectId: 'p-1',
        status: 'in_progress',
        sessionId: 'lead-91',
      },
    ],
    worktrees: { 't-91': worktreeFor('t-91') } as Record<
      string,
      WorktreeSessionMetadata | undefined
    >,
  };
  const reads: Array<{ host: string; repository: unknown; branch: string }> =
    [];
  const warn = vi.fn();
  const mayContinueCalls: Array<[string, string]> = [];
  const provider = {
    id: 'github',
    canServeHost: (host: string) => host === 'github.com',
    findOpenPullRequestsByHead: async (
      context: { host: string; repository: unknown },
      branch: string,
    ) => {
      reads.push({ ...context, branch });
      options.duringRead?.();
      return (
        options.answer?.(branch) ?? { state: 'read', pullRequests: [own()] }
      );
    },
  } as unknown as IPullRequestProvider;
  const branches = new PullRequestFeedbackTaskBranches({
    enabled: () => true,
    store: () => store,
    readStore: () => store,
    tasks: () => state.tasks,
    project: (idOrSlug) =>
      idOrSlug === state.project.id || idOrSlug === state.project.slug
        ? state.project
        : undefined,
    taskWorktree: (taskId) => state.worktrees[taskId],
    repositoryIdentity: async (path) =>
      state.repositories[path] ?? `local:${path}`,
    providers: () => [provider],
    conversationOf: (sessionId) => `chat-${sessionId}`,
    session: () => ({ state: state.stopped ? 'stopped' : 'idle' }),
    mayContinue: (conversationId, userId) => {
      mayContinueCalls.push([conversationId, userId]);
      return state.mayContinue;
    },
    headReviewEnabled: () => state.headReview,
    logger: { warn },
    now: () => state.now,
  });
  const turnOn = (
    setBy = 'owner',
    settings = {
      fixFailingChecks: true,
      addressReviewComments: false,
      reviewEachHead: false,
    },
  ) =>
    store.writeProjectDefaults({
      projectId: PROJECT.id,
      projectCreatedAt: PROJECT.createdAt,
      settings,
      setBy,
      now: new Date(T0).toISOString(),
    });
  const discover = () =>
    branches.discover({
      now: state.now,
      signal: new AbortController().signal,
    });
  return {
    store,
    state,
    reads,
    warn,
    mayContinueCalls,
    branches,
    turnOn,
    discover,
  };
}

describe('Task-branch discovery', () => {
  it('claims the exact Task branch pull request with the defaults, as their setter', async () => {
    const t = setup();
    t.turnOn('owner');
    expect(await t.discover()).toBe('ok');
    expect(t.reads).toEqual([
      {
        host: 'github.com',
        repository: { owner: 'acme', name: 'widgets' },
        branch: BRANCH,
      },
    ]);
    expect(t.store.derivedLinks('chat-lead-91')).toMatchObject([
      { taskId: 't-91', prKey: PR_KEY, identity: PR, headRef: BRANCH },
    ]);
    expect(t.store.claim(PR_KEY)).toMatchObject({
      conversationId: 'chat-lead-91',
      settings: {
        fixFailingChecks: true,
        addressReviewComments: false,
        reviewEachHead: false,
      },
      enabledBy: 'owner',
      origin: 'project-default',
    });
    expect(t.branches.derivedLinks('chat-lead-91')).toEqual([
      {
        ...PR,
        source: 'branch-derived',
        linkedAt: new Date(T0).toISOString(),
      },
    ]);
  });

  it.each([
    ['a fork (cross-repository)', own({ crossRepository: true })],
    ['a fork owner with the same branch name', own({ headOwner: 'mallory' })],
    ['another branch', own({ headRefName: `${BRANCH}-2` })],
  ])('refuses %s', async (_name, row) => {
    const t = setup({
      answer: () => ({ state: 'read', pullRequests: [row] }),
    });
    t.turnOn();
    await t.discover();
    expect(t.store.derivedLinks('chat-lead-91')).toEqual([]);
    expect(t.store.allClaims()).toEqual([]);
  });

  it('refuses a worktree of another repository, and a Project with no forge origin, before any read', async () => {
    const t = setup();
    t.turnOn();
    t.state.repositories['/repos/widgets'] = 'github.com/acme/widgets';
    t.state.worktrees['t-91'] = {
      ...worktreeFor('t-91'),
      repoPath: '/repos/other',
    };
    t.state.repositories['/repos/other'] = 'github.com/acme/other';
    await t.discover();
    expect(t.reads).toEqual([]);
    t.state.worktrees['t-91'] = worktreeFor('t-91');
    delete t.state.repositories['/repos/widgets'];
    t.state.now += 31 * MINUTE;
    await t.discover();
    expect(t.reads).toEqual([]);
    expect(t.store.allClaims()).toEqual([]);
  });

  it('never reads a Task without its own worktree, a finished Task, or one whose lead stopped', async () => {
    const t = setup();
    t.turnOn();
    t.state.worktrees['t-91'] = { ...worktreeFor('t-91'), owner: undefined };
    await t.discover();
    t.state.worktrees['t-91'] = worktreeFor('t-91');
    t.state.stopped = true;
    await t.discover();
    t.state.stopped = false;
    t.state.tasks = [{ ...t.state.tasks[0]!, status: 'done' }];
    await t.discover();
    expect(t.reads).toEqual([]);
  });

  it('leaves an existing claim row alone, even one with every switch off', async () => {
    const t = setup();
    t.turnOn();
    t.store.writeClaim({
      prKey: PR_KEY,
      identity: PR,
      conversationId: 'someone-else',
      settings: {
        fixFailingChecks: false,
        addressReviewComments: false,
        reviewEachHead: false,
      },
      enabledBy: 'person',
      now: '2026-11-16T11:00:00.000Z',
    });
    await t.discover();
    expect(t.store.claim(PR_KEY)).toMatchObject({
      conversationId: 'someone-else',
      settings: { fixFailingChecks: false, addressReviewComments: false },
      enabledBy: 'person',
    });
    expect(t.store.claim(PR_KEY)?.origin).toBeUndefined();
  });

  it('makes no claim when the setter may not continue the lead chat; the link still shows', async () => {
    const t = setup();
    t.turnOn();
    t.state.mayContinue = false;
    await t.discover();
    expect(t.store.derivedLinks('chat-lead-91')).toHaveLength(1);
    expect(t.store.allClaims()).toEqual([]);
  });

  it('a pull request removed from the chat is never claimed again', async () => {
    const t = setup();
    t.turnOn();
    t.state.mayContinue = false;
    await t.discover();
    expect(t.branches.dismiss('chat-lead-91', PR)).toBe(true);
    expect(t.branches.derivedLinks('chat-lead-91')).toEqual([]);
    expect(
      t.store.autoClaim({
        prKey: PR_KEY,
        identity: PR,
        taskId: 't-91',
        conversationId: 'chat-lead-91',
        settings: {
          fixFailingChecks: true,
          addressReviewComments: true,
          reviewEachHead: false,
        },
        enabledBy: 'owner',
        now: new Date(T0).toISOString(),
      }),
    ).toBe('removed');
    // Nor is the Task looked at again.
    t.state.mayContinue = true;
    t.state.now += 60 * MINUTE;
    await t.discover();
    expect(t.reads).toHaveLength(1);
    expect(t.store.allClaims()).toEqual([]);
  });

  it('turning the defaults off leaves the claims they made on, and counts them', async () => {
    const t = setup();
    t.turnOn();
    await t.discover();
    t.branches.writeDefaults(
      'widgets',
      { fixFailingChecks: false, addressReviewComments: false },
      'owner',
    );
    expect(t.store.claim(PR_KEY)?.settings.fixFailingChecks).toBe(true);
    expect(t.branches.defaults('widgets', true, () => true)).toEqual({
      projectSlug: 'widgets',
      settings: {
        fixFailingChecks: false,
        addressReviewComments: false,
        reviewEachHead: false,
      },
      canChange: true,
      stillOn: 1,
    });
    // A person changing it from the chat makes it theirs: no longer counted.
    t.store.writeClaim({
      prKey: PR_KEY,
      identity: PR,
      conversationId: 'chat-lead-91',
      settings: {
        fixFailingChecks: true,
        addressReviewComments: true,
        reviewEachHead: false,
      },
      enabledBy: 'owner',
      now: new Date(T0).toISOString(),
    });
    expect(t.branches.defaults('widgets', true, () => true)?.stillOn).toBe(0);
  });

  it('a defaults write without a switch keeps its stored value', () => {
    const t = setup();
    t.store.writeProjectDefaults({
      projectId: PROJECT.id,
      projectCreatedAt: PROJECT.createdAt,
      settings: {
        fixFailingChecks: false,
        addressReviewComments: false,
        reviewEachHead: true,
      },
      setBy: 'owner',
      now: new Date(T0).toISOString(),
    });
    t.branches.writeDefaults(
      'widgets',
      { fixFailingChecks: true, addressReviewComments: false },
      'owner',
    );
    expect(
      t.store.projectDefaults(PROJECT.id, PROJECT.createdAt)?.settings,
    ).toEqual({
      fixFailingChecks: true,
      addressReviewComments: false,
      reviewEachHead: true,
    });
  });

  it('reads at most 3 Tasks a tick; a Task again after 10 minutes once its lead turned, else 30', async () => {
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      id: `t-${index}`,
      createdAt: '2026-11-16T09:00:00.000Z',
      projectId: 'p-1',
      status: 'in_progress',
      sessionId: `lead-${index}`,
    }));
    const t = setup({
      tasks,
      answer: () => ({ state: 'read', pullRequests: [] }),
    });
    for (const task of tasks)
      t.state.worktrees[task.id] = worktreeFor(
        task.id,
        `station/task/${task.id}`,
      );
    t.turnOn();
    await t.discover();
    expect(t.reads).toHaveLength(3);
    await t.discover();
    expect(t.reads).toHaveLength(5);
    // Nothing is due again within 10 minutes, nudged or not.
    t.branches.nudge('chat-lead-0');
    t.state.now += 9 * MINUTE;
    await t.discover();
    expect(t.reads).toHaveLength(5);
    // After 10 minutes only the nudged Task is read; the sweep waits 30.
    t.state.now += 2 * MINUTE;
    await t.discover();
    expect(t.reads.slice(5).map((read) => read.branch)).toEqual([
      'station/task/t-0',
    ]);
    expect(t.reads).toHaveLength(6);
    t.state.now += 20 * MINUTE;
    await t.discover();
    expect(t.reads).toHaveLength(9);
  });

  it('a rate-limited read asks the poller to back off', async () => {
    const t = setup({
      answer: () => ({
        state: 'unavailable',
        cause: 'rate-limited',
        reason: 'GitHub rate limited the read.',
      }),
    });
    t.turnOn();
    expect(await t.discover()).toBe('rate-limited');
  });

  it('reads nothing while no Project has defaults on', async () => {
    const t = setup();
    await t.discover();
    expect(t.reads).toEqual([]);
  });

  it('asks whether the setter may continue the lead chat, with exactly those two', async () => {
    const t = setup();
    t.turnOn('owner');
    await t.discover();
    expect(t.mayContinueCalls).toEqual([['chat-lead-91', 'owner']]);
  });

  it("an existing claim is reported as a person's, without a failed insert or a warning", async () => {
    const t = setup();
    t.turnOn();
    t.store.writeClaim({
      prKey: PR_KEY,
      identity: PR,
      conversationId: 'someone-else',
      settings: {
        fixFailingChecks: true,
        addressReviewComments: false,
        reviewEachHead: false,
      },
      enabledBy: 'person',
      now: '2026-11-16T11:00:00.000Z',
    });
    expect(
      t.store.autoClaim({
        prKey: PR_KEY,
        identity: PR,
        taskId: 't-91',
        conversationId: 'chat-lead-91',
        settings: {
          fixFailingChecks: true,
          addressReviewComments: true,
          reviewEachHead: false,
        },
        enabledBy: 'owner',
        now: new Date(T0).toISOString(),
      }),
    ).toBe('claim-exists');
    await t.discover();
    expect(t.warn).not.toHaveBeenCalled();
    expect(t.store.claim(PR_KEY)?.conversationId).toBe('someone-else');
  });

  it('reads the defaults of this incarnation of the Project only', async () => {
    const t = setup();
    t.turnOn();
    // The Project removed and created again under the same id.
    t.state.project = { ...PROJECT, createdAt: '2026-11-16T10:00:00.000Z' };
    expect(t.branches.defaults('widgets', true)?.settings).toEqual({
      fixFailingChecks: false,
      addressReviewComments: false,
      reviewEachHead: false,
    });
    await t.discover();
    expect(t.reads).toEqual([]);
    expect(t.store.allClaims()).toEqual([]);
  });

  it('a pull request removed from a Task stays out when the Task is created again', async () => {
    const t = setup();
    t.turnOn();
    await t.discover();
    expect(t.branches.dismiss('chat-lead-91', PR)).toBe(true);
    // Released, then pruned: no claim row is left to hold it.
    t.store.deleteClaim(PR_KEY);
    t.state.tasks = [
      {
        id: 't-91',
        createdAt: '2026-11-17T09:00:00.000Z',
        projectId: 'p-1',
        status: 'in_progress',
        sessionId: 'lead-91b',
      },
    ];
    t.state.now += 31 * MINUTE;
    await t.discover();
    expect(t.reads).toHaveLength(2);
    expect(t.store.derivedLinks('chat-lead-91b')).toEqual([]);
    // Recorded removed for the new incarnation: it is not read again.
    for (const later of [31, 62, 93]) {
      t.state.now += later * MINUTE;
      await t.discover();
    }
    expect(t.reads).toHaveLength(2);
    expect(t.store.allClaims()).toEqual([]);
    expect(
      t.store.autoClaim({
        prKey: PR_KEY,
        identity: PR,
        taskId: 't-91',
        conversationId: 'chat-lead-91b',
        settings: {
          fixFailingChecks: true,
          addressReviewComments: false,
          reviewEachHead: false,
        },
        enabledBy: 'owner',
        now: new Date(t.state.now).toISOString(),
      }),
    ).toBe('removed');
  });

  it('never reads a worktree recorded for another Task', async () => {
    const t = setup();
    t.turnOn();
    t.state.worktrees['t-91'] = {
      ...worktreeFor('t-91'),
      owner: { kind: 'task', taskId: 't-other' },
    };
    await t.discover();
    expect(t.reads).toEqual([]);
  });

  it('defaults turned off during the forge read leave the link but make no claim', async () => {
    let t: ReturnType<typeof setup> | undefined;
    t = setup({
      duringRead: () =>
        t!.branches.writeDefaults(
          'widgets',
          { fixFailingChecks: false, addressReviewComments: false },
          'owner',
        ),
    });
    t.turnOn();
    await t.discover();
    expect(t.store.derivedLinks('chat-lead-91')).toHaveLength(1);
    expect(t.store.allClaims()).toEqual([]);
  });

  it("keeps the forge's spelling of the repository, so a typed link and this one are one pull request", async () => {
    const t = setup({
      answer: () => ({
        state: 'read',
        pullRequests: [own({ url: 'https://github.com/Acme/Widgets/pull/42' })],
      }),
    });
    t.turnOn();
    await t.discover();
    expect(t.branches.derivedLinks('chat-lead-91')).toMatchObject([
      { repository: { owner: 'Acme', name: 'Widgets' }, ref: '42' },
    ]);
    expect(t.store.claim(PR_KEY)?.prKey).toBe(PR_KEY);
  });

  it('counts only open pull requests in chats the reader may read', async () => {
    const t = setup();
    t.turnOn();
    await t.discover();
    expect(t.branches.defaults('widgets', true, () => true)?.stillOn).toBe(1);
    expect(t.branches.defaults('widgets', true, () => false)?.stillOn).toBe(0);
    t.store.setCondition(PR_KEY, {
      state: 'closed',
      at: new Date(T0).toISOString(),
    });
    expect(t.branches.defaults('widgets', true, () => true)?.stillOn).toBe(0);
  });
});

describe('"Review each new head" in Project defaults', () => {
  const REVIEW_ONLY = {
    fixFailingChecks: false,
    addressReviewComments: false,
    reviewEachHead: true,
  };

  it('a default with only review on claims the Task branch pull request, and counts it still on', async () => {
    const t = setup();
    t.state.headReview = true;
    t.turnOn('owner', REVIEW_ONLY);
    expect(await t.discover()).toBe('ok');
    expect(t.store.claim(PR_KEY)?.settings).toEqual(REVIEW_ONLY);
    // Turned off at the Project: the review-only claim still gets review.
    t.turnOn('owner', { ...REVIEW_ONLY, reviewEachHead: false });
    expect(t.branches.defaults('widgets', true, () => true)?.stillOn).toBe(1);
    // While review is not offered it does nothing, so it is not counted.
    t.state.headReview = false;
    expect(t.branches.defaults('widgets', true, () => true)?.stillOn).toBe(0);
  });

  it('with the preview off, review alone claims nothing, is never copied, and cannot be set', async () => {
    const t = setup();
    t.turnOn('owner', REVIEW_ONLY);
    expect(await t.discover()).toBe('ok');
    expect(t.reads).toEqual([]);
    expect(t.store.claim(PR_KEY)).toBeUndefined();
    // A default that also sends claims, without the review switch.
    t.turnOn('owner', { ...REVIEW_ONLY, fixFailingChecks: true });
    expect(await t.discover()).toBe('ok');
    expect(t.store.claim(PR_KEY)?.settings).toEqual({
      fixFailingChecks: true,
      addressReviewComments: false,
      reviewEachHead: false,
    });
    // Off at the Project: that claim (it sends) is still on.
    t.turnOn('owner', { ...REVIEW_ONLY, reviewEachHead: false });
    expect(t.branches.defaults('widgets', true, () => true)?.stillOn).toBe(1);
    // The write cannot change review while it is not offered.
    t.turnOn('owner', { ...REVIEW_ONLY, fixFailingChecks: true });
    t.branches.writeDefaults(
      'widgets',
      { fixFailingChecks: false, reviewEachHead: false },
      'owner',
    );
    expect(
      t.store.projectDefaults(PROJECT.id, PROJECT.createdAt)?.settings
        .reviewEachHead,
    ).toBe(true);
  });
});
