import {
  APPROVAL_ESCALATION_REQUIRES_RESTART_CODE,
  ENGINE_SESSION_BINDING_DEAD_CODE,
  isApprovalMode,
} from '@kontourai/station-contracts/provider';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { toastStore } from '../../contexts/ToastContext';
import {
  formatChatErrorDisplay,
  translateChatError,
} from '../../utils/chatErrorTranslation';
import {
  acknowledgesModelRequest,
  modelControlOptionsMatch,
  replaceModelControlOptions,
} from '../../utils/modelCapabilities';
import {
  isChatErrorMarker,
  pruneStaleFailureMarkers,
} from '../../utils/sessionFailure';
import { finalizeAssistantTurn } from './assistantTurn';
import { createAssistantStreamingMessage } from './messageParts';
import { drainQueuedMessageOnTurnCompleted } from './queueDrain';
import type { OrchestrationEvent } from './types';

function repeatedErrorText(message: string, count: number) {
  return count > 1 ? `${message} (repeated ${count}×)` : message;
}

function repeatCount(content: string, prefix: string) {
  if (!content.startsWith(prefix)) return null;
  const suffix = content.slice(prefix.length);
  if (!suffix) return 1;
  const match = /^ \(repeated (\d+)×\)$/.exec(suffix);
  return match ? Number(match[1]) : null;
}

