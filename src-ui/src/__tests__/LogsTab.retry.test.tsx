/**
 * @vitest-environment jsdom
 *
 * station#2645 follow-up (live diagnosis 2026-08-14): the Logs tab's error
 * came from a transient outage window, but the cached error rendered a
 * dead-end ErrorState — the tab looked permanently broken. The error state
 * must carry a retry that refetches.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const refetch = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk/developer-runtime', () => ({
  useServerLogsQuery: () => ({
    data: undefined,
    error: new Error('transient'),
    isLoading: false,
    refetch,
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));

import LogsTab from '../views/developer/LogsTab';

describe('Logs tab error recovery (station#2645 follow-up)', () => {
  test('the error state carries a retry that refetches', () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <LogsTab />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Unable to load server logs.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });
});
