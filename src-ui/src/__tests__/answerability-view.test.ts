import type { Notification } from '@kontourai/station-contracts/notification';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import {
  isSessionUnanswerable,
  notificationAnswerabilityView,
  sessionAnswerabilityView,
  sessionsByThreadId,
} from '../utils/answerability';

/**
 * The UI's single read of the ADR 0012 wire decoration (archive#1780).
 *
 * Four states, not a boolean, and each one is pinned here because the
 * difference between them is the difference between disabling an action and
 * lying about one: only an OBSERVED negative may disable anything, and "I
 * could not look" must never render as either observed answer.
 */

const unanswerable = {
  answerable: false,
  qualification: 'provider_absent',
  observedBy: 'station-7f3a',
  observedAt: '2026-08-03T12:04:03.000Z',
} as const;

function summary(
  overrides: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    provider: 'acme',
    threadId: 'thread-1',
    status: 'ready',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:01.000Z',
    ...overrides,
  };
}

function approvalNotification(metadata: Record<string, unknown>): Notification {
  return {
    id: 'notif-1',
    source: 'approval-inbox',
    category: 'approval-request',
    title: 'Approval needed',
    priority: 'high',
    status: 'delivered',
    metadata,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  };
}

describe('sessionAnswerabilityView', () => {
  test('an observed negative carries the basis, provider named', () => {
    const view = sessionAnswerabilityView(
      summary({ answerability: unanswerable, provider: 'acme' }),
    );
    expect(view.status).toBe('unanswerable');
    if (view.status !== 'unanswerable') throw new Error('narrowing');
    expect(view.notice).toContain("no adapter for provider 'acme'");
    expect(view.notice).toContain('station-7f3a');
    expect(view.notice).toContain('2026-08-03T12:04:03.000Z');
  });

  test('an observed positive carries no basis to render', () => {
    expect(sessionAnswerabilityView(summary()).status).toBe('answerable');
  });

  test('the predicate reads the decoration, not a re-fold of lifecycleState', () => {
    // A `failed` session is terminal-by-fold and still ANSWERABLE
    // (`failed -> queued | running` is a live retry path, archive#1090). Any
    // implementation that re-derived this from `lifecycleState` would get
    // this backwards, which is the regression the required wire member and
    // the predicate pin in `open-requests.ts` exist to prevent.
    expect(isSessionUnanswerable(summary({ lifecycleState: 'failed' }))).toBe(
      false,
    );
    //...and a still-`running` session whose adapter is gone IS unanswerable.
    expect(
      isSessionUnanswerable(
        summary({ lifecycleState: 'running', answerability: unanswerable }),
      ),
    ).toBe(true);
  });
});

describe('notificationAnswerabilityView', () => {
  const notification = approvalNotification({
    requestKind: 'orchestration',
    threadId: 'thread-1',
  });

  test('joins to the decorated summary and reports the observation', () => {
    const view = notificationAnswerabilityView(
      notification,
      sessionsByThreadId([
        summary({ answerability: unanswerable, provider: 'acme' }),
      ]),
      true,
    );
    expect(view.status).toBe('unanswerable');
  });

  test('a settled read that does not list the session is an explicit gap', () => {
    const view = notificationAnswerabilityView(notification, new Map(), true);
    expect(view.status).toBe('unknown');
    if (view.status !== 'unknown') throw new Error('narrowing');
    expect(view.notice).toContain('Answerability unknown');
    expect(view.notice).toContain('thread-1');
  });

  test('an unsettled read claims nothing about the Station', () => {
    // "The sessions query has not resolved yet" is not "this Station does
    // not list the session". Annotating during a fetch would be a claim made
    // by a spinner.
    expect(
      notificationAnswerabilityView(notification, new Map(), false).status,
    ).toBe('not-applicable');
  });

  test.each([
    // Same scope boundary `attention-projection.ts` draws server-side: only an
    // orchestration-kind notification with a thread id has a session behind
    // it. The first two rows name a session the settled read DOES list, so a
    // join would be the fuzzy match the honesty bar forbids; the empty id
    // would otherwise render as an "unknown" gap.
    [
      'a registry-kind approval',
      { requestKind: 'registry', threadId: 'thread-1' },
    ],
    ['a notification with no request kind', { threadId: 'thread-1' }],
    [
      'an orchestration notification with an empty thread id',
      { requestKind: 'orchestration', threadId: '' },
    ],
  ])(
    '%s has no session behind it and is left entirely alone',
    (_label, metadata) => {
      expect(
        notificationAnswerabilityView(
          approvalNotification(metadata),
          sessionsByThreadId([summary({ answerability: unanswerable })]),
          true,
        ).status,
      ).toBe('not-applicable');
    },
  );
});
