/**
 * Who owns a pull request's agent feedback: one conversation at a time, only
 * for a pull request a person linked or kept there, a second conversation
 * refused with the owner named, and a move that bumps the generation so a
 * message queued for the old owner is refused at placement.
 */
import { join } from 'node:path';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  type PullRequestFeedbackObservation,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { PullRequestFeedbackDelivery } from '../pull-request-feedback-delivery.js';
import {
  PullRequestFeedbackOwnership,
  type PullRequestFeedbackViewer,
  pullRequestFeedbackSendsKind,
} from '../pull-request-feedback-ownership.js';
import { PullRequestFeedbackStore } from '../pull-request-feedback-store.js';

const PR: PullRequestLinkIdentity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const DECLARED_ONLY: PullRequestLinkIdentity = { ...PR, ref: '43' };
const ON = {
  fixFailingChecks: true,
  addressReviewComments: false,
  reviewEachHead: false,
};

const tempDir = trackTempDirs();
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function setup() {
  const store = new PullRequestFeedbackStore(
    join(tempDir('pr-feedback-owner-'), 'pull-request-feedback.sqlite'),
  );
  closers.push(() => store.close());
  // Each chat's person-linked pull requests. An agent's bare declaration of
  // #43 never reaches this list (declaredPullRequestsForConversation keeps
  // only what a person kept on the Task).
  const linked: Record<string, PullRequestLinkIdentity[]> = {
    'chat-a': [PR],
    'chat-b': [{ ...PR, repository: { owner: 'ACME', name: 'Widgets' } }],
    'review-123': [PR],
  };
  const ownership = new PullRequestFeedbackOwnership({
    store: () => store,
    readStore: () => store,
    linkedIdentities: async (id) => linked[id] ?? [],
    session: () => ({ state: 'idle', ownerUserId: 'owner' }),
    mayContinue: (_id, userId) => userId === 'owner',
    title: (id) => (id === 'chat-a' ? 'Fix the parser' : undefined),
  });
  const viewer = (
    canRead: (id: string) => boolean = () => true,
  ): PullRequestFeedbackViewer => ({ userId: 'owner', canRead });
  return { store, ownership, viewer };
}