function reconcileDurableTurn(sessionId: string, providerTurnId: string): void {
  void import('../../lib/outboundQueue')
    .then(({ outboundDispatch }) =>
      outboundDispatch.completeAcceptedTurn(sessionId, providerTurnId),
    )
    .catch((error) => {
      activeChatsStore.updateChat(sessionId, {
        status: 'error',
        error: `Could not reconcile the durable offline turn: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
}

export function handleTurnStartedEvent(
  event: Extract<OrchestrationEvent, { method: 'turn.started' }>,
) {
  // Durable per-turn confirmation of the actually-applied approval mode
  // (#727 review round 3, item 1) — clears/updates the pending-apply chip
  // state once the adapter has genuinely resolved this turn's posture.
  const approvalMode = isApprovalMode(event.metadata?.approvalMode)
    ? event.metadata.approvalMode
    : undefined;
  const effectiveModel =
    typeof event.metadata?.effectiveModel === 'string'
      ? event.metadata.effectiveModel
      : undefined;
  const effectiveModelOptions =
    event.metadata?.effectiveModelOptions &&
    typeof event.metadata.effectiveModelOptions === 'object' &&
    !Array.isArray(event.metadata.effectiveModelOptions)
      ? (event.metadata.effectiveModelOptions as Record<string, unknown>)
      : undefined;
  const currentChat = activeChatsStore.getChatForExecutionSession(
    event.threadId,
  );
  const acceptedExplicitChoice = acknowledgesModelRequest(
    currentChat?.requestedModel,
    currentChat?.defaultModel,
    effectiveModel,
  );
  const acceptedNewChatChoice =
    currentChat?.modelSource === 'session override' &&
    currentChat.model === effectiveModel;
  if (
    effectiveModel &&
    (acceptedExplicitChoice || acceptedNewChatChoice) &&
    currentChat?.agentSlug &&
    currentChat.executionMode !== 'station'
  ) {
    void import('../lastChosenModel')
      .then(
        ({
          buildLastChosenModelBindingKeyFromIdentity,
          trackLastChosenModel,
        }) =>
          trackLastChosenModel(
            buildLastChosenModelBindingKeyFromIdentity(
              currentChat.agentSlug as string,
              currentChat.providerId ?? currentChat.agentConnectionId,
            ),
            effectiveModel,
          ),
      )
      .catch(() => undefined);
  }
  activeChatsStore.updateChat(event.threadId, {
    // The dispatch this turn came from has started; the pre-start cancel
    // window it named is over (UX audit T1 review).
    pendingClientTurnId: undefined,
    status: 'sending',
    orchestrationTurnOpen: true,
    // station#1410: the identity of the turn whose text is about to be
    // buffered, so a terminal event for a DIFFERENT turn cannot attach its
    // provenance to this one.
    openTurnId: event.turnId,
    // station#3352: the shell below is this turn's first and only copy, so it
    // is authoritative again — a reconnect catch-up for the PREVIOUS turn must
    // not leave the projection rendering this one alongside it.
    openTurnShellSuperseded: false,
    isProcessingStep: false,
    // Optimistic: the turn has started, so the session is running. Without
    // this, a stale `orchestrationStatus: 'idle'` from the previous turn
    // suppresses the streaming indicator until the provider's
    // session.state-changed round-trips (the "chat looks idle while the
    // agent thinks" bug). The server event remains authoritative and will
    // confirm or correct this value.
    orchestrationStatus: 'running',
    // A fresh turn must not inherit the previous turn's activity hint.
    activityHint: undefined,
    streamingMessage: {
      role: 'assistant',
      content: '',
      contentParts: [],
    },
    ...(approvalMode ? { lastAppliedApprovalMode: approvalMode } : {}),
    ...(effectiveModel
      ? { model: effectiveModel, orchestrationModel: effectiveModel }
      : {}),
    ...(acceptedExplicitChoice
      ? {
          requestedModel: undefined,
          requestedModelSource: undefined,
          ...(modelControlOptionsMatch(
            currentChat?.requestedProviderOptions,
            effectiveModelOptions,
          )
            ? { requestedProviderOptions: undefined }
            : {}),
          ...(currentChat?.requestedModel !== null
            ? { modelSource: currentChat?.requestedModelSource }
            : {}),
        }
      : {}),
    ...(effectiveModel
      ? {
          providerOptions: replaceModelControlOptions(
            currentChat?.providerOptions ?? {},
            effectiveModelOptions,
          ),
        }
      : {}),
  });
}

export function handleTurnCompletedEvent(
  apiBase: string,
  event: Extract<OrchestrationEvent, { method: 'turn.completed' }>,
  /** station#1410: envelope carried beside this frame, when the server sent one. */
  provenance?: unknown,
) {
  // station#1410 (D1): attach the sidecar only when this terminal event
  // closes the turn whose text is actually buffered.
  //
  // Adapters emit a terminal for an EARLIER turn after the next one has
  // started streaming. `finalizeAssistantTurn` commits whatever is in the
  // streaming shell, so an unconditional stamp would publish turn B's text
  // under turn A's envelope — wrong engine, model, tools and usage, stated
  // with full confidence — and a later reload (where the server-side
  // projection applies the same guard) would silently disagree with what the
  // user was shown live.
  //
  // No known open id means the turn's `turn.started` fell outside this
  // connection's window; the terminal is then the only identity available
  // and adopting it is correct. This mirrors `adoptTerminalIdentity` in
  // `runtime-event-projection.ts` exactly.
  const openTurnId = activeChatsStore.getChatForExecutionSession(
    event.threadId,
  )?.openTurnId;
  const historyRevision =
    activeChatsStore.getChatForExecutionSession(event.threadId)
      ?.orchestrationHistoryRevision ?? 0;
  const closesOpenTurn = !openTurnId || openTurnId === event.turnId;

  finalizeAssistantTurn(
    event.threadId,
    event.outputText,
    closesOpenTurn
      ? {
          turnId: event.turnId,
          provenance,
          answerEligible: event.finishReason !== 'cancelled',
        }
      : undefined,
  );
  activeChatsStore.updateChat(event.threadId, {
    orchestrationHistoryRevision: historyRevision + 1,
  });
  // Queue settlement is independent of the live streaming shell: provider
  // turn identity is exact evidence even for a delayed terminal event.
  const chatKey =
    activeChatsStore.getChatKeyForExecutionSession(event.threadId) ??
    event.threadId;
  reconcileDurableTurn(chatKey, event.turnId);
  drainQueuedMessageOnTurnCompleted(apiBase, chatKey);
}

export function handleTurnAbortedEvent(
  event: Extract<OrchestrationEvent, { method: 'turn.aborted' }>,
) {
  const chatKey =
    activeChatsStore.getChatKeyForExecutionSession(event.threadId) ??
    event.threadId;
  reconcileDurableTurn(chatKey, event.turnId);
  const historyRevision =
    activeChatsStore.getChatForExecutionSession(event.threadId)
      ?.orchestrationHistoryRevision ?? 0;
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  activeChatsStore.updateChat(chatKey, {
    // A late provider abort revokes a previously committed same-turn answer.
    // Keeping it would leave Add to Task on an answer the lifecycle rejects.
    ...(chat
      ? {
          messages: (chat.messages ?? []).map((message) => {
            if (
              !(
                message.turnId === event.turnId &&
                // Row-scoped Session identity protects a predecessor answer
                // that happens to reuse the provider's turn id. Untagged
                // legacy rows remain safe only inside this one Session store.
                (message.sessionId === event.threadId ||
                  message.sessionId === undefined)
              )
            ) {
              return message;
            }
            const {
              answerEligible: _eligible,
              provenance: _provenance,
              ...rest
            } = message;
            return rest;
          }),
        }
      : {}),
    status: 'idle',
    error: event.reason,
    orchestrationStatus: 'aborted',
    orchestrationTurnOpen: false,
    openTurnId: undefined,
    streamingMessage: undefined,
    isProcessingStep: false,
    activityHint: undefined,
    orchestrationHistoryRevision: historyRevision + 1,
  });
}

export function handleRuntimeErrorEvent(
  event: Extract<OrchestrationEvent, { method: 'runtime.error' }>,
) {
  // station#3451 finding 8 (L1 fix round: corrected wording, not code):
  // `RuntimeErrorEvent extends CanonicalRuntimeEventBase`, which carries an
  // optional TOP-LEVEL `turnId` — publishers set it there (muse-adapter.ts,
  // bedrock-adapter.ts's `publishTurnFailure`, codex's `'error'`/
  // `turn.status:'failed'` sites all do), never inside `details`. Reading
  // only `event.details?.turnId` meant this reconcile never fired for any of
  // them, so a turn dispatched through the durable offline queue stayed
  // `accepted` forever. `event.details?.turnId` is checked FIRST below — no
  // `src-server` producer ever sets it, so keeping it primary is harmless —
  // and `event.turnId` is the fallback that actually closes the gap for
  // every real producer.
  const terminalTurnId = event.details?.turnId ?? event.turnId;
  if (typeof terminalTurnId === 'string') {
    reconcileDurableTurn(
      activeChatsStore.getChatKeyForExecutionSession(event.threadId) ??
        event.threadId,
      terminalTurnId,
    );
  }
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  // Surface the error inline (mirroring the durable projection, which renders
  // runtime errors as a text part so a failed turn does not
  // render blank and the message survives turn finalization.
  const streamingMessage =
    chat?.streamingMessage || createAssistantStreamingMessage();
  // A repeat is only compacted after this handler closed the current turn.
  // `turn.started` opens it again, so identical errors from a later turn
  // remain distinct and retain their retry marker boundary. Dedup always
  // compares the RAW `event.message` — independent of how it is displayed
  // below — so a terminal-session classification's translated text does not
  // change what counts as "the same failure repeating".
  const repeatsCurrentTurn =
    !chat?.orchestrationTurnOpen && chat?.error === event.message;
  // station#1827: the streaming bubble is literally "the chat's only
  // content" a dead engine binding used to leave behind (the ticket's
  // reported symptom) — translate it through the same table
  // `ChatDockBody`'s marker rendering already uses, instead of showing the
  // engine's raw prose as if it were an ordinary reply. Every other
  // `runtime.error` (no code, or a different code) keeps today's exact raw
  // `event.message` display — unchanged.
  const translation =
    event.code === ENGINE_SESSION_BINDING_DEAD_CODE
      ? translateChatError({ message: event.message, code: event.code })
      : undefined;
  const errorPartPrefix = translation
    ? formatChatErrorDisplay(translation, event.message)
    : event.message;
  const previousPart = streamingMessage.contentParts?.at(-1);
  const previousPartCount =
    repeatsCurrentTurn && previousPart?.type === 'text'
      ? repeatCount(previousPart.content || '', errorPartPrefix)
      : null;
  const repeatedCount = previousPartCount ? previousPartCount + 1 : 1;
  const nextParts =
    previousPartCount && previousPart
      ? [
          ...(streamingMessage.contentParts || []).slice(0, -1),
          {
            ...previousPart,
            content: repeatedErrorText(errorPartPrefix, repeatedCount),
          },
        ]
      : [
          ...(streamingMessage.contentParts || []),
          { type: 'text' as const, content: errorPartPrefix },
        ];
  // station#1827: the code rides along in the marker (`[CHAT_ERROR:code]`)
  // so `ChatDockBody`'s marker rendering can classify it the same way
  // without re-deriving from prose — see that file's parsing of this exact
  // shape. Absent code keeps the original `[CHAT_ERROR]` shape byte-for-byte.
  const markerPrefix = `[SYSTEM_EVENT] [CHAT_ERROR${
    event.code ? `:${event.code}` : ''
  }] ${event.message}`;
  // UX audit V3 review round 3: the turn this failure is ABOUT. An attributed
  // error names it; an unattributed one ends whichever turn was open when it
  // arrived, which is the honest attribution and the one the transcript's
  // pruning reads. `undefined` (a failure with no turn context at all) leaves
  // the marker unscoped, and unscoped markers are never pruned.
  //
  // The third fallback matters: this handler CLOSES the turn it reports on
  // (`openTurnId: undefined` below), so a second error for that same turn —
  // the repeat-compaction case — arrives with no open turn to inherit. The
  // latest existing card's turn is the one still being talked about.
  const latestMarkerTurnId = [...(chat?.messages ?? [])]
    .reverse()
    .find((message) => isChatErrorMarker(message))?.turnId;
  const failedTurnId = event.turnId ?? chat?.openTurnId ?? latestMarkerTurnId;
  // Markers for EARLIER turns are no longer about this conversation's latest
  // failure: a second failure must replace the first card, not sit beside it.
  const priorMessages = pruneStaleFailureMarkers(
    chat?.messages || [],
    failedTurnId,
  );
  const previousMarker = priorMessages.at(-1);
  const previousMarkerCount =
    repeatsCurrentTurn && previousMarker?.role === 'user'
      ? repeatCount(previousMarker.content, markerPrefix)
      : null;
  const messages =
    previousMarkerCount && previousMarker
      ? [
          ...priorMessages.slice(0, -1),
          {
            ...previousMarker,
            content: `${markerPrefix} (repeated ${previousMarkerCount + 1}×)`,
            timestamp: Date.now(),
            ...(failedTurnId ? { turnId: failedTurnId } : {}),
          },
        ]
      : [
          ...priorMessages,
          {
            role: 'user' as const,
            content: markerPrefix,
            timestamp: Date.now(),
            ...(failedTurnId ? { turnId: failedTurnId } : {}),
          },
        ];
  activeChatsStore.updateChat(event.threadId, {
    status: 'error',
    error: event.message,
    orchestrationStatus: 'errored',
    // Mirrors the server fold: no adapter emits a terminal turn event on
    // failure, so runtime.error closes the turn (#761).
    orchestrationTurnOpen: false,
    openTurnId: undefined,
    streamingMessage: {
      ...streamingMessage,
      contentParts: nextParts,
    },
    // station#1207: this event is also how a silent stall on the
    // station-agent adapter's inner /chat bridge surfaces (no dedicated
    // `turn.failed` method exists — `runtime.error` IS the terminal-failure
    // signal for this path, see `failTurn` in `station-agent-adapter.ts`).
    // Append the exact `[SYSTEM_EVENT] [CHAT_ERROR]` marker shape the direct
    // `/chat` path persists server-side (`chat-lifecycle.ts`) so
    // `ChatDockBody`'s ALREADY-WORKING "Send again" rendering
    // (`findPrecedingUserTurn`, #797) picks it up for free instead of a
    // second bespoke retry mechanism — this module has no access to
    // `sendMessage` (a hook closure), but `ChatDockBody` already does.
    // Client/session-only (not server-persisted like the direct path's
    // marker), so unlike that path it does not survive a reload — disclosed
    // gap, tracked as follow-up.
    messages,
    orchestrationHistoryRevision: (chat?.orchestrationHistoryRevision ?? 0) + 1,
  });
}

export function handleRuntimeWarningEvent(
  event: Extract<OrchestrationEvent, { method: 'runtime.warning' }>,
) {
  toastStore.show(event.message, event.threadId, 5000);

  // #727 review item 1b (CRITICAL): a mid-session escalation to 'never'
  // that the adapter rejected (no allowDangerouslySkipPermissions granted
  // at spawn) must not leave the composer chip showing a posture that
  // never actually applied. The adapter reports which mode IS actually in
  // effect; revert the client's stored override to match reality.
  if (event.code === APPROVAL_ESCALATION_REQUIRES_RESTART_CODE) {
    const revertTo = event.details?.revertToApprovalMode;
    if (isApprovalMode(revertTo)) {
      const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
      activeChatsStore.updateChat(event.threadId, {
        providerOptions: {
          ...(chat?.providerOptions ?? {}),
          approvalMode: revertTo,
        },
      });
    }
  }
}
