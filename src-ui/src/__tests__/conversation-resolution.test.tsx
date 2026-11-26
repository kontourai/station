// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InboxRow } from '../components/chat-dock/ChatDockInboxRows';
import type { HomeWorkItem } from '../views/home/home-view-model';

vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => null,
  useApiBase: () => ({ apiBase: 'http://localhost' }),
}));

const item: HomeWorkItem = {
  id: 'conversation',
  conversationId: 'conversation',
  kind: 'chat',
  kindLabel: 'Direct chat',
  title: 'Review inbox',
  projectLabel: 'Station',
  agentLabel: 'Codex',
  modelLabel: 'GPT',
  updatedAt: 1000,
  lifecycleLabel: 'Completed',
  chatSessionId: 'conversation',
};

describe('Mark done row actions', () => {
  it.each([false, true])(
    'desktop invokes Mark done or Reopen (done: %s) from the row menu and restores row focus',
    (isDone) => {
      const onSelect = vi.fn();
      render(
        <InboxRow
          item={item}
          now={2000}
          isCurrent={false}
          isSnoozed={false}
          onActivate={vi.fn()}
          done={{ done: isDone, pending: false, onSelect }}
        />,
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Actions for Review inbox' }),
      );
      fireEvent.click(
        screen.getByRole('menuitem', { name: isDone ? 'Reopen' : 'Mark done' }),
      );
      expect(onSelect).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: /^Review inbox\b/ }),
      );
    },
  );

  it('mobile marks done from Details, closes the sheet, and keeps the row reachable', async () => {
    const onSelect = vi.fn();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <InboxRow
          item={item}
          now={2000}
          isCurrent={false}
          isSnoozed={false}
          onActivate={vi.fn()}
          chrome="touch"
          actionsInDetails
          done={{ done: false, pending: false, onSelect }}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Review inbox' }),
    );
    expect(await screen.findByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(onSelect).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      screen.getByRole('button', { name: /^Review inbox\b/ }),
    ).toBeTruthy();
  });
});
