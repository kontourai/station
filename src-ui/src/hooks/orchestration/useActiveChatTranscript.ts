import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { getJson, readEnvelopeOrThrow } from '@kontourai/station-sdk';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { useEffect, useMemo, useRef, useState } from 'react';
import { activeChatsStore } from '../../contexts/active-chats-store';
import type { ChatMessage, ChatSession } from '../../types';
import { serverTurnLive } from '../../utils/conversation-activity';
import { isSessionExecutionActive } from '../../utils/execution';
import { CHAT_ERROR_MARKER_PREFIX } from '../../utils/sessionFailure';
import { extractUIBlocks } from '../../utils/uiBlocks';
import { upsertToolResultBlocks } from './messageParts';
import { requestReplayHistory, useReplayHistory } from './replay/history';
import { isReplayThread } from './replay/replay-registry';
import { parseTurnStartedAt } from './turnHandlers';
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

/** Events that end a turn by its id. */
const TURN_TERMINAL_METHODS = [
  'turn.completed',
  'runtime.error',
  'turn.aborted',
];

/**
 * #2304: the turn still open at the end of this window, by its newest
 * non-steer `turn.started`, or undefined when the window cannot say: that
 * `turn.started` is outside the page, or the turn already ended in it (a
 * terminal for that turn, or an interrupted-turn boundary, which the
 * projection also treats as closing whatever turn is open).
 */
function openTurnInWindow(
  events: readonly { event: CanonicalRuntimeEvent }[],
  threadId: string,
): { turnId?: string; createdAt: string } | undefined {
  let open: { turnId?: string; createdAt: string } | undefined;
  for (const { event } of events) {
    if (event.threadId !== threadId) continue;
    if (event.method === 'turn.started' && event.inputKind !== 'steer') {
      open = { turnId: event.turnId, createdAt: event.createdAt };
    } else if (
      (TURN_TERMINAL_METHODS.includes(event.method) &&
        event.turnId === open?.turnId) ||
      (event.method === 'session.state-changed' &&
        event.interruptedTurnBoundary?.boundaryId)
    ) {
      open = undefined;
    }
  }
  return open;
}

/**
 * #2304: the server's start time for the turn still open at the end of this
 * window. A client that attached to an already-running turn never saw its
 * `turn.started` live, so the bounded read is the only place that start
 * exists. Undefined when the window cannot say, or its open turn is not
 * `openTurnId` when one is given.
 */
