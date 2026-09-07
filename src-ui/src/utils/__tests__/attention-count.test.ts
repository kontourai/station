/**
 * archive#3214: the notifications page printed the pending count of its
 * FILTERED list under the same "Needs attention (N)" label the bell badge
 * wears for the FULL pending set, so any active filter made the header
 * contradict the badge the reader had just clicked.
 *
 * These pin the two derivations the fix leaves behind: the predicate that
 * decides what "pending" means (`countPendingAttention`, the client mirror of
 * `AttentionProjectionService.list`'s `!acknowledgedAt` filter) and the rule
 * that decides which population the label is allowed to name
 * (`attentionCountLabel`).
 */

import type { AttentionItem } from '@kontourai/station-contracts/attention';
import { describe, expect, test } from 'vitest';
import {
  EMPTY_NOTIFICATION_HISTORY_FILTERS,
  filterNotificationHistory,
  hasNotificationHistoryFilters,
} from '../../pages/notificationHistoryFilters';
import {
  attentionCountLabel,
  countPendingAttention,
  pendingAttentionItems,
} from '../attention';

const AT = '2026-08-11T12:00:00.000Z';

function failed(
  id: string,
  overrides: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    id,
    kind: 'session-failed',
    title: id,
    createdAt: AT,
    updatedAt: AT,
    openHref: `/?surface=activity&session=${id}`,
    source: { threadId: id },
    ...overrides,
  } as AttentionItem;
}

function approval(
  id: string,
  overrides: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    id,
    kind: 'approval',
    title: id,
    createdAt: AT,
    updatedAt: AT,
    openHref: `/?surface=activity&session=${id}`,
    source: { notificationId: id, notificationSource: 'approval-inbox' },
    actions: [],
    ...overrides,
  } as AttentionItem;
}

/**
 * archive#3222: the tray RENDERS the pending subset rather than counting it,
 * so the predicate had to become a list. These pin that the list and the count
 * are one derivation — a second `!acknowledgedAt` spelled anywhere else is the
 * drift this module exists to prevent.
 */
describe('pendingAttentionItems', () => {
  test('keeps only the items carrying no acknowledgedAt, in order', () => {
    const items = [
      failed('a'),
      failed('b', { acknowledgedAt: AT }),
      approval('c'),
    ];
    expect(pendingAttentionItems(items).map((item) => item.id)).toEqual([
      'a',
      'c',
    ]);
  });

  test('an all-acknowledged list yields nothing to render', () => {
    expect(
      pendingAttentionItems([
        failed('a', { acknowledgedAt: AT }),
        approval('b', { acknowledgedAt: AT }),
      ]),
    ).toEqual([]);
  });

  test('the count is the length of the list — one predicate, not two', () => {
    const items = [
      failed('a'),
      failed('b', { acknowledgedAt: AT }),
      approval('c'),
      approval('d', { acknowledgedAt: AT }),
    ];
    expect(countPendingAttention(items)).toBe(
      pendingAttentionItems(items).length,
    );
  });
});

