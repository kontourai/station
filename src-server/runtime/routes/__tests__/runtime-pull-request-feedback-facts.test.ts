/**
 * The composed runtime's Task board fact (`factFor`): what a kept pull
 * request's agent feedback is doing, for a reader of its owning chat only.
 * `fixing` is read from the owning chat's turn events: the inbox places the
 * feedback message under its batch key, Station stamps that key on the
 * turn it starts, and the fact says `fixing` while that turn has not ended.
 * Real feedback store in a temp home, the inbox harness's EventStore,
 * OrchestrationService and ThreadInboxDelivery; only the engine is scripted.
 */
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  type PullRequestFeedbackObservation,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  CONVERSATION,
  createInboxHarness,
  eventually,
  OWNER,
} from '../../../routes/orchestration/__tests__/helpers/thread-inbox-harness.js';
import {
  PullRequestFeedbackStore,
  pullRequestFeedbackStorePath,
} from '../../../services/pull-requests/pull-request-feedback-store.js';
import {
  composePullRequestFeedbackRuntime,
  type PullRequestFeedbackRuntime,
} from '../runtime-pull-request-feedback.js';

const PR: PullRequestLinkIdentity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const PR_KEY = pullRequestFeedbackKey(PR);
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const REQUEST = new Request('http://station.test/api/tasks/pull-request-facts');

const station = createInboxHarness();
const tempDir = trackTempDirs();
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function failing(): PullRequestFeedbackObservation {
  return {
    identity: PR,
    url: 'https://github.com/acme/widgets/pull/42',
    state: 'OPEN',
    draft: false,
    headSha: HEAD,
    baseSha: 'b'.repeat(40),
    headRefName: 'feature',
    baseRefName: 'main',
    mergeable: 'mergeable',
    checks: [
      {
        name: 'ci / unit-tests',
        conclusion: 'FAILURE',
        completed: true,
        required: true,
        url: 'https://github.com/acme/widgets/actions/runs/1/job/2',
      },
    ],
    checksTruncated: false,
    threads: [],
    threadsTotal: 0,
    reviews: [],
    observedAt: '2026-11-10T12:00:00.000Z',
  };
}

async function setup({
  headReview = false,
  observed = true,
  reviewOnly = false,
}: {
  headReview?: boolean;
  observed?: boolean;
  reviewOnly?: boolean;
} = {}) {
  let runtime: PullRequestFeedbackRuntime | undefined;
  const h = station({
    placementRefusal: (input) => runtime?.placementRefusal(input),
  });
  const first = await h.send('first', 'open the pull request');
  expect(first.status, await first.clone().text()).toBe(200);
  await eventually(() => expect(h.inbox.mustQueue(CONVERSATION)).toBe(false));
  const homeDir = tempDir('pr-feedback-facts-');
  const seed = new PullRequestFeedbackStore(
    pullRequestFeedbackStorePath(homeDir),
  );
  seed.writeClaim({
    prKey: PR_KEY,
    identity: PR,
    conversationId: CONVERSATION,
    settings: {
      fixFailingChecks: !reviewOnly,
      addressReviewComments: false,
      reviewEachHead: headReview,
    },
    enabledBy: OWNER,
    now: '2026-11-10T12:00:00.000Z',
  });
  const observation = failing();
  if (observed)
    seed.writeObservation(PR_KEY, {
      observation,
      observedAt: observation.observedAt,
      unchangedSince: observation.observedAt,
      digest: JSON.stringify(observation),
    });
  if (reviewOnly)
    seed.writeHeadReview({
      prKey: PR_KEY,
      headSha: HEAD,
      state: 'reviewed',
      requiredIds: [],
      findings: [],
      others: 0,
      startedAt: observation.observedAt,
      settledAt: observation.observedAt,
      rerun: 0,
    });
  seed.close();
  const state = { enabled: true, reads: true, current: true };
  runtime = composePullRequestFeedbackRuntime({
    homeDir,
    hosted: false,
    featurePreviews: {
      bind: () => ({
        select: (branches: {
          enabled: () => unknown;
          disabled: () => unknown;
        }) => (state.enabled ? branches.enabled() : branches.disabled()),
      }),
    } as never,
    eventStore: h.store,
    inbox: h.inbox,
    orchestration: h.service,
    eventBus: { subscribe: () => () => {} },
    providers: () => [],
    links: { list: () => [PR] } as never,
    keptForSessions: () => [],
    access: {
      current: () => state.current,
      canRead: (request, id) =>
        request === REQUEST && id === CONVERSATION && state.reads,
      operator: () => OWNER,
      readerOf: () => () => state.reads,
    },
    logger: { warn: vi.fn() },
  })!;
  const composed = runtime;
  closers.push(() => composed.close());
  const delivery = composed.routeArgs[1]()!;
  // The Task whose run is the owning chat (`TaskRecord.sessionId`).
  const run = h.service.currentConversationSessionId(CONVERSATION);
  return { h, runtime: composed, delivery, state, run };
}

