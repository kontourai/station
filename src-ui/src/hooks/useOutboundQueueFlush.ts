/** One durable-delivery supervisor per owning connection, shared across remounts. */
import { useConnectionStatus } from '@kontourai/station-connect';
import { isSteerConflictCode } from '@kontourai/station-contracts/provider';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { StationConnection } from '../connections/station-connection';
import {
  chatBelongsToStation,
  outboundStationIdentity,
} from '../connections/station-state';
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';
import {
  type ChatUIState,
  isTurnInFlight,
} from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  conversationCanMutate,
  conversationOpenPhase,
} from '../contexts/conversation-open-policy';
import type {
  HeldOutboundIntent,
  OutboundDeliveryLookup,
  OutboundDispatchTurn,
  OutboundStationIdentity,
} from '../lib/outboundQueue';
import {
  outboundStationKey,
  outboundTurnKey,
  rowBelongsToStation,
} from '../lib/outboundQueue';
import { checkServerHealth, probeServerConnection } from '../lib/serverHealth';
import { describeStationFailure } from '../utils/stationFailure';
import {
  getStreamConnectionState,
  subscribeStreamConnectionState,
} from './orchestration/streamConnectionState';
import { useSendMessage } from './useActiveChatSessions';

/**
 * The follow-ups each chat holds in its local queue behind a running turn,
 * as durable outbox intents keyed by their queue ids (the key the drain will
 * send them under). A steer already handed to the engine is not held.
 */
