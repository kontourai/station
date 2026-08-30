/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const schedulerStream = vi.hoisted(() => ({
  close: vi.fn(),
  onMessage: undefined as
    | ((event: Readonly<{ data: string }>) => void)
    | undefined,
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    ...actual,
    fetchSSE: vi.fn(
      (
        _url: string,
        options: Readonly<{
          onMessage: (event: Readonly<{ data: string }>) => void;
        }>,
      ) => {
        schedulerStream.onMessage = options.onMessage;
        return { close: schedulerStream.close };
      },
    ),
  };
});

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://scheduler-events.example.test' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import {
  getSchedulerEventInvalidationKeys,
  isSchedulerDeferralTerminal,
  type SchedulerEvent,
  useSchedulerEvents,
} from '../hooks/useScheduler';

function queryWrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function emitSchedulerEvent(event: SchedulerEvent): void {
  act(() => {
    schedulerStream.onMessage?.({ data: JSON.stringify(event) });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  schedulerStream.close.mockClear();
  schedulerStream.onMessage = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler event invalidation', () => {
  test('keeps started and missed events scheduler-only', () => {
    expect(getSchedulerEventInvalidationKeys('job.started')).toEqual([
      ['scheduler'],
    ]);
    expect(getSchedulerEventInvalidationKeys('job.missed')).toEqual([
      ['scheduler'],
    ]);
    expect(getSchedulerEventInvalidationKeys('job.deferred')).toEqual([
      ['scheduler'],
    ]);
  });

  test('refreshes runs only for terminal or run-state-changing events', () => {
    expect(getSchedulerEventInvalidationKeys('job.completed')).toEqual([
      ['scheduler'],
      ['runs'],
    ]);
    expect(getSchedulerEventInvalidationKeys('job.failed')).toEqual([
      ['scheduler'],
      ['runs'],
    ]);
    expect(getSchedulerEventInvalidationKeys('job.retrying')).toEqual([
      ['scheduler'],
      ['runs'],
    ]);
  });

  test('keeps a waiting retry live while treating a released occurrence as terminal', () => {
    expect(isSchedulerDeferralTerminal({ disposition: 'waiting' })).toBe(false);
    expect(isSchedulerDeferralTerminal({ disposition: 'released' })).toBe(true);
    expect(isSchedulerDeferralTerminal({})).toBe(true);
  });

  test('preserves the running timer for waiting deferrals and clears released ones', () => {
    const { result, unmount } = renderHook(() => useSchedulerEvents(), {
      wrapper: queryWrapper,
    });

    emitSchedulerEvent({ event: 'job.started', job: 'parked-retry' });
    emitSchedulerEvent({
      event: 'job.deferred',
      job: 'parked-retry',
      disposition: 'waiting',
    });
    expect(result.current.isRunning('parked-retry')).toBe(true);

    act(() => vi.advanceTimersByTime(5 * 60_000 - 1));
    expect(result.current.isRunning('parked-retry')).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.isRunning('parked-retry')).toBe(false);

    emitSchedulerEvent({ event: 'job.started', job: 'released-occurrence' });
    expect(result.current.isRunning('released-occurrence')).toBe(true);
    emitSchedulerEvent({
      event: 'job.deferred',
      job: 'released-occurrence',
      disposition: 'released',
    });
    expect(result.current.isRunning('released-occurrence')).toBe(false);

    unmount();
  });
});
