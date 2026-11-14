// @vitest-environment jsdom

/**
 * #3075: the inbox shows the server's read state. Each row here is built the
 * way the dock builds it: a server inventory item (`ConversationListItem`,
 * carrying `readState`) layered onto a work item by the one inventory mapping
 * (`withConversationInventory`), then rendered by the real inbox panel.
 * Nothing else decides "unread": the old client `hasUnread` is gone.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ConversationListItem } from '@kontourai/station-contracts/orchestration';
import { conversationQueries } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import { conversationOnScreenStore } from '../contexts/conversation-on-screen-store';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { withConversationInventory } from '../views/home/conversation-inventory-facts';
import type { HomeWorkItem } from '../views/home/home-view-model';

// The app supplies connection authority; these isolated row tests supply the
// project catalogue used by the scope labels without starting remote reads.
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [] }),
}));

const NOW = Date.parse('2026-11-11T12:00:00Z');
const UPDATED_AT = '2026-11-11T11:58:00.000Z';
const VERSION = Date.parse(UPDATED_AT);

function workItem(id: string): HomeWorkItem {
  return {
    id,
    kind: 'chat',
    kindLabel: 'Direct chat',
    title: `${id} title`,
    projectLabel: 'station',
    agentLabel: 'Claude Code',
    modelLabel: 'Opus',
    updatedAt: NOW - 120_000,
    lifecycleLabel: 'Ready',
    chatSessionId: id,
  };
}

/** What `GET /api/conversations` returns for this conversation. */
function inventoryItem(
  id: string,
  readState: ConversationListItem['readState'],
): ConversationListItem {
  return {
    id,
    source: 'runtime',
    agentSlug: agentId('default'),
    title: `${id} title`,
    createdAt: '2026-11-11T11:00:00.000Z',
    updatedAt: UPDATED_AT,
    messageCount: 4,
    mutable: false,
    answerability: { answerable: true },
    ...(readState ? { readState } : {}),
  };
}

function fromServer(
  id: string,
  readState: ConversationListItem['readState'],
): HomeWorkItem {
  const [item] = withConversationInventory(
    [workItem(id)],
    new Map([[id, inventoryItem(id, readState)]]),
  );
  return item!;
}

function renderPanel(
  items: HomeWorkItem[],
  overrides: Partial<React.ComponentProps<typeof ChatDockInboxPanel>> = {},
) {
  return render(
    <ChatDockInboxPanel
      items={items}
      activeChatSessionId={null}
      openChatSessionIds={items.map((item) => item.id)}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={vi.fn()}
      onOpenHistory={vi.fn()}
      now={NOW}
      {...overrides}
    />,
  );
}

const rowOf = (name: RegExp) =>
  screen.getByRole('button', { name }).closest('[data-testid="inbox-row"]');

let focused = true;
const dock = Symbol('test-dock');

describe('inbox unread state comes from the server', () => {
  beforeEach(() => {
    localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
    focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  });
  afterEach(() => {
    act(() => conversationOnScreenStore.release(dock));
    cleanup();
    vi.restoreAllMocks();
  });

  it('marks exactly the rows the server reports unread, in the accessible name and the row', () => {
    renderPanel([
      fromServer('fresh', { version: VERSION, seenVersion: 0, unread: true }),
      fromServer('seen', {
        version: VERSION,
        seenVersion: VERSION,
        unread: false,
      }),
      // A server that reports no read state: never a guessed one.
      fromServer('unknown', undefined),
    ]);

    expect(
      screen.getByRole('button', { name: /^fresh title, unread, station/ }),
    ).not.toBeNull();
    expect(rowOf(/^fresh title/)?.hasAttribute('data-unread')).toBe(true);

    for (const id of ['seen', 'unknown']) {
      const name = new RegExp(`^${id} title, station`);
      expect(screen.getByRole('button', { name })).not.toBeNull();
      expect(rowOf(name)?.hasAttribute('data-unread')).toBe(false);
    }
  });

  it('the chat on screen in a focused window never reads unread; unfocused, or covered, it stays unread', () => {
    const current = fromServer('current', {
      version: VERSION,
      seenVersion: 0,
      unread: true,
    });
    // The dock publishes its chat as on screen while its pane shows it.
    act(() => conversationOnScreenStore.publish(dock, 'current'));
    const onScreen = renderPanel([current], {
      activeChatSessionId: 'current',
    });
    expect(
      screen.getByRole('button', { name: /^current title, station/ }),
    ).not.toBeNull();
    onScreen.unmount();

    focused = false;
    const unfocused = renderPanel([current], {
      activeChatSessionId: 'current',
    });
    expect(
      screen.getByRole('button', { name: /^current title, unread, station/ }),
    ).not.toBeNull();
    unfocused.unmount();

    // Focused, but the list covers the chat (a phone inbox): the dock
    // withdraws its on-screen answer.
    focused = true;
    act(() => conversationOnScreenStore.release(dock));
    renderPanel([current], { activeChatSessionId: 'current' });
    expect(
      screen.getByRole('button', { name: /^current title, unread, station/ }),
    ).not.toBeNull();
  });

  it('opening an unread row acknowledges the version the server reported for it', async () => {
    const onAcknowledgeConversation = vi.fn();
    const fresh = fromServer('fresh', {
      version: VERSION,
      seenVersion: 0,
      unread: true,
    });
    expect(fresh).toMatchObject({
      unread: true,
      readVersion: VERSION,
      conversationUpdatedAt: UPDATED_AT,
    });
    renderPanel([fresh], { onAcknowledgeConversation });
    fireEvent.click(
      screen.getByRole('button', { name: /^fresh title, unread, station/ }),
    );
    await waitFor(() =>
      expect(onAcknowledgeConversation).toHaveBeenCalledWith(fresh),
    );
  });

  it('a row whose read state the server could not read shows as unknown, never as read, with one quiet retry', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const lost = fromServer('lost', {
      version: VERSION,
      unavailable: true,
    });
    render(
      <QueryClientProvider client={client}>
        <ChatDockInboxPanel
          items={[
            lost,
            fromServer('known', {
              version: VERSION,
              seenVersion: VERSION,
              unread: false,
            }),
          ]}
          activeChatSessionId={null}
          openChatSessionIds={['lost', 'known']}
          onFocusChat={vi.fn()}
          onOpenConversation={vi.fn()}
          onOpenSession={vi.fn()}
          onCloseChat={vi.fn()}
          onOpenHistory={vi.fn()}
          now={NOW}
        />
      </QueryClientProvider>,
    );
    expect(lost).not.toHaveProperty('unread');
    const name = /^lost title, read status unknown, station/;
    expect(screen.getByRole('button', { name })).not.toBeNull();
    const row = rowOf(name);
    expect(row?.hasAttribute('data-unread')).toBe(false);
    expect(row?.hasAttribute('data-read-unknown')).toBe(true);
    expect(
      rowOf(/^known title, station/)?.hasAttribute('data-read-unknown'),
    ).toBe(false);
    // One note for the surface, not one per row.
    const notes = screen
      .getAllByRole('status')
      .filter((node) => node.textContent?.includes('Read status unavailable'));
    expect(notes).toHaveLength(1);
    fireEvent.click(within(notes[0]!).getByRole('button', { name: 'Retry' }));
    expect(invalidate).toHaveBeenCalledWith(
      { queryKey: conversationQueries.inventory().queryKey },
      { cancelRefetch: false },
    );
  });
});