describe('the composed Task board feedback fact', () => {
  it('projects a current head awaiting Station review to the board, only to a reader of its chat', async () => {
    const { runtime, state, run } = await setup({ headReview: true });
    expect(runtime.factFor(PR, REQUEST, run)).toMatchObject({
      state: 'reviewing',
      headSha: HEAD,
    });
    state.reads = false;
    expect(runtime.factFor(PR, REQUEST, run)).toBeUndefined();
  });
  it('keeps review enabled before its first forge observation, even if the board reads a clean head first', async () => {
    const { runtime, run } = await setup({ headReview: true, observed: false });
    expect(runtime.factFor(PR, REQUEST, run)).toEqual({
      state: 'reviewing',
      reviewEachHead: true,
    });
  });
  it('keeps the review hold while a feedback turn is fixing, even if the board still has an idle run', async () => {
    const { h, runtime, delivery, run } = await setup({ headReview: true });
    h.adapter.holdTurns = true;
    expect((await delivery.deliver(CONVERSATION)).kind).toBe('queued');
    await eventually(() => expect(h.inbox.mustQueue(CONVERSATION)).toBe(true));
    expect(runtime.factFor(PR, REQUEST, run)).toMatchObject({
      state: 'reviewing',
      reviewEachHead: true,
      headSha: HEAD,
    });
    h.adapter.complete();
  });
  it('a clear review-only claim does not say auto-fix is on', async () => {
    const { runtime, run } = await setup({
      headReview: true,
      reviewOnly: true,
    });
    expect(runtime.factFor(PR, REQUEST, run)).toEqual({
      state: 'reviewed',
      reviewEachHead: true,
      headSha: HEAD,
    });
  });
  it('fixing while the turn Station started for the failing checks runs, then sent', async () => {
    const { h, runtime, delivery, run } = await setup();
    expect(runtime.factFor(PR, REQUEST, run)).toEqual({
      state: 'watching',
      headSha: HEAD,
    });
    h.adapter.holdTurns = true;
    const outcome = await delivery.deliver(CONVERSATION);
    expect(outcome.kind, JSON.stringify(outcome)).toBe('queued');
    const key = (outcome as { clientTurnId: string }).clientTurnId;
    await eventually(() => expect(h.inbox.mustQueue(CONVERSATION)).toBe(true));
    // The turn that runs carries the batch's key as its clientTurnId.
    await eventually(() =>
      expect(runtime.factFor(PR, REQUEST, run)).toEqual({
        state: 'fixing',
        headSha: HEAD,
      }),
    );
    expect(key.startsWith('prf-')).toBe(true);
    // The same pull request kept on another Task, whose run is another
    // chat (or where feedback moved away from it), or a Task with no run:
    // that card is not fixing anything.
    for (const other of ['task-other-run', undefined])
      expect(runtime.factFor(PR, REQUEST, other)?.state).not.toBe('fixing');
    h.adapter.complete();
    await eventually(() => expect(h.inbox.mustQueue(CONVERSATION)).toBe(false));
    // The next run settles the placed message as sent.
    await delivery.deliver(CONVERSATION);
    await eventually(() =>
      expect(runtime.factFor(PR, REQUEST, run)).toMatchObject({
        state: 'sent',
        headSha: HEAD,
        at: expect.any(String),
      }),
    );
  });

  it('the Task’s own run doing other work (a person’s turn) is not fixing', async () => {
    const { h, runtime, run } = await setup();
    h.adapter.holdTurns = true;
    const mine = await h.send('mine', 'look at something else');
    expect(mine.status, await mine.clone().text()).toBe(200);
    await eventually(() => expect(h.inbox.mustQueue(CONVERSATION)).toBe(true));
    expect(runtime.factFor(PR, REQUEST, run)).toEqual({
      state: 'watching',
      headSha: HEAD,
    });
    h.adapter.complete();
  });

  it('nothing for a reader who may not read the owning chat, a requester who lost standing, or while the preview is off', async () => {
    const { runtime, state } = await setup();
    expect(runtime.factFor(PR, REQUEST)).toBeDefined();
    state.reads = false;
    expect(runtime.factFor(PR, REQUEST)).toBeUndefined();
    state.reads = true;
    state.current = false;
    expect(runtime.factFor(PR, REQUEST)).toBeUndefined();
    state.current = true;
    state.enabled = false;
    expect(runtime.factFor(PR, REQUEST)).toBeUndefined();
  });
});
