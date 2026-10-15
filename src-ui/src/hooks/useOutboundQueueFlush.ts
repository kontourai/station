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
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';
import type { ChatUIState } from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import { conversationCanMutate } from '../contexts/conversation-open-policy';
import type {
  HeldOutboundIntent,
  OutboundStationIdentity,
} from '../lib/outboundQueue';
import { checkServerHealth, probeServerConnection } from '../lib/serverHealth';
import { useSendMessage } from './useActiveChatSessions';

/**
 * The follow-ups each chat holds in its local queue behind a running turn,
 * as durable outbox intents keyed by their queue ids (the key the drain will
 * send them under). A steer already handed to the engine is not held.
 */
function heldOutboundIntents(
  chats: Readonly<Record<string, ChatUIState>>,
): HeldOutboundIntent[] {
  const intents: HeldOutboundIntent[] = [];
  for (const [chatKey, chat] of Object.entries(chats)) {
    if (!chat.agentSlug) continue;
    const base = {
      sessionId: chatKey,
      agentSlug: chat.agentSlug,
      conversationId: chat.conversationId ?? chatKey,
      ...(chat.projectSlug ? { projectSlug: chat.projectSlug } : {}),
      ...(chat.executionAgentId
        ? { executionAgentId: chat.executionAgentId }
        : {}),
      ...(chat.executionOnCurrentStation !== undefined
        ? { executionOnCurrentStation: chat.executionOnCurrentStation }
        : {}),
      ...(chat.expectedDefinitionFingerprint
        ? { expectedDefinitionFingerprint: chat.expectedDefinitionFingerprint }
        : {}),
    };
    const held: Array<
      readonly [string, { id: string; delivery?: string } | undefined]
    > = chat.queuedMessages.map(
      (content, index) =>
        [content, chat.queuedMessageMetadata?.[index]] as const,
    );
    if (chat.pendingQueueDispatch)
      held.push([
        chat.pendingQueueDispatch.content,
        chat.pendingQueueDispatch.metadata,
      ]);
    for (const [content, metadata] of held) {
      if (!metadata || metadata.delivery) continue;
      intents.push({ ...base, clientTurnId: metadata.id, content });
    }
  }
  return intents;
}

/**
 * A row this window would send now: pending, not held by any window, for
 * this Station, behind no unsent message, in a chat that may be written to.
 */
function hasSendableRow(): boolean {
  return Object.values(activeChatsStore.getSnapshot()).some(
    (chat) =>
      conversationCanMutate(chat) &&
      chat.outboundQueuedTurns?.some(
        (turn) =>
          turn.status === 'pending' &&
          !turn.heldElsewhere &&
          !turn.waitingForStation &&
          !turn.behindUnsent,
      ),
  );
}

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

/** How often a send under way in another window is looked at again. */
const OWNER_RECHECK_MS = 3_000;

