/**
 * Task-owned pull requests (#5066), below the routes: the real feedback
 * store in a temp home, the production session readers, a real
 * ThreadInboxDelivery on a real EventStore and OrchestrationService (the
 * inbox harness), the real delivery, and the real pre-tool policy
 * evaluator. Only the engine is scripted, and the Task graph is a small
 * in-memory port (its own hold is covered in the Task graph tests).
 */
import { join } from 'node:path';
import {
  type PullRequestFeedbackObservation,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import type { ProjectPullRequestWatchSettings } from '@kontourai/station-contracts/pull-request-watch';
import type {
  TaskKeptDeclaredPullRequest,
  TaskPullRequestWatchHold,
  TaskRecord,
} from '@kontourai/station-contracts/task-graph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  CONVERSATION,
  createInboxHarness,
  eventually,
  OWNER,
} from '../../../routes/orchestration/__tests__/helpers/thread-inbox-harness.js';
import { createStagedPreToolPolicyEvaluator } from '../../../runtime/agents/pre-tool-policy.js';
import { createFeedbackSessionReaders } from '../../../runtime/routes/runtime-pull-request-feedback.js';
import { normalizeGitHubFeedbackObservation } from '../github-feedback-observation.js';
import { PullRequestFeedbackDelivery } from '../pull-request-feedback-delivery.js';
import { PullRequestFeedbackOwnership } from '../pull-request-feedback-ownership.js';
import { PullRequestFeedbackStore } from '../pull-request-feedback-store.js';
import { PullRequestWatch } from '../pull-request-watch.js';
import recordedFixture from './fixtures/github-feedback-observation.json' with {
  type: 'json',
};

const recorded = structuredClone(recordedFixture) as any;
const IDENTITY = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const PR_KEY = pullRequestFeedbackKey(IDENTITY);
const HEADS = [
  'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  'b2c3d4e5f60718293a4b5c6d7e8f901234567890',
  'c3d4e5f60718293a4b5c6d7e8f90123456789012',
  'd4e5f60718293a4b5c6d7e8f9012345678901234',
];

/** Only its failing checks: no threads, no reviews, no conflict. */
function failing(headSha: string, at = '2026-11-10T12:00:00.000Z') {
  const observation = normalizeGitHubFeedbackObservation(
    recorded,
    IDENTITY,
    at,
  )!;
  return {
    ...observation,
    headSha,
    threads: [],
    threadsTotal: 0,
    reviews: [],
    mergeable: 'mergeable' as const,
  };
}

/** The same pull request with every check finished and passing. */
function green(headSha: string): PullRequestFeedbackObservation {
  const observation = failing(headSha, '2026-11-10T13:00:00.000Z');
  return {
    ...observation,
    reviewDecision: 'APPROVED',
    checks: observation.checks.map((check) => ({
      ...check,
      completed: true,
      conclusion: 'SUCCESS',
    })),
  };
}

