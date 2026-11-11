// @vitest-environment jsdom

/**
 * #3075: the inbox shows the server's read state. Each row here is built the
 * way the dock builds it: a server inventory item (`ConversationListItem`,
 * carrying `readState`) layered onto a work item by the one inventory mapping
 * (`withConversationInventory`), then rendered by the real inbox panel.
 * Nothing else decides "unread": the old client `hasUnread` is gone.
 */

import type { ConversationListItem } from '@kontourai/station-contracts/orchestration';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { withConversationInventory } from '../views/home/conversation-inventory-facts';
import type { HomeWorkItem } from '../views/home/home-view-model';

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
    agentSlug: 'default' as ConversationListItem['agentSlug'],
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

describe('inbox unread state comes from the server', () => {
  beforeEach(() => {
    localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
    focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  });
  afterEach(() => {
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
    const onScreen = renderPanel([current], {
      activeChatSessionId: 'current',
      activeChatOnScreen: true,
    });
    expect(
      screen.getByRole('button', { name: /^current title, station/ }),
    ).not.toBeNull();
    onScreen.unmount();

    focused = false;
    const unfocused = renderPanel([current], {
      activeChatSessionId: 'current',
      activeChatOnScreen: true,
    });
    expect(
      screen.getByRole('button', { name: /^current title, unread, station/ }),
    ).not.toBeNull();
    unfocused.unmount();

    // Focused, but the list covers the chat (a phone inbox).
    focused = true;
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
});
