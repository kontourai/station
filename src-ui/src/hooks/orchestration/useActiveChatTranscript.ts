import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { useEffect, useMemo, useState } from 'react';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { apiRequest, unwrapApiData } from '../../lib/apiClient';
import type { ChatMessage, ChatSession } from '../../types';
import { isSessionExecutionActive } from '../../utils/execution';
import { CHAT_ERROR_MARKER_PREFIX } from '../../utils/sessionFailure';
import { useSessionEventWindow } from './useSessionEventWindow';

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_CHANGED_FILES = new Map<
  string,
  NonNullable<ChatMessage['changedFiles']>
>();

function transcriptMessageText(message: ChatMessage): string {
  return [
    message.content ?? '',
    ...(message.contentParts ?? []).map((part) => part.content ?? ''),
  ].join('\n');
}

/**
 * the live `[SYSTEM_EVENT] [CHAT_ERROR…]` marker
 * `handleRuntimeErrorEvent` appends is the dock's visible failure card, and it
 * used to be dropped here — it is an ordinary `role: 'user'` row with no
 * `clientId`, so the bounded projection kept neither it nor the streaming
 * shell it was written beside (that shell is suppressed by the same update's
 * `status: 'error'`). A session killed mid-turn therefore rendered its prompt
 * and nothing else. Retained explicitly, exactly like the flow supplements
 * beside it: the bounded turn projector cannot recreate it, and it is the one
 * row that carries the reason plus its retry affordance.
 */
function isLiveFailureMarker(message: ChatMessage): boolean {
  return transcriptMessageText(message)
    .trimStart()
    .startsWith(CHAT_ERROR_MARKER_PREFIX);
}

function isLiveSupplementalMessage(message: ChatMessage): boolean {
  return Boolean(
    message.ephemeral ||
      isLiveFailureMarker(message) ||
      message.contentParts?.some(
        (part) =>
          part.type === 'flow-run-attached' ||
          part.type === 'flow-gate-verdict',
      ),
  );
}

function mergeTranscriptMessages(...groups: ChatMessage[][]): ChatMessage[] {
  const seenIds = new Set<string>();
  return groups
    .flat()
    .filter((message) => {
      if (!message.id) return true;
      if (seenIds.has(message.id)) return false;
      seenIds.add(message.id);
      return true;
    })
    .map((message, inputIndex) => ({ message, inputIndex }))
    .sort((left, right) => {
      const leftTimestamp = left.message.timestamp;
      const rightTimestamp = right.message.timestamp;
      if (leftTimestamp === undefined && rightTimestamp === undefined) {
        return left.inputIndex - right.inputIndex;
      }
      if (leftTimestamp === undefined) return 1;
      if (rightTimestamp === undefined) return -1;
      return (
        leftTimestamp - rightTimestamp || left.inputIndex - right.inputIndex
      );
    })
    .map(({ message }) => message);
}

/**
 * The dock's orchestration transcript reader. It deliberately shares the
 * bounded REST window protocol with SessionsView rather than requesting the
 * unbounded conversation endpoint for a Station-owned thread. The app-wide
 * orchestration stream remains the only live authority.
 */
