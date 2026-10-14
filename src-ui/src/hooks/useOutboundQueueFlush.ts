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
import { activeChatsStore } from '../contexts/active-chats-store';
import { conversationCanMutate } from '../contexts/conversation-open-policy';
import { checkServerHealth, probeServerConnection } from '../lib/serverHealth';
import { useSendMessage } from './useActiveChatSessions';

// Module-level (not a `useRef`) so mounting this hook twice — StrictMode's
// double-invoked effects, or a fast remount — can never run two overlapping
// drain passes; a `useRef` would only guard a SINGLE instance's re-renders,
// not a second mounted instance.
let flushing = false;
/**
 * A flush asked for while one is running. The running pass may already have
 * passed the row or chat that changed, so it runs once more when it ends
 * instead of the request being dropped.
 */
let flushRequestedWhileFlushing = false;
/**
 * Asking Station again about sends it reported `received` (an app closed
 * while its session was starting). Doubles up to the lookup's ceiling; reset
 * once nothing is waiting. Module-level for the same reason as `flushing`.
 */
let reconcileRetryTimer: ReturnType<typeof setTimeout> | undefined;
let reconcileRetryDelayMs = 0;

export function useOutboundQueueFlush(apiBase: string): void {
  const sendMessage = useSendMessage(apiBase);
  const { status } = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  const previousStatusRef = useRef(status);

  const triggerFlush = useCallback(
    (rerunIfBusy = false) => {
      if (flushing) {
        // Only a request for a change the running pass cannot have seen (a
        // chat that just became writable). Queue notifications are not: the
        // pass makes them itself, and rerunning on them would never settle.
        if (rerunIfBusy) flushRequestedWhileFlushing = true;
        return;
      }
      flushing = true;
      void Promise.all([
        import('../lib/outboundQueue'),
        import('../lib/deliveryLookup'),
      ])
        .then(async ([{ outboundDispatch }, delivery]) => {
          // Sends a closed or crashed app left `invoking`: ask Station what
          // became of each key before anything is sent. Not-received rows
          // become pending and go out below, with their original key.
          const { received } = await outboundDispatch.reconcile(
            delivery.lookupTurnDelivery(apiBase),
          );
          if (reconcileRetryTimer) clearTimeout(reconcileRetryTimer);
          reconcileRetryTimer = undefined;
          if (received > 0) {
            reconcileRetryDelayMs = Math.min(
              Math.max(
                reconcileRetryDelayMs * 2,
                delivery.IN_FLIGHT_FIRST_CHECK_MS,
              ),
              delivery.DELIVERY_CHECK_MAX_INTERVAL_MS,
            );
            reconcileRetryTimer = setTimeout(() => {
              reconcileRetryTimer = undefined;
              triggerFlushRef.current();
            }, reconcileRetryDelayMs);
          } else {
            reconcileRetryDelayMs = 0;
          }
          const blockedSessionIds = new Set(
            Object.entries(activeChatsStore.getSnapshot())
              .filter(([, chat]) => !conversationCanMutate(chat))
              .map(([sessionId]) => sessionId),
          );
          const outcome = await outboundDispatch.flush(
            async (turn, claim) => {
              const chat = activeChatsStore.getSnapshot()[turn.sessionId];
              if (chat && !conversationCanMutate(chat)) {
                return {
                  kind: 'deferred' as const,
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
                    executionAgentId: turn.executionAgentId,
                    executionOnCurrentStation: turn.executionOnCurrentStation,
                    expectedDefinitionFingerprint:
                      turn.expectedDefinitionFingerprint,
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
            },
            { blockedSessionIds },
          );
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
          if (flushRequestedWhileFlushing) {
            flushRequestedWhileFlushing = false;
            triggerFlushRef.current(true);
          }
        });
    },
    [sendMessage, apiBase],
  );
  const triggerFlushRef = useRef(triggerFlush);
  triggerFlushRef.current = triggerFlush;

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

  // A pass defers a chat whose conversation is not writable yet (a reload
  // re-proves the open conversation before it may send), and nothing else
  // would send its rows once it is. Flush again when a chat holding a
  // waiting row becomes writable.
  useEffect(() => {
    if (status !== 'connected') return;
    const writableWithWaiting = () =>
      new Set(
        Object.entries(activeChatsStore.getSnapshot())
          .filter(
            ([, chat]) =>
              conversationCanMutate(chat) &&
              chat.outboundQueuedTurns?.some(
                (turn) => turn.status === 'pending',
              ),
          )
          .map(([sessionId]) => sessionId),
      );
    let previous = writableWithWaiting();
    const unsubscribe = activeChatsStore.subscribe(() => {
      const next = writableWithWaiting();
      const gained = [...next].some((sessionId) => !previous.has(sessionId));
      previous = next;
      if (gained) triggerFlush(true);
    });
    return () => {
      unsubscribe();
    };
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
