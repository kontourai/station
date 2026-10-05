// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  FOLD_FIXTURES,
  FOLD_SESSION_CREATED_AT,
} from '../../../../../tests/helpers/session-summary-fold-fixtures';
import { buildOrchestrationItems } from '../../../views/home/home-view-model';
import { RecentChatList } from '../RecentChatList';

vi.mock('../../../contexts/ApiBaseContext', async (original) => ({
  ...(await original<typeof import('../../../contexts/ApiBaseContext')>()),
  useHostRequestAuthorityScope: () => null,
}));
afterEach(cleanup);

test('the recent list scopes project and No project separately, limits to five newest chats, and opens the selected row', () => {
  const items = buildOrchestrationItems(
    Array.from({ length: 8 }, (_, index) => ({
      provider: 'codex',
      status: 'running' as const,
      createdAt: FOLD_SESSION_CREATED_AT,
      controlMode: 'station-owned' as const,
      answerability: { answerable: true as const },
      isLoaded: true,
      isPersisted: true,
      eventCount: 2,
      displayTitle: `Work ${index}`,
      ...FOLD_FIXTURES.runningTool.summary,
      threadId: `thread-${index}`,
      projectSlug: index === 7 ? undefined : 'project-a',
      updatedAt: new Date(
        Date.parse(FOLD_SESSION_CREATED_AT) + index * 60000,
      ).toISOString(),
    })),
    [],
  );
  const onOpen = vi.fn();
  const props = { items, agents: [], onOpen, onViewAll: vi.fn() };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RecentChatList {...props} context="project-a" />
    </QueryClientProvider>,
  );
  const rows = document.querySelectorAll('.inbox-row__open');
  expect(rows).toHaveLength(5);
  expect(rows[0].textContent).toContain('Work 6');
  expect(screen.queryByRole('button', { name: /Work 7/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Work 1/ })).toBeNull();
  fireEvent.click(rows[0]);
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ orchestrationThreadId: 'thread-6' }),
  );
  view.rerender(
    <QueryClientProvider client={client}>
      <RecentChatList {...props} context="__global__" />
    </QueryClientProvider>,
  );
  expect(document.querySelectorAll('.inbox-row__open')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /^Work 7,/ })).toBeTruthy();
});

// Review MED-3c: an empty draft shows the composer alone, not a heading over
// a "Start something new" placeholder; a pending or failed read still shows.
test('nothing to continue renders nothing; a pending or failed read still says so', () => {
  const props = { items: [], agents: [], onOpen: vi.fn(), onViewAll: vi.fn() };
  const view = render(<RecentChatList {...props} context="__global__" />);
  expect(view.container.innerHTML).toBe('');
  view.rerender(<RecentChatList {...props} context="__global__" pending />);
  expect(screen.getByRole('region', { name: 'Continue working' })).toBeTruthy();
  view.rerender(<RecentChatList {...props} context="__global__" error />);
  expect(screen.getByText('Could not load recent chats')).toBeTruthy();
});