describe('countPendingAttention', () => {
  test('counts only items carrying no acknowledgedAt', () => {
    expect(
      countPendingAttention([
        failed('a'),
        failed('b', { acknowledgedAt: AT }),
        approval('c'),
      ]),
    ).toBe(2);
  });

  test('an empty list, and an all-acknowledged list, both count zero', () => {
    expect(countPendingAttention([])).toBe(0);
    expect(
      countPendingAttention([
        failed('a', { acknowledgedAt: AT }),
        approval('b', { acknowledgedAt: AT }),
      ]),
    ).toBe(0);
  });

  /**
   * The reported divergence itself, at the derivation level: the same
   * predicate over the filtered subset is a genuinely smaller number, which is
   * why the label — not the count — is what had to change.
   */
  test('the filtered subset counts fewer pending than the full set', () => {
    const items = [
      failed('boom', { title: 'Build failed' }),
      approval('ask', { title: 'Approval needed' }),
      failed('acked', { title: 'Old failure', acknowledgedAt: AT }),
    ];
    const filters = { ...EMPTY_NOTIFICATION_HISTORY_FILTERS, query: 'build' };
    const visible = filterNotificationHistory(items, [], filters);

    expect(countPendingAttention(items)).toBe(2);
    expect(countPendingAttention(visible.items)).toBe(1);
    expect(hasNotificationHistoryFilters(filters)).toBe(true);
  });

  /**
   * A filter that only removes ALREADY-ACKNOWLEDGED rows leaves the pending
   * count untouched — so "a filter is active" is not the same fact as "the
   * two counts differ", and the label rule below must not conflate them.
   */
  test('a filter that only hides acknowledged rows leaves the pending count equal', () => {
    const items = [
      failed('boom', { title: 'Build failed' }),
      failed('acked', { title: 'Build failed earlier', acknowledgedAt: AT }),
    ];
    const filters = {
      ...EMPTY_NOTIFICATION_HISTORY_FILTERS,
      query: 'build failed',
    };
    const visible = filterNotificationHistory(items, [], filters);

    expect(visible.items).toHaveLength(2);
    expect(countPendingAttention(items)).toBe(1);
    expect(countPendingAttention(visible.items)).toBe(1);
  });

  /**
   * Every filter dimension the bar offers can produce the divergence, not only
   * search: category chips and the date range reach the same items.
   */
  test.each([
    ['category', { categories: ['approval'] }, 1],
    ['from date', { from: '2026-08-12' }, 0],
    ['to date', { to: '2026-08-10' }, 0],
    // From after To: `matchesDate` rejects everything, so the page shows an
    // empty attention list while the badge still reads 2.
    ['inverted date range', { from: '2026-08-12', to: '2026-08-10' }, 0],
  ])(
    '%s scoping drops pending items the badge still counts',
    (_name, partial, expected) => {
      const items = [failed('boom'), approval('ask')];
      const filters = { ...EMPTY_NOTIFICATION_HISTORY_FILTERS, ...partial };
      expect(hasNotificationHistoryFilters(filters)).toBe(true);
      expect(countPendingAttention(items)).toBe(2);
      expect(
        countPendingAttention(
          filterNotificationHistory(items, [], filters).items,
        ),
      ).toBe(expected);
    },
  );
});

describe('attentionCountLabel', () => {
  test('unfiltered, the label names the badge total alone', () => {
    expect(
      attentionCountLabel({
        narrowed: false,
        pendingTotal: 7,
        pendingVisible: 7,
      }),
    ).toBe('7');
  });

  test('unfiltered with nothing pending renders no count at all', () => {
    expect(
      attentionCountLabel({
        narrowed: false,
        pendingTotal: 0,
        pendingVisible: 0,
      }),
    ).toBeNull();
  });

  test('filtered, the label names both populations as a pair', () => {
    expect(
      attentionCountLabel({
        narrowed: true,
        pendingTotal: 7,
        pendingVisible: 3,
      }),
    ).toBe('3 of 7');
  });

  /**
   * The pair is unconditional while a filter is active. A bare "(3)" that
   * means "3 in total" or "3 in this view" depending on invisible state is
   * precisely the defect; "(3 of 3)" says the filter hides no attention.
   */
  test('filtered but agreeing still renders the pair, not a bare number', () => {
    expect(
      attentionCountLabel({
        narrowed: true,
        pendingTotal: 3,
        pendingVisible: 3,
      }),
    ).toBe('3 of 3');
  });

  /**
   * The worst case: the filter hides every pending item. The old label
   * rendered nothing here (`pendingCount ? … : ''`), so a reader who arrived
   * from a badge reading 5 saw a bare "Needs attention" and no trace of the 5.
   */
  test('filtered to nothing still reports the total the badge is showing', () => {
    expect(
      attentionCountLabel({
        narrowed: true,
        pendingTotal: 5,
        pendingVisible: 0,
      }),
    ).toBe('0 of 5');
  });

  test('filtered with nothing pending anywhere reports the honest zero pair', () => {
    expect(
      attentionCountLabel({
        narrowed: true,
        pendingTotal: 0,
        pendingVisible: 0,
      }),
    ).toBe('0 of 0');
  });

  /**
   * Deliberately unclamped: within one `/api/attention` response these two
   * cannot disagree, so a visible count exceeding the total could only mean
   * the server's definition of pending had drifted from the client mirror.
   * Clamping would hide that behind a plausible number.
   */
  test('a visible count above the total is reported, not clamped', () => {
    expect(
      attentionCountLabel({
        narrowed: true,
        pendingTotal: 3,
        pendingVisible: 5,
      }),
    ).toBe('5 of 3');
  });

  /**
   * archive#3222: the tray narrows by TRUNCATION, not by a filter bar — it has
   * room for five rows under a badge that may read nine. The helper takes the
   * fact, not the mechanism, so the same pair covers both surfaces and the
   * tray needs no second label rule of its own.
   */
  test('truncation is a narrowing: five rows under a badge of nine reads as a pair', () => {
    expect(
      attentionCountLabel({
        narrowed: true,
        pendingTotal: 9,
        pendingVisible: 5,
      }),
    ).toBe('5 of 9');
  });
});