export function useOutboundQueueFlush(apiBase: string): void {
  const sendMessage = useSendMessage(apiBase);
  const { observation } = useAuthorityPersistence();
  const environmentId = observation?.environmentId;
  const stationRef = useRef<OutboundStationIdentity>({ apiBase });
  stationRef.current = {
    apiBase,
    ...(environmentId ? { environmentId } : {}),
  };
  const { status } = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  const previousStatusRef = useRef(status);

  const triggerFlush = useCallback(
    (rerunIfBusy = false, syncHeldCopies = true) => {
      if (flushing) {
        // Only a request for a change the running pass cannot have seen (a
        // chat that just became writable). Queue notifications are not: the
        // pass makes them itself, and rerunning on them would never settle.
        if (rerunIfBusy) flushRequestedWhileFlushing = true;
        return;
      }
      flushing = true;
      void import('../lib/outboundQueue')
        .then(async ({ outboundDispatch }) => {
          const {
            lookupTurnDelivery,
            IN_FLIGHT_FIRST_CHECK_MS,
            DELIVERY_CHECK_MAX_INTERVAL_MS,
          } = await import('../lib/deliveryLookup');
          // Sends a closed or crashed app left `invoking`: ask Station what
          // became of each key before anything is sent. Not-received rows
          // become pending and go out below, with their original key.
          const { received } = await outboundDispatch.reconcile(
            lookupTurnDelivery(apiBase),
            { station: stationRef.current },
          );
          // Then this tab's held follow-ups: a reconcile can release a send
          // that was mid-drain at a reload to pending, and the restored queue
          // must take it back before the flush could send it too (one
          // message, one sender).
          // Not on a pass another window's change started: re-holding here
          // would take back a key a duplicated tab also holds, and its own
          // notice would come back and do the same.
          if (syncHeldCopies)
            await outboundDispatch
              .syncHeld(
                heldOutboundIntents(activeChatsStore.getSnapshot()).map(
                  (intent) => ({ ...intent, station: stationRef.current }),
                ),
              )
              .catch(() => undefined);
          if (reconcileRetryTimer) clearTimeout(reconcileRetryTimer);
          reconcileRetryTimer = undefined;
          if (received > 0) {
            reconcileRetryDelayMs = Math.min(
              Math.max(reconcileRetryDelayMs * 2, IN_FLIGHT_FIRST_CHECK_MS),
              DELIVERY_CHECK_MAX_INTERVAL_MS,
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
            { blockedSessionIds, station: stationRef.current },
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
    let ownerRecheck: ReturnType<typeof setTimeout> | undefined;
    void Promise.all([
      import('../lib/outboundQueue'),
      import('./outboundQueueProjection'),
      import('../lib/outboundQueueReporting'),
    ]).then(
      ([{ outboundDispatch }, { projectOutboundQueueEntries }, reporter]) => {
        if (!active) return;
        const refreshProjection = (afterProjection?: () => void) => {
          projection = projection.then(async () => {
            try {
              const entries = await outboundDispatch.open();
              // Keys finished with in any window: a discarded message's
              // bubble goes here too, a started one stops reading unanswered.
              const retired = await outboundDispatch
                .retiredKeys()
                .catch(() => undefined);
              if (!active) return;
              projectOutboundQueueEntries(entries, retired);
              // "Sending" holds only while the window sending it runs, and a
              // window that closes or crashes says nothing. While any row
              // reads so, look again now and then; nothing is scheduled
              // once none does.
              if (
                ownerRecheck === undefined &&
                entries.some((entry) => entry.sendUnderWay)
              )
                ownerRecheck = setTimeout(() => {
                  ownerRecheck = undefined;
                  if (active) refreshProjection();
                }, OWNER_RECHECK_MS);
              afterProjection?.();
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
        const stops = [
          outboundDispatch.subscribe(handleQueueChanged),
          // Another window's change (a Discard there, a send it settled)
          // reaches this one only through the queue's cross-window channel.
          // It refreshes what this window shows, and sends only when that
          // shows a message this window may send now (the send that held it
          // back settled there, and that window may have closed). That pass
          // never re-holds this tab's follow-ups (`syncHeld`): taking a
          // shared key back from a duplicated tab would bring its notice
          // back here, forever.
          outboundDispatch.subscribeRemoteChange(() =>
            refreshProjection(() => {
              if (status === 'connected' && hasSendableRow())
                triggerFlush(false, false);
            }),
          ),
        ];
        if (typeof document !== 'undefined') {
          // A hidden window can miss a message on that channel; coming back
          // into view is when its bubbles are about to be read again.
          const onVisibility = () => {
            if (document.visibilityState === 'visible') refreshProjection();
          };
          document.addEventListener('visibilitychange', onVisibility);
          stops.push(() =>
            document.removeEventListener('visibilitychange', onVisibility),
          );
        }
        unsubscribe = () => {
          for (const stop of stops) stop();
        };
      },
    );
    return () => {
      active = false;
      if (ownerRecheck) clearTimeout(ownerRecheck);
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
                // A copy another window holds is sent only on the user's
                // Send, never by a flush; it appearing here (that window just
                // held it) must not start a pass that takes it back.
                (turn) => turn.status === 'pending' && !turn.heldElsewhere,
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

  // Rows are written for, and only ever sent to, the Station this renderer
  // talks to now. Learning which Station that is can make rows sendable.
  useEffect(() => {
    void import('../lib/outboundQueue').then(({ noteCurrentStation }) => {
      noteCurrentStation({
        apiBase,
        ...(environmentId ? { environmentId } : {}),
      });
      if (environmentId && status === 'connected') triggerFlushRef.current();
    });
  }, [apiBase, environmentId, status]);

  // Held follow-ups live in the tab's session storage; their durable copy is
  // kept in the outbox, so closing the app does not lose them. One write at a
  // time, and only when the held set changed.
  useEffect(() => {
    let disposed = false;
    let written = '';
    let writing = false;
    let again = false;
    const sync = () => {
      if (disposed) return;
      const intents = heldOutboundIntents(activeChatsStore.getSnapshot());
      const signature = JSON.stringify(
        intents.map((intent) => [intent.clientTurnId, intent.content]),
      );
      if (signature === written) return;
      if (writing) {
        again = true;
        return;
      }
      writing = true;
      void import('../lib/outboundQueue')
        .then(({ outboundDispatch }) =>
          outboundDispatch.syncHeld(
            intents.map((intent) => ({
              ...intent,
              station: stationRef.current,
            })),
          ),
        )
        .then(() => {
          written = signature;
        })
        .catch(() => {
          // Storage unavailable: the follow-ups stay in session storage only,
          // as before this durability existed.
        })
        .finally(() => {
          writing = false;
          if (again) {
            again = false;
            sync();
          }
        });
    };
    sync();
    const unsubscribe = activeChatsStore.subscribe(sync);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

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
