/**
 * The composed runtime's #4508 hand-off (`owns`): the item's kind reaches the
 * per-kind rule, and a pull request no longer linked to the claim's chat is
 * not owned, so the Task's lead is still woken for it. Its Needs-you sources
 * and the one notice a pause sends through the bound notification service.
 * Real store file in a temp home, the inbox harness's event store and inbox.
 */
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import { pullRequestFeedbackKey } from '@kontourai/station-contracts/pull-request-feedback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createInboxHarness } from '../../../routes/orchestration/__tests__/helpers/thread-inbox-harness.js';
import {
  PullRequestFeedbackStore,
  pullRequestFeedbackStorePath,
} from '../../../services/pull-requests/pull-request-feedback-store.js';
import { composePullRequestFeedbackRuntime } from '../runtime-pull-request-feedback.js';

const PR: PullRequestLinkIdentity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const ITEM = 'github:acme/widgets#42';
const station = createInboxHarness();
const tempDir = trackTempDirs();
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function setup(
  settings: {
    fixFailingChecks: boolean;
    addressReviewComments: boolean;
  },
  preview: { on: boolean } = { on: true },
) {
  const world = station();
  const homeDir = tempDir('pr-feedback-runtime-');
  const store = new PullRequestFeedbackStore(
    pullRequestFeedbackStorePath(homeDir),
  );
  store.writeClaim({
    prKey: pullRequestFeedbackKey(PR),
    identity: PR,
    conversationId: 'chat-a',
    settings: { ...settings, reviewEachHead: false },
    enabledBy: 'owner',
    now: '2026-11-10T12:00:00.000Z',
  });
  const links: { list: PullRequestLinkIdentity[] } = { list: [PR] };
  const runtime = composePullRequestFeedbackRuntime({
    homeDir,
    hosted: false,
    featurePreviews: {
      bind: () => ({
        select: (branches: {
          enabled: () => unknown;
          disabled: () => unknown;
        }) => (preview.on ? branches.enabled() : branches.disabled()),
      }),
    } as never,
    eventStore: world.store,
    inbox: world.inbox,
    orchestration: world.service,
    eventBus: { subscribe: () => () => {} },
    providers: () => [],
    links: { list: () => links.list } as never,
    keptForSessions: () => [],
    access: {
      current: () => true,
      canRead: () => true,
      operator: () => 'owner',
      readerOf: () => () => true,
    },
    logger: { warn: vi.fn() },
  })!;
  closers.push(() => runtime.close());
  closers.push(() => store.close());
  return { runtime, links, store, world };
}

describe('the composed #4508 hand-off', () => {
  it('passes the kind through: only checks are owned when only checks are on', () => {
    const { runtime } = setup({
      fixFailingChecks: true,
      addressReviewComments: false,
    });
    expect(runtime.owns(ITEM, 'check_run')).toBe(true);
    expect(runtime.owns(ITEM, 'review')).toBe(false);
    expect(runtime.owns(ITEM, 'review_comment')).toBe(false);
    expect(runtime.owns(ITEM, 'comment')).toBe(false);
    expect(runtime.owns('github:acme/widgets#43', 'check_run')).toBe(false);
  });

  it('owns nothing once the pull request is unlinked from the claim chat', () => {
    const { runtime, links } = setup({
      fixFailingChecks: true,
      addressReviewComments: true,
    });
    expect(runtime.owns(ITEM, 'review')).toBe(true);
    links.list = [];
    expect(runtime.owns(ITEM, 'check_run')).toBe(false);
    expect(runtime.owns(ITEM, 'review')).toBe(false);
  });
});

