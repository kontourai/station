/**
 * @vitest-environment jsdom
 *
 * #1582 B9: an empty, just-created chat counted as "1 open chat" and produced
 * a "Continue most recent work" card. After a reload both were gone — so it
 * was never work.
 *
 * The two answers came from two different places. What survives a reload is
 * decided by the store's own write path (`serializeActiveChats`); what the
 * count and the card render was the raw live map, unfiltered. They now share
 * one predicate, and this file drives the REAL store through the real creation
 * and promotion calls rather than hand-building chat maps, because the point
 * is that the map the count reads and the map the store writes are the same
 * map.
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { serializeActiveChats } from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import { openChatsStore } from '../contexts/open-chats-store';
import type { AgentSummary } from '../types';

const AGENTS = [{ slug: 'claude', name: 'Claude Code' }] as AgentSummary[];

function openChatCount(): number {
  return openChatsStore.select(AGENTS).length;
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
    expect(openChatCount()).toBe(0);
    expect(survivesReloadCount()).toBe(0);
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

    expect(openChatCount()).toBe(1);
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

    expect(openChatCount()).toBe(1);
    expect(survivesReloadCount()).toBe(1);
  });

  // The property the fix is FOR, over a map holding all three shapes at once:
  // the two readings agree, whatever is in the store.
  test('the open-chat count equals what survives a reload', () => {
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
    expect(openChatCount()).toBe(survivesReloadCount());
    expect(openChatCount()).toBe(1);
  });
});
