import type { InterruptTurnResult } from '@kontourai/station-contracts/orchestration';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import {
  type ChatHttpError,
  conversationQueries,
  interruptOrchestrationTurn,
  isProvablyNotSent,
  useAgentConnectionsQuery,
  useInvalidateQuery,
} from '@kontourai/station-sdk';
import { useCallback } from 'react';
import { useActiveChatActions } from '../contexts/ActiveChatsContext';
import {
  type ChatMessage,
  isTurnInFlight,
} from '../contexts/active-chats-state';
import {
  activeChatsStore,
  type ChatUIState,
} from '../contexts/active-chats-store';
import type {
  OutboundDispatchClaim,
  OutboundDispatchTransportResult,
} from '../lib/outboundQueue';
import type { ComposerAttachmentStageSnapshot, FileAttachment } from '../types';
import {
  type ChatErrorTranslation,
  translateChatError,
} from '../utils/chatErrorTranslation';
import { sessionAdapterSupportsSteering } from '../utils/execution';
import { buildOutgoingUserMessage } from './useActiveChatSessions.helpers';
import { useStreamingMessage } from './useStreamingMessage';

interface SendTransaction {
  submittedDraft: string;
// archive#1311 merge: these hold the client's own `ChatUIState.messages`
// (from `options.state?.messages` and `buildOutgoingUserMessage(...).messages`
// respectively) — genuinely `ChatMessage[]`, not the backend-shaped
// `ActiveChatConversationMessage` (whose `timestamp` is `string | number`
 // since archive#1311, no longer structurally assignable to `ChatMessage`'s
// `number`).
  originalMessages: ChatMessage[];
  optimisticMessages: ChatMessage[];
/**
* archive#1293: the stable client id `buildOutgoingUserMessage` assigned
* to the optimistic user message this transaction appended — the rollback
* below removes exactly this entry by id rather than requiring
* `latestState.messages` to still be the exact array reference set at
* send time (which any intervening `updateChat` — turn finalize,
* rehydrate, openConversation — silently invalidates).
*/
  optimisticMessageClientId?: string;
  attachments?: FileAttachment[];
/** Byte-free selected-stage snapshot, restored only after a definitive rejection. */
  attachmentStages?: ComposerAttachmentStageSnapshot[];
}

function prepareSendTransaction(options: {
  state: ChatUIState | undefined;
  submittedDraft: string;
  modelInput: string;
  attachments?: FileAttachment[];
}): SendTransaction {
  const originalMessages = options.state?.messages ?? [];
  const outgoing = buildOutgoingUserMessage(
    originalMessages,
    options.modelInput,
    options.attachments,
  );
  return {
    submittedDraft: options.submittedDraft,
    originalMessages,
    optimisticMessages: outgoing.messages,
    optimisticMessageClientId: outgoing.clientId,
    attachments: options.attachments,
    attachmentStages: options.state?.attachmentStages,
  };
}

function rejectedSendRollback(
  transaction: SendTransaction,
  latestState: ChatUIState | undefined,
): Partial<ChatUIState> {
  const messages = latestState?.messages;
  const rollbackMessages = (() => {
    if (!messages || !transaction.optimisticMessageClientId) {
      return undefined;
    }
    const index = messages.findIndex(
      (message) => message.clientId === transaction.optimisticMessageClientId,
    );
// Not found: the optimistic entry was already replaced by a real backend
// transcript (or removed some other way) — nothing to roll back.
    if (index === -1) {
      return undefined;
    }
    const next = [...messages];
    next.splice(index, 1);
    return next;
  })();

  return {
    ...(latestState?.input === '' ? { input: transaction.submittedDraft } : {}),
    ...((latestState?.attachments?.length ?? 0) === 0 &&
    transaction.attachments?.length
      ? { attachments: transaction.attachments }
      : {}),
    ...((latestState?.attachmentStages?.length ?? 0) === 0 &&
    transaction.attachmentStages?.length
      ? { attachmentStages: transaction.attachmentStages }
      : {}),
    ...(rollbackMessages ? { messages: rollbackMessages } : {}),
  };
}

