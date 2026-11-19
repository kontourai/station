// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { FieldworkReview } from '../index';

vi.mock('@kontourai/station-sdk', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useNavigation: () => ({ selectedProject: 'review-project' }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('opening, closing, and leaving review make no output reads; an explicit check shows a failed read', async () => {
  vi.useFakeTimers();
  let open = false;
  let outputRequests = 0;
  vi.stubGlobal('fetch', async (input: string) => {
    if (input.endsWith('/open')) {
      open = true;
      return Response.json({
        review: { url: 'http://127.0.0.1:53122/#cap=fixture' },
      });
    }
    if (input.endsWith('/close')) {
      open = false;
      return Response.json({ success: true });
    }
    if (input.endsWith('/reviewed-output')) {
      outputRequests++;
      return Response.json(
        { success: false, error: 'Read failed' },
        { status: 500 },
      );
    }
    expect(input).toMatch(/\/review-project\/runs$/);
    return Response.json({
      runs: [
        {
          id: 'run-1',
          proposalCount: 1,
          createdAt: '2026-01-01T00:00:00Z',
          open,
        },
      ],
    });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <FieldworkReview />
    </QueryClientProvider>,
  );
  const tick = async (milliseconds: number) => {
    await act(() => vi.advanceTimersByTimeAsync(milliseconds));
  };
  await tick(20);
  await tick(20);
  fireEvent.click(screen.getByRole('button', { name: 'Open review' }));
  await tick(20);
  expect(screen.getByTitle('Fieldwork review')).toBeTruthy();
  await tick(1500);
  expect(outputRequests).toBe(0);

  fireEvent.click(
    screen.getByRole('button', { name: 'Check reviewed output' }),
  );
  await tick(20);
  expect(screen.getByText('Could not read reviewed output.')).toBeTruthy();
  expect(outputRequests).toBe(1);

  fireEvent.click(screen.getByRole('button', { name: 'Close review' }));
  await tick(20);
  expect(screen.queryByTitle('Fieldwork review')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open review' }));
  await tick(20);
  expect(screen.getByTitle('Fieldwork review')).toBeTruthy();
  unmount();
  await tick(1500);
  expect(outputRequests).toBe(1);
  client.clear();
});
