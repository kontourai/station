/**
 * @vitest-environment jsdom
 */
/**
 * An in-app toast's Open and an attention row's Open name a conversation
 * the way an OS tap does, so the dock reports one that is gone instead of
 * clearing it silently. Each opens through its REAL default navigation into
 * the REAL navigation store; the dock's REAL cold open then reads the chat
 * from the URL against a Station that does not know it.
 */
import type { Notification } from '@kontourai/station-contracts/notification';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useChatDockActiveChatSync } from '../components/chat-dock/useChatDockActiveChatSync';
import { navigationStore } from '../contexts/NavigationContext';
import { activateNotification } from '../lib/notification-activation';
import {
  getNotificationOpenNotice,
  setNotificationOpenNotice,
} from '../lib/notificationStationOpen';
import { navigateToAttentionTarget } from '../utils/attentionOpen';

const fetchConversationById = vi.fn();
vi.mock('@kontourai/station-sdk', () => ({
  fetchConversationById: (...args: unknown[]) => fetchConversationById(...args),
}));
vi.mock('@kontourai/station-sdk/notification-read', () => ({
  markNotificationRead: vi.fn(async () => 'read'),
}));

function dockOpensUrlChat() {
  return renderHook(() =>
    useChatDockActiveChatSync({
      activeChat: navigationStore.getSnapshot().activeChat,
      agentCatalogKey: 'claude',
      agentsLoaded: true,
      apiBase: '/api',
      sessions: [],
      openConversation: vi.fn(),
      setActiveSessionId: vi.fn(),
      updateParams: (params) => navigationStore.updateParams(params),
      showSurface: vi.fn(),
    }),
  );
}

beforeEach(() => {
  fetchConversationById.mockReset();
  // The Station has no record of it: deleted, or never on this Station.
  fetchConversationById.mockResolvedValue(null);
  navigationStore.navigate('/', { chat: null, dock: null });
});

afterEach(() => act(() => setNotificationOpenNotice(null)));

describe('in-app opens of a notification target', () => {
  test("an attention row's Open reports a conversation that is gone", async () => {
    navigateToAttentionTarget('/?chat=gone-from-attention&dock=open');
    expect(navigationStore.getSnapshot().activeChat).toBe(
      'gone-from-attention',
    );
    dockOpensUrlChat();
    await waitFor(() =>
      expect(getNotificationOpenNotice()).toEqual({ kind: 'not-found' }),
    );
  });

  test("an in-app toast's Open reports a conversation that is gone", async () => {
    const notification: Pick<Notification, 'id' | 'metadata'> = {
      id: 'n-1',
      metadata: {
        envelope: {
          v: 1,
          source: {
            kind: 'agent',
            sessionId: 'gone-from-toast',
            agent: 'builder',
            assurance: 'bound',
          },
          audience: { kind: 'session-readers', sessionId: 'gone-from-toast' },
          urgency: 'attention',
          interrupt: 'default',
        },
      },
    };
    await act(async () => {
      await activateNotification(notification);
    });
    expect(navigationStore.getSnapshot().activeChat).toBe('gone-from-toast');
    dockOpensUrlChat();
    await waitFor(() =>
      expect(getNotificationOpenNotice()).toEqual({ kind: 'not-found' }),
    );
  });

  test("an agent's linked notification reports a conversation that is gone", async () => {
    // The envelope AgentNotificationGate writes when notify_user names a link.
    const notification: Pick<Notification, 'id' | 'metadata'> = {
      id: 'n-2',
      metadata: {
        envelope: {
          v: 1,
          source: {
            kind: 'agent',
            sessionId: 'agent-session',
            agent: 'builder',
            assurance: 'bound',
          },
          audience: { kind: 'session-readers', sessionId: 'agent-session' },
          urgency: 'attention',
          target: {
            kind: 'path',
            path: '/?chat=gone-from-agent-link&dock=open',
          },
          interrupt: 'default',
        },
      },
    };
    await act(async () => {
      await activateNotification(notification);
    });
    expect(navigationStore.getSnapshot().activeChat).toBe(
      'gone-from-agent-link',
    );
    dockOpensUrlChat();
    await waitFor(() =>
      expect(getNotificationOpenNotice()).toEqual({ kind: 'not-found' }),
    );
  });

  test('an ordinary chat link that is gone still clears quietly (#1582)', async () => {
    navigationStore.navigate('/', { chat: 'draft-never-saved', dock: 'open' });
    dockOpensUrlChat();
    await waitFor(() =>
      expect(navigationStore.getSnapshot().activeChat).toBeNull(),
    );
    expect(getNotificationOpenNotice()).toBeNull();
  });
});
