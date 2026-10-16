// @vitest-environment jsdom

/** The dock and mobile inboxes merge an open chat with the server's
 * approval state while retaining the chat's project identity. */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createRef, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOLD_FIXTURES,
  FOLD_SESSION_CREATED_AT,
} from '../../../tests/helpers/session-summary-fold-fixtures';
import type { AgentSummary } from '../types';

const NOW = Date.parse('2026-09-30T10:01:15.000Z');
const CHAT_TAB = 'tab-1';
const AGENTS: AgentSummary[] = [
  { slug: agentId('demo-agent'), name: 'Demo agent' },
];
/** The row's accessible name: its title and its project. The chat is bound
 *  to Project B and the session reports no slug, so the merge must name the
 *  chat's project, not the session side's "No project" fallback. */
const ROW_NAME = 'Mismatch demo chat, Project B';

/** The server's own fold of a turn that opened an approval (#3042). */
const SESSIONS: OrchestrationSessionSummary[] = [
  {
    provider: 'claude',
    threadId: 'T',
    status: 'running',
    createdAt: FOLD_SESSION_CREATED_AT,
    updatedAt: '2026-09-30T10:00:05.000Z',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 3,
    assignedAgentSlug: agentId('demo-agent'),
    ...FOLD_FIXTURES.approvalInOpenTurn.summary,
  },
];

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => undefined,
}));
import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import { MobileTaskSwitcher } from '../components/chat-dock/MobileTaskSwitcher';
import { activeChatsStore } from '../contexts/active-chats-store';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { useInboxWorkItems } from '../views/home/useInboxWorkItems';
import { useWorkFacts } from '../views/home/useWorkFacts';

/** The dock inbox the way `ChatDock.tsx` mounts it: the shared items and
 *  the facts derived beside them. */
function DockInbox() {
  const items = useInboxWorkItems(AGENTS, SESSIONS);
  const workFacts = useWorkFacts(items, SESSIONS);
  return (
    <ChatDockInboxPanel
      items={items}
      workFacts={workFacts}
      activeChatSessionId={null}
      openChatSessionIds={[CHAT_TAB]}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={vi.fn()}
      onOpenHistory={vi.fn()}
      now={NOW}
    />
  );
}

/** The mobile task switcher the way `ChatDock.tsx` mounts it: the same
 *  items and facts as the dock panel. It portals its sheet, so its rows are
 *  found on the document rather than in a container. */
function MobileSwitcher() {
  const items = useInboxWorkItems(AGENTS, SESSIONS);
  const workFacts = useWorkFacts(items, SESSIONS);
  return (
    <MobileTaskSwitcher
      open
      tasks={items}
      workFacts={workFacts}
      activeChatSessionId={null}
      openChatSessionIds={[CHAT_TAB]}
      visualViewportStyle={{}}
      triggerRef={createRef<HTMLButtonElement>()}
      onClose={vi.fn()}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={vi.fn()}
      now={NOW}
    />
  );
}

function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <KeyboardShortcutsProvider>{ui}</KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
}

/** The status line as drawn, without screen-reader-only text. */
function statusTextIn(root: HTMLElement): string {
  const clone = within(root)
    .getByTestId('inbox-row-status')
    .cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('.sr-only')) hidden.remove();
  return clone.textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  // ONE store state: the chat this tab holds open, on the folded session's
  // conversation. On its own the chat store says nothing about the open
  // approval; only the session does.
  activeChatsStore.initChat(CHAT_TAB, {
    agentSlug: 'demo-agent',
    agentName: 'Demo agent',
    title: 'Mismatch demo chat',
    conversationId: 'T',
    currentSessionId: 'T',
    projectSlug: 'project-b',
    projectName: 'Project B',
  });
});

afterEach(() => {
  cleanup();
  activeChatsStore.removeChat(CHAT_TAB);
  vi.useRealTimers();
});

describe('open chat approval status in the dock and mobile inbox', () => {
  it('the dock shows the session approval status and the chat project', async () => {
    const dock = renderWithProviders(<DockInbox />);
    const dockRow = await within(dock.container).findByRole('button', {
      name: ROW_NAME,
    });

    expect(statusTextIn(dock.container)).toBe('Needs approval');
    expect(within(dock.container).getByTestId('inbox-row').dataset.lane).toBe(
      'needsYou',
    );
    expect(dockRow.getAttribute('aria-label')).toBe(ROW_NAME);
    expect(
      within(dock.container).getByText('Project B', {
        selector: '.inbox-row__project',
      }),
    ).toBeTruthy();
  });

  it('the mobile task switcher shows the same row', async () => {
    renderWithProviders(<MobileSwitcher />);
    const row = await screen.findByRole('button', { name: ROW_NAME });
    const sheet = row.closest('[data-testid="inbox-row"]') as HTMLElement;
    expect(within(sheet).getByText('Needs approval')).toBeTruthy();
    expect(sheet.dataset.lane).toBe('needsYou');
  });

  it('merges the open chat with its session once', () => {
    // The merged item carries the session it was merged with; a chat-only
    // item carries none.
    let items: ReturnType<typeof useInboxWorkItems> = [];
    function Probe() {
      items = useInboxWorkItems(AGENTS, SESSIONS);
      return null;
    }
    render(<Probe />);
    const row = items.find((item) => item.chatSessionId === CHAT_TAB);
    expect(row).toMatchObject({
      id: 'T',
      kind: 'chat',
      lifecycleLabel: 'Needs attention',
      orchestrationThreadId: 'T',
    });
    // Every open chat has its one item here; nothing is invented for it.
    expect(
      items.filter((item) => item.chatSessionId === CHAT_TAB),
    ).toHaveLength(1);
  });
});
