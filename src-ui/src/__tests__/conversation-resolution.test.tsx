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

describe('conversation resolution row actions', () => {
  it.each([false, true])(
    'desktop invokes the %s resolution action and restores row focus',
    (settled) => {
      const onChange = vi.fn();
      render(
        <InboxRow
          item={item}
          now={2000}
          isCurrent={false}
          isSnoozed={false}
          isOpenChat
          onActivate={vi.fn()}
          resolution={{ settled, pending: false, onChange }}
        />,
      );
      const action = screen.getByRole('button', {
        name: `${settled ? 'Reopen' : 'Settle'} Review inbox`,
      });
      action.focus();
      fireEvent.click(action);
      expect(onChange).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Review inbox, Station' }),
      );
    },
  );

  it('mobile settles from Details, closes the sheet, and keeps the row reachable', async () => {
    const onChange = vi.fn();
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
          isOpenChat
          onActivate={vi.fn()}
          chrome="touch"
          actionsInDetails
          resolution={{ settled: false, pending: false, onChange }}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Review inbox' }),
    );
    expect(await screen.findByRole('dialog')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Settle conversation' }),
    );
    expect(onChange).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      screen.getByRole('button', { name: 'Review inbox, Station' }),
    ).toBeTruthy();
  });
});