export function useSendMessage(
  apiBase: string,
  onActiveSessionChange?: (newSessionId: string) => void,
  onError?: (error: Error) => void,
  handleSlashCommand?: (
    sessionId: string,
    content: string,
  ) => Promise<boolean | string | 'CLEAR'>,
) {
  const {
    updateChat,
    clearInput,
    assignConversationId,
    addEphemeralMessage,
    clearEphemeralMessages,
  } = useActiveChatActions();
  const { clearStreamingMessage } = useStreamingMessage();
// Only consulted at the mid-turn send gate below to decide steering vs.
 // enqueue (archive#613). No built-in adapter declares 'steering' today, so this
// list never actually flips the branch in production.
  const { data: agentConnections = [] } = useAgentConnectionsQuery() as {
    data: ConnectionConfig[];
  };
  const invalidate = useInvalidateQuery();
  const sendMessage = useCallback(
    async (
      sessionId: string,
      agentSlug: string,
      conversationId: string | undefined,
      content: string,
      attachments?: FileAttachment[],
// Ambient, model-facing context (timezone, geolocation, …) delivered
 // out-of-band (archive#685): never part of `content`, so the rendered and
// persisted user turn stays exactly what the user typed.
      ambientContext?: string,
// archive#1207: a client-generated per-turn idempotency key. Omitted
// for every genuinely new turn (a fresh id is generated below) —
// passed explicitly ONLY by this turn's own Retry handler (see the
// catch block), so a retried turn reuses the SAME id rather than
// minting a new one. Lets a future outbound-queue/dedup consumer
 // recognize a turn that actually landed just
// before a disconnect instead of double-sending it.
      turnId?: string,
// The durable outbound queue owns deferred replay. A busy replay must
// stay durable, rather than also entering this legacy in-memory queue.
      options?: {
        skipInMemoryQueueOnBusy?: boolean;
/** State-bound capability supplied only by OutboundDispatchModule. */
        dispatch?: OutboundDispatchClaim;
        executionSnapshot?: {
          requestedModel?: string | null;
          requestedProviderOptions?: Record<string, unknown>;
          model?: string;
          providerOptions?: Record<string, unknown>;
        };
      },
    ) => {
      const allChats = activeChatsStore.getSnapshot();
      const currentState = allChats[sessionId];
      const submittedDraft = content;

      if (currentState?.status === 'sending') {
        const steeringCapable = sessionAdapterSupportsSteering(
          currentState.agentConnectionId,
          agentConnections,
        );
        if (!steeringCapable) {
          if (options?.skipInMemoryQueueOnBusy) {
            return options?.dispatch
              ? ({
                  kind: 'not-invoked',
                } satisfies OutboundDispatchTransportResult)
              : undefined;
          }
          clearInput(sessionId);
          updateChat(sessionId, {
            queuedMessages: [...(currentState.queuedMessages || []), content],
          });
          return;
        }
// Steering-capable adapter: skip the enqueue and fall through to
// dispatch immediately below — the same send path a drained queued
 // message takes (archive#613), rather than waiting for the turn boundary.
      }

      if (content.startsWith('/') && handleSlashCommand) {
        const result = await handleSlashCommand(sessionId, content);
        if (result === true || result === 'CLEAR') {
          return options?.dispatch
            ? ({
                kind: 'not-invoked',
              } satisfies OutboundDispatchTransportResult)
            : undefined;
        }
        if (typeof result === 'string' && result !== 'CLEAR') {
          addEphemeralMessage(sessionId, {
            role: 'system',
            content: `Slash command **${content}** was sent as user message`,
          });
          content = result;
        }
      }

      const transaction = prepareSendTransaction({
        state: currentState,
        submittedDraft,
        modelInput: content,
        attachments,
      });

// archive#1207: reuse the id passed in by a Retry handler; mint a
// fresh one for every other call (first send, queued-message drain,
// "Continue" after tool-calls/length) since those are genuinely new
// turns, not a resend of this one.
      const resolvedTurnId = turnId ?? crypto.randomUUID();

      const abortController = new AbortController();

      clearInput(sessionId);
      updateChat(sessionId, {
        status: 'sending',
        messages: transaction.optimisticMessages,
        abortController,
 // The window a Stop has to be held through, named ( 
// review): from here until this dispatch's own `turn.started`.
        pendingClientTurnId: resolvedTurnId,
        attachments: [],
        attachmentStages: [],
      });

      try {
        const { dispatchForeground } = await import(
          '../lib/foregroundMessageDispatch'
        );
        const receipt = await dispatchForeground({
          apiBase,
          sessionId,
          agentSlug,
          projectSlug: currentState?.projectSlug,
          requestedModel: options?.executionSnapshot
            ? options.executionSnapshot.requestedModel
            : currentState?.requestedModel,
          requestedProviderOptions: options?.executionSnapshot
            ? options.executionSnapshot.requestedProviderOptions
            : currentState?.requestedProviderOptions,
          model: options?.executionSnapshot
            ? options.executionSnapshot.model
            : currentState?.model,
          providerOptions: options?.executionSnapshot
            ? options.executionSnapshot.providerOptions
            : currentState?.providerOptions,
          message: content,
          conversationId:
            currentState?.conversationId ?? conversationId ?? sessionId,
          attachments,
          attachmentStages: currentState?.attachmentStages,
          ambientContext,
          clientTurnId: resolvedTurnId,
          signal: abortController.signal,
        });

        if (currentState?.conversationId !== receipt.conversationId) {
          assignConversationId(sessionId, receipt.conversationId);
        }
        updateChat(sessionId, {
          status: 'sending',
          abortController: undefined,
          orchestrationSessionStarted: true,
// A continuation can start a child execution session. Keep the
// durable tab keyed by its conversation while routing subsequent
// live controls/events to the server-receipted child identity.
          currentSessionId: receipt.sessionId,
        });
// archive#1146: the send above is what brings this chat's orchestration
// session into existence, and a session that has just come into
// existence is not in the cached list every reader of
// `useOrchestrationSessionsQuery` is holding. Nothing else invalidates
// that key on this path (`AttentionCard.tsx` is the only other writer,
// and it fires on a different surface), and `staleTime` alone never
// triggers a refetch — measured live, the chat dock's directory label
// stayed on its pre-session value indefinitely (120s of polling, no
// refetch). Guarded on the false→true transition read from the
// pre-send snapshot, so it fires once per chat rather than on every
// send.
        if (!currentState?.orchestrationSessionStarted) {
          invalidate(['orchestration-sessions']);
          invalidate(conversationQueries.inventory().queryKey);
        }
        onActiveSessionChange?.(sessionId);
        return options?.dispatch
          ? ({
              kind: 'accepted',
              providerTurnId: receipt.providerTurnId,
            } satisfies OutboundDispatchTransportResult)
          : true;
      } catch (error) {
        const err = error as Error & Partial<ChatHttpError>;
        const latestState = activeChatsStore.getSnapshot()[sessionId];

 // archive#1224 (offline): a genuinely offline send (the
// browser already knows it has no network) or a network-level fetch
// failure (the request never reached the server at all — a real
// HTTP error response, which DOES reach the server, is deliberately
// excluded; see `isNetworkLevelSendError`'s doc comment) is queued
// for automatic replay instead of surfacing as a dead-end error.
// The optimistic user message (already rendered above) is kept
// as-is — never rolled back — so it visibly sits in the
// conversation with a pending affordance until it sends for real.
// A queue chunk outage is itself an unavailable durable path. Keep
// the foreground error total rather than stranding the composer in
// `sending` because its error classifier could not load.
        const queueModule = await import('../lib/outboundQueue').catch(
          () => undefined,
        );
        const undeliverableCause =
          queueModule?.classifyUndeliverableSend(err) ?? null;
        if (undeliverableCause && !options?.dispatch) {
          try {
            const { outboundDispatch } = await import('../lib/outboundQueue');
            await outboundDispatch.enqueue(
              {
                clientTurnId: resolvedTurnId,
                sessionId,
                agentSlug,
                conversationId: latestState?.conversationId ?? conversationId,
                content,
                attachments,
                ambientContext,
                requestedModel: currentState?.requestedModel,
                requestedProviderOptions:
                  currentState?.requestedProviderOptions,
                model: currentState?.model,
                providerOptions: currentState?.providerOptions,
              },
              error,
            );
          } catch (queueError) {
            clearStreamingMessage(sessionId);
            updateChat(sessionId, {
              status: 'error',
              error:
                queueError instanceof Error
                  ? `Send unavailable: ${queueError.message}`
                  : 'Send unavailable',
              abortController: undefined,
            });
            return false;
          }
          clearStreamingMessage(sessionId);
          updateChat(sessionId, {
            status: 'queued',
            abortController: undefined,
          });
// archive#1292: appended via addEphemeralMessage (not spread onto
// `updates` above) so this notice gets a real id/timestamp — see
// the completion-notice comment above for why that matters.
          addEphemeralMessage(sessionId, {
            role: 'system',
// archive#3686. Neither line asserts a network condition or a
// moment of recovery, because this device observes neither.
//
// "Couldn't reach Station" was the first attempt and was still
// wrong: a bare TypeError is not proof the request never arrived
// (see the SDK's `isProvablyNotSent`, which exists for exactly
// that reason), and "sends when it's back" misdescribes the retry
// trigger too — the queue flushes as soon as health reports
// connected, which may be immediately.
            content:
              undeliverableCause === 'browser-reports-offline'
                ? 'Your browser reports no network — queued to retry automatically'
                : "Send wasn't confirmed — queued to retry automatically",
            action: {
              label: 'Discard',
              handler: async () => {
                try {
                  const { outboundDispatch } = await import(
                    '../lib/outboundQueue'
                  );
                  await outboundDispatch.discard(resolvedTurnId);
                  updateChat(sessionId, { status: 'idle' });
                } catch (discardError) {
                  updateChat(sessionId, {
                    status: 'error',
                    error: `Discard failed: ${discardError instanceof Error ? discardError.message : String(discardError)}`,
                  });
                }
              },
            },
          });
          return false;
        }

// This error-only loader keeps the foreground receipt classifier out
// of the initial chat shell. Classification still runs before any
// observer or retry affordance is exposed.
        const foreground = queueModule?.readForeground(err);
        const foregroundIndeterminate = !!foreground;
        const observedSessionId = foreground?.sessionId;
        const rollbackComposer = foregroundIndeterminate
          ? {}
          : rejectedSendRollback(transaction, latestState);
// Pre-stream fetch-level failure (agent-not-found, model-override
// validation, provider-resolution throws, or the SDK's
// `ChatHttpError` carrying the server's real HTTP-error body — see
// archive#191). Translated via the same shared table the mid-stream
// SSE path uses, so the copy is consistent regardless of which of
// the two raw-error surfaces produced it.
        const translated =
          foreground?.translation ??
          translateChatError({
            status: err.status,
            message: err.serverMessage || err.message,
            code: err.code,
          });
        const terminalSession = foregroundIndeterminate
          ? false
          : (translated as ChatErrorTranslation).terminalSession;
        const dispatchClaim = options?.dispatch;
        if (dispatchClaim) {
// Once the foreground call has begun, neither an abort, a network
// error, nor an HTTP/receipt error proves the provider did nothing.
// Latch durable evidence before any observer or return path can
// make this claim replayable.
          await dispatchClaim!.indeterminate(translated.title);
        }
        if (foregroundIndeterminate && observedSessionId) {
// Persist the observed session identity before surfacing the
// non-retryable notice, so reload/navigation keeps the evidence.
          assignConversationId(sessionId, observedSessionId);
        }
        updateChat(sessionId, {
// `terminalSession` is a Station-side refusal: the conversation has
// ended, so the send was declined before any engine saw it. Writing
// `'error'` here is what `chatLifecycleLabel` (home-view-model.ts)
// turns into the inbox's "Failed" — and `Failed` outranks the
// server's truthful `Completed` in LIFECYCLE_PRIORITY, so the
// misattribution wins the merge. Nothing failed; leave the chat
// non-error and let the persisted server lifecycle name it. The
// refusal itself is carried by the ephemeral notice below, which
// already suppresses Retry for exactly this case.
          status: foregroundIndeterminate || terminalSession ? 'idle' : 'error',
          error: err.message,
          abortController: undefined,
          ...(foregroundIndeterminate
            ? {
                orchestrationSessionStarted: true,
              }
            : {}),
          ...rollbackComposer,
        });
// Error observers are diagnostic. Classification and user-visible
// evidence above remain authoritative if one of them throws.
        try {
          onError?.(err);
        } catch {
// Intentional isolation: do not let an observer cause replay.
        }
// archive#1292: this error notice replaces whatever ephemeral
// notices preceded it (matching the previous behavior of assigning
// a brand-new `ephemeralMessages` array here) rather than
// accumulating — clear first, then add through addEphemeralMessage
// so id/timestamp are always assigned (never defaulting to
// timestamp 0, which used to sort this notice ahead of the whole
// transcript instead of next to the turn it belongs to).
        clearEphemeralMessages(sessionId);
        addEphemeralMessage(sessionId, {
          role: 'system',
          content: `${translated.title}: ${translated.body}${
            translated.hint ? `\n\n${translated.hint}` : ''
          }`,
          ...(terminalSession ? { terminalSession: true } : {}),
// A workspace refusal is permanent for this conversation. Other
// failures retry with the same id and latest conversation id.
          action:
            terminalSession || foregroundIndeterminate || dispatchClaim
              ? undefined
              : {
                  label: 'Retry',
                  handler: () =>
                    sendMessage(
                      sessionId,
                      agentSlug,
                      latestState?.conversationId ?? conversationId,
                      content,
                      attachments,
                      ambientContext,
                      resolvedTurnId,
                    ),
                },
        });
        if (foregroundIndeterminate) {
          invalidate(['orchestration-sessions']);
          invalidate(conversationQueries.inventory().queryKey);
          onActiveSessionChange?.(sessionId);
        }
        clearStreamingMessage(sessionId);
        if (foregroundIndeterminate || dispatchClaim) throw err;
        if (options?.dispatch) {
          return {
            kind: 'not-invoked',
            reason: translated.title,
          } satisfies OutboundDispatchTransportResult;
        }
        return false;
      }
    },
    [
      addEphemeralMessage,
      agentConnections,
      apiBase,
      assignConversationId,
      clearEphemeralMessages,
      clearInput,
      clearStreamingMessage,
      handleSlashCommand,
      invalidate,
      onActiveSessionChange,
      onError,
      updateChat,
    ],
  );

  return sendMessage;
}