describe('pull request feedback ownership', () => {
  it('a second chat is refused with the owner named, or "another chat" when unreadable', async () => {
    const { ownership, viewer } = setup();
    expect(
      await ownership.write({
        conversationId: 'chat-a',
        identity: PR,
        settings: ON,
        viewer: viewer(),
      }),
    ).toMatchObject({ kind: 'ok', view: { ownedHere: true } });
    expect(
      await ownership.write({
        conversationId: 'chat-b',
        identity: PR,
        settings: ON,
        viewer: viewer(),
      }),
    ).toEqual({
      kind: 'conflict',
      owner: { conversationId: 'chat-a', title: 'Fix the parser' },
    });
    expect(
      await ownership.write({
        conversationId: 'chat-b',
        identity: PR,
        settings: ON,
        viewer: viewer(() => false),
      }),
      // A reader of chat-b who may not read chat-a learns only that
      // another chat owns it: not which one.
    ).toEqual({ kind: 'conflict', owner: {} });
    // The other chat sees who owns it, read-only.
    const seen = await ownership.view('chat-b', viewer());
    expect(seen.pullRequests[0]).toMatchObject({
      ownedHere: false,
      owner: { conversationId: 'chat-a', title: 'Fix the parser' },
      history: [],
    });
    const unseen = await ownership.view(
      'chat-b',
      viewer(() => false),
    );
    expect(unseen.pullRequests[0]?.owner).toEqual({});
    // Nor its switches or status (here `watching` with checks on): one rule
    // with the by-pull-request read.
    expect(unseen.pullRequests[0]).toMatchObject({
      ownedHere: false,
      settings: {
        fixFailingChecks: false,
        addressReviewComments: false,
        reviewEachHead: false,
      },
      status: { state: 'off' },
      history: [],
    });
    expect(unseen.pullRequests[0]).not.toHaveProperty('last');
    // A reader of the owner still sees them.
    expect(seen.pullRequests[0]).toMatchObject({
      settings: { fixFailingChecks: true },
      status: { state: 'watching' },
    });
  });

  it('a move bumps the generation and the old queued message is refused at placement', async () => {
    const { ownership, store, viewer } = setup();
    await ownership.write({
      conversationId: 'chat-a',
      identity: PR,
      settings: ON,
      viewer: viewer(),
    });
    const prKey = pullRequestFeedbackKey(PR);
    store.writeObservation(prKey, {
      observation: {
        identity: PR,
        state: 'OPEN',
        headSha: 'a1b2c3d4e5f6',
        checks: [],
      } as unknown as PullRequestFeedbackObservation,
      observedAt: '2026-11-10T12:00:00.000Z',
      unchangedSince: '2026-11-10T12:00:00.000Z',
      digest: 'x',
    });
    store.beginBatch(
      {
        key: 'prf-old',
        conversationId: 'chat-a',
        generation: 1,
        state: 'submitting',
        message: 'feedback',
        actor: { userId: 'owner' },
        createdAt: '2026-11-10T12:00:00.000Z',
        summary: [
          {
            prKey,
            headSha: 'a1b2c3d4e5f6',
            generation: 1,
            categories: [{ category: 'failing-checks', count: 1 }],
          },
        ],
      },
      [],
    );
    const delivery = new PullRequestFeedbackDelivery({
      store: () => store,
      enabled: () => true,
      session: () => ({ state: 'idle', ownerUserId: 'owner' }),
      mayContinue: () => true,
      turnWindows: () => [],
      inbox: () => undefined,
      logger: { warn: vi.fn() },
    });
    expect(
      delivery.placementRefusal({
        conversationId: 'chat-a',
        clientTurnId: 'prf-old',
      }),
    ).toBeUndefined();
    expect(
      await ownership.write({
        conversationId: 'chat-b',
        identity: PR,
        settings: ON,
        viewer: viewer(),
        move: true,
      }),
    ).toMatchObject({ kind: 'ok' });
    expect(store.claim(prKey)).toMatchObject({
      conversationId: 'chat-b',
      generation: 2,
    });
    expect(
      delivery.placementRefusal({
        conversationId: 'chat-a',
        clientTurnId: 'prf-old',
      }),
    ).toMatchObject({ reasonCode: 'pr_feedback_owner_changed' });
  });

  it('only a pull request a person linked or kept is claimable; reviewer chats never', async () => {
    const { ownership, store, viewer } = setup();
    expect(
      await ownership.write({
        conversationId: 'chat-a',
        identity: DECLARED_ONLY,
        settings: ON,
        viewer: viewer(),
      }),
    ).toEqual({ kind: 'not-linked' });
    expect(
      await ownership.write({
        conversationId: 'review-123',
        identity: PR,
        settings: ON,
        viewer: viewer(),
      }),
    ).toEqual({ kind: 'reviewer' });
    expect(store.allClaims()).toEqual([]);
  });

  it('someone who may not send to the chat cannot turn it on', async () => {
    const { ownership, store } = setup();
    expect(
      await ownership.write({
        conversationId: 'chat-a',
        identity: PR,
        settings: ON,
        viewer: { userId: 'stranger', canRead: () => true },
      }),
    ).toEqual({ kind: 'not-permitted' });
    expect(store.allClaims()).toEqual([]);
  });

  it('a claim with every switch off holds nothing: another chat takes it without a conflict', async () => {
    const { ownership, store, viewer } = setup();
    await ownership.write({
      conversationId: 'chat-a',
      identity: PR,
      settings: ON,
      viewer: viewer(),
    });
    await ownership.off({
      conversationId: 'chat-a',
      identity: PR,
      viewer: viewer(),
    });
    expect(
      (await ownership.view('chat-a', viewer())).pullRequests[0]?.status,
    ).toEqual({ state: 'off' });
    expect(
      await ownership.write({
        conversationId: 'chat-b',
        identity: PR,
        settings: ON,
        viewer: viewer(),
      }),
    ).toMatchObject({ kind: 'ok' });
    expect(store.claim(pullRequestFeedbackKey(PR))?.conversationId).toBe(
      'chat-b',
    );
  });

  it('a pull request unlinked since can still be turned off from its chat', async () => {
    const { ownership, store, viewer } = setup();
    await ownership.write({
      conversationId: 'chat-a',
      identity: PR,
      settings: ON,
      viewer: viewer(),
    });
    const unlinked = new PullRequestFeedbackOwnership({
      store: () => store,
      readStore: () => store,
      linkedIdentities: async () => [],
      session: () => ({ state: 'idle', ownerUserId: 'owner' }),
      mayContinue: (_id, userId) => userId === 'owner',
      title: () => undefined,
    });
    expect(
      await unlinked.off({
        conversationId: 'chat-a',
        identity: PR,
        viewer: viewer(),
      }),
    ).toMatchObject({ kind: 'ok', view: { status: { state: 'off' } } });
    expect(store.claim(pullRequestFeedbackKey(PR))?.settings).toEqual({
      fixFailingChecks: false,
      addressReviewComments: false,
      reviewEachHead: false,
    });
    // Only from the chat that owns it.
    expect(
      await unlinked.off({
        conversationId: 'chat-b',
        identity: PR,
        viewer: viewer(),
      }),
    ).toEqual({ kind: 'not-linked' });
  });
});

