/**
 * archive#1224 (offline) — flush trigger.
 *
 * Mounted exactly once (in `App.tsx`, alongside the sibling
 * `useQueryCacheReconnectSync` this mirrors) so only one drain pass ever
 * runs at a time app-wide. Reuses the existing connection-health signal
 * (`useConnectionStatus`, already globally polled via `ConnectionBannerSource`)
 * rather than building a second offline detector, and replays through the
 * SAME `useSendMessage` every live send uses — the shared
 * `flushOutboundQueue` algorithm (`lib/outboundQueue.ts`) never
 * re-implements the direct-vs-orchestration branch `sendMessage` already
 * owns.
 */
import { useConnectionStatus } from '@kontourai/station-connect';
import { useCallback, useEffect, useRef } from 'react';
import { conversationCanMutate } from '../components/chat-dock/conversationOpenPolicy';
import { activeChatsStore } from '../contexts/active-chats-store';
import { checkServerHealth, probeServerConnection } from '../lib/serverHealth';
import { useSendMessage } from './useActiveChatSessions';

// Module-level (not a `useRef`) so mounting this hook twice — StrictMode's
// double-invoked effects, or a fast remount — can never run two overlapping
// drain passes; a `useRef` would only guard a SINGLE instance's re-renders,
// not a second mounted instance.
let flushing = false;

export function useOutboundQueueFlush(apiBase: string): void {
  const sendMessage = useSendMessage(apiBase);
  const { status } = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  const previousStatusRef = useRef(status);

  const triggerFlush = useCallback(() => {
    if (flushing) return;
    flushing = true;
    void import('../lib/outboundQueue')
      .then(async ({ outboundDispatch }) => {
        const outcome = await outboundDispatch.flush(async (turn, claim) => {
          const chat = activeChatsStore.getSnapshot()[turn.sessionId];
          if (chat && !conversationCanMutate(chat)) {
            return {
              kind: 'not-invoked' as const,
              reason: 'Conversation open state is not currently mutable.',
            };
          }
          const result = await sendMessage(
            turn.sessionId,
            turn.agentSlug,
            turn.conversationId,
            turn.content,
            turn.attachments,
            turn.ambientContext,
            turn.clientTurnId,
            {
              skipInMemoryQueueOnBusy: true,
              dispatch: claim,
              executionSnapshot: {
                requestedModel: turn.requestedModel,
                requestedProviderOptions: turn.requestedProviderOptions,
                model: turn.model,
                providerOptions: turn.providerOptions,
              },
            },
          );
          // The replay call is given an outbound capability, so its Interface
          // returns an explicit transport fact. Keep this narrow conversion at
          // the composition Seam; the Module never infers invocation from a
          // boolean.
          if (result && typeof result === 'object' && 'kind' in result) {
            return result;
          }
          // A boolean success is only available to direct callers. A replay
          // lacking the typed provider receipt cannot be accepted because a
          // later terminal event would have no exact correlation.
          return {
            kind: 'not-invoked' as const,
            reason: 'The send gate did not invoke the provider.',
          };
        });
        if (outcome === 'unavailable') {
          const { reportOutboundQueueUnavailable } = await import(
            '../lib/outboundQueueReporting'
          );
          reportOutboundQueueUnavailable(
            'persistent queue settlement could not be confirmed.',
          );
        }
      })
      .catch(async (error) => {
        const { reportOutboundQueueUnavailable } = await import(
          '../lib/outboundQueueReporting'
        );
        reportOutboundQueueUnavailable(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        flushing = false;
      });
  }, [sendMessage]);

  useEffect(() => {
    let active = true;
    let projection = Promise.resolve();
    let unsubscribe: () => void = () => {};
    void Promise.all([
      import('../lib/outboundQueue'),
      import('./outboundQueueProjection'),
      import('../lib/outboundQueueReporting'),
    ]).then(
      ([{ outboundDispatch }, { projectOutboundQueueEntries }, reporter]) => {
        if (!active) return;
        const refreshProjection = () => {
          projection = projection.then(async () => {
            try {
              const entries = await outboundDispatch.open();
              if (active) projectOutboundQueueEntries(entries);
            } catch (error) {
              if (!active) return;
              reporter.reportOutboundQueueUnavailable(
                error instanceof Error ? error.message : String(error),
              );
            }
          });
        };
        const handleQueueChanged = () => {
          refreshProjection();
          if (status === 'connected') queueMicrotask(triggerFlush);
        };
        refreshProjection();
        unsubscribe = outboundDispatch.subscribe(handleQueueChanged);
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [status, triggerFlush]);

  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (previous !== 'connected' && status === 'connected') {
      triggerFlush();
    }
  }, [status, triggerFlush]);

  const hasFlushedOnMountRef = useRef(false);
  useEffect(() => {
    // A queue populated by a prior session (survived a restart) with the
    // connection already confirmed reachable by the time this mounts has no
    // offline→online transition to catch above — try once on mount too.
    if (!hasFlushedOnMountRef.current && status === 'connected') {
      hasFlushedOnMountRef.current = true;
      triggerFlush();
    }
  }, [status, triggerFlush]);
}
