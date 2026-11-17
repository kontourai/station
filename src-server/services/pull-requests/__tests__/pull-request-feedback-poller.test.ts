/**
 * Detection: what is read, when, and what a failed read does. Real store,
 * a provider whose one feedback read is scripted, and the real delivery
 * (with no inbox it only records and holds).
 */
import { join } from 'node:path';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  type PullRequestFeedbackObservationResult,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { normalizeGitHubFeedbackObservation } from '../github-feedback-observation.js';
import {
  type FeedbackSessionState,
  PullRequestFeedbackDelivery,
} from '../pull-request-feedback-delivery.js';
import {
  MAX_PER_TICK,
  PullRequestFeedbackPoller,
  type PullRequestFeedbackPollerPorts,
} from '../pull-request-feedback-poller.js';
import { PullRequestFeedbackStore } from '../pull-request-feedback-store.js';
import recordedFixture from './fixtures/github-feedback-observation.json' with {
  type: 'json',
};

const recorded = structuredClone(recordedFixture) as any;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const MINUTE = 60_000;
const ON = {
  fixFailingChecks: true,
  addressReviewComments: true,
  reviewEachHead: false,
};
const pr = (ref: string, host = 'github.com'): PullRequestLinkIdentity => ({
  provider: 'github',
  host,
  repository: { owner: 'acme', name: 'widgets' },
  ref,
});

const tempDir = trackTempDirs();
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function setup(discover?: PullRequestFeedbackPollerPorts['discover']) {
  const store = new PullRequestFeedbackStore(
    join(tempDir('pr-feedback-poll-'), 'pull-request-feedback.sqlite'),
  );
  closers.push(() => store.close());
  const reads: string[] = [];
  const answers = new Map<
    string,
    () =>
      | PullRequestFeedbackObservationResult
      | Promise<PullRequestFeedbackObservationResult>
  >();
  const provider = {
    id: 'github',
    canServeHost: () => true,
    getFeedbackObservation: async (context: { host: string }, ref: string) => {
      reads.push(`${context.host}#${ref}`);
      const answer = answers.get(ref);
      if (answer) return answer();
      return {
        state: 'observed' as const,
        observation: normalizeGitHubFeedbackObservation(
          recorded,
          pr(ref, context.host),
          new Date(NOW).toISOString(),
        )!,
      };
    },
  } as unknown as IPullRequestProvider;
  const sessions = new Map<string, FeedbackSessionState['state']>();
  const turns = new Map<string, number>();
  const state = { enabled: true };
  const session = (id: string): FeedbackSessionState => ({
    state: sessions.get(id) ?? 'idle',
    ownerUserId: 'owner',
  });
  const delivery = new PullRequestFeedbackDelivery({
    store: () => store,
    enabled: () => state.enabled,
    session,
    mayContinue: () => true,
    turnWindows: () => [],
    inbox: () => undefined,
    logger: { warn: vi.fn() },
  });
  let clock = NOW;
  const links: { list?: PullRequestLinkIdentity[] } = {};
  const poller = new PullRequestFeedbackPoller({
    ...(discover ? { discover } : {}),
    linked: () => links.list ?? [pr('1'), pr('2')],
    enabled: () => state.enabled,
    store: () => store,
    providers: () => [provider],
    session,
    lastTurnAt: (id) => turns.get(id),
    delivery: () => delivery,
    logger: { warn: vi.fn() },
    now: () => clock,
  });
  const claim = (identity: PullRequestLinkIdentity, conversationId: string) =>
    store.writeClaim({
      prKey: pullRequestFeedbackKey(identity),
      identity,
      conversationId,
      settings: ON,
      enabledBy: 'owner',
      now: new Date(NOW).toISOString(),
    });
  const poll = (at: number) => {
    clock = at;
    return poller.poll({ now: at, signal: new AbortController().signal });
  };
  return {
    store,
    reads,
    answers,
    sessions,
    turns,
    state,
    poller,
    links,
    claim,
    poll,
    setClock: (at: number) => {
      clock = at;
    },
  };
}

