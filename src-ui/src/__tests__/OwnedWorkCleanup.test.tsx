// @vitest-environment jsdom

import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { OwnedWorkCleanup } from '../components/session-detail/OwnedWorkCleanup';

const { dispatch } = vi.hoisted(() => ({
  dispatch: vi.fn(async () => undefined),
}));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  dispatchOrchestrationCommand: dispatch,
}));
afterEach(() => {
  cleanup();
  dispatch.mockReset();
});

const session: OrchestrationSessionSummary = {
  threadId: 'parent',
  provider: 'claude',
  status: 'closed',
  lifecycleState: 'running',
  hasActiveTurn: false,
  controlMode: 'station-owned',
  answerability: { answerable: true },
  isLoaded: false,
  isPersisted: true,
  eventCount: 2,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  ownedWork: {
    state: 'unknown',
    ownLifecycleState: 'canceled',
    runningChildCount: 0,
    pendingStopCount: 1,
    pendingStops: [{ custody: 'unknown', reason: 'dead-owner', count: 1 }],
  },
};

function mount() {
  const removed = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <OwnedWorkCleanup
        session={session}
        apiBase="http://station.test"
        onRemoved={removed}
      />
    </QueryClientProvider>,
  );
  return removed;
}

test('release waits for an explicit untracked-process confirmation and cancel sends nothing', async () => {
  const removed = mount();
  expect(
    screen.getByText('The Station process that owned the child has exited.')
      .textContent,
  ).toBe('The Station process that owned the child has exited.');
  fireEvent.click(screen.getByRole('button', { name: 'Release and remove' }));
  const dialog = screen.getByRole('alertdialog');
  expect(
    within(dialog).getByText(
      /Child processes may still be running and will no longer be tracked/,
    ),
  ).toBeTruthy();
  expect(dispatch).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Keep tracking' }),
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(dispatch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Release and remove' }));
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Release and remove',
    }),
  );
  await waitFor(() => expect(removed).toHaveBeenCalledOnce());
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(
    {
      type: 'releaseUnknownOwnedWork',
      threadId: 'parent',
      confirmation: 'child-process-may-still-be-running',
    },
    'http://station.test',
  );
});

test('a refused release stays visible and keeps the session tracked', async () => {
  dispatch.mockRejectedValueOnce(
    new Error('A child with a known owner cannot be released.'),
  );
  const removed = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Release and remove' }));
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Release and remove',
    }),
  );
  await screen.findByText('A child with a known owner cannot be released.');
  expect(screen.getByRole('alertdialog').textContent).toContain(
    'A child with a known owner cannot be released.',
  );
  expect(removed).not.toHaveBeenCalled();
});