export function useActiveChatTranscript(apiBase: string, session: ChatSession) {
  const enabled = Boolean(session.orchestrationSessionStarted);
  const window = useSessionEventWindow(
    apiBase,
    // The window is intentionally conversation-shaped: it aggregates lineage
    // for reload while each event itself still carries its child session id.
    enabled ? (session.conversationId ?? session.id) : null,
    session.orchestrationHistoryRevision,
    session.currentSessionId ?? session.id,
  );
  const checkpointRevision = session.orchestrationHistoryRevision ?? 0;

  useEffect(() => {
    // A restored conversation may have continued in another client. The
    // conversation read is authoritative for which child session receives
    // subsequent Stop/approval/live-event routing; no route-local workspace
    // reconstruction is involved.
    const currentSessionId = window.currentSessionId;
    if (currentSessionId && session.currentSessionId !== currentSessionId) {
      activeChatsStore.updateChat(session.id, {
        currentSessionId,
        ...(session.conversationId
          ? {
              conversationOpenPending: true,
              conversationOpenFailed: false,
              // Retire the predecessor shell at the boundary. Subsequent
              // live events and open revalidation now address the new child.
              orchestrationTurnOpen: false,
              openTurnId: undefined,
              streamingMessage: undefined,
            }
          : {}),
      });
    }
  }, [
    session.conversationId,
    session.currentSessionId,
    session.id,
    window.currentSessionId,
  ]);
  const checkpointKey = `${apiBase}\0${session.id}\0${checkpointRevision}`;
  const [changedFilesState, setChangedFilesState] = useState<{
    key: string;
    byTurn: Map<string, NonNullable<ChatMessage['changedFiles']>>;
  }>(() => ({ key: checkpointKey, byTurn: EMPTY_CHANGED_FILES }));
  // Key the data at read time. React effects run after render, so clearing in
  // the effect alone lets one render of session B inherit session A's file
  // claims. A mismatched key is synchronously empty.
  const changedFilesByTurn =
    changedFilesState.key === checkpointKey
      ? changedFilesState.byTurn
      : EMPTY_CHANGED_FILES;
  useEffect(() => {
    if (!enabled) {
      setChangedFilesState({ key: checkpointKey, byTurn: EMPTY_CHANGED_FILES });
      return;
    }
    const controller = new AbortController();
    void apiRequest<{
      success: true;
      data: Array<{
        turnId: string;
        changedFiles: NonNullable<ChatMessage['changedFiles']>;
      }>;
    }>(
      `${apiBase}/api/orchestration/sessions/${encodeURIComponent(session.id)}/checkpoints?revision=${checkpointRevision}`,
      {
        signal: controller.signal,
      },
    )
      .then((response) => unwrapApiData(response))
      .then((records) => {
        if (!controller.signal.aborted) {
          setChangedFilesState({
            key: checkpointKey,
            byTurn: new Map(
              records.map((record) => [record.turnId, record.changedFiles]),
            ),
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setChangedFilesState({
            key: checkpointKey,
            byTurn: EMPTY_CHANGED_FILES,
          });
        }
      });
    return () => controller.abort();
  }, [apiBase, checkpointKey, checkpointRevision, enabled, session.id]);
  const messages = useMemo(() => {
    if (!enabled) return session.messages;
    const agentBySessionId = new Map(
      (window.sessionLineage ?? []).flatMap((entry) =>
        entry.agentSlug ? [[entry.sessionId, entry.agentSlug] as const] : [],
      ),
    );
    const agentPresentationBySessionId = new Map(
      (window.sessionLineage ?? []).map((entry) => [entry.sessionId, entry]),
    );
    const projected = projectRuntimeEventsToMessages(
      window.events
        .map((item) => item.event)
        .filter((event): event is CanonicalRuntimeEvent =>
          Boolean(event.eventId),
        ),
      { stableIds: true },
    )
      // The open turn is rendered by exactly one of two things: the live
      // streaming shell (`ChatMessageList`'s `StreamingMessage`) or this
      // projection. Normally the shell owns it — it has every token from
      // `turn.started` on, and admitting the projected copy alongside would
      // render the turn twice.
      //
      // archive#3352 reverses that after a reconnect the server could not
      // replay: the shell then holds only what arrived before the drop, so
      // the projection is the more complete copy and the shell is dropped
      // (`applyOrchestrationSnapshot`) in favour of it. `turn.started` clears
      // the flag, so a turn the shell owns from its first token suppresses
      // this copy exactly as before.
      .filter(
        (message) =>
          !(
            session.orchestrationTurnOpen &&
            !session.openTurnShellSuperseded &&
            message.role === 'assistant' &&
            message.metadata?.turnId === session.openTurnId
          ),
      )
      .map<ChatMessage>((message) => ({
        id: message.id,
        role: message.role,
        content: message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join(''),
        contentParts: message.parts.map((part) => ({
          type: part.type,
          content: part.text,
          url: part.url,
          blobRef: part.blobRef,
          mediaType: part.mediaType,
          name: part.name,
          toolCallId: part.toolCallId,
          sourceEventId: part.sourceEventId,
          toolName: part.toolName,
          args: part.args,
          result: part.result,
          output: part.output,
          error: part.error,
          cancelled: part.cancelled,
          state: part.state,
          isError: part.isError,
          progressMessage: part.progressMessage,
          runtimeError: part.runtimeError,
          runtimeErrorCode: part.runtimeErrorCode,
          needsApproval: part.needsApproval,
          approvalId: part.approvalId,
          approvalStatus: part.approvalStatus,
        })),
        timestamp: message.metadata?.timestamp,
        model: message.metadata?.model ?? undefined,
        modelOptions: message.metadata?.modelOptions,
        turnId: message.metadata?.turnId,
        sessionId: message.metadata?.sessionId,
        agentSlug: message.metadata?.sessionId
          ? agentBySessionId.get(message.metadata.sessionId)
          : undefined,
        agentDisplayName: message.metadata?.sessionId
          ? agentPresentationBySessionId.get(message.metadata.sessionId)
              ?.agentDisplayName
          : undefined,
        agentIcon: message.metadata?.sessionId
          ? agentPresentationBySessionId.get(message.metadata.sessionId)
              ?.agentIcon
          : undefined,
        sourceEventId: message.metadata?.sourceEventId,
        answerEligible: message.metadata?.answerEligible,
        provenance: message.metadata?.provenance,
        changedFiles: message.metadata?.turnId
          ? changedFilesByTurn.get(message.metadata.turnId)
          : undefined,
      }));
    const active =
      session.orchestrationTurnOpen ||
      isSessionExecutionActive({
        orchestrationStatus: session.orchestrationStatus,
        status: session.status,
      });
    const currentPendingClientId = active
      ? [...session.messages]
          .reverse()
          .find((message) => message.role === 'user' && message.clientId)
          ?.clientId
      : undefined;
    const claimedProjectedUsers = new Set<number>();
    const hiddenProjectedUsers = new Set<number>();
    const pendingUsers = session.messages.filter((message) => {
      if (message.role !== 'user' || !message.clientId) return false;
      const match = projected.findIndex(
        (candidate, index) =>
          !claimedProjectedUsers.has(index) &&
          candidate.role === 'user' &&
          candidate.content === message.content,
      );
      if (match < 0) return true;
      claimedProjectedUsers.add(match);
      // The local row owns the prompt's stable identity until the turn has
      // settled. If the bounded newest page already contains turn.started,
      // suppress that one canonical duplicate during the live interval.
      if (active && message.clientId === currentPendingClientId) {
        hiddenProjectedUsers.add(match);
        return true;
      }
      return false;
    });
    let visibleProjected = projected.filter(
      (_message, index) => !hiddenProjectedUsers.has(index),
    );
    // Flow events and provider notices are appended by the single app-wide
    // orchestration stream. They are not turn rows, so the bounded turn
    // projector does not recreate them. Keep those explicit live supplements
    // alongside the REST projection without admitting ordinary full-history
    // rows from the active-chat store.
    // A failure must render exactly once — but #765 A1 flips WHICH copy wins
    // when both exist for the same turn: the local `[CHAT_ERROR]` marker
    // carries the translated copy and the Send again/New chat affordance
    // (`ChatDockBody`'s `renderOverride` — this hook's only consumer), while
    // the projected `runtimeError` part is untranslatable prose with no
    // action. Previously the marker was hidden in favour of the projected
    // part, which is exactly how the audit saw a raw
    // "No conversation found with session ID: <uuid>" with no retry. Now the
    // marker stays and that turn's projected failure PARTS are stripped
    // (real streamed content on the same row survives).
    //
    // Matched on turn identity, not on text: two turns can fail the same
    // way, and a global text match would collapse them. A marker with no
    // turn identity keeps the text-comparison fallback it had before.
    const markerFailureTurnIds = new Set(
      session.messages
        .filter((message) => isLiveFailureMarker(message))
        .map((message) => message.turnId)
        .filter((turnId): turnId is string => typeof turnId === 'string'),
    );
    if (markerFailureTurnIds.size > 0) {
      visibleProjected = visibleProjected.flatMap((message) => {
        if (
          typeof message.turnId !== 'string' ||
          !markerFailureTurnIds.has(message.turnId) ||
          !message.contentParts?.some((part) => part.runtimeError === true)
        ) {
          return [message];
        }
        const remaining = message.contentParts.filter(
          (part) => part.runtimeError !== true,
        );
        if (remaining.length === 0) return [];
        return [
          {
            ...message,
            contentParts: remaining,
            content: remaining
              .filter((part) => part.type === 'text')
              .map((part) => part.content ?? '')
              .join(''),
          },
        ];
      });
    }
    const projectedFailureText = visibleProjected
      .map(transcriptMessageText)
      .join('\n');
    const supplementalMessages = session.messages.filter((message) => {
      if (!isLiveSupplementalMessage(message)) return false;
      if (!isLiveFailureMarker(message)) return true;
      // A turn-identified marker owns its failure's one visible element —
      // the projected copy for that turn was stripped above.
      if (message.turnId !== undefined) return true;
      const reason = transcriptMessageText(message)
        .replace(/^\s*\[SYSTEM_EVENT\]\s*\[CHAT_ERROR(?::[\w-]+)?\]\s*/, '')
        .trim();
      return reason.length === 0 || !projectedFailureText.includes(reason);
    });
    const handoffBoundaries: ChatMessage[] = window.handoffs.map((handoff) => ({
      id: `conversation-handoff:${handoff.sessionId}`,
      role: 'system',
      content: '',
      timestamp: Date.parse(handoff.createdAt),
      contentParts: [
        { type: 'conversation-handoff', conversationHandoff: handoff },
      ],
    }));
    const contextBoundaryMarkers: ChatMessage[] = window.contextBoundaries.map(
      (boundary) => ({
        id: `conversation-context-boundary:${boundary.boundaryId}`,
        role: 'system',
        content: '',
        timestamp: Date.parse(boundary.consumedAt),
        contentParts: [
          {
            type: 'conversation-context-boundary',
            conversationContextBoundary: boundary,
          },
        ],
      }),
    );
    // While the first bounded page is in flight, retain only local ephemeral
    // notices; persisted transcript rows never cause a full conversation read.
    return mergeTranscriptMessages(
      visibleProjected,
      handoffBoundaries,
      contextBoundaryMarkers,
      pendingUsers.map((message) => ({
        ...message,
        id: message.id ?? message.clientId,
      })),
      supplementalMessages,
    );
  }, [
    enabled,
    session.messages,
    session.openTurnId,
    session.openTurnShellSuperseded,
    session.orchestrationStatus,
    session.orchestrationTurnOpen,
    session.status,
    changedFilesByTurn,
    window.events,
    window.sessionLineage,
    window.handoffs,
    window.contextBoundaries,
  ]);

  return {
    ...window,
    enabled,
    messages: enabled
      ? messages
      : EMPTY_MESSAGES === session.messages
        ? EMPTY_MESSAGES
        : messages,
  };
}
