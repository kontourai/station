// @vitest-environment jsdom

/**
 * The dock header and its reset dialog read ONE conversation's
 * context-boundary status. The dock used to hand-roll its own `useQuery`
 * under a `'conversation-context-boundary'` key while the dialog called the
 * SDK's `useConversationContextBoundaryStatusQuery`, so a dock with the
 * dialog open held two cache entries and two two-second refetch timers over
 * the same endpoint.
 *
 * This mounts the dock's REAL boundary hook (`useConversationBoundaryDialogs`)
 * beside the REAL dialog and reads the REAL query cache: one entry, not two.
 * A hand-rolled query, or a drifted call shape (a different `apiBase`,
 * idempotency-key default, or key factory), lands on its own entry.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationContextResetDialog } from '../components/chat-dock/ConversationContextResetDialog';
import { contextBoundaryUiStorageKey } from '../components/chat-dock/conversationContextBoundaryUiState';
import { useConversationBoundaryDialogs } from '../components/chat-dock/useConversationBoundaryDialogs';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
} from '../lib/outboundQueue';
import { _resetOutboundQueueSource } from '../lib/outboundQueueSnapshotSource';
import type { ChatSession } from '../types';

const API_BASE = 'http://station.test';
const CONVERSATION_ID = 'conversation-under-reset';
const IDEMPOTENCY_KEY = 'idem-1';

function seedStoredBoundary(): void {
  window.localStorage.setItem(
    contextBoundaryUiStorageKey(CONVERSATION_ID),
    JSON.stringify({
      idempotencyKey: IDEMPOTENCY_KEY,
      boundaryId: 'boundary-1',
      conversationId: CONVERSATION_ID,
      policy: 'empty-next-cold-start',
      status: 'reserved',
      priorTranscriptInjected: false,
    }),
  );
}

function DockBoundaryHook() {
  useConversationBoundaryDialogs({
    agents: [],
    apiBase: API_BASE,
    activeSession: {
      id: 'session-1',
      conversationId: CONVERSATION_ID,
      agentSlug: 'codex',
    } as ChatSession,
    allSessions: [],
  });
  return null;
}

function boundaryQueryKeys(client: QueryClient): unknown[][] {
  return client
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey as unknown[])
    .filter((key) => String(key[0]).includes('context-boundary'));
}

describe('conversation context-boundary status cache', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // The hook also subscribes to the outbound queue; keep it off IndexedDB.
    let queue: unknown;
    _setOutboundQueueStorage({
      getItem: async () => queue,
      setItem: async (_key, next) => {
        queue = next;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline in test');
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    _resetOutboundQueueSource();
    _resetOutboundQueueStorage();
  });

  test('the dock and its reset dialog observe one cache entry', async () => {
    seedStoredBoundary();
    const client = new QueryClient();

    render(
      <QueryClientProvider client={client}>
        <DockBoundaryHook />
        <ConversationContextResetDialog
          apiBase={API_BASE}
          conversationId={CONVERSATION_ID}
          sessionId="session-1"
          eligibility={{ kind: 'reserve' }}
          onStoppedSessionRefreshed={vi.fn().mockResolvedValue(null)}
          onClose={vi.fn()}
          onReserved={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(boundaryQueryKeys(client).length).toBeGreaterThan(0),
    );
    expect(boundaryQueryKeys(client)).toEqual([
      [
        'orchestration-context-boundary',
        CONVERSATION_ID,
        IDEMPOTENCY_KEY,
        API_BASE,
      ],
    ]);
  });
});
