/**
 * The composed runtime's #4508 hand-off (`owns`): the item's kind reaches the
 * per-kind rule, and a pull request no longer linked to the claim's chat is
 * not owned, so the Task's lead is still woken for it. Real store file in a
 * temp home, the inbox harness's event store and inbox.
 */
import { join } from 'node:path';
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

function setup(settings: {
  fixFailingChecks: boolean;
  addressReviewComments: boolean;
}) {
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
  store.close();
  const links: { list: PullRequestLinkIdentity[] } = { list: [PR] };
  const runtime = composePullRequestFeedbackRuntime({
    homeDir,
    hosted: false,
    featurePreviews: {
      bind: () => ({
        select: (branches: { enabled: () => unknown }) => branches.enabled(),
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
  return { runtime, links };
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