/**
 * What a Stop press produced, for the composer to render. Every variant except
 * `not-running` names something the SERVER derived or something this client
 * can prove about its own request — none of them is the caller asserting an
* engine state.
 */
export type StopTurnOutcome =
/** The server reported what its cancel settled as. */
  | { kind: 'settled'; result: InterruptTurnResult }
/**
* The request never answered inside the client budget, or failed in a way
* that does not prove it never left this browser. The turn may well have
* stopped; nothing here knows.
*/
  | { kind: 'indeterminate'; reason: string }
/** The request provably never left this client, so nothing was interrupted. */
  | { kind: 'failed'; reason: string }
/** There was no local turn in flight to stop. */
  | { kind: 'not-running' };

/** The user-facing sentence for a settled/failed/indeterminate Stop. */
export function describeStopTurnOutcome(outcome: StopTurnOutcome): string {
  switch (outcome.kind) {
    case 'settled':
      switch (outcome.result.outcome) {
        case 'cooperative':
// Deliberately not "the engine was stopped": on this path Station
// keeps the session resumable and its engine process warm
// (`persistResumableStoppedSession`). Saying otherwise would be a
// label describing something the server did not do.
          return 'Stopped. The turn was interrupted and the engine is kept warm for this conversation.';
        case 'forced':
 // review : "ended its process" is not uniformly
// evidenced — `stopSession` closes the engine's handles and some
// adapters (Claude's SDK path among them) return without observing
// an OS process exit. What IS evidenced end to end is that the
// cancel went unacknowledged and Station tore the session down
// itself, so that is what this says.
          return 'Stopped. The engine did not acknowledge in time, so Station forced the turn to stop and tore the session down.';
        case 'turn-completed':
          return 'The turn finished before the stop took effect.';
        case 'pending-turn-start':
// Honest: the engine session did not exist yet. Station recorded
// the cancel and applies it to the turn the moment it starts.
          return 'Stop requested. The engine had not started this turn yet — it will be interrupted as soon as it does.';
        case 'no-active-turn':
          return 'There was no turn running to stop.';
      }
      break;
    case 'indeterminate':
      return `Stop requested — waiting for the engine. ${outcome.reason}`;
    case 'failed':
      return `Stop failed: ${outcome.reason}`;
    case 'not-running':
      return 'There was no turn running to stop.';
  }
  return 'There was no turn running to stop.';
}

