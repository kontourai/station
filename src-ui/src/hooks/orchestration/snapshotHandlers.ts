import type { QueryClient } from '@tanstack/react-query';
import type { ChatUIState } from '../../contexts/active-chats-store';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../contexts/background-tasks-store';
import {
  acknowledgesModelRequest,
  modelControlOptionsMatch,
  replaceModelControlOptions,
} from '../../utils/modelCapabilities';
import { rehydrateChatSession } from './rehydrateChatSession';
import type { OrchestrationSnapshotPayload } from './types';

type SnapshotChatState = Pick<
  ChatUIState,
  | 'provider'
  | 'providerOptions'
  | 'requestedModel'
  | 'requestedModelSource'
  | 'requestedProviderOptions'
  | 'modelSource'
  | 'defaultModel'
  | 'orchestrationSessionStarted'
  | 'orchestrationStatus'
  | 'orchestrationTurnOpen'
>;

/** Fold-absent (legacy) payloads count as open — only an explicit false demotes. */
function turnIsOpen(session: { hasActiveTurn?: boolean }): boolean {
  return session.hasActiveTurn !== false;
}

/**
 * archive#3352: the per-thread catch-up half of a reconnect-fallback snapshot,
 * merged into that thread's ONE `updateChat` call below.
 *
 * The gap this snapshot stands in for is, by definition, an interval in which
 * the server appended events this client never received — for EVERY session it
 * names, not only the ones still mid-turn. A session that is idle at reconnect
 * is not evidence that nothing changed: the most damaging case in archive#3352 is a
 * turn that both streamed and COMPLETED inside the gap, which arrives here as
 * `hasActiveTurn: false` and whose `turn.completed` (the event that otherwise
 * bumps `orchestrationHistoryRevision`) is gone for good — the snapshot branch
 * of `GET /api/orchestration/events` replays nothing. So the revision bump is
 * unconditional. `orchestrationHistoryRevision` is what the dock's bounded
 * window reader (`useSessionEventWindow`) refetches on, and that reader is
 * also the only transcript authority for an orchestration session
 * (`rehydrateChatSession` deliberately declines to read /messages for one).
 *
 * The bump is cheap because `useSessionEventWindow` has exactly one consumer,
 * `useActiveChatTranscript`, which `ChatDockBody` mounts for the ACTIVE
 * session only: a bump on any other thread is a number nothing is reading.
 * Comparing the payload's `lastEventAt` against what this client has already
 * folded would be strictly better, but nothing on the client tracks its own
 * fold position — neither `ChatUIState` nor anything it derives records a
 * sequence or timestamp — and inventing that state is a larger change than
 * the one refetch it would save.
 *
 * The local streaming shell is dropped at the same time. It holds only what
 * arrived on the connection that died, so after the gap it is a strict prefix
 * of what the refetch is about to deliver; keeping it would render that prefix
 * twice (open turn) or leave stale text a later terminal event could commit as
 * a message (settled turn). For an open turn `openTurnShellSuperseded` hands
 * that turn's rendering to the projection until `turn.started` opens the next
 * one — see `useActiveChatTranscript`'s suppression filter.
 */
function reconnectCatchUpUpdates(
  chat: Pick<ChatUIState, 'orchestrationHistoryRevision'> | undefined,
  hasOpenTurn: boolean,
): Partial<ChatUIState> {
  return {
    orchestrationHistoryRevision: (chat?.orchestrationHistoryRevision ?? 0) + 1,
    streamingMessage: undefined,
    ...(hasOpenTurn ? { openTurnShellSuperseded: true } : {}),
  };
}

export type OrchestrationSnapshotSyncPlan = {
  sessionUpdates: Array<{
    threadId: string;
    updates: Partial<ChatUIState>;
  }>;
  exitedThreadIds: string[];
};