const station = createInboxHarness();
const tempDir = trackTempDirs();
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function setup(options: {
  project?: ProjectPullRequestWatchSettings;
  taskWatch?: 'on' | 'off';
}) {
  let delivery: PullRequestFeedbackDelivery | undefined;
  const h = station({
    placementRefusal: (input) => delivery?.placementRefusal(input),
  });
  const first = await h.send('first', 'open the pull request');
  expect(first.status, await first.clone().text()).toBe(200);
  await eventually(() => expect(h.inbox.mustQueue(CONVERSATION)).toBe(false));
  const store = new PullRequestFeedbackStore(
    join(tempDir('pr-watch-'), 'pull-request-feedback.sqlite'),
  );
  closers.push(() => store.close());
  const readers = createFeedbackSessionReaders({
    eventStore: h.store,
    orchestration: h.service,
    inbox: h.inbox,
  });
  const sessionId = h.service.currentConversationSessionId(CONVERSATION);
  const task: TaskRecord = {
    id: 'task-1',
    projectId: 'project-1',
    title: 'Widgets',
    description: '',
    priority: 'normal',
    status: 'in_progress',
    createdBy: OWNER,
    createdAt: '2026-11-10T11:00:00.000Z',
    updatedAt: '2026-11-10T11:00:00.000Z',
    sessionId,
    ...(options.taskWatch ? { pullRequestWatch: options.taskWatch } : {}),
  };
  const keep: TaskKeptDeclaredPullRequest = {
    schemaVersion: 1,
    taskId: task.id,
    provider: IDENTITY.provider,
    host: IDENTITY.host,
    repository: IDENTITY.repository,
    ref: IDENTITY.ref,
    nativeId: 'PR_kw42',
    provenance: {
      sessionId,
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      declarationId: 'declaration-1',
      eventId: 'event-1',
    },
    keptAt: '2026-11-10T11:30:00.000Z',
  };
  const live: TaskRecord[] = [];
  let clock = Date.parse('2026-11-10T12:00:00.000Z');
  live.push(task);
  const holds: Array<{ taskId: string; hold: TaskPullRequestWatchHold }> = [];
  const logger = { warn: vi.fn(), info: vi.fn() };
  const watch = new PullRequestWatch({
    enabled: () => true,
    store: () => store,
    readStore: () => store,
    liveTasks: () => live,
    project: () =>
      options.project ? { pullRequestWatch: options.project } : {},
    keeps: () => [keep],
    conversationOf: readers.conversationOf,
    ownerOf: (conversationId) =>
      h.service.sessionRecordedOwnerId(
        h.service.currentConversationSessionId(conversationId),
      ),
    taskForConversation: (conversationId) =>
      readers.conversationOf(task.sessionId!) === conversationId
        ? task
        : undefined,
    holdTask: async (input) => {
      holds.push(input);
      return true;
    },
    // Each refusal a second apart, so their order is their order.
    now: () => (clock += 1000),
    logger,
  });
  const onReady = vi.fn();
  const notify = vi.fn();
  delivery = new PullRequestFeedbackDelivery({
    store: () => store,
    enabled: () => true,
    session: readers.session,
    mayContinue: (conversationId, userId) =>
      h.inbox.mayContinue(conversationId, userId),
    turnWindows: readers.turnWindows,
    inbox: () => ({
      submit: (input) => h.inbox.submit(input),
      entry: (conversationId, key) => h.inbox.entry(conversationId, key),
    }),
    logger,
    onFixBudgetSpent: (input) => watch.fixBudgetSpent(input),
    onReady,
    notify,
  });
  const observe = (observation: PullRequestFeedbackObservation) =>
    store.writeObservation(PR_KEY, {
      observation,
      observedAt: observation.observedAt,
      unchangedSince: observation.observedAt,
      digest: JSON.stringify(observation),
    });
  const feedbackPrompts = () =>
    h
      .prompts()
      .filter((prompt) => prompt.startsWith('[Station: pull request feedback'));
  const deliverPlaced = async () => {
    const outcome = await delivery!.deliver(CONVERSATION);
    expect(outcome.kind, JSON.stringify(outcome)).toBe('queued');
    const key = (outcome as { clientTurnId: string }).clientTurnId;
    await eventually(() =>
      expect(h.inbox.entry(CONVERSATION, key)?.state).toBe('sent'),
    );
    await eventually(() => expect(h.inbox.mustQueue(CONVERSATION)).toBe(false));
  };
  const evaluator = createStagedPreToolPolicyEvaluator({
    spec: { slug: 'coder' } as never,
    toolNameMapping: new Map(),
    isGranted: () => true,
    logger,
    pullRequestWatchPolicy: (input) => {
      const verdict = watch.guard(input);
      return verdict
        ? { decision: verdict.decision, predicate: verdict.predicate }
        : undefined;
    },
  });
  /** One Bash call the engine reports for this Task's Session, at full access. */
  const bash = (command: string) =>
    evaluator(
      { toolName: 'Bash', toolCallId: 'call-1', toolArgs: { command } },
      { agentSlug: 'coder', conversationId: sessionId },
      { interaction: 'external', fullAccess: true },
    );
  return {
    h,
    store,
    task,
    live,
    watch,
    delivery,
    holds,
    onReady,
    notify,
    observe,
    feedbackPrompts,
    deliverPlaced,
    bash,
  };
}

