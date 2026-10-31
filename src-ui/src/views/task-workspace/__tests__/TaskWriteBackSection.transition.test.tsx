/** @vitest-environment jsdom */

import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://station.test',
    authorityKey: 'task-viewer',
    isCurrent: () => true,
  }),
}));

import { TaskWriteBackSection } from '../TaskWriteBackSection';

const createdAt = '2026-10-01T10:00:00.000Z';

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('switching Tasks never shows the previous Task history', async () => {
  setClientCredentialResolver(() => ({
    origin: 'https://station.test',
    requestAuthority: {
      apiBase: 'https://station.test',
      authorityKey: 'task-viewer',
      isCurrent: () => true,
    },
  }));
  let finishB!: (response: Response) => void;
  const pendingB = new Promise<Response>((resolve) => {
    finishB = resolve;
  });
  const response = (taskId: string, destination: string) =>
    new Response(
      JSON.stringify({
        success: true,
        data: {
          entries: [
            {
              id: `entry-${taskId}`,
              taskId,
              taskCreatedAt: createdAt,
              ordinal: 1,
              target: {
                kind: 'chat',
                system: 'Discord',
                destination,
                action: 'notify',
              },
              initiatedBy: { kind: 'person', id: 'person-1' },
              attemptedAt: createdAt,
              retryOf: null,
              state: 'pending',
              failureReason: null,
              settledAt: null,
            },
          ],
        },
      }),
    );
  const fetchMock = vi.fn((url: string) =>
    url.includes('/task-a/')
      ? Promise.resolve(response('task-a', '#task-a'))
      : pendingB,
  );
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <TaskWriteBackSection taskId="task-a" taskCreatedAt={createdAt} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText('Written to the issue'));
  expect(await screen.findByText('Discord · notify · #task-a')).toBeTruthy();
  view.rerender(
    <QueryClientProvider client={client}>
      <TaskWriteBackSection taskId="task-b" taskCreatedAt={createdAt} />
    </QueryClientProvider>,
  );
  if (!screen.getByText('Written to the issue').closest('details')?.open) {
    fireEvent.click(screen.getByText('Written to the issue'));
  }
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/task-b/'),
      expect.anything(),
    ),
  );
  expect(screen.queryByText('Discord · notify · #task-a')).toBeNull();
  expect(
    screen.getByRole('status', { name: 'Loading write-back history' }),
  ).toBeTruthy();
  finishB(response('task-b', '#task-b'));
  expect(await screen.findByText('Discord · notify · #task-b')).toBeTruthy();
  expect(screen.queryByText('Discord · notify · #task-a')).toBeNull();
});