export function buildOrchestrationSnapshotSyncPlan(
  payload: OrchestrationSnapshotPayload,
  chats: Record<string, SnapshotChatState>,
) {
  const liveThreadIds = new Set(
    payload.sessions.map((session) => session.threadId),
  );

  const sessionUpdates = payload.sessions
    .map((session) => {
      if (!chats[session.threadId]) return null;
      return {
        threadId: session.threadId,
        updates: {
          provider: session.provider,
          model:
            session.reportedModel ?? session.effectiveModel ?? session.model,
          ...(acknowledgesModelRequest(
            chats[session.threadId]?.requestedModel,
            chats[session.threadId]?.defaultModel,
            session.reportedModel ?? session.effectiveModel ?? session.model,
          )
            ? {
                // The model can acknowledge independently from controls: a
                // late B+high report must not consume a newer B+low request.
                requestedModel: undefined,
                requestedModelSource: undefined,
                ...(modelControlOptionsMatch(
                  chats[session.threadId]?.requestedProviderOptions,
                  session.effectiveModelOptions,
                )
                  ? { requestedProviderOptions: undefined }
                  : {}),
                ...(chats[session.threadId]?.requestedModel !== null
                  ? {
                      modelSource:
                        chats[session.threadId]?.requestedModelSource,
                    }
                  : {}),
              }
            : {}),
          ...(session.effectiveModel
            ? {
                providerOptions: replaceModelControlOptions(
                  chats[session.threadId]?.providerOptions ?? {},
                  session.effectiveModelOptions,
                ),
              }
            : {}),
          orchestrationProvider: session.provider,
          orchestrationModel:
            session.reportedModel ?? session.effectiveModel ?? session.model,
          orchestrationSessionStarted: true,
          // archive#1034: the payload's `status` is the provider's process state;
          // 'running' with no open turn (hasActiveTurn === false) must not
          // re-strand the streaming shell after a reconnect — the exact
          // symptom archive#1005 fixed on the live-event path.
          orchestrationStatus:
            session.status === 'running' && !turnIsOpen(session)
              ? 'idle'
              : session.status,
          // Reseed the client turn fold only from an EXPLICIT server
          // verdict (archive#1076) — a reconnect during an in-turn approval must
          // let the next live 'running' state-change re-engage. A legacy
          // payload without the field must NOT persist turnIsOpen's
          // conservative default into the long-lived fold: nothing would
          // ever clear it and an attach-only 'running' would re-engage the
          // shell (closure-round). Absent field → fold untouched.
          ...(session.hasActiveTurn === undefined
            ? {}
            : { orchestrationTurnOpen: session.hasActiveTurn }),
          status:
            session.status === 'running' && turnIsOpen(session)
              ? 'sending'
              : 'idle',
        } satisfies Partial<ChatUIState>,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const exitedThreadIds = Object.entries(chats)
    .filter(
      ([threadId, chat]) =>
        chat.provider !== 'bedrock' &&
        chat.orchestrationSessionStarted &&
        !liveThreadIds.has(threadId),
    )
    .map(([threadId]) => threadId);

  return {
    sessionUpdates,
    exitedThreadIds,
  } satisfies OrchestrationSnapshotSyncPlan;
}

export interface ApplyOrchestrationSnapshotOptions {
  apiBase: string;
  /**
   * archive#1225: `true` when this snapshot is the server's bounded-gap
   * fallback on a RECONNECT (`resolveStreamResumePlan`'s `gap_exceeded`/
   * `invalid_cursor` outcomes), not the ordinary snapshot every fresh
   * connect (including first-ever mount) also sends. A snapshot only
   * carries per-session STATUS fields (`buildOrchestrationSnapshotSyncPlan`
   * above) — never the turns that happened during the gap — so a
   * currently-open chat's message transcript needs an explicit full
   * refetch or it stays stale forever. Omitted/false keeps this a pure
   * status sync, exactly matching pre-archive#1225 behavior (a first connect has
   * nothing stale to refresh — `ChatDock`'s own mount-time
   * `rehydrateSessions` already covers that case).
   */
  isReconnectFallback?: boolean;
  /**
   * archive#1225 forwarded verbatim to
   * `rehydrateChatSession` so the reconnect-fallback refetch keeps the same
   * `toolMappings` cache-lookup fallback the mount-time rehydrate path has
   * (`conversationsStore.fetchMessages`'s `['agentTools', agentSlug]`
   * lookup) — dropping it would silently regress persisted tool-call parts
   * back to raw internal names. Threaded down from `useOrchestration`'s
   * `useQueryClient` call via `ensureOrchestrationEventStream`, since
   * neither that module nor this one is a hook.
   */
  queryClient?: QueryClient;
}

export function applyOrchestrationSnapshot(
  payload: OrchestrationSnapshotPayload,
  options?: ApplyOrchestrationSnapshotOptions,
) {
  // archive#1301: seed/reconcile delegate→parent-chat bindings and
  // terminal states from the connect-time (or reconnect-fallback) snapshot —
  // the same widened fields (`delegation`, `createdAt`, `lastEventAt`) this
  // payload type now declares. Independent of the chat-status sync plan
  // below: a delegate session is never itself a tracked chat, so it has no
  // entry in `chats` and never appears in `plan.sessionUpdates`.
  backgroundTasksStore.reconcileSnapshot(payload);

  const snapshot = activeChatsStore.getSnapshot();
  const plan = buildOrchestrationSnapshotSyncPlan(payload, snapshot);
  const isReconnectFallback = options?.isReconnectFallback === true;
  const openTurnThreadIds = new Set(
    payload.sessions.filter(turnIsOpen).map((session) => session.threadId),
  );

  for (const { threadId, updates } of plan.sessionUpdates) {
    // One write per thread. Each `updateChat` copies the whole chat map and
    // broadcasts to every listener, and this loop runs on the reconnect hot
    // path (archive#3350/archive#3351), so the catch-up fields ride the status sync
    // rather than following it with a second write.
    activeChatsStore.updateChat(threadId, {
      ...updates,
      ...(isReconnectFallback
        ? reconnectCatchUpUpdates(
            snapshot[threadId],
            openTurnThreadIds.has(threadId),
          )
        : {}),
    });
  }

  for (const threadId of plan.exitedThreadIds) {
    activeChatsStore.updateChat(threadId, {
      orchestrationSessionStarted: false,
      orchestrationStatus: 'exited',
      orchestrationTurnOpen: false,
      status: 'idle',
      isProcessingStep: false,
      streamingMessage: undefined,
    });
  }

  if (!isReconnectFallback || !options) return;
  // Bounded catch-up guardrail (archive#1225): force a real refetch for every
  // tracked chat this snapshot named, reusing the SAME mechanism
  // `useRehydrateSessions` uses on mount (`rehydrateChatSession`) rather than
  // a second bespoke fetch. `plan.sessionUpdates` is already scoped to threads
  // BOTH present in this snapshot AND already tracked locally, so no extra
  // existence check is needed here.
  //
  // It reads the PRE-update `snapshot`, and that is load-bearing rather than
  // incidental: `rehydrateChatSession` returns immediately for a chat already
  // marked `orchestrationSessionStarted` (a Station-owned thread hydrates
  // through the bounded window instead), and the loop above has just set that
  // flag on every thread here. Reading the post-update map would leave this
  // loop unable to do anything at all. What survives is exactly one case — a
  // locally tracked chat this client did not yet know had an orchestration
  // session — and it is a /messages read, so it carries no revision or turn
  // state; the window catch-up above is what serves every already-started
  // chat.
  for (const { threadId } of plan.sessionUpdates) {
    const chat = snapshot[threadId];
    if (!chat?.agentSlug || !chat.conversationId) continue;
    void rehydrateChatSession(options.apiBase, threadId, chat, {
      force: true,
      queryClient: options.queryClient,
    });
  }
}
