// @vitest-environment jsdom
/**
 * #2310 — the Draft lane through the RENDERED dock inbox, built exactly as
 * production builds it (ChatDock.tsx: `buildHomeTaskItems({ chats: {},
 * sessions, chatItems: useOpenChats(agents, sessions) })`, where
 * `useOpenChats` is `buildActiveChatTaskItems`). Ported from the independent
 * verifier's production-path probe; the sending-device case (AC2) failed on
 * 088a2b359 and passes after the review H1 fix.
 */
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import type { ChatUIState } from '../contexts/active-chats-state';
import { deviceSettingsStore } from '../lib/device-settings-store';
import {
  buildActiveChatTaskItems,
  buildHomeTaskItems,
} from '../views/home/home-view-model';

const THREAD = 'grok-build:1790099828990';
const NOW = Date.parse('2026-09-22T20:00:00.000Z');

// The field shape the server builder emits for a never-prompted session
// (hand-transcribed; see draft-inbox-lanes.test.ts for provenance).
const SERVER_DRAFT: OrchestrationSessionSummary = {
  provider: 'acp',
  threadId: THREAD,
  status: 'ready',
  controlMode: 'station-owned',
  answerability: { answerable: true },
  createdAt: '2026-09-22T17:58:14.194Z',
  updatedAt: '2026-09-22T17:58:15.194Z',
  isLoaded: false,
  isPersisted: true,
  eventCount: 34,
  lifecycleState: 'queued',
  pendingReview: false,
  assignedAgentSlug:
    'grok-build' as OrchestrationSessionSummary['assignedAgentSlug'],
  projectSlug: 'example-project',
  conversationId: THREAD,
  environmentId: 'env-test',
  lastEventAt: '2026-09-22T17:58:14.534Z',
  lastEventMethod: 'policy.hooks-attached',
  hasActiveTurn: false,
  draft: true,
} as OrchestrationSessionSummary;

const HISTORY: OrchestrationSessionSummary = {
  ...SERVER_DRAFT,
  threadId: 'claude:1790000000000',
  conversationId: 'claude:1790000000000',
  provider: 'claude',
  assignedAgentSlug:
    'claude-code' as OrchestrationSessionSummary['assignedAgentSlug'],
  lifecycleState: 'running',
  lastEventMethod: 'turn.completed',
  draft: false,
};

const AFTER_FIRST_TURN_DONE: OrchestrationSessionSummary = {
  ...SERVER_DRAFT,
  lifecycleState: 'running',
  status: 'running',
  lastEventMethod: 'turn.completed',
  hasActiveTurn: false,
  draft: false,
};

function panelItems(
  sessions: OrchestrationSessionSummary[],
  chats: Record<string, Partial<ChatUIState>> = {},
) {
  // Production (ChatDock.tsx): buildHomeTaskItems({chats:{}, sessions,
  // chatItems: useOpenChats(agents, sessions)}) where useOpenChats =
  // buildActiveChatTaskItems({chats, agents, sessions}).
  const chatItems = buildActiveChatTaskItems({
    chats: chats as Record<string, ChatUIState>,
    agents: [],
    sessions,
  });
  return buildHomeTaskItems({ chats: {}, sessions, agents: [], chatItems });
}

function renderInbox(items: ReturnType<typeof panelItems>) {
  return render(
    <ChatDockInboxPanel
      items={items}
      activeChatSessionId={undefined as never}
      openChatSessionIds={[]}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={vi.fn()}
      onOpenHistory={vi.fn()}
      now={NOW}
    />,
  );
}

describe('#2310 Drafts through the rendered dock inbox', () => {
  beforeEach(() => {
    localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
  });

  it('AC1: server Draft summary renders under Drafts, not Active now; history row stays Active now', () => {
    renderInbox(panelItems([SERVER_DRAFT, HISTORY]));
    const active = screen.getByRole('region', { name: 'Active now' });
    const drafts = screen.getByRole('region', { name: 'Drafts' });
    expect(within(drafts).getByText('Draft')).not.toBeNull();
    expect(drafts.textContent).toContain('grok-build');
    expect(active.textContent).not.toContain('grok-build');
    expect(active.textContent).toContain('claude-code');
  });

  it('AC2 (render half): refreshed summary moves the row out of Drafts', () => {
    const view = renderInbox(panelItems([SERVER_DRAFT, HISTORY]));
    expect(
      screen.getByRole('region', { name: 'Drafts' }).textContent,
    ).toContain('grok-build');
    view.rerender(
      <ChatDockInboxPanel
        items={panelItems([AFTER_FIRST_TURN_DONE, HISTORY])}
        activeChatSessionId={undefined as never}
        openChatSessionIds={[]}
        onFocusChat={vi.fn()}
        onOpenConversation={vi.fn()}
        onOpenSession={vi.fn()}
        onCloseChat={vi.fn()}
        onOpenHistory={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Drafts' })).toBeNull();
    expect(
      screen.getByRole('region', { name: 'Active now' }).textContent,
    ).toContain('grok-build');
  });

  it('AC2 sending device: first turn completed locally, sessions cache NOT refetched, row is not a Draft', () => {
    // Chat store after the first prompt's turn completed on this device.
    // orchestrationSessionStarted/currentSessionId are what session.started
    // (eventHandlers.ts) / conversation reopen set BEFORE the first send, which
    // makes useActiveChatSessionMessaging skip invalidate(['orchestration-sessions']).
    renderInbox(
      panelItems([SERVER_DRAFT, HISTORY], {
        [THREAD]: {
          agentSlug: 'grok-build',
          status: 'idle',
          orchestrationStatus: 'running',
          orchestrationSessionStarted: true,
          currentSessionId: THREAD,
          conversationId: THREAD,
          createdAt: Date.parse('2026-09-22T17:58:14.000Z'),
          messages: [
            { role: 'user', content: 'first prompt', timestamp: NOW - 60_000 },
            { role: 'assistant', content: 'answer', timestamp: NOW - 30_000 },
          ],
        } as Partial<ChatUIState>,
      }),
    );
    const drafts = screen.queryByRole('region', { name: 'Drafts' });
    expect(drafts?.textContent ?? '').not.toContain('grok-build');
  });
});