describe('pull request feedback that needs a person', () => {
  const pause = (store: PullRequestFeedbackStore) =>
    store.setCondition(pullRequestFeedbackKey(PR), {
      state: 'paused',
      reason: 'repeated-failure',
      headSha: HEAD,
      failing: ['ci / unit-tests'],
      at: '2026-11-16T09:00:00.000Z',
    });

  it('reads a pause as a source; nothing while the preview is off or once unlinked', () => {
    const preview = { on: true };
    const { runtime, store, links } = setup(
      { fixFailingChecks: true, addressReviewComments: false },
      preview,
    );
    expect(runtime.attentionSources()).toEqual([]);
    pause(store);
    expect(runtime.attentionSources()).toEqual([
      {
        conversationId: 'chat-a',
        sessionId: expect.any(String),
        prKey: pullRequestFeedbackKey(PR),
        identity: PR,
        reason: 'repeated-failure',
        headSha: HEAD,
        failing: ['ci / unit-tests'],
        at: '2026-11-16T09:00:00.000Z',
      },
    ]);
    preview.on = false;
    expect(runtime.attentionSources()).toEqual([]);
    preview.on = true;
    links.list = [];
    expect(runtime.attentionSources()).toEqual([]);
  });

  it('a pause recorded before pauses kept `at` gets one, once: saving switches does not resurface it', () => {
    const { runtime, store } = setup({
      fixFailingChecks: true,
      addressReviewComments: false,
    });
    const prKey = pullRequestFeedbackKey(PR);
    store.setCondition(prKey, {
      state: 'paused',
      reason: 'round-limit',
      headSha: HEAD,
    });
    const [first] = runtime.attentionSources();
    expect(Date.parse(first!.at)).not.toBeNaN();
    expect(store.claim(prKey)?.condition).toMatchObject({ at: first!.at });
    // Saving the switches again moves enabledAt, never this pause's version.
    store.writeClaim({
      prKey,
      identity: PR,
      conversationId: 'chat-a',
      settings: {
        fixFailingChecks: true,
        addressReviewComments: true,
        reviewEachHead: false,
      },
      enabledBy: 'owner',
      now: '2030-01-01T00:00:00.000Z',
    });
    expect(runtime.attentionSources()[0]?.at).toBe(first!.at);
  });

  it('a pause sends one notice to the bound notification service, for the chat', async () => {
    const { runtime, store } = setup({
      fixFailingChecks: true,
      addressReviewComments: false,
    });
    const prKey = pullRequestFeedbackKey(PR);
    const at = '2026-11-16T08:00:00.000Z';
    store.writeObservation(prKey, {
      observation: {
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
          },
        ],
        checksTruncated: false,
        threads: [],
        threadsTotal: 0,
        reviews: [],
        observedAt: at,
      },
      observedAt: at,
      unchangedSince: at,
      digest: 'd',
    });
    // Three rounds already placed on this head.
    for (const n of [1, 2, 3]) {
      store.beginBatch(
        {
          key: `prf-round-${n}`,
          conversationId: 'chat-a',
          generation: 1,
          state: 'submitting',
          message: 'm',
          actor: { userId: 'owner' },
          createdAt: at,
          summary: [{ prKey, headSha: HEAD, generation: 1, categories: [] }],
        },
        [],
      );
      store.settleBatch(`prf-round-${n}`, 'sent', at);
    }
    const scheduleEnveloped = vi.fn(async () => ({}) as never);
    runtime.bindNotifier({
      scheduleEnveloped,
      list: async () => [],
      markStatus: vi.fn(async () => undefined),
    });
    const delivery = runtime.routeArgs[1]()!;
    expect((await delivery.deliver('chat-a')).kind).toBe('none');
    expect(store.claim(prKey)?.condition).toMatchObject({
      state: 'paused',
      cap: 'head',
    });
    await vi.waitFor(() => expect(scheduleEnveloped).toHaveBeenCalledTimes(1));
    expect(scheduleEnveloped).toHaveBeenCalledWith(
      'pull-request-feedback',
      {
        category: 'pull-request-feedback',
        title: 'Agent paused on #42: checks still failing after 3 rounds',
        body: 'acme/widgets at a1b2c3d. Send again or turn off auto-fix in Station.',
        dedupeTag: expect.stringMatching(
          /^pr-feedback:[0-9a-f]{16}:round-limit:[0-9a-f]{12}$/,
        ),
        metadata: { sessionId: 'chat-a' },
      },
      {
        v: 1,
        source: { kind: 'system', subsystem: 'pull-request-feedback' },
        audience: { kind: 'session-readers', sessionId: 'chat-a' },
        urgency: 'attention',
        target: { kind: 'session', sessionId: 'chat-a' },
        interrupt: 'default',
      },
    );
    expect((await delivery.deliver('chat-a')).kind).toBe('none');
    expect(scheduleEnveloped).toHaveBeenCalledTimes(1);
  });
});