describe('a Task watches the pull request it keeps (#5066)', () => {
  it('a seeded failing check wakes the Task once; the same event again does not; a passing push reports ready once', async () => {
    const t = await setup({ project: { enabled: true, maxFixAttempts: 3 } });
    t.watch.sync();
    const claim = t.store.claim(PR_KEY);
    expect(claim?.conversationId).toBe(CONVERSATION);
    expect(claim?.watch).toMatchObject({ taskId: 'task-1', maxFixAttempts: 3 });
    expect(claim?.settings).toMatchObject({
      fixFailingChecks: true,
      addressReviewComments: true,
    });

    t.observe(failing(HEADS[0]!));
    await t.deliverPlaced();
    expect(t.feedbackPrompts()).toHaveLength(1);
    expect(t.feedbackPrompts()[0]).toContain('ci / unit-tests');

    // The same failing check, observed again (another poll, a restarted
    // process over the same store): no second wake.
    t.observe(failing(HEADS[0]!, '2026-11-10T12:05:00.000Z'));
    expect((await t.delivery.deliver(CONVERSATION)).kind).toBe('none');
    t.watch.sync();
    expect((await t.delivery.deliver(CONVERSATION)).kind).toBe('none');
    expect(t.feedbackPrompts()).toHaveLength(1);
    expect(t.watch.view(t.task).pullRequests[0]?.watch.state).toBe('fixing');

    // The agent pushed a fix; the new head passes.
    t.observe(green(HEADS[1]!));
    expect((await t.delivery.deliver(CONVERSATION)).kind).toBe('none');
    expect((await t.delivery.deliver(CONVERSATION)).kind).toBe('none');
    expect(t.onReady).toHaveBeenCalledTimes(1);
    const view = t.watch.view(t.task);
    expect(view.pullRequests[0]).toMatchObject({
      watch: { state: 'ready', headSha: HEADS[1] },
      fixAttempts: 1,
      maxFixAttempts: 3,
    });
    expect(t.feedbackPrompts()).toHaveLength(1);
  });

  it('after N fix attempts the Task waits on its person with the failing check named', async () => {
    const t = await setup({ project: { enabled: true, maxFixAttempts: 2 } });
    t.watch.sync();
    t.observe(failing(HEADS[0]!));
    await t.deliverPlaced();
    t.observe(failing(HEADS[1]!));
    await t.deliverPlaced();
    expect(t.feedbackPrompts()).toHaveLength(2);

    // The third head still fails: the budget of two is spent.
    t.observe(failing(HEADS[2]!));
    expect((await t.delivery.deliver(CONVERSATION)).kind).toBe('none');
    expect(t.feedbackPrompts()).toHaveLength(2);
    expect(t.store.claim(PR_KEY)?.condition).toMatchObject({
      state: 'paused',
      reason: 'fix-budget',
      headSha: HEADS[2],
    });
    await eventually(() => expect(t.holds).toHaveLength(1));
    expect(t.holds[0]).toMatchObject({
      taskId: 'task-1',
      hold: { pullRequest: 'acme/widgets#42' },
    });
    expect(t.holds[0]!.hold.checks).toContain('ci / unit-tests');
    // One Needs-you notice (and push) for the person, naming the checks.
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify.mock.calls[0]![0]).toMatchObject({
      reason: 'fix-budget',
      headSha: HEADS[2],
    });
    expect(t.notify.mock.calls[0]![0].failing).toContain('ci / unit-tests');
    expect(t.watch.view(t.task).pullRequests[0]).toMatchObject({
      watch: { state: 'budget-spent', headSha: HEADS[2] },
      fixAttempts: 2,
      maxFixAttempts: 2,
    });

    // A fourth failing head stays paused and holds the Task only once.
    t.observe(failing(HEADS[3]!));
    expect((await t.delivery.deliver(CONVERSATION)).kind).toBe('none');
    expect(t.feedbackPrompts()).toHaveLength(2);
    expect(t.holds).toHaveLength(1);
    expect(t.notify).toHaveBeenCalledTimes(1);

    // Send again grants the person's one more attempt.
    const again = await t.delivery.sendAgain(PR_KEY);
    expect(again).toMatchObject({ kind: 'queued' });
    expect(t.store.claim(PR_KEY)?.watch?.extra).toBe(1);
  });

  it('an attempt to arm auto-merge from the Task is refused and recorded; the same call outside a watching Task is not', async () => {
    const t = await setup({ project: { enabled: true, maxFixAttempts: 3 } });
    const refused = await t.bash('gh pr merge 42 --auto --squash');
    expect(refused.behavior).toBe('deny');
    expect(refused.behavior === 'deny' ? refused.denial.reason : '').toContain(
      'arming auto-merge is the person’s decision',
    );
    const forced = await t.bash('git fetch && git push --force-with-lease');
    expect(forced.behavior).toBe('deny');
    const ci = await t.bash("sed -i 's/18/20/' .github/workflows/ci.yml");
    // A person must approve it.
    expect(ci).toMatchObject({ behavior: 'ask', required: true });
    expect(t.watch.view(t.task).refusals).toEqual([
      expect.objectContaining({ kind: 'ci-config', outcome: 'asked' }),
      expect.objectContaining({ kind: 'force-push', outcome: 'refused' }),
      expect.objectContaining({
        kind: 'arm-auto-merge',
        outcome: 'refused',
        toolName: 'Bash',
        detail: 'gh pr merge 42 --auto --squash',
      }),
    ]);
    // Ordinary work still runs.
    expect((await t.bash('git push origin HEAD')).behavior).toBe('allow');

    // Control: a Task that does not watch is not refused.
    const control = await setup({
      project: { enabled: true, maxFixAttempts: 3 },
      taskWatch: 'off',
    });
    expect(
      (await control.bash('gh pr merge 42 --auto --squash')).behavior,
    ).toBe('allow');
    expect(control.watch.view(control.task).refusals).toEqual([]);
  });

  it('Stop watching releases the claim, and watching again resumes it; a person turning it off in the chat keeps it off', async () => {
    const t = await setup({ project: { enabled: true, maxFixAttempts: 3 } });
    t.watch.sync();
    expect(t.store.claim(PR_KEY)?.settings.fixFailingChecks).toBe(true);
    t.task.pullRequestWatch = 'off';
    t.watch.syncTask(t.task);
    expect(t.store.claim(PR_KEY)?.settings.fixFailingChecks).toBe(false);
    expect(t.watch.view(t.task)).toMatchObject({
      watching: false,
      source: 'task',
      mode: 'off',
    });
    t.task.pullRequestWatch = 'on';
    t.watch.syncTask(t.task);
    expect(t.store.claim(PR_KEY)?.settings.fixFailingChecks).toBe(true);

    // A person's own off in the chat: the claim loses its Task mark and
    // a later sync does not turn it back on.
    t.store.releaseClaim(PR_KEY, '2026-11-10T14:00:00.000Z');
    t.store.setWatch(PR_KEY, null);
    t.watch.sync();
    expect(t.store.claim(PR_KEY)?.settings.fixFailingChecks).toBe(false);
  });

  it('a Task that ends stops watching its pull requests', async () => {
    const t = await setup({ project: { enabled: true, maxFixAttempts: 3 } });
    t.watch.sync();
    expect(t.store.claim(PR_KEY)?.settings.fixFailingChecks).toBe(true);
    t.task.status = 'done';
    t.live.splice(0);
    t.watch.sync();
    expect(t.store.claim(PR_KEY)?.settings.fixFailingChecks).toBe(false);
  });

  it('a Project that does not watch claims nothing', async () => {
    const t = await setup({ project: { enabled: false, maxFixAttempts: 3 } });
    t.watch.sync();
    expect(t.store.claim(PR_KEY)).toBeUndefined();
    expect(t.watch.view(t.task)).toMatchObject({
      watching: false,
      source: 'project',
      projectEnabled: false,
    });
  });
});

