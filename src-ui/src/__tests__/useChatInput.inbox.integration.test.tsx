/** @vitest-environment jsdom */
import { SDKProvider } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AGENT,
  CONVERSATION,
  createInboxHarness,
  READER,
} from '../../../src-server/routes/orchestration/__tests__/helpers/thread-inbox-harness';
import { ActiveChatsProvider } from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import { useChatInput } from '../hooks/useChatInput';

vi.mock('../contexts/AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => ({ namespace: 'fixture', status: 'verified' }),
}));
vi.mock('../contexts/AccountPreferencesContext', () => ({
  useAccountPreferences: () => ({
    status: 'account',
    data: { schemaVersion: 1, values: { interactiveApprovalModes: {} } },
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://inbox.station' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const apiBase = 'http://inbox.station';
const sessionId = 'mounted-inbox';

describe('mounted composer inbox handoff (test-scoped caller)', () => {
  const station = createInboxHarness();
  afterEach(() => {
    activeChatsStore.removeChat(sessionId);
    vi.unstubAllGlobals();
  });

  test('queues a busy follow-up through SDK and Hono for an independent reader', async () => {
    // SQLite returns Node-realm blobs; use that realm's byte-array constructor.
    vi.stubGlobal(
      'Uint8Array',
      Object.getPrototypeOf(Buffer.prototype).constructor,
    );
    const world = station();
    await world.busy();
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      world.app.request(new Request(input, init)),
    );
    activeChatsStore.initChat(sessionId, {
      agentSlug: AGENT,
      agentName: 'Claude',
      title: 'Inbox',
      conversationId: CONVERSATION,
    });
    activeChatsStore.updateChat(sessionId, {
      status: 'sending',
      input: 'then summarize',
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <SDKProvider value={{ apiBase, contexts: {}, hooks: {} }}>
          <ActiveChatsProvider>{children}</ActiveChatsProvider>
        </SDKProvider>
      </QueryClientProvider>
    );
    const mounted = renderHook(
      () =>
        useChatInput({
          apiBase,
          sessionId,
          agentSlug: AGENT,
          conversationId: CONVERSATION,
          availableModels: [],
        }),
      { wrapper },
    );
    await act(async () => {
      await mounted.result.current.handleSend(undefined, undefined, {
        queueOnBusy: true,
      });
    });
    // READER is the existing fixture's scoped caller switch, not authentication coverage.
    const response = await world.listInbox(READER);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'then summarize', state: 'queued' }),
      ]),
    );
    expect(activeChatsStore.getSnapshot()[sessionId]?.queuedMessages).toEqual(
      [],
    );
    mounted.unmount();
    client.clear();
  });
});
