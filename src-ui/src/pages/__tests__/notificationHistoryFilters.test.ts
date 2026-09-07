import type { AttentionItem } from '@kontourai/station-contracts/attention';
import type { Notification } from '@kontourai/station-contracts/notification';
import { describe, expect, test } from 'vitest';
import {
  EMPTY_NOTIFICATION_HISTORY_FILTERS,
  filterNotificationHistory,
  readNotificationHistoryFilters,
  writeNotificationHistoryFilters,
} from '../notificationHistoryFilters';

const attention: AttentionItem = {
  id: 'session-failed:one',
  kind: 'session-failed',
  title: 'Build failed',
  body: 'Compiler exited',
  createdAt: '2026-08-09T12:00:00.000Z',
  updatedAt: '2026-08-10T12:00:00.000Z',
  source: { threadId: 'one' },
  openHref: '/?surface=activity&session=one',
};

const notification: Notification = {
  id: 'pairing-one',
  source: 'device-pairing',
  category: 'pairing-request',
  title: 'Pixel pairing expired',
  body: 'Request another code',
  priority: 'normal',
  status: 'expired',
  createdAt: '2026-08-11T12:00:00.000Z',
  updatedAt: '2026-08-11T12:00:00.000Z',
};

describe('notification history filters', () => {
  test('reads stable multi-value filters and ignores impossible dates', () => {
    const filters = readNotificationHistoryFilters(
      new URLSearchParams(
        'q=build&category=session-failed&category=session-failed&category=pairing-request&from=2026-02-31&to=2026-08-11',
      ),
    );

    expect(filters).toEqual({
      query: 'build',
      categories: ['pairing-request', 'session-failed'],
      from: '',
      to: '2026-08-11',
    });
  });

  test('writes filters without discarding unrelated navigation state', () => {
    const params = writeNotificationHistoryFilters(
      new URLSearchParams('section=notifications&legacy=kept'),
      {
        query: '  pixel  ',
        categories: ['session-failed', 'pairing-request'],
        from: '2026-08-10',
        to: '2026-08-11',
      },
    );

    expect(params.get('section')).toBe('notifications');
    expect(params.get('legacy')).toBe('kept');
    expect(params.get('q')).toBe('pixel');
    expect(params.getAll('category')).toEqual([
      'pairing-request',
      'session-failed',
    ]);
  });

  test('matches all query terms across copy and source', () => {
    const result = filterNotificationHistory([attention], [notification], {
      ...EMPTY_NOTIFICATION_HISTORY_FILTERS,
      query: '  PIXEL \t device  ',
    });

    expect(result.items).toEqual([]);
    expect(result.notifications).toEqual([notification]);
  });

  test('combines multi-category and inclusive displayed-date filtering', () => {
    const result = filterNotificationHistory([attention], [notification], {
      query: '',
      categories: ['session-failed'],
      from: '2026-08-10',
      to: '2026-08-10',
    });

    expect(result.items).toEqual([attention]);
    expect(result.notifications).toEqual([]);
  });

  test('an inverted date range produces no misleading partial result', () => {
    const result = filterNotificationHistory([attention], [notification], {
      ...EMPTY_NOTIFICATION_HISTORY_FILTERS,
      from: '2026-08-12',
      to: '2026-08-10',
    });

    expect(result).toEqual({ items: [], notifications: [] });
  });
});
