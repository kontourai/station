/**
 * @vitest-environment jsdom
 *
 * Calendar.tsx destructures selectEvent, autoSelectEvent, clearSelection and
 * formatLocalDate from useCalendarNavigation, and treats selectedCategories as
 * a Set. The hook returned none of those, so the calendar threw as soon as
 * events loaded (#2343). These tests drive the hook through the SDK's real
 * LayoutNavigationProvider, so tab state round-trips through the same
 * string-valued getTabState/setTabState a layout gets at runtime.
 */
import { LayoutNavigationProvider } from '@kontourai/station-sdk';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { detectMeetingProvider, getCacheKey } from '../calendar-utils';
import {
  formatLocalDate,
  useCalendarNavigation,
} from '../useCalendarNavigation';

const STORAGE_KEY = 'layout-enterprise-tab-calendar';

function wrapper({ children }: { children: ReactNode }) {
  // activeTabId is another tab, so state lives in sessionStorage only.
  return (
    <LayoutNavigationProvider layoutSlug="enterprise" activeTabId="crm">
      {children}
    </LayoutNavigationProvider>
  );
}

function stored() {
  return new URLSearchParams(sessionStorage.getItem(STORAGE_KEY) ?? '');
}

afterEach(() => sessionStorage.clear());

describe('useCalendarNavigation', () => {
  test('a person selecting an event persists it and marks it user-selected', () => {
    const { result } = renderHook(() => useCalendarNavigation(), { wrapper });

    act(() => result.current.selectEvent('meeting-1'));

    expect(result.current.selectedEventId).toBe('meeting-1');
    expect(result.current.isUserSelected).toBe(true);
    expect(stored().get('eventId')).toBe('meeting-1');
  });

  test('an automatic selection is neither persisted nor user-selected', () => {
    const { result } = renderHook(() => useCalendarNavigation(), { wrapper });

    act(() => result.current.autoSelectEvent('meeting-2'));

    expect(result.current.selectedEventId).toBe('meeting-2');
    expect(result.current.isUserSelected).toBe(false);
    expect(stored().get('eventId')).toBeNull();
  });

  test('clearing the selection clears the persisted event too', () => {
    const { result } = renderHook(() => useCalendarNavigation(), { wrapper });

    act(() => result.current.selectEvent('meeting-1'));
    act(() => result.current.clearSelection());

    expect(result.current.selectedEventId).toBeNull();
    expect(result.current.isUserSelected).toBe(false);
    expect(stored().get('eventId')).toBe('');
  });

  test('category filters and the selection survive a remount', () => {
    const first = renderHook(() => useCalendarNavigation(), { wrapper });
    act(() => first.result.current.selectEvent('meeting-3'));
    act(() =>
      first.result.current.setSelectedCategories(
        new Set(['Customer', 'Travel']),
      ),
    );
    first.unmount();

    const { result } = renderHook(() => useCalendarNavigation(), { wrapper });

    expect(result.current.selectedEventId).toBe('meeting-3');
    expect(result.current.selectedCategories).toEqual(
      new Set(['Customer', 'Travel']),
    );
  });

  test('formats dates in local time, not UTC', () => {
    // 23:30 local on 1 March is 2 March in UTC for any zone west of UTC.
    expect(formatLocalDate(new Date(2026, 2, 1, 23, 30))).toBe('2026-03-01');
  });
});

describe('calendar-utils', () => {
  test('scopes cache keys by namespace', () => {
    expect(getCacheKey('sfdc', 'details-1')).not.toBe(
      getCacheKey('tasks', 'details-1'),
    );
  });

  test('finds a join link in the body and names its service', () => {
    expect(
      detectMeetingProvider(
        'Room 4',
        '<p>Join: https://acme.zoom.us/j/123?pwd=x</p>',
      ),
    ).toEqual({ provider: 'Zoom', url: 'https://acme.zoom.us/j/123?pwd=x' });
  });

  test('decodes HTML-escaped ampersands in a join link', () => {
    expect(
      detectMeetingProvider(
        undefined,
        '<a href="https://acme.zoom.us/j/123?pwd=x&amp;uname=y">Join</a>',
      ),
    ).toEqual({
      provider: 'Zoom',
      url: 'https://acme.zoom.us/j/123?pwd=x&uname=y',
    });
  });

  test('matches the link host, not a service name elsewhere in the URL', () => {
    expect(
      detectMeetingProvider('https://evil.example/?next=zoom.us', undefined),
    ).toBeNull();
  });

  test('returns null when no known service is linked', () => {
    expect(detectMeetingProvider('Conference room B', 'Agenda')).toBeNull();
  });
});