function openTurnStartFromWindow(
  events: readonly { event: CanonicalRuntimeEvent }[],
  threadId: string,
  openTurnId: string | undefined,
): number | undefined {
  const open = openTurnInWindow(events, threadId);
  if (!open) return undefined;
  if (openTurnId && open.turnId !== openTurnId) return undefined;
  return parseTurnStartedAt(open.createdAt);
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
  // A replay has no server record. Its canonical fold owns the transcript;
  // querying the synthetic ID would replace settled replay rows with an empty page.
  const replay = isReplayThread(session.id);
  const replayHistory = useReplayHistory(session.id);
  const enabled = Boolean(
    session.orchestrationSessionStarted && (!replay || replayHistory),
  );
  const serverWindow = useSessionEventWindow(
    apiBase,
    // The window is intentionally conversation-shaped: it aggregates lineage
    // for reload while each event itself still carries its child session id.
    enabled && !replay ? (session.conversationId ?? session.id) : null,
    session.orchestrationHistoryRevision,
    session.currentSessionId ?? session.id,
  );
  const window = useMemo(
    () =>
      replayHistory
        ? {
            ...replayHistory,
            error: replayHistory.errorMessage
              ? new Error(replayHistory.errorMessage)
              : undefined,
            loadOlder: () => requestReplayHistory(session.id),
            reload: () => requestReplayHistory(session.id),
          }
        : serverWindow,
    [replayHistory, serverWindow, session.id],
  );
  const checkpointRevision = session.orchestrationHistoryRevision ?? 0;

  useEffect(() => {
    // A restored conversation may have continued in another client. The
    // conversation read is authoritative for which child session receives
    // subsequent Stop/approval/live-event routing; no route-local workspace
    // reconstruction is involved.
    const currentSessionId = window.currentSessionId;
    const latest = activeChatsStore.getSnapshot()[session.id];
    if (
      currentSessionId &&
      session.currentSessionId !== currentSessionId &&
      latest?.currentSessionId === session.currentSessionId
    ) {
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
  // #2304: seed the open turn's server start when this client attached to a
  // turn already running (fresh load, reconnect), so the "Working for" clock
  // reads the turn's duration rather than this view's. A live `turn.started`
  // stamps it directly and wins.
  //
  // When a stamp is CLEARED while this reader is mounted (the fold closed, or
  // a reconnect catch-up discarded it), or a catch-up supersedes the shell
  // when there was no stamp to clear, the page on screen is the one read
  // before that happened — after a gap it can still show the previous turn
  // open. Seed only from a page read after it.
  const executionSessionId = session.currentSessionId ?? session.id;
  const previousTurnStartedAt = useRef(session.openTurnStartedAt);
  const previousShellSuperseded = useRef(session.openTurnShellSuperseded);
  const eventsReadBeforeClear = useRef<unknown>(undefined);
  useEffect(() => {
    if (
      (previousTurnStartedAt.current !== undefined &&
        session.openTurnStartedAt === undefined) ||
      (!previousShellSuperseded.current && session.openTurnShellSuperseded)
    ) {
      eventsReadBeforeClear.current = window.events;
    }
    previousTurnStartedAt.current = session.openTurnStartedAt;
    previousShellSuperseded.current = session.openTurnShellSuperseded;
    if (!enabled || replay || !session.orchestrationTurnOpen) return;
    // #2309: with a server activity record the clock reads the record's
    // open-turn start; this seed is only the older-server fallback.
    if (session.conversationActivity) return;
    if (session.openTurnStartedAt !== undefined) return;
    if (window.events === eventsReadBeforeClear.current) return;
    const startedAt = openTurnStartFromWindow(
      window.events,
      executionSessionId,
      // A superseded shell's `openTurnId` is the last turn THIS connection
      // saw start; after a gap the server may have moved on, and the
      // refetched page is the authority for which turn is open.
      session.openTurnShellSuperseded ? undefined : session.openTurnId,
    );
    if (startedAt === undefined) return;
    const latest = activeChatsStore.getSnapshot()[session.id];
    if (
      !latest?.orchestrationTurnOpen ||
      latest.openTurnStartedAt !== undefined
    )
      return;
    activeChatsStore.updateChat(session.id, { openTurnStartedAt: startedAt });
  }, [
    enabled,
    replay,
    executionSessionId,
    session.id,
    session.openTurnId,
    session.openTurnShellSuperseded,
    session.openTurnStartedAt,
    session.orchestrationTurnOpen,
    session.conversationActivity,
    window.events,
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
    if (!enabled || replay) {
      setChangedFilesState({ key: checkpointKey, byTurn: EMPTY_CHANGED_FILES });
      return;
    }
    const controller = new AbortController();
    // station#2236: this fetch MUST ride the SDK authenticated transport
    // (`getJson`), never a bare fetch — the legacy `apiRequest` helper sent
    // no Authorization header and no cookie attaches on native shells, so
    // this call 401'd (`credential_missing`) on every native client and the
    // changed-files data silently dropped.
    void getJson(
      `${apiBase}/api/orchestration/sessions/${encodeURIComponent(session.id)}/checkpoints?revision=${checkpointRevision}`,
      { signal: controller.signal },
    )
      .then((response) =>
        readEnvelopeOrThrow<
          Array<{
            turnId: string;
            changedFiles: NonNullable<ChatMessage['changedFiles']>;
          }>
        >(response),
      )
      .then((records) => {
        if (!controller.signal.aborted) {
          setChangedFilesState({
            key: checkpointKey,
            byTurn: new Map(
              (records ?? []).map((record) => [
                record.turnId,
                record.changedFiles,
              ]),
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
  }, [apiBase, checkpointKey, checkpointRevision, enabled, replay, session.id]);
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
        contentParts: message.parts.flatMap((part) => {
          const mapped = {
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
            approvalThreadId: part.approvalThreadId,
            approvalEventId: part.approvalEventId,
            approvalStatus: part.approvalStatus,
          };
          // Preserve the same tool-result identity and sanitized blocks as
          // the live renderer when the completed turn enters durable replay.
          return part.type === 'tool-invocation' &&
            part.sourceEventId &&
            part.toolCallId
            ? upsertToolResultBlocks(
                [mapped],
                part.toolCallId,
                part.sourceEventId,
                extractUIBlocks(part.output),
              )
            : [mapped];
        }),
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
      }));
    // #2309: the server's record when it sent one; the legacy fold otherwise.
    const active =
      serverTurnLive({
        conversationActivity: session.conversationActivity,
        status: session.status,
        sendAwaitingTurnStart: session.sendAwaitingTurnStart,
        stopSettledTurnId: session.stopSettledTurnId,
      }) ??
      (session.orchestrationTurnOpen ||
        isSessionExecutionActive({
          orchestrationStatus: session.orchestrationStatus,
          status: session.status,
        }));
    const currentPendingClientId = active
      ? [...session.messages]
          .reverse()
          .find((message) => message.role === 'user' && message.clientId)
          ?.clientId
      : undefined;
    const claimedProjectedUsers = new Set<number>();
    // The live prompt row, keyed by the index of the canonical row it stands
    // in for (#2304). It takes that row's position, and — when that row is
    // its own turn's prompt — its timestamp, keeping its own identity and
    // content. (Any other content match keeps the row's own time.)
    // The merge sorts by timestamp, then
    // by input order: the projection stamps a turn's prompt and its activity
    // with the one `turn.started` time, and emits the prompt first, so in the
    // canonical row's slot with the canonical time the prompt wins the tie.
    // Appended in a later group it lost that tie; keeping its own time (the
    // composer's send time on this client's clock) it sorted below its own
    // activity whenever this clock ran ahead of the server's.
    const liveProjectedUsers = new Map<number, ChatMessage>();
    // The turn the window shows open. A sender whose `turn.started` fell in
    // a reconnect gap never had its prompt row stamped with a turn id, so it
    // can only match by content; when its text is the open turn's prompt,
    // that row IS its canonical copy. (`openTurnId` is not the key: across a
    // gap it still names the last turn this connection saw start.)
    const windowOpenTurnId = active
      ? openTurnInWindow(window.events, executionSessionId)?.turnId
      : undefined;
    const unclaimedUser = (candidate: ChatMessage, index: number) =>
      !claimedProjectedUsers.has(index) && candidate.role === 'user';
    // Only the CURRENT pending send can be the open turn's prompt, and it is
    // resolved FIRST: an older unstamped local row with the same text would
    // otherwise claim the open turn's row (hiding its own older prompt and
    // duplicating this one). It can still adopt an identical-text open turn
    // that another client sent; the live `turn.started` handler
    // (`turnHandlers.ts`) is looser still: while a send is pending it adopts
    // the newest composer row for the next turn regardless of its text.
    const currentPending = session.messages.find(
      (message) =>
        message.role === 'user' &&
        message.clientId !== undefined &&
        message.clientId === currentPendingClientId &&
        !message.turnId,
    );
    const openTurnPromptMatch =
      currentPending && windowOpenTurnId
        ? projected.findIndex(
            (candidate, index) =>
              unclaimedUser(candidate, index) &&
              candidate.turnId === windowOpenTurnId &&
              candidate.content === currentPending.content,
          )
        : -1;
    if (openTurnPromptMatch >= 0)
      claimedProjectedUsers.add(openTurnPromptMatch);
    const pendingUsers = session.messages.filter((message) => {
      if (message.role !== 'user' || !message.clientId) return false;
      let match = message.turnId
        ? projected.findIndex(
            (candidate, index) =>
              unclaimedUser(candidate, index) &&
              candidate.turnId === message.turnId,
          )
        : -1;
      let ownTurn = match >= 0;
      if (message === currentPending && openTurnPromptMatch >= 0) {
        match = openTurnPromptMatch;
        ownTurn = true;
      }
      if (!message.turnId && match < 0) {
        match = projected.findIndex(
          (candidate, index) =>
            unclaimedUser(candidate, index) &&
            candidate.content === message.content,
        );
      }
      if (match < 0) return true;
      claimedProjectedUsers.add(match);
      // The local row owns the prompt's stable identity until the turn has
      // settled. If the bounded newest page already contains turn.started,
      // the local row replaces that one canonical duplicate — in the
      // canonical row's position — during the live interval.
      if (active && message.clientId === currentPendingClientId) {
        liveProjectedUsers.set(match, {
          ...message,
          id: message.id ?? message.clientId,
          // Only this prompt's OWN turn's row lends its time: matched by
          // turn id, or by content against the turn the window shows open.
          // Any other content match can be an older turn that sent the same
          // text, and its time is not ours.
          timestamp: ownTurn
            ? (projected[match]?.timestamp ?? message.timestamp)
            : message.timestamp,
        });
      }
      return false;
    });
    let visibleProjected = projected.map(
      (message, index) => liveProjectedUsers.get(index) ?? message,
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
    // A large turn can fill the first event page before its terminal record.
    // Preserve the latest completed live answer until the read includes that
    // turn's unelided completion. Never replace it with an unfinished prefix.
    const latestLiveAnswer = [...session.messages]
      .reverse()
      .find(
        (message) =>
          message.role === 'assistant' &&
          message.turnId &&
          message.answerEligible !== undefined,
      );
    const retainedLiveAnswer =
      latestLiveAnswer &&
      !window.events.some(
        ({ event, elided }) =>
          TURN_TERMINAL_METHODS.includes(event.method) &&
          event.turnId === latestLiveAnswer.turnId &&
          !elided,
      )
        ? latestLiveAnswer
        : undefined;
    if (retainedLiveAnswer) {
      visibleProjected = visibleProjected.filter(
        (message) =>
          message.role !== 'assistant' ||
          message.turnId !== retainedLiveAnswer.turnId,
      );
    }
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
      retainedLiveAnswer ? [retainedLiveAnswer] : [],
    ).map((message) => {
      if (message.changedFiles || !message.turnId) return message;
      const changedFiles = changedFilesByTurn.get(message.turnId);
      return changedFiles ? { ...message, changedFiles } : message;
    });
  }, [
    enabled,
    executionSessionId,
    session.messages,
    session.openTurnId,
    session.openTurnShellSuperseded,
    session.orchestrationStatus,
    session.orchestrationTurnOpen,
    session.status,
    session.conversationActivity,
    session.sendAwaitingTurnStart,
    session.stopSettledTurnId,
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
