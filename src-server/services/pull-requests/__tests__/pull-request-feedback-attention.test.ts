/**
 * The one push notification a feedback pause or a stopped agent sends,
 * through a real NotificationService on a real EventBus: written once per
 * pull request, reason and head, so the same notice again (a restart
 * noticing a stopped agent again) does not deliver a second time.
 */
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TITLE_MAX,
} from '@kontourai/station-contracts/notification';
import { pullRequestFeedbackKey } from '@kontourai/station-contracts/pull-request-feedback';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { NotificationService } from '../../notifications/notification-service.js';
import { EventBus } from '../../orchestration/event-bus.js';
import {
  type PullRequestFeedbackNotice,
  pullRequestFeedbackAttentionCopy,
  schedulePullRequestFeedbackNotice,
  settlePullRequestFeedbackNotices,
} from '../pull-request-feedback-attention.js';

const PR: PullRequestLinkIdentity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const tempDir = trackTempDirs();

const notice = (
  overrides: Partial<PullRequestFeedbackNotice> = {},
): PullRequestFeedbackNotice => ({
  conversationId: 'chat-a',
  prKey: pullRequestFeedbackKey(PR),
  identity: PR,
  reason: 'agent-stopped',
  headSha: HEAD,
  at: '2026-11-16T09:00:00.000Z',
  waiting: [
    { category: 'failing-checks', count: 2 },
    { category: 'review-threads', count: 1 },
  ],
  ...overrides,
});

describe('a feedback notice', () => {
  const world = () => {
    const bus = new EventBus();
    const delivered: unknown[] = [];
    bus.subscribe((frame) => {
      if (frame.event === SERVER_EVENTS.NOTIFICATION_DELIVERED)
        delivered.push(frame.data);
    });
    const service = new NotificationService(
      bus,
      tempDir('pr-feedback-notice-'),
      999_999,
    );
    return { service, delivered };
  };

  it('is delivered once per pause or stop, even when noticed again', async () => {
    const { service, delivered } = world();
    await schedulePullRequestFeedbackNotice(service, notice(), 'session-a');
    await schedulePullRequestFeedbackNotice(service, notice(), 'session-a');
    expect(delivered).toHaveLength(1);
    const [record] = await service.list();
    expect(record).toMatchObject({
      source: 'pull-request-feedback',
      category: 'pull-request-feedback',
      title: '#42 has feedback waiting; its agent stopped',
      body: 'acme/widgets at a1b2c3d: 2 failing checks and 1 review comment were not sent. Open the chat to continue.',
    });
    // A pause on the same head is a different notice.
    await schedulePullRequestFeedbackNotice(
      service,
      notice({ reason: 'repeated-failure', failing: ['ci / unit-tests'] }),
      'session-a',
    );
    expect(delivered).toHaveLength(2);
  });

  it('a second pause on the same head, after Send again, interrupts again even when the first was read or dismissed', async () => {
    const { service, delivered } = world();
    const first = notice({
      reason: 'round-limit',
      cap: 'head',
      rounds: 3,
      failing: ['ci / unit-tests'],
    });
    await schedulePullRequestFeedbackNotice(service, first, 'session-a');
    const [record] = await service.list();
    await service.markRead(record!.id, 'local:web');
    await service.dismiss(record!.id);
    // Send again granted a round; the next round on the same head paused
    // again, with words the same as the first.
    await schedulePullRequestFeedbackNotice(
      service,
      { ...first, at: '2026-11-16T10:00:00.000Z' },
      'session-a',
    );
    expect(delivered).toHaveLength(2);
  });

  it('a notice whose pause or stop is over is settled; the live one stays', async () => {
    const { service } = world();
    const lifted = notice({ reason: 'round-limit', cap: 'head' });
    const live = notice({ at: '2026-11-16T11:00:00.000Z' });
    await schedulePullRequestFeedbackNotice(service, lifted, 'session-a');
    await schedulePullRequestFeedbackNotice(service, live, 'session-a');
    await settlePullRequestFeedbackNotices(service, [live]);
    const byTitle = new Map(
      (await service.list()).map((record) => [record.title, record.status]),
    );
    expect(byTitle.get('Agent paused on #42 after 3 rounds of feedback')).toBe(
      'expired',
    );
    expect(byTitle.get('#42 has feedback waiting; its agent stopped')).toBe(
      'delivered',
    );
  });

  it('never promises the pause lifts by itself, and fits a notification', () => {
    const notices = [
      notice(),
      notice({ reason: 'round-limit', cap: 'head', rounds: 4 }),
      notice({ reason: 'round-limit', cap: 'head', failing: ['a', 'b', 'c'] }),
      notice({ reason: 'round-limit', cap: 'day' }),
      notice({ reason: 'repeated-failure', failing: ['x'.repeat(200)] }),
      notice({
        identity: { ...PR, ref: '123456789012' },
        reason: 'round-limit',
        cap: 'head',
        failing: ['a'],
      }),
    ];
    for (const value of notices) {
      const copy = pullRequestFeedbackAttentionCopy(value);
      expect(copy.title.length).toBeLessThanOrEqual(NOTIFICATION_TITLE_MAX);
      expect(copy.body.length).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX);
      expect(`${copy.title} ${copy.body}`).not.toMatch(
        /tomorrow|resumes|automatically/i,
      );
    }
    expect(
      pullRequestFeedbackAttentionCopy(
        notice({ reason: 'round-limit', cap: 'day' }),
      ),
    ).toEqual({
      title: '#42: 10 feedback messages in 24 hours',
      body: 'New feedback on a1b2c3d was not sent. Auto-fix is paused.',
    });
  });
});