describe('a held-for-checks status', () => {
  it('says the failures wait on checks still running', async () => {
    const { ownership, store, viewer } = setup();
    await ownership.write({
      conversationId: 'chat-a',
      identity: PR,
      settings: ON,
      viewer: viewer(),
    });
    const observation = {
      identity: PR,
      state: 'OPEN',
      headSha: 'a1b2c3d4e5f6',
      checks: [
        {
          name: 'lint',
          conclusion: 'FAILURE',
          completed: true,
          required: false,
        },
        { name: 'e2e', conclusion: null, completed: false, required: false },
      ],
    } as unknown as PullRequestFeedbackObservation;
    store.writeObservation(pullRequestFeedbackKey(PR), {
      observation,
      observedAt: '2026-11-10T12:00:00.000Z',
      unchangedSince: '2026-11-10T12:00:00.000Z',
      digest: 'x',
      incompleteSince: { e2e: new Date().toISOString() },
    });
    expect(
      (await ownership.view('chat-a', viewer())).pullRequests[0]?.status,
    ).toEqual({ state: 'held', reason: 'checks-running' });
    // Once the check finished, nothing is held.
    store.writeObservation(pullRequestFeedbackKey(PR), {
      observation: {
        ...observation,
        checks: [observation.checks[0]!],
      },
      observedAt: '2026-11-10T12:10:00.000Z',
      unchangedSince: '2026-11-10T12:10:00.000Z',
      digest: 'y',
    });
    expect(
      (await ownership.view('chat-a', viewer())).pullRequests[0]?.status,
    ).toEqual({ state: 'watching' });
  });
});

describe('the Task follow-up hand-off (#4508)', () => {
  const claim = (
    settings: Partial<typeof ON>,
    condition?: Parameters<typeof pullRequestFeedbackSendsKind>[0]['condition'],
  ) => ({
    settings: { ...ON, fixFailingChecks: false, ...settings },
    ...(condition ? { condition } : {}),
  });

  it('owns a kind only while its own switch is on', () => {
    const checks = claim({ fixFailingChecks: true });
    expect(pullRequestFeedbackSendsKind(checks, 'check_run')).toBe(true);
    expect(pullRequestFeedbackSendsKind(checks, 'review')).toBe(false);
    expect(pullRequestFeedbackSendsKind(checks, 'review_comment')).toBe(false);
    const reviews = claim({ addressReviewComments: true });
    expect(pullRequestFeedbackSendsKind(reviews, 'check_run')).toBe(false);
    expect(pullRequestFeedbackSendsKind(reviews, 'review')).toBe(true);
    expect(pullRequestFeedbackSendsKind(reviews, 'review_comment')).toBe(true);
    expect(pullRequestFeedbackSendsKind(reviews, 'comment')).toBe(false);
  });

  it('owns nothing while paused, unavailable or closed', () => {
    const both = { fixFailingChecks: true, addressReviewComments: true };
    for (const condition of [
      { state: 'paused', reason: 'round-limit', headSha: 'a' },
      { state: 'unavailable', cause: 'credentials' },
      { state: 'closed', at: '2026-11-10T00:00:00Z' },
    ] as const) {
      expect(
        pullRequestFeedbackSendsKind(claim(both, condition), 'check_run'),
      ).toBe(false);
      expect(
        pullRequestFeedbackSendsKind(claim(both, condition), 'review'),
      ).toBe(false);
    }
  });
});