export function useCancelMessage(apiBase?: string) {
  const { updateChat } = useActiveChatActions();

  return useCallback(
    async (sessionId: string): Promise<StopTurnOutcome> => {
      const state = activeChatsStore.getSnapshot()[sessionId];
// the old guard required a browser abort controller,
// which the send path clears the moment the orchestration POST returns —
// so for most of a turn's life Stop silently did nothing at all. The
// turn, not this client's stream handle, is what decides whether there
// is something to interrupt.
      if (!isTurnInFlight(state)) {
        return { kind: 'not-running' };
      }
 // a second press must not dispatch a second cancel or
// produce a second receipt. The server already coalesces concurrent
// stops onto one task, but the browser used to submit the duplicate
// anyway — and the button stayed live because nothing recorded that a
// stop was in flight. `stopPending` is that record, and the composer
// disables Stop while it is set.
      if (state.stopPending) return { kind: 'not-running' };
      const abortController = state.abortController;
      if (abortController) {
        (
          abortController as AbortController & {
            _userInitiated?: boolean;
          }
        )._userInitiated = true;
      }
      updateChat(sessionId, { stopPending: true });
      try {
// The browser stream is only an observer of the engine turn. Ask the
// orchestration owner to interrupt the exact server session before
// releasing this local observer; otherwise Stop merely hides a turn
// that continues spending tokens and can later be reported Done.
        const result = await interruptOrchestrationTurn({
          threadId: state.conversationId ?? sessionId,
// Only meaningful while the engine has not started this turn: it
 // binds a held cancel to THIS dispatch 
          ...(state.pendingClientTurnId
            ? { clientTurnId: state.pendingClientTurnId }
            : {}),
          apiBase,
        });
        return { kind: 'settled', result };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? '');
// The SAME derivation the continuation path uses to separate "this
// request provably never left the browser" from "no answer, and no
// way to know." A POST that timed out may already have interrupted
// the turn, so it is reported as indeterminate, never as a failure.
        return isProvablyNotSent(error)
          ? { kind: 'failed', reason: message }
          : {
              kind: 'indeterminate',
              reason:
                'Station did not answer before the request ended; the turn may still have been interrupted.',
            };
      } finally {
// Whatever the request did, this browser's observer is released and
// the composer leaves `sending` — a rejected or hung interrupt used
// to strand both, leaving a stream nobody was reading and a composer
// that could never be used again.
        abortController?.abort('User cancelled');
        updateChat(sessionId, {
          status: 'idle',
          abortController: undefined,
          stopPending: false,
        });
      }
    },
    [apiBase, updateChat],
  );
}
