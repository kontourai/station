// @vitest-environment jsdom

import { join } from 'node:path';
import type { ConversationContextBoundaryProjection } from '@kontourai/station-contracts/conversation-context-boundary';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs';
import { createOrchestrationRoutes } from '../../../src-server/routes/orchestration/orchestration';
import { ConversationLineage } from '../../../src-server/services/orchestration/conversation-lineage';
import { EventStore } from '../../../src-server/services/orchestration/event-store';
import { ConversationContextResetDialog } from '../components/chat-dock/ConversationContextResetDialog';
import {
  forgetContextBoundaryIntent,
  rememberContextBoundaryIntent,
} from '../components/chat-dock/conversationContextBoundaryUiState';

const stop = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  dispatchOrchestrationCommandWithReceipt: stop,
}));

const tempRoot = trackTempDirs();
const conversationId = 'reset-fixture';
const apiBase = 'http://reset-station.test';
const createdAt = '2026-11-19T00:00:00.000Z';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  stop.mockReset();
});

test.each([
  ['direct reset', { kind: 'reserve' }, 'Reset agent context', false, false],
  ['two stale tabs', { kind: 'reserve' }, 'Reset agent context', false, true],
  [
    'transport replay conflicts after the first commit',
    { kind: 'reserve' },
    'Reset agent context',
    false,
    'replay',
  ],
  [
    'earlier unknown attempt',
    { kind: 'reserve' },
    'Reset agent context',
    false,
    'unknown',
  ],
  [
    'legacy reset hint',
    { kind: 'reserve' },
    'Reset agent context',
    true,
    false,
  ],
  [
    'legacy hint behind a missing scoped attempt',
    { kind: 'reserve' },
    'Reset agent context',
    true,
    'unknown',
  ],
  [
    'stop then reset',
    { kind: 'stop-session', reason: 'Stop the agent first.' },
    'Stop agent and reset',
    false,
    false,
  ],
] as const)(
  '%s recovers the committed reservation after a lost response and reload',
  async (_path, eligibility, label, legacy, competing) => {
    // SQLite returns buffers from the Node realm, outside Vitest's DOM VM.
    vi.stubGlobal(
      'Uint8Array',
      Object.getPrototypeOf(Buffer.prototype).constructor,
    );
    const file = join(tempRoot('context-reset-recovery-'), 'events.sqlite');
    let store = new EventStore(file);
    store.upsertSession({
      provider: 'claude',
      threadId: conversationId,
      status: 'closed',
      createdAt,
      updatedAt: createdAt,
    });
    let committed:
      | { key: string; result: ConversationContextBoundaryProjection }
      | undefined;
    const reservationStatusReads: string[] = [];
    let statusAfterReload: Promise<void> | undefined;
    let releaseStatus: (() => void) | undefined;
    const principal = humanPrincipal('fixture', 'reset-author', 'Reset author');
    const authority = {
      namespace: 'station-reset-owner',
      actorId: principal.id,
      isCurrent: () => true,
    };
    const mountRoutes = (eventStore: EventStore) => {
      const lineage = new ConversationLineage({
        eventStore,
        logger: { warn() {} },
        readSession: async (threadId) =>
          threadId === conversationId
            ? ({
                session: { lifecycleState: 'canceled', hasActiveTurn: false },
              } as Awaited<
                ReturnType<
                  ConstructorParameters<
                    typeof ConversationLineage
                  >[0]['readSession']
                >
              >)
            : null,
        readSessionMessages: () => [],
        readSessionSeedMessages: () => [],
        listSessionReadModel: async () => [],
        canReadSession: (threadId) => threadId === conversationId,
      });
      return new Hono().route(
        '/api/orchestration',
        createOrchestrationRoutes(
          {} as Parameters<typeof createOrchestrationRoutes>[0],
          {
            eventBus: { subscribe: () => () => {} },
            logger: { debug() {} },
            resolvePrincipal: () => principal,
            reserveConversationContextBoundary: (input) =>
              lineage.reserveConversationContextBoundary(
                input.conversationId,
                sessionReadAuthorityFromRequest(
                  principal.id,
                  undefined,
                  undefined,
                ),
                { ...input, clientOrigin: JSON.stringify(input.clientOrigin) },
              ),
            readConversationContextBoundary: async (id, key, authority) => {
              reservationStatusReads.push(key);
              if (!statusAfterReload) return null;
              await statusAfterReload;
              return lineage.readConversationContextBoundaryStatus(
                id,
                key,
                authority,
              );
            },
            cancelConversationContextBoundary: (id, key, authority) =>
              lineage.cancelConversationContextBoundary(id, key, authority),
          },
        ),
      );
    };
    let app = mountRoutes(store);
    let reserveRequests = 0;
    let failure: unknown;
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const response = await app.request(request.clone());
        if (!response.ok) failure = await response.clone().text();
        if (request.method !== 'POST') return response;
        reserveRequests += 1;
        expect(response.status, await response.clone().text()).toBe(200);
        const { idempotencyKey } = await request.clone().json();
        committed = {
          key: idempotencyKey,
          result: (await response.json()).data,
        };
        if (competing === 'replay') {
          const replay = await app.request(request);
          expect(replay.status).toBe(409);
          return replay;
        }
        throw new TypeError('Reservation response was lost');
      },
    );
    stop.mockResolvedValue({
      receipt: { commandId: 'stop', status: 'accepted' },
    });
    const openDialog = () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const dialog = render(
        <QueryClientProvider client={client}>
          <ConversationContextResetDialog
            apiBase={apiBase}
            authority={authority}
            conversationId={conversationId}
            sessionId={conversationId}
            eligibility={eligibility}
            onStoppedSessionRefreshed={async () =>
              ({
                lifecycleState: 'canceled',
                hasActiveTurn: false,
              }) as Awaited<
                ReturnType<
                  React.ComponentProps<
                    typeof ConversationContextResetDialog
                  >['onStoppedSessionRefreshed']
                >
              >
            }
            onReserved={() => {}}
            onClose={() => dialog.unmount()}
          />
        </QueryClientProvider>,
      );
      return () => {
        dialog.unmount();
        client.clear();
      };
    };
    let close = openDialog();
    try {
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() =>
        expect(committed?.result.status, String(failure)).toBe('reserved'),
      );
      const key = committed!.key;
      const marker = store.conversationContextBoundaryByKey(
        conversationId,
        key,
      );
      expect(marker).toMatchObject({
        actorId: principal.id,
        status: 'reserved',
      });
      if (competing === true) {
        // The other tab captured its action before the first tab's storage
        // event. Its distinct write reaches the owner after the first commit.
        const scope = {
          ...authority,
          conversationId,
          sessionId: conversationId,
        };
        const secondKey = 'stale-tab-reset-request';
        expect(
          rememberContextBoundaryIntent(scope, {
            idempotencyKey: secondKey,
            policy: 'empty-next-cold-start',
          }),
        ).toBe(true);
        const second = await app.request(
          `/api/orchestration/conversations/${conversationId}/context-boundary`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              idempotencyKey: secondKey,
              policy: 'empty-next-cold-start',
              expectedCurrentSessionId: conversationId,
            }),
          },
        );
        expect(second.status).toBe(409);
        expect(
          store.conversationContextBoundaryByKey(conversationId, secondKey),
        ).toBeUndefined();
        forgetContextBoundaryIntent(scope, secondKey);
        expect(store.conversationSessions(conversationId)).toHaveLength(2);
      }

      await waitFor(() =>
        expect(
          (
            screen.getByRole('button', {
              name: 'Close context reset',
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      expect(screen.queryByRole('button', { name: 'Cancel reset' })).toBeNull();
      if (eligibility.kind === 'stop-session') {
        expect(screen.getByText('Agent stopped.')).toBeTruthy();
        expect(screen.queryByText(/Nothing was reset/)).toBeNull();
      }
      const closeButton = screen.getByRole('button', {
        name: 'Close context reset',
      });
      closeButton.focus();
      expect(document.activeElement).toBe(closeButton);
      fireEvent.click(closeButton);
      close();
      const legacyKey = `station.conversation-context-boundary.v1:${encodeURIComponent(conversationId)}`;
      if (legacy) {
        localStorage.clear();
        localStorage.setItem(
          legacyKey,
          JSON.stringify({
            conversationId,
            idempotencyKey: key,
            boundaryId: committed!.result.boundaryId,
            policy: committed!.result.policy,
            status: 'reserved',
            priorTranscriptInjected: false,
          }),
        );
      }
      const olderKey = 'older-unknown-key';
      if (competing === 'unknown') {
        expect(
          rememberContextBoundaryIntent(
            { ...authority, conversationId, sessionId: conversationId },
            {
              idempotencyKey: olderKey,
              policy: 'empty-next-cold-start',
              recordedAt: 0,
            },
          ),
        ).toBe(true);
      }
      store.close();
      store = new EventStore(file);
      app = mountRoutes(store);
      reservationStatusReads.length = 0;
      statusAfterReload = new Promise<void>((resolve) => {
        releaseStatus = resolve;
      });
      close = openDialog();
      await waitFor(() =>
        expect(reservationStatusReads).toContain(
          competing === 'unknown' ? olderKey : key,
        ),
      );
      expect(screen.queryByRole('button', { name: 'Cancel reset' })).toBeNull();
      releaseStatus?.();

      const cancel = await screen.findByRole('button', {
        name: 'Cancel reset',
      });
      expect(reservationStatusReads).toContain(key);
      expect(reserveRequests).toBe(1);
      if (legacy) expect(localStorage.getItem(legacyKey)).toBeNull();
      fireEvent.click(cancel);
      await waitFor(() =>
        expect(
          store.conversationContextBoundaryByKey(conversationId, key)?.status,
        ).toBe('cancelled'),
      );
      expect(store.conversationSessions(conversationId).at(-1)?.sessionId).toBe(
        conversationId,
      );
    } finally {
      releaseStatus?.();
      close();
      store.close();
    }
  },
);
