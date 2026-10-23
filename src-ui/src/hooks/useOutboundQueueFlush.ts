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
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';
import {
  type ChatUIState,
  isTurnInFlight,
} from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import { conversationCanMutate } from '../contexts/conversation-open-policy';
import type {
  HeldOutboundIntent,
  OutboundDispatchTurn,
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
 * Pending rows a flush cannot claim yet because an earlier row of the same
 * chat goes first (the rule `claimNext` applies): a send under way, an
 * accepted one, a not-sent one, or an earlier pending row. Held copies and
 * unconfirmed rows hold nothing back.
 */
function keysBlockedByEarlierRows(
  entries: readonly OutboundDispatchTurn[],
): Set<string> {
  const blocked = new Set<string>();
  const sessionsWithBlocker = new Set<string>();
  for (const entry of entries) {
    if (entry.heldBy) continue;
    if (entry.status === 'pending' && sessionsWithBlocker.has(entry.sessionId))
      blocked.add(entry.clientTurnId);
    if (entry.status !== 'may-have-started')
      sessionsWithBlocker.add(entry.sessionId);
  }
  return blocked;
}

/**
 * A row this window would send now: pending, not held by any window, for
 * this Station, behind no unsent message, in a chat that may be written to.
 */
function sendableHere(clientTurnId: string): boolean {
  return Object.values(activeChatsStore.getSnapshot()).some(
    (chat) =>
      conversationCanMutate(chat) &&
      chat.outboundQueuedTurns?.some(
        (turn) =>
          turn.clientTurnId === clientTurnId &&
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
let flushRequestedWhileFlushing: (() => void) | undefined;
/** Failed lookups keep sends fenced; retry observation with capped backoff. */
const LOOKUP_RETRY_FIRST_MS = 2_000;
const LOOKUP_RETRY_MAX_MS = 60_000;

/** How often a send under way in another window is looked at again. */
const OWNER_RECHECK_MS = 3_000;

export function useOutboundQueueFlush(apiBase: string): void {
  const sendMessage = useSendMessage(apiBase);
  const {
    observation,
    namespace,
    status: authorityStatus,
  } = useAuthorityPersistence();
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
  const reconcileRetryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const reconcileRetryDelayMs = useRef(0);
  const reconciliationAllowed = useRef(false);
  const availabilityGeneration = useRef(0);
  const pageHidden = useRef(false);
  const reconcileScopeRef = useRef<object | undefined>(undefined);
  const reconcileScope = useMemo(
    () => ({
      apiBase,
      environmentId,
      namespace,
      authorityStatus,
      status,
    }),
    [apiBase, environmentId, namespace, authorityStatus, status],
  );
  useEffect(() => {
    reconcileScopeRef.current = reconcileScope;
    const resetRetry = () => {
      if (reconcileRetryTimer.current)
        clearTimeout(reconcileRetryTimer.current);
      reconcileRetryTimer.current = undefined;
      reconcileRetryDelayMs.current = 0;
    };
    const onAvailability = () => {
      const wasAllowed = reconciliationAllowed.current;
      reconciliationAllowed.current =
        reconcileScope.status === 'connected' &&
        !pageHidden.current &&
        document.visibilityState !== 'hidden' &&
        navigator.onLine !== false;
      if (wasAllowed !== reconciliationAllowed.current)
        availabilityGeneration.current += 1;
      if (!reconciliationAllowed.current) resetRetry();
      else if (!wasAllowed) {
        resetRetry();
        triggerFlushRef.current(true);
      }
    };
    const onPageHide = () => {
      pageHidden.current = true;
      onAvailability();
    };
    const onPageShow = () => {
      pageHidden.current = false;
      onAvailability();
    };
    document.addEventListener('visibilitychange', onAvailability);
    window.addEventListener('offline', onAvailability);
    window.addEventListener('online', onAvailability);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    onAvailability();
    return () => {
      availabilityGeneration.current += 1;
      reconcileScopeRef.current = undefined;
      reconciliationAllowed.current = false;
      resetRetry();
      document.removeEventListener('visibilitychange', onAvailability);
      window.removeEventListener('offline', onAvailability);
      window.removeEventListener('online', onAvailability);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [reconcileScope]);

  const triggerFlush = useCallback(
    /**
     * `send-only`: a pass started because a row became sendable after
     * another window's change. It neither asks Station about rows (that can
     * release a duplicate tab's held follow-up to pending) nor re-holds this
     * tab's follow-ups (that takes a shared key back from a duplicate tab,
     * whose notice would come back here): it only sends.
     */
    (rerunIfBusy = false, mode: 'full' | 'send-only' = 'full') => {
      const scope = reconcileScopeRef.current;
      const generation = availabilityGeneration.current;
      const current = () =>
        scope !== undefined &&
        scope === reconcileScopeRef.current &&
        generation === availabilityGeneration.current &&
        reconciliationAllowed.current &&
        document.visibilityState !== 'hidden' &&
        navigator.onLine !== false;
      if (!current()) return;
      const station = stationRef.current;
      if (flushing) {
        // Only a request for a change the running pass cannot have seen (a
        // chat that just became writable). Queue notifications are not: the
        // pass makes them itself, and rerunning on them would never settle.
        if (rerunIfBusy)
          flushRequestedWhileFlushing = () => triggerFlushRef.current(true);
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
          if (!current()) return;
          // Sends a closed or crashed app left `invoking`: ask Station what
          // became of each key before anything is sent. Not-received rows
          // become pending and go out below, with their original key.
          // A send-only pass asks Station nothing and leaves the retry
          // schedule as it was.
          const reconciled =
            mode === 'full'
              ? await outboundDispatch.reconcile(
                  (turn) => {
                    if (!current())
                      throw new Error('Automatic delivery observation paused');
                    return lookupTurnDelivery(apiBase)(turn);
                  },
                  { station },
                )
              : undefined;
          if (!current()) return;
          // Then this tab's held follow-ups: a reconcile can release a send
          // that was mid-drain at a reload to pending, and the restored queue
          // must take it back before the flush could send it too (one
          // message, one sender).
          if (mode === 'full')
            await outboundDispatch
              .syncHeld(
                heldOutboundIntents(activeChatsStore.getSnapshot()).map(
                  (intent) => ({ ...intent, station }),
                ),
              )
              .catch(() => undefined);
          if (!current()) return;
          if (reconciled) {
            if (reconcileRetryTimer.current)
              clearTimeout(reconcileRetryTimer.current);
            reconcileRetryTimer.current = undefined;
            const lookupFailed = reconciled.lookupFailed > 0;
            if (lookupFailed || reconciled.received > 0) {
              reconcileRetryDelayMs.current = Math.min(
                Math.max(
                  reconcileRetryDelayMs.current * 2,
                  lookupFailed
                    ? LOOKUP_RETRY_FIRST_MS
                    : IN_FLIGHT_FIRST_CHECK_MS,
                ),
                lookupFailed
                  ? LOOKUP_RETRY_MAX_MS
                  : DELIVERY_CHECK_MAX_INTERVAL_MS,
              );
              reconcileRetryTimer.current = setTimeout(() => {
                reconcileRetryTimer.current = undefined;
                if (current()) triggerFlushRef.current(true);
              }, reconcileRetryDelayMs.current);
            } else {
              reconcileRetryDelayMs.current = 0;
            }
          }
          // A chat with a turn running is not sent to: its send would only be
          // deferred (the end of the turn starts the next pass).
          const blockedSessionIds = new Set(
            Object.entries(activeChatsStore.getSnapshot())
              .filter(
                ([, chat]) =>
                  !conversationCanMutate(chat) || isTurnInFlight(chat),
              )
              .map(([sessionId]) => sessionId),
          );
          const outcome = await outboundDispatch.flush(
            async (turn, claim) => {
              if (!current()) return { kind: 'deferred' as const };
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
            { blockedSessionIds, station },
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
            const requested = flushRequestedWhileFlushing;
            flushRequestedWhileFlushing = undefined;
            requested();
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
    let deferredRetry:
      | { at: number; timer: ReturnType<typeof setTimeout> }
      | undefined;
    void Promise.all([
      import('../lib/outboundQueue'),
      import('./outboundQueueProjection'),
      import('../lib/outboundQueueReporting'),
    ]).then(
      ([
        { outboundDispatch, OUTBOUND_DEFER_RETRY_MS },
        { projectOutboundQueueEntries },
        reporter,
      ]) => {
        if (!active) return;
        // Keys the last projection showed held back by an earlier row.
        let lastBlocked = new Set<string>();
        const refreshProjection = () => {
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
              // Another window's change can free a row here: the send that
              // held it back settled there (that window may then close and
              // never send it). Only that transition starts a pass, so a
              // row this window cannot send yet (a turn still running) is
              // not retried on every notice from every window.
              const blocked = keysBlockedByEarlierRows(entries);
              const freed = [...lastBlocked].filter(
                (key) => !blocked.has(key) && sendableHere(key),
              );
              lastBlocked = blocked;
              // A row deferred moments ago is skipped by every pass until its
              // wait ends (OUTBOUND_DEFER_RETRY_MS); one retry then, so a
              // trigger that came too soon (a turn ending) never strands it.
              // One timer, for the earliest wait; when it fires it reads the
              // queue again, which arms it for the next row still waiting (a
              // pass that claims nothing announces no change to do that).
              const retryAt = Math.min(
                ...entries
                  .filter(
                    (entry) =>
                      entry.status === 'pending' &&
                      !entry.heldBy &&
                      entry.deferredAt !== undefined &&
                      entry.deferredAt + OUTBOUND_DEFER_RETRY_MS > Date.now(),
                  )
                  .map((entry) => entry.deferredAt! + OUTBOUND_DEFER_RETRY_MS),
              );
              if (
                Number.isFinite(retryAt) &&
                (!deferredRetry || retryAt < deferredRetry.at)
              ) {
                if (deferredRetry) clearTimeout(deferredRetry.timer);
                deferredRetry = {
                  at: retryAt,
                  timer: setTimeout(
                    () => {
                      deferredRetry = undefined;
                      if (!active) return;
                      refreshProjection();
                      if (status === 'connected') triggerFlush(true);
                    },
                    retryAt - Date.now() + 10,
                  ),
                };
              }
              if (freed.length > 0 && status === 'connected')
                triggerFlush(false, 'send-only');
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
          // It refreshes what this window shows; a row it frees is sent by a
          // send-only pass (see refreshProjection).
          outboundDispatch.subscribeRemoteChange(() => refreshProjection()),
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
      if (deferredRetry) clearTimeout(deferredRetry.timer);
      unsubscribe();
    };
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
              // Sendable now: open for writing and no turn running (the end
              // of a turn is what lets a message held back by it go).
              conversationCanMutate(chat) &&
              !isTurnInFlight(chat) &&
              chat.outboundQueuedTurns?.some(
                // A row on its way counts as waiting too: a claim and its
                // release (a send deferred because a turn is running, here
                // or in another window) must not read as the chat newly
                // gaining a waiting row, or each release starts the next
                // send. A copy another window holds is sent only on the
                // user's Send, never by a flush.
                (turn) =>
                  (turn.status === 'pending' || turn.status === 'invoking') &&
                  !turn.heldElsewhere,
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
    const scope = reconcileScope;
    void import('../lib/outboundQueue').then(({ noteCurrentStation }) => {
      if (scope !== reconcileScopeRef.current) return;
      noteCurrentStation({
        apiBase,
        ...(environmentId ? { environmentId } : {}),
      });
    });
  }, [apiBase, environmentId, reconcileScope]);

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
}