describe('pull request feedback detection', () => {
  it('reads each due claim once, then waits its interval: 2 minutes while the agent is active, 10 otherwise', async () => {
    const t = setup();
    t.claim(pr('1'), 'chat-active');
    t.claim(pr('2'), 'chat-quiet');
    t.turns.set('chat-active', NOW - 30 * MINUTE);
    // #2 has nothing to say: every check passed, no threads, no conflict.
    const clean = normalizeGitHubFeedbackObservation(
      recorded,
      pr('2'),
      new Date(NOW).toISOString(),
    )!;
    t.answers.set('2', () => ({
      state: 'observed',
      observation: {
        ...clean,
        checks: clean.checks.filter((check) => check.conclusion === 'SUCCESS'),
        threads: [],
        reviews: [],
        mergeable: 'mergeable',
      },
    }));
    expect(await t.poll(NOW)).toEqual({ outcome: 'polled', read: 2 });
    t.reads.length = 0;
    expect(await t.poll(NOW + MINUTE)).toEqual({ outcome: 'polled', read: 0 });
    await t.poll(NOW + 2 * MINUTE);
    expect(t.reads).toEqual(['github.com#1']);
    await t.poll(NOW + 10 * MINUTE);
    expect(t.reads).toEqual(['github.com#1', 'github.com#1', 'github.com#2']);
  });

  it('a tick reads at most MAX_PER_TICK, oldest due first', async () => {
    const t = setup();
    expect(MAX_PER_TICK).toBe(20);
    t.links.list = Array.from({ length: 25 }, (_, i) => pr(String(i + 1)));
    for (let ref = 1; ref <= 25; ref += 1)
      t.claim(pr(String(ref)), `chat-${ref}`);
    expect((await t.poll(NOW)).read).toBe(20);
    expect((await t.poll(NOW + 1)).read).toBe(5);
    expect(new Set(t.reads).size).toBe(25);
  });

  it('not signed in: the claim reads unavailable, its host backs off 15 minutes, switches stay on', async () => {
    const t = setup();
    t.claim(pr('1'), 'chat-a');
    t.answers.set('1', () => ({
      state: 'unavailable',
      cause: 'credentials',
      reason: 'not signed in',
    }));
    await t.poll(NOW);
    const key = pullRequestFeedbackKey(pr('1'));
    expect(t.store.claim(key)).toMatchObject({
      settings: ON,
      condition: { state: 'unavailable', cause: 'credentials' },
    });
    expect(await t.poll(NOW + 14 * MINUTE)).toEqual({
      outcome: 'polled',
      read: 0,
    });
    t.answers.delete('1');
    await t.poll(NOW + 15 * MINUTE);
    expect(t.reads).toHaveLength(2);
    expect(t.store.claim(key)?.condition).toBeUndefined();
  });

  it('rate limited: every read backs off 15 minutes', async () => {
    const t = setup();
    t.claim(pr('1'), 'chat-a');
    t.claim(pr('2'), 'chat-b');
    t.answers.set('1', () => ({
      state: 'unavailable',
      cause: 'rate-limited',
      reason: 'rate limited',
    }));
    t.answers.set('2', () => ({
      state: 'unavailable',
      cause: 'rate-limited',
      reason: 'rate limited',
    }));
    expect((await t.poll(NOW)).outcome).toBe('backing-off');
    expect(t.reads).toHaveLength(1);
    expect(await t.poll(NOW + 10 * MINUTE)).toEqual({
      outcome: 'backing-off',
      read: 0,
    });
  });

  it('a merged pull request is closed and read no more; a stopped agent is not read', async () => {
    const t = setup();
    const merged = structuredClone(recorded);
    merged.data.repository.pullRequest.merged = true;
    t.claim(pr('1'), 'chat-a');
    t.claim(pr('2'), 'chat-stopped');
    t.sessions.set('chat-stopped', 'stopped');
    t.answers.set('1', () => ({
      state: 'observed',
      observation: normalizeGitHubFeedbackObservation(
        merged,
        pr('1'),
        new Date(NOW).toISOString(),
      )!,
    }));
    await t.poll(NOW);
    expect(t.reads).toEqual(['github.com#1']);
    expect(
      t.store.claim(pullRequestFeedbackKey(pr('1')))?.condition,
    ).toMatchObject({ state: 'closed' });
    await t.poll(NOW + 60 * MINUTE);
    expect(t.reads).toEqual(['github.com#1']);
  });

  it("the owning agent's turn end reads its pull requests at once, at most once a minute", async () => {
    const t = setup();
    t.claim(pr('1'), 'chat-a');
    t.setClock(NOW);
    await t.poller.refresh('chat-a');
    expect(t.reads).toEqual(['github.com#1']);
    t.setClock(NOW + 30_000);
    await t.poller.refresh('chat-a');
    expect(t.reads).toHaveLength(1);
    t.setClock(NOW + 61_000);
    await t.poller.refresh('chat-a');
    expect(t.reads).toHaveLength(2);
  });

  it('with the preview off nothing is read', async () => {
    const t = setup();
    t.claim(pr('1'), 'chat-a');
    t.state.enabled = false;
    expect(await t.poll(NOW)).toEqual({ outcome: 'disabled', read: 0 });
    await t.poller.refresh('chat-a');
    expect(t.reads).toEqual([]);
  });

  it('a claim whose pull request is no longer linked is released, not read', async () => {
    const t = setup();
    t.claim(pr('1'), 'chat-a');
    t.links.list = [];
    await t.poll(NOW);
    expect(t.reads).toEqual([]);
    expect(t.store.claim(pullRequestFeedbackKey(pr('1')))?.settings).toEqual({
      fixFailingChecks: false,
      addressReviewComments: false,
      reviewEachHead: false,
    });
  });

  it('a closed pull request is read again hours later, and watched again when it reopened', async () => {
    const t = setup();
    const merged = structuredClone(recorded);
    merged.data.repository.pullRequest.state = 'CLOSED';
    t.claim(pr('1'), 'chat-a');
    t.answers.set('1', () => ({
      state: 'observed',
      observation: normalizeGitHubFeedbackObservation(
        merged,
        pr('1'),
        new Date(NOW).toISOString(),
      )!,
    }));
    await t.poll(NOW);
    const key = pullRequestFeedbackKey(pr('1'));
    expect(t.store.claim(key)?.condition).toMatchObject({ state: 'closed' });
    t.answers.delete('1');
    await t.poll(NOW + 6 * 60 * MINUTE);
    expect(t.reads).toHaveLength(2);
    expect(t.store.claim(key)?.condition).toBeUndefined();
  });

  it('a read that started earlier never replaces a newer stored head', async () => {
    const t = setup();
    t.claim(pr('1'), 'chat-a');
    const key = pullRequestFeedbackKey(pr('1'));
    const observed = normalizeGitHubFeedbackObservation(
      recorded,
      pr('1'),
      new Date(NOW).toISOString(),
    )!;
    // The turn-end refresh stored a newer head while the tick's read (which
    // started at NOW) was still running.
    t.store.writeObservation(key, {
      observation: { ...observed, headSha: 'newer' },
      observedAt: new Date(NOW + MINUTE).toISOString(),
      unchangedSince: new Date(NOW + MINUTE).toISOString(),
      digest: 'newer',
    });
    t.answers.set('1', () => ({
      state: 'observed',
      observation: { ...observed, headSha: 'older' },
    }));
    await t.poll(NOW);
    expect(t.reads).toEqual(['github.com#1']);
    expect(t.store.observation(key)?.observation.headSha).toBe('newer');
  });

  it('a pull request already being read is not read again by the tick', async () => {
    const t = setup();
    t.claim(pr('1'), 'chat-a');
    const pending: Array<() => void> = [];
    const observed = normalizeGitHubFeedbackObservation(
      recorded,
      pr('1'),
      new Date(NOW).toISOString(),
    )!;
    t.answers.set(
      '1',
      () =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve({ state: 'observed', observation: observed }),
          );
        }),
    );
    t.setClock(NOW);
    const refreshing = t.poller.refresh('chat-a');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // The tick finds the same pull request due while the refresh reads it.
    const ticking = t.poll(NOW);
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const release of pending.splice(0)) release();
    for (const release of pending.splice(0)) release();
    await refreshing;
    const summary = await ticking;
    for (const release of pending.splice(0)) release();
    expect(summary).toEqual({ outcome: 'polled', read: 0 });
    expect(t.reads).toEqual(['github.com#1']);
  });

  it('the turn-end refresh leaves a closed pull request to its six-hourly re-read', async () => {
    const t = setup();
    t.claim(pr('1'), 'chat-a');
    t.store.setCondition(pullRequestFeedbackKey(pr('1')), {
      state: 'closed',
      at: new Date(NOW).toISOString(),
    });
    t.setClock(NOW);
    await t.poller.refresh('chat-a');
    expect(t.reads).toEqual([]);
  });

  it('an off claim is pruned 14 days after it was turned off, not before', async () => {
    const t = setup();
    const old = pullRequestFeedbackKey(pr('1'));
    const recent = pullRequestFeedbackKey(pr('2'));
    t.claim(pr('1'), 'chat-a');
    t.claim(pr('2'), 'chat-b');
    t.store.releaseClaim(
      old,
      new Date(NOW - 15 * 24 * 60 * MINUTE).toISOString(),
    );
    t.store.releaseClaim(
      recent,
      new Date(NOW - 13 * 24 * 60 * MINUTE).toISOString(),
    );
    await t.poll(NOW);
    expect(t.store.claim(old)).toBeUndefined();
    expect(t.store.claim(recent)).toBeDefined();
  });

  it('records when each check was first seen incomplete on a head, and starts again on a new head', async () => {
    const t = setup();
    t.claim(pr('1'), 'chat-a');
    const key = pullRequestFeedbackKey(pr('1'));
    await t.poll(NOW);
    const first = t.store.observation(key)?.incompleteSince;
    expect(first).toEqual({ 'ci / e2e': new Date(NOW).toISOString() });
    t.store.setNextDueAt(key, 0);
    await t.poll(NOW + 30 * MINUTE);
    expect(t.store.observation(key)?.incompleteSince).toEqual(first);
    const moved = structuredClone(recorded);
    moved.data.repository.pullRequest.headRefOid = 'f'.repeat(40);
    t.answers.set('1', () => ({
      state: 'observed',
      observation: normalizeGitHubFeedbackObservation(
        moved,
        pr('1'),
        new Date(NOW).toISOString(),
      )!,
    }));
    t.store.setNextDueAt(key, 0);
    await t.poll(NOW + 40 * MINUTE);
    expect(t.store.observation(key)?.incompleteSince).toEqual({
      'ci / e2e': new Date(NOW + 40 * MINUTE).toISOString(),
    });
  });
});

describe('Task-branch discovery on the tick', () => {
  it('runs first, so a pull request it claims is read the same tick', async () => {
    let t: ReturnType<typeof setup> | undefined;
    const discover = vi.fn(async () => {
      t!.claim(pr('1'), 'chat-lead');
      return 'ok' as const;
    });
    t = setup(discover);
    expect(await t.poll(NOW)).toEqual({ outcome: 'polled', read: 1 });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(t.reads).toEqual(['github.com#1']);
  });

  it('a rate-limited discovery backs every read off', async () => {
    const discover = vi.fn(async () => 'rate-limited' as const);
    const t = setup(discover);
    t.claim(pr('1'), 'chat-a');
    expect(await t.poll(NOW)).toEqual({ outcome: 'backing-off', read: 0 });
    expect(await t.poll(NOW + MINUTE)).toEqual({
      outcome: 'backing-off',
      read: 0,
    });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(t.reads).toEqual([]);
  });
});
