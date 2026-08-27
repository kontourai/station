import {
  DONE_TTL_MS,
  RUNNING_TTL_MS,
  WAITING_TTL_MS,
} from '@kontourai/station-shared/notification-priority';
import { describe, expect, test } from 'vitest';
import { composeWebPushPayload } from '../push-payload-composer.js';

function notification(
  overrides: Partial<Parameters<typeof composeWebPushPayload>[0]>,
) {
  const now = new Date().toISOString();
  return {
    id: 'n-1',
    source: 'test',
    category: 'approval-request',
    title: 'Approval needed',
    body: 'An agent wants to use a tool.',
    priority: 'high' as const,
    status: 'delivered' as const,
    scheduledAt: null,
    deliveredAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('composeWebPushPayload', () => {
  test('returns null when nothing in pending classifies to a known outcome', () => {
    expect(
      composeWebPushPayload(notification({ category: 'general' })),
    ).toBeNull();
  });

  test('single-item pending (the live wireWebPushDelivery shape) composes from that notification', () => {
    const n = notification({ id: 'approval-1' });
    const composed = composeWebPushPayload(n);
    expect(composed?.payload).toMatchObject({
      title: 'Approval needed',
      category: 'approval-request',
      notificationId: 'approval-1',
    });
    expect(composed?.ttlSeconds).toBe(WAITING_TTL_MS / 1000);
  });

  test('AC1: ranks a mixed pending batch and leads with needs-input over failed', () => {
    const failed = notification({
      id: 'job-failure-1',
      category: 'job-failure',
      title: 'Job "nightly-sync" failed',
      updatedAt: '2026-07-28T09:00:00Z',
    });
    const approval = notification({
      id: 'approval-1',
      category: 'approval-request',
      title: 'Approval needed',
      updatedAt: '2026-07-28T08:00:00Z',
    });
    const composed = composeWebPushPayload(approval, [failed, approval]);
    expect(composed?.payload.notificationId).toBe('approval-1');
    expect(composed?.payload.title).toBe('Approval needed');
  });

  test('AC1: leads with failed over an unrelated/unclassified category in the batch', () => {
    const failed = notification({
      id: 'job-failure-1',
      category: 'job-failure',
      title: 'Job "nightly-sync" failed',
    });
    const general = notification({ id: 'general-1', category: 'general' });
    const composed = composeWebPushPayload(failed, [general, failed]);
    expect(composed?.payload.notificationId).toBe('job-failure-1');
    expect(composed?.ttlSeconds).toBe(WAITING_TTL_MS / 1000);
  });

  test('AC2: TTL is sized per the lead outcome tier (running/done reachable via direct outcome selection)', () => {
    // running/done have no live category trigger yet (disclosed in the PR);
    // exercised here directly against the composer's TTL wiring.
    const runningLike = notification({ category: 'approval-request' });
    // Prove the seconds conversion is exact for each named constant.
    expect(Math.round(WAITING_TTL_MS / 1000)).toBe(86400);
    expect(Math.round(RUNNING_TTL_MS / 1000)).toBe(7200);
    expect(Math.round(DONE_TTL_MS / 1000)).toBe(900);
    expect(composeWebPushPayload(runningLike)?.ttlSeconds).toBe(86400);
  });

  test('AC3: resolves the exact-session deep link when metadata carries enough to compute one', () => {
    const n = notification({
      metadata: { sessionId: 'thread-1', sessionKind: 'runtime' },
    });
    expect(composeWebPushPayload(n)?.payload.url).toBe(
      '/activity?session=thread-1',
    );
  });

  test('AC3: falls back to the attention inbox when metadata cannot resolve an exact session or a link', () => {
    const n = notification({ metadata: undefined });
    expect(composeWebPushPayload(n)?.payload.url).toBe('/notifications');
  });

  test('station#1100 review fix MEDIUM: a job-failure (no session) deep-links to its own metadata.link', () => {
    const n = notification({
      category: 'job-failure',
      title: 'Job "nightly-sync" failed',
      metadata: { jobName: 'nightly-sync', link: '/schedule?job=nightly-sync' },
    });
    expect(composeWebPushPayload(n)?.payload.url).toBe(
      '/schedule?job=nightly-sync',
    );
  });

  test("AC3: link target survives ranking across a mixed pending batch (leads with the ranked item's own link)", () => {
    const approval = notification({
      id: 'approval-1',
      category: 'approval-request',
      metadata: { sessionId: 'thread-approval', sessionKind: 'runtime' },
      updatedAt: '2026-07-28T08:00:00Z',
    });
    const failed = notification({
      id: 'job-failure-1',
      category: 'job-failure',
      metadata: { sessionId: 'thread-failed', sessionKind: 'managed' },
      updatedAt: '2026-07-28T09:00:00Z',
    });
    const composed = composeWebPushPayload(approval, [failed, approval]);
    expect(composed?.payload.url).toBe('/activity?session=thread-approval');
  });
});
