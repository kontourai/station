/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import LogsTab from '../LogsTab';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));

test('typing updates the log search immediately but scans the server only after settling', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(String(url));
      return Response.json({ entries: [] });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.useFakeTimers();
  const mounted = render(
    <QueryClientProvider client={client}>
      <LogsTab />
    </QueryClientProvider>,
  );
  try {
    await act(async () => {
      await Promise.resolve();
    });
    expect(requests).toHaveLength(1);
    const search = screen.getByRole('textbox', { name: 'Search' });
    fireEvent.change(search, { target: { value: 'boot' } });
    expect((search as HTMLInputElement).value).toBe('boot');
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.change(search, { target: { value: 'booted' } });
    await act(async () => {
      vi.advanceTimersByTime(249);
    });
    expect(requests).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1]!).searchParams.get('q')).toBe('booted');
    fireEvent.change(search, { target: { value: 'cancel on unmount' } });
    mounted.unmount();
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(requests).toHaveLength(2);
  } finally {
    mounted.unmount();
    client.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
