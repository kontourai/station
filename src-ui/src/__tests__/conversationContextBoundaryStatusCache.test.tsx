// @vitest-environment jsdom

/**
 * The dock header and its reset dialog read ONE conversation's
 * context-boundary status. The dock used to hand-roll its own `useQuery`
 * under a `'conversation-context-boundary'` key while the dialog called the
 * SDK's `useConversationContextBoundaryStatusQuery`, so a dock with the
 * dialog open held two cache entries and two two-second refetch timers over
 * the same endpoint.
 *
 * What is proved here, and what is not:
 *
 * - The behavioural test mounts the REAL dialog and a probe that issues the
 *   dock's call, and reads the REAL query cache: one entry, not two. That is
 *   the property the fix exists for, and it fails if either call shape drifts
 *   (a different `apiBase`, a different idempotency-key default, a different
 *   key factory) — the drifted caller lands on its own entry.
 * - It does not mount `ChatWorkspacePane`. No test in this repo does: its
 *   graph needs an active chat session carrying a `conversationId`, seeded
 *   through `activeChatsStore` plus the conversation inventory query, and
 *   `DockShellControlParity.test.tsx`/`DockShellProjectBinding.test.tsx` both
 *   record that decision. So the probe is a copy of the dock's call, and the
 *   second test pins the dock's real call against it: the copy cannot silently
 *   stop describing the original.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useConversationContextBoundaryStatusQuery } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationContextResetDialog } from '../components/chat-dock/ConversationContextResetDialog';
import { contextBoundaryUiStorageKey } from '../components/chat-dock/conversationContextBoundaryUiState';

const API_BASE = 'http://station.test';
const CONVERSATION_ID = 'conversation-under-reset';
const IDEMPOTENCY_KEY = 'idem-1';

/**
 * The dock's own source. `ChatWorkspacePane` holds the surface; its
 * conversation-boundary state (including this query) lives in
 * `useConversationBoundaryDialogs`. Both are read so the "no hand-rolled
 * query is left in the dock" assertions keep covering the whole surface
 * wherever the call currently sits.
 */
const dockSource = [
  join(__dirname, '..', 'components', 'chat-dock', 'ChatDock.tsx'),
  join(
    __dirname,
    '..',
    'components',
    'chat-dock',
    'useConversationBoundaryDialogs.ts',
  ),
]
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

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

/**
 * The dock's call, verbatim. The second test is what keeps it verbatim.
 */
function DockBoundaryStatusProbe({
  apiBase,
  conversationId,
  idempotencyKey,
}: {
  apiBase: string;
  conversationId: string;
  idempotencyKey: string | undefined;
}) {
  useConversationContextBoundaryStatusQuery(
    conversationId,
    idempotencyKey ?? '',
    apiBase,
    { enabled: Boolean(idempotencyKey), refetchInterval: 2_000 },
  );
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
  });

  test('the dock and its reset dialog observe one cache entry', async () => {
    seedStoredBoundary();
    const client = new QueryClient();

    render(
      <QueryClientProvider client={client}>
        <DockBoundaryStatusProbe
          apiBase={API_BASE}
          conversationId={CONVERSATION_ID}
          idempotencyKey={IDEMPOTENCY_KEY}
        />
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

  test('the dock issues exactly the call the probe copies', () => {
    // No hand-rolled query for this endpoint is left in the dock.
    expect(dockSource).not.toContain("'conversation-context-boundary'");
    expect(dockSource).not.toContain('getConversationContextBoundaryStatus');

    const call = dockSource.match(
      /useConversationContextBoundaryStatusQuery\(([\s\S]{0,300}?)\);/,
    );
    expect(call, 'the dock must call the SDK boundary-status query').not.toBe(
      null,
    );
    const args = (call?.[1] ?? '').replace(/\s+/g, ' ');
    expect(args).toContain('activeConversationId');
    expect(args).toContain("contextBoundaryStored?.idempotencyKey ?? ''");
    expect(args).toContain('apiBase');
    expect(args).toContain('enabled: Boolean(contextBoundaryStored)');
    expect(args).toContain('refetchInterval: 2_000');
  });
});