function heldOutboundIntents(
  chats: Readonly<Record<string, ChatUIState>>,
  connection?: StationConnection,
): HeldOutboundIntent[] {
  const intents: HeldOutboundIntent[] = [];
  for (const [chatKey, chat] of Object.entries(chats)) {
    if (!chat.agentSlug || !chatBelongsToStation(chat, connection)) continue;
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
      readonly [
        string,
        { id: string; delivery?: string; originUnverified?: true } | undefined,
      ]
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
      if (!metadata || metadata.delivery || metadata.originUnverified) continue;
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
const supervisors = new Map<
  string,
  {
    flushing: boolean;
    requested?: () => void;
    /**
     * The queue changed while a pass was running. Such a change starts no
     * pass (most are the pass's own), but a pass asks Station about released
     * sends only once, as it begins, so one released after that is looked
     * for when the pass ends.
     */
    changedWhileFlushing?: boolean;
    /**
     * Released sends this supervisor has asked Station about, sent, or
     * already started a pass for: each prompts at most one extra pass.
     */
    handled: Set<string>;
  }
>();
/**
 * A flush asked for while one is running. The running pass may already have
 * passed the row or chat that changed, so it runs once more when it ends
 * instead of the request being dropped.
 */
function supervisorFor(station: OutboundStationIdentity) {
  const key = outboundStationKey(station);
  let state = supervisors.get(key);
  if (!state) {
    state = { flushing: false, handled: new Set() };
    supervisors.set(key, state);
  }
  return state;
}
/** Failed lookups keep sends fenced; retry observation with capped backoff. */
const LOOKUP_RETRY_FIRST_MS = 2_000;
const LOOKUP_RETRY_MAX_MS = 60_000;

/** How often a send under way in another window is looked at again. */
const OWNER_RECHECK_MS = 3_000;

export function useOutboundQueueFlush(
  apiBase: string,
  connection?: StationConnection,
): void {
  const sendMessage = useSendMessage(apiBase);
  const {
    observation,
    namespace,
    status: authorityStatus,
  } = useAuthorityPersistence();
  const environmentId = observation?.environmentId;
  const stationRef = useRef<OutboundStationIdentity>({ apiBase });
  stationRef.current = connection
    ? outboundStationIdentity(connection)
    : {
        host: true,
        apiBase,
        ...(environmentId ? { environmentId } : {}),
        ...(namespace && authorityStatus === 'verified'
          ? { authorityNamespace: namespace }
          : {}),
      };
  const { status: hostStatus } = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  const stream = useSyncExternalStore(subscribeStreamConnectionState, () =>
    getStreamConnectionState(apiBase),
  );
  const status =
    connection && connection.routeKind !== 'host'
      ? stream.phase === 'caught-up'
        ? 'connected'
        : 'disconnected'
      : hostStatus;
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
      connection,
    }),
    [apiBase, environmentId, namespace, authorityStatus, status, connection],
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
        (!reconcileScope.connection ||
          (reconcileScope.connection.isCurrent() &&
            reconcileScope.connection.capabilities.send.state === 'allowed')) &&
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
        (!connection || connection.isCurrent()) &&
        document.visibilityState !== 'hidden' &&
        navigator.onLine !== false;
      if (!current()) return;
      const station = stationRef.current;
      const supervisor = supervisorFor(station);
      if (supervisor.flushing) {
        // Only a request for a change the running pass cannot have seen (a
        // chat that just became writable). Queue notifications are not: the
        // pass makes them itself, and rerunning on them would never settle.
        if (rerunIfBusy)
          supervisor.requested = () => triggerFlushRef.current(true);
        else supervisor.changedWhileFlushing = true;
        return;
      }
      supervisor.flushing = true;
      supervisor.changedWhileFlushing = false;
      void import('../lib/outboundQueue')
        .then(async ({ outboundDispatch, OutboundLookupPausedError }) => {
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
                  async (turn) => {
                    // Hidden, offline or disconnected since the pass began:
                    // whatever the request did then says nothing about
                    // Station, so it is not one of the row's failed lookups.
                    if (!current()) throw new OutboundLookupPausedError();
                    supervisor.handled.add(outboundTurnKey(turn));
                    let answer: Awaited<ReturnType<OutboundDeliveryLookup>>;
                    try {
                      answer = await lookupTurnDelivery(
                        apiBase,
                        connection?.requestScope,
                      )(turn);
                    } catch (error) {
                      if (!current()) throw new OutboundLookupPausedError();
                      throw error;
                    }
                    if (!current()) throw new OutboundLookupPausedError();
                    return answer;
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
                heldOutboundIntents(
                  activeChatsStore.getSnapshot(),
                  connection,
                ).map((intent) => ({ ...intent, station })),
                { station },
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
          // A known busy conversation can accept a durable inbox handoff.
          // A busy chat without a conversation still waits for its first turn.
          const blockedSessionIds = new Set(
            Object.entries(activeChatsStore.getSnapshot())
              .filter(
                ([, chat]) =>
                  chatBelongsToStation(chat, connection) &&
                  ((!conversationCanMutate(chat) &&
                    conversationOpenPhase(chat) !== 'busy') ||
                    (isTurnInFlight(chat) && !chat.conversationId)),
              )
              .map(([sessionId]) => sessionId),
          );
          const outcome = await outboundDispatch.flush(
            async (turn, claim) => {
              if (!current()) return { kind: 'deferred' as const };
              supervisor.handled.add(outboundTurnKey(turn));
              const chat = activeChatsStore.getSnapshot()[turn.sessionId];
              if (
                chat &&
                !conversationCanMutate(chat) &&
                conversationOpenPhase(chat) !== 'busy'
              ) {
                return {
                  kind: 'deferred' as const,
                  reason: 'Conversation open state is not currently mutable.',
                };
              }
              if (chat && isTurnInFlight(chat) && !chat.conversationId) {
                return {
                  kind: 'deferred' as const,
                  reason: 'Waiting for the conversation identity.',
                };
              }
              if (turn.inboxSteerHead) {
                if (!turn.conversationId)
                  return {
                    kind: 'refused' as const,
                    reason: 'The steer has no conversation identity.',
                  };
                const { submitConversationSteer } = await import(
                  '@kontourai/station-sdk/client'
                );
                try {
                  await submitConversationSteer(
                    apiBase,
                    turn.conversationId,
                    {
                      key: turn.clientTurnId,
                      message: turn.content,
                      expectedHead: turn.inboxSteerHead,
                    },
                    { requestScope: connection?.requestScope },
                  );
                  if (!current()) return { kind: 'unanswered' as const };
                  return { kind: 'queued' as const };
                } catch (error) {
                  const refusal = error as {
                    code?: unknown;
                    stationEnvelope?: unknown;
                  };
                  if (
                    refusal?.stationEnvelope === true &&
                    (refusal.code === 'inbox_stale_head' ||
                      refusal.code === 'conversation_inbox_full' ||
                      isSteerConflictCode(refusal.code))
                  )
                    return {
                      kind: 'refused' as const,
                      reason: describeStationFailure(error).body,
                    };
                  return { kind: 'unanswered' as const };
                }
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
                  connection,
                  skipInMemoryQueueOnBusy: true,
                  dispatch: claim,
                  executionSnapshot: {
                    projectSlug: turn.projectSlug,
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
              connection,
            );
          }
        })
        .catch(async (error) => {
          const { reportOutboundQueueUnavailable } = await import(
            '../lib/outboundQueueReporting'
          );
          reportOutboundQueueUnavailable(
            describeStationFailure(error).body,
            connection,
          );
        })
        .finally(() => {
          supervisor.flushing = false;
          if (supervisor.requested) {
            const requested = supervisor.requested;
            supervisor.requested = undefined;
            requested();
            return;
          }
          // A send-only pass asks Station nothing, and starts no pass that
          // would.
          if (mode !== 'full' || !supervisor.changedWhileFlushing) return;
          supervisor.changedWhileFlushing = false;
          // A send released while this pass ran (its request got no answer)
          // was not there when the pass asked Station about released sends,
          // and its own notice started no pass. Ask about it now rather than
          // at the next unrelated trigger.
          void import('../lib/outboundQueue')
            .then(({ outboundDispatch }) => outboundDispatch.snapshot())
            .then((rows) => {
              const released = rows.filter(
                (row) =>
                  row.status === 'invoking' &&
                  row.awaitingLookup &&
                  !row.heldBy &&
                  !row.legacyImport &&
                  rowBelongsToStation(row, station),
              );
              const keys = new Set(released.map(outboundTurnKey));
              for (const key of supervisor.handled)
                if (!keys.has(key)) supervisor.handled.delete(key);
              const unseen = [...keys].filter(
                (key) => !supervisor.handled.has(key),
              );
              if (unseen.length === 0) return;
              for (const key of unseen) supervisor.handled.add(key);
              triggerFlushRef.current(true);
            })
            .catch(() => {
              // The queue could not be read: the next pass reports that.
            });
        });
    },
    [sendMessage, apiBase, connection],
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
              const entries = (await outboundDispatch.open()).filter((entry) =>
                rowBelongsToStation(entry, stationRef.current),
              );
              // Keys finished with in any window: a discarded message's
              // bubble goes here too, a started one stops reading unanswered.
              const retired = await outboundDispatch
                .retiredKeys(stationRef.current, { partitioned: true })
                .catch(() => undefined);
              if (!active) return;
              projectOutboundQueueEntries(
                entries.filter(
                  (entry) =>
                    !entry.inboxSteerHead ||
                    (!!namespace &&
                      entry.station?.authorityNamespace ===
                        stationRef.current.authorityNamespace),
                ),
                retired,
                connection,
              );
              if (connection)
                await activeChatsStore.recoverLegacyImports(connection);
              // "Sending" holds only while the window sending it runs, and a
              // window that closes or crashes says nothing; the same goes for
              // a copy another window holds. While any row depends on a
              // window still running, look again now and then; nothing is
              // scheduled once none does.
              if (
                ownerRecheck === undefined &&
                entries.some(
                  (entry) =>
                    entry.sendUnderWay ||
                    (entry.heldBy && !entry.heldHere && !entry.holderGone),
                )
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
                describeStationFailure(error).body,
                connection,
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
  }, [status, triggerFlush, namespace, connection]);

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
              chatBelongsToStation(chat, connection) &&
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
  }, [status, triggerFlush, connection]);

  // Rows are written for, and only ever sent to, the Station this renderer
  // talks to now. Learning which Station that is can make rows sendable.
  useEffect(() => {
    if (connection && connection.routeKind !== 'host') return;
    const scope = reconcileScope;
    void import('../lib/outboundQueue').then(({ noteCurrentStation }) => {
      if (scope !== reconcileScopeRef.current) return;
      noteCurrentStation(
        connection
          ? outboundStationIdentity(connection)
          : {
              host: true,
              apiBase,
              ...(environmentId ? { environmentId } : {}),
              ...(namespace && authorityStatus === 'verified'
                ? { authorityNamespace: namespace }
                : {}),
            },
      );
    });
  }, [
    apiBase,
    environmentId,
    namespace,
    authorityStatus,
    reconcileScope,
    connection,
  ]);

  // Held follow-ups live in the tab's session storage; their durable copy is
  // kept in the outbox, so closing the app does not lose them. One write at a
  // time, and only when the held set changed.
  useEffect(() => {
    let disposed = false;
    let written = '';
    let writing = false;
    let again = false;
    const sync = () => {
      if (disposed || (connection && !connection.isCurrent())) return;
      const intents = heldOutboundIntents(
        activeChatsStore.getSnapshot(),
        connection,
      );
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
            { station: stationRef.current },
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
  }, [connection]);
}
