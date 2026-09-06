/**
 * @vitest-environment jsdom
 *
 * #1582 B9: an empty, just-created chat produced a "Continue most recent work
 * → New chat" card on Home. After a reload it was gone — so it was never work.
 * What survives a reload is decided by the store's own write path
 * (`serializeActiveChats`); Home's card read the raw live map, unfiltered.
 *
 * There are two questions here and they have different answers, which is why
 * there are two selectors over one predicate:
 *
 * - the dock inbox and the sidebar's mini-inbox list the chats OPEN IN THIS
 *   TAB, and a chat the user is looking at belongs in both whatever it holds;
 * - Home names WORK.
 *
 * Filtering both at once is not hypothetical: the first cut of this fix did,
 * and a just-created chat vanished from the dock's own list — caught by
 * `tests/cross-runtime-chat-switching.spec.ts` in the PR smoke suite, by no
 * unit test, and by nothing in this file until the inbox case below was added.
 *
 * This drives the REAL store through the real creation and promotion calls
 * rather than hand-building chat maps, because the point is that the map these
 * selectors read and the map the store writes are the same map.
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { serializeActiveChats } from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import { openChatsStore } from '../contexts/open-chats-store';
import type { AgentSummary } from '../types';
import { buildActiveChatTaskItems } from '../views/home/home-view-model';

const AGENTS = [{ slug: 'claude', name: 'Claude Code' }] as AgentSummary[];

/** What an inbox lists: every chat open in this tab. */
function openChatCount(): number {
  return openChatsStore.select(AGENTS).length;
}

/** What Home names: the chats that are work (`useOpenWorkChats`'s selection). */
function workChatCount(): number {
  return buildActiveChatTaskItems({
    chats: activeChatsStore.getSnapshot(),
    agents: AGENTS,
    onlyWork: true,
  }).length;
}

function survivesReloadCount(): number {
  return serializeActiveChats(activeChatsStore.getSnapshot()).length;
}

beforeEach(() => {
  sessionStorage.clear();
  for (const sessionId of Object.keys(activeChatsStore.getSnapshot())) {
    activeChatsStore.removeChat(sessionId);
  }
});

describe('what counts as an open chat', () => {
  test('a chat created and never used is not open work', () => {
    activeChatsStore.initChat('claude:1788672912443', {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'New chat',
    });

    // It IS in the live map — this is not a test of the store forgetting it.
    expect(Object.keys(activeChatsStore.getSnapshot())).toContain(
      'claude:1788672912443',
    );
    expect(workChatCount()).toBe(0);
    expect(survivesReloadCount()).toBe(0);
    // ...and it is still IN the inbox, because the user is looking at it.
    expect(openChatCount()).toBe(1);
  });

  test('the same chat becomes open work once its first turn promotes it', () => {
    activeChatsStore.initChat('claude:1788672912443', {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'New chat',
    });
    activeChatsStore.assignConversationId(
      'claude:1788672912443',
      'conversation-1',
    );

    expect(workChatCount()).toBe(1);
    expect(survivesReloadCount()).toBe(1);
  });

  test('a chat holding an unsent record is open work before promotion', () => {
    // archive#3706: the record's only durable copy is in this chat, so the
    // store persists it before any conversation exists. The count has to
    // agree, or a chat with unsent work would go uncounted.
    activeChatsStore.initChat('claude:unsent', {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'New chat',
    });
    activeChatsStore.updateChat('claude:unsent', {
      unsentMessages: [
        {
          id: 'unsent-1',
          content: 'a draft nobody has sent',
          reason: 'the chat had already ended',
          at: Date.now(),
        },
      ],
    });

    expect(workChatCount()).toBe(1);
    expect(survivesReloadCount()).toBe(1);
  });

  // The property the fix is FOR, over a map holding all three shapes at once:
  // the two readings agree, whatever is in the store.
  test('the work count equals what survives a reload, while the inbox lists them all', () => {
    const metadata = {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'New chat',
    };
    activeChatsStore.initChat('claude:draft', metadata);
    activeChatsStore.initChat('claude:promoted', metadata);
    activeChatsStore.assignConversationId('claude:promoted', 'conversation-2');
    activeChatsStore.initChat('claude:another-draft', metadata);

    expect(Object.keys(activeChatsStore.getSnapshot())).toHaveLength(3);
    expect(workChatCount()).toBe(survivesReloadCount());
    expect(workChatCount()).toBe(1);
    // The regression the PR smoke suite caught: an inbox drops nothing.
    expect(openChatCount()).toBe(3);
  });
});
