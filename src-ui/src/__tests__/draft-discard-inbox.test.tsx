// @vitest-environment jsdom
/**
 * #2312 — discarding a Draft, and folding day-old Drafts, through the two
 * rendered inbox hosts: the desktop dock panel and the mobile switcher sheet.
 * Rows are built the way ChatDock.tsx builds them (see
 * draft-inbox-rendered.test.tsx), and the discard is observed at the SDK
 * command it dispatches — the server delete — not at local state.
 */
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatch = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dispatchOrchestrationCommandWithReceipt: dispatch,
}));

import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import { MobileTaskSwitcher } from '../components/chat-dock/MobileTaskSwitcher';
import { DISCARD_DRAFT_FAILED } from '../components/drafts/DiscardDraftButton';
import type { ChatUIState } from '../contexts/active-chats-state';
import { deviceSettingsStore } from '../lib/device-settings-store';
import {
  buildActiveChatTaskItems,
  buildHomeTaskItems,
} from '../views/home/home-view-model';

const NOW = Date.parse('2026-09-23T20:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (ageMs: number) => new Date(NOW - ageMs).toISOString();

function draft(
  threadId: string,
  ageMs: number,
  slug: string,
): OrchestrationSessionSummary {
  return {
    provider: 'acp',
    threadId,
    status: 'ready',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    createdAt: iso(ageMs),
    updatedAt: iso(ageMs),
    isLoaded: false,
    isPersisted: true,
    eventCount: 34,
    lifecycleState: 'queued',
    pendingReview: false,
    assignedAgentSlug: agentId(slug),
    projectSlug: 'example-project',
    conversationId: threadId,
    lastEventAt: iso(ageMs),
    lastEventMethod: 'policy.hooks-attached',
    hasActiveTurn: false,
    draft: true,
    displayTitle: `Draft ${threadId}`,
  };
}

// No open chat: the orchestration-only shape the issue says had no way out.
const FRESH = draft('grok-build:fresh', 23 * HOUR, 'fresh-agent');
const STALE = draft('grok-build:stale', 25 * HOUR, 'stale-agent');
const WORKED: OrchestrationSessionSummary = {
  ...draft('claude:worked', HOUR, 'worked-agent'),
  provider: 'claude',
  lifecycleState: 'running',
  lastEventMethod: 'turn.completed',
  draft: false,
};

function items(
  sessions: OrchestrationSessionSummary[],
  chats: Record<string, Partial<ChatUIState>> = {},
) {
  const chatItems = buildActiveChatTaskItems({
    chats: chats as Record<string, ChatUIState>,
    agents: [],
    sessions,
  });
  return buildHomeTaskItems({ chats: {}, sessions, agents: [], chatItems });
}

function titleOf(rows: ReturnType<typeof items>, threadId: string): string {
  const row = rows.find((item) => item.orchestrationThreadId === threadId);
  if (!row) throw new Error(`no row for ${threadId}`);
  return row.title;
}

let queryClient: QueryClient;
function withQueryClient({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderPanel(
  rows: ReturnType<typeof items>,
  openChatSessionIds: string[] = [],
) {
  const onCloseChat = vi.fn();
  render(
    <ChatDockInboxPanel
      items={rows}
      activeChatSessionId={undefined as never}
      openChatSessionIds={openChatSessionIds}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={onCloseChat}
      onOpenHistory={vi.fn()}
      now={NOW}
    />,
    { wrapper: withQueryClient },
  );
  return { onCloseChat };
}

function accepted(threadId: string) {
  return {
    receipt: {
      commandId: 'discard-1',
      threadId,
      commandType: 'discardDraft',
      status: 'accepted',
      createdAt: new Date(NOW).toISOString(),
    },
    result: null,
  };
}

describe('#2312 discarding Drafts from the inbox', () => {
  beforeEach(() => {
    localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
    dispatch.mockReset();
    queryClient = new QueryClient();
  });

  it('an orchestration-only Draft is discarded by the server command, and the session list is re-read', async () => {
    dispatch.mockResolvedValue(accepted(FRESH.threadId));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const rows = items([FRESH, WORKED]);
    const { onCloseChat } = renderPanel(rows);

    const drafts = screen.getByRole('region', { name: 'Drafts' });
    fireEvent.click(
      within(drafts).getByRole('button', {
        name: `Discard draft ${titleOf(rows, FRESH.threadId)}`,
      }),
    );

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['orchestration-sessions'],
      }),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'discardDraft',
      threadId: FRESH.threadId,
    });
    // No tab was open, so there was none to close.
    expect(onCloseChat).not.toHaveBeenCalled();
  });

  it('a row that is not a Draft offers no discard', () => {
    const rows = items([FRESH, WORKED]);
    renderPanel(rows);
    expect(
      screen.queryByRole('button', {
        name: `Discard draft ${titleOf(rows, WORKED.threadId)}`,
      }),
    ).toBeNull();
    expect(
      screen.getAllByRole('button', { name: /^Discard draft / }),
    ).toHaveLength(1);
  });

  it('a Draft open in a tab is discarded on the server, then its tab closes', async () => {
    dispatch.mockResolvedValue(accepted(FRESH.threadId));
    const rows = items([FRESH], {
      [FRESH.threadId]: {
        agentSlug: 'fresh-agent',
        status: 'idle',
        orchestrationSessionStarted: true,
        currentSessionId: FRESH.threadId,
        conversationId: FRESH.threadId,
        createdAt: NOW - 23 * HOUR,
        messages: [],
      } as Partial<ChatUIState>,
    });
    const row = rows.find((item) => item.chatSessionId === FRESH.threadId);
    // Fixture guard: the merged row is the open chat AND the server Draft.
    expect(row?.lifecycleLabel).toBe('Draft');
    expect(row?.orchestrationThreadId).toBe(FRESH.threadId);
    const { onCloseChat } = renderPanel(rows, [FRESH.threadId]);

    fireEvent.click(
      screen.getByRole('button', { name: `Discard draft ${row?.title}` }),
    );

    await waitFor(() =>
      expect(onCloseChat).toHaveBeenCalledWith(FRESH.threadId),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: 'discardDraft',
      threadId: FRESH.threadId,
    });
  });

  it('a refused discard says so, keeps the tab, and still re-reads the list', async () => {
    dispatch.mockRejectedValue(new Error('Only a Draft can be discarded'));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const rows = items([FRESH]);
    const { onCloseChat } = renderPanel(rows, [FRESH.threadId]);

    fireEvent.click(
      screen.getByRole('button', {
        name: `Discard draft ${titleOf(rows, FRESH.threadId)}`,
      }),
    );

    expect((await screen.findByRole('alert')).textContent).toBe(
      DISCARD_DRAFT_FAILED,
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['orchestration-sessions'],
    });
    expect(onCloseChat).not.toHaveBeenCalled();
  });

  it('a Draft untouched for more than a day folds under "N older drafts" until opened', () => {
    const rows = items([FRESH, STALE]);
    renderPanel(rows);
    const drafts = screen.getByRole('region', { name: 'Drafts' });
    const staleTitle = titleOf(rows, STALE.threadId);
    // Fixture guard: both are Drafts with distinct titles.
    expect(staleTitle).not.toBe(titleOf(rows, FRESH.threadId));

    expect(
      within(drafts).getByText(titleOf(rows, FRESH.threadId)),
    ).toBeTruthy();
    expect(within(drafts).queryByText(staleTitle)).toBeNull();
    const toggle = within(drafts).getByRole('button', {
      name: /1 older draft$/,
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(drafts).getByText(staleTitle)).toBeTruthy();
    // Folded, not hidden from action: the older Draft is still discardable.
    expect(
      within(drafts).getByRole('button', {
        name: `Discard draft ${staleTitle}`,
      }),
    ).toBeTruthy();
  });

  it('the mobile switcher offers the same discard and the same fold', async () => {
    dispatch.mockResolvedValue(accepted(STALE.threadId));
    const rows = items([FRESH, STALE]);
    render(
      <MobileTaskSwitcher
        open
        tasks={rows}
        activeChatSessionId={null}
        visualViewportStyle={{}}
        triggerRef={createRef<HTMLButtonElement>()}
        onClose={vi.fn()}
        onFocusChat={vi.fn()}
        onOpenConversation={vi.fn()}
        onOpenSession={vi.fn()}
        now={NOW}
      />,
      { wrapper: withQueryClient },
    );
    const staleTitle = titleOf(rows, STALE.threadId);
    expect(screen.queryByText(staleTitle)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /1 older draft$/ }));
    fireEvent.click(
      screen.getByRole('button', { name: `Discard draft ${staleTitle}` }),
    );

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({
        type: 'discardDraft',
        threadId: STALE.threadId,
      }),
    );
  });
});
