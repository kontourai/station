import type { AttentionItem } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import { suppressMirroredNotifications } from '../attention';

const feedbackItem = (notificationId?: string): AttentionItem => ({
  id: 'pull-request-feedback:0123456789abcdef',
  kind: 'pull-request-feedback',
  title: '#42 still failing after 3 rounds',
  createdAt: '2026-11-16T09:00:00.000Z',
  updatedAt: '2026-11-16T09:00:00.000Z',
  source: {
    conversationId: 'chat-a',
    identity: {
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'acme', name: 'widgets' },
      ref: '42',
    },
    ...(notificationId ? { notificationId } : {}),
  },
  reason: 'round-limit',
  openHref: '/?surface=chat&session=chat-a',
  viewerMayChange: true,
});

describe('a pull request feedback notice beside its Needs-you item', () => {
  test('is shown once: its activity copy is suppressed while the item stands', () => {
    const notifications = [{ id: 'notice-1' }, { id: 'other' }];
    expect(
      suppressMirroredNotifications(notifications, [feedbackItem('notice-1')]),
    ).toEqual([{ id: 'other' }]);
  });

  test('an item that names no notice suppresses nothing', () => {
    const notifications = [{ id: 'notice-1' }];
    expect(
      suppressMirroredNotifications(notifications, [feedbackItem()]),
    ).toEqual(notifications);
  });
});