describe('a person turning feedback off in the chat ends the watch for that pull request', () => {
  const ownershipFor = (t: Awaited<ReturnType<typeof setup>>) =>
    new PullRequestFeedbackOwnership({
      store: () => t.store,
      readStore: () => t.store,
      linkedIdentities: async () => [IDENTITY],
      session: () => ({ state: 'idle', ownerUserId: OWNER }),
      mayContinue: () => true,
      title: () => 'Chat',
      headReviewEnabled: () => true,
    });
  const viewer = { userId: OWNER, canRead: () => true };

  it('enabling head review keeps the Task watch and its fix budget across sync', async () => {
    const t = await setup({ project: { enabled: true, maxFixAttempts: 3 } });
    t.watch.sync();
    const watch = t.store.claim(PR_KEY)!.watch!;
    t.store.setWatch(PR_KEY, { ...watch, extra: 1 });
    const result = await ownershipFor(t).write({
      conversationId: CONVERSATION,
      identity: IDENTITY,
      settings: {
        fixFailingChecks: true,
        addressReviewComments: true,
        reviewEachHead: true,
      },
      viewer,
    });
    expect(result.kind).toBe('ok');
    t.watch.sync();
    expect(t.store.claim(PR_KEY)).toMatchObject({
      watch: { ...watch, extra: 1 },
      settings: { reviewEachHead: true },
    });
    expect(t.watch.view(t.task).pullRequests[0]?.watch.state).not.toBe(
      'elsewhere',
    );
    expect((await t.bash('gh pr merge 42 --auto')).behavior).toBe('deny');
  });

  it('both sending switches off through the switches write: the next sync leaves it off', async () => {
    const t = await setup({ project: { enabled: true, maxFixAttempts: 3 } });
    t.watch.sync();
    expect(t.store.claim(PR_KEY)?.watch?.taskId).toBe('task-1');
    const result = await ownershipFor(t).write({
      conversationId: CONVERSATION,
      identity: IDENTITY,
      settings: {
        fixFailingChecks: false,
        addressReviewComments: false,
        reviewEachHead: false,
      },
      viewer,
    });
    expect(result.kind).toBe('ok');
    t.watch.sync();
    const claim = t.store.claim(PR_KEY);
    expect(claim?.watch).toBeUndefined();
    expect(claim?.settings).toMatchObject({
      fixFailingChecks: false,
      addressReviewComments: false,
    });
  });

  it('turning it off: the next sync leaves it off', async () => {
    const t = await setup({ project: { enabled: true, maxFixAttempts: 3 } });
    t.watch.sync();
    expect(
      (
        await ownershipFor(t).off({
          conversationId: CONVERSATION,
          identity: IDENTITY,
          viewer,
        })
      ).kind,
    ).toBe('ok');
    t.watch.sync();
    expect(t.store.claim(PR_KEY)?.watch).toBeUndefined();
    expect(t.store.claim(PR_KEY)?.settings.fixFailingChecks).toBe(false);
  });
});
