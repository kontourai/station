import type { QueryClient } from '@tanstack/react-query';
import type { ChatUIState } from '../../contexts/active-chats-store';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../contexts/background-tasks-store';
import { childWorkGlobalStore } from '../../contexts/child-work-global-store';
import { newerConversationActivity } from '../../utils/conversation-activity';
import {
  acknowledgesModelRequest,
  modelControlOptionsMatch,
  replaceModelControlOptions,
} from '../../utils/modelCapabilities';
import { reconcileChildWorkSnapshot } from './childWorkHandlers';
import { rehydrateChatSession } from './rehydrateChatSession';
import { isReplayThread } from './replay/replay-registry';
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
  | 'currentSessionId'
  | 'conversationId'
>;

/** Fold-absent (legacy) payloads count as open — only an explicit false demotes. */
function turnIsOpen(session: { hasActiveTurn?: boolean }): boolean {
  return session.hasActiveTurn !== false;
}

type ConversationRecord = NonNullable<
  OrchestrationSnapshotPayload['sessions'][number]['conversationActivity']
>;

/**
 * #2309: is a turn open for the CONVERSATION this row belongs to? The row's
 * `conversationActivity` answers for every lineage child, so the root row of
 * a conversation whose child runs the turn reads open too. Rows from an older
 * server keep the per-row fold.
 */
function rowTurnIsOpen(
  session: { hasActiveTurn?: boolean },
  record: ConversationRecord | undefined,
): boolean {
  return record ? record.openTurn !== undefined : turnIsOpen(session);
}

/** The explicit verdict for the legacy fold, or undefined when none was sent. */
function rowTurnVerdict(
  session: { hasActiveTurn?: boolean },
  record: ConversationRecord | undefined,
): boolean | undefined {
  if (record) return record.openTurn !== undefined;
  return session.hasActiveTurn;
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
 *
 * #2304: the open turn's start (`openTurnStartedAt`) is dropped with the
 * shell, for the same reason. The fold reseeds `orchestrationTurnOpen` from
 * `hasActiveTurn` without ever passing through `false`, so a turn that
 * completed inside the gap, followed by the next one starting, would
 * otherwise leave the finished turn's start on the "Working for" clock.
 * `useActiveChatTranscript` re-derives it from the refetched window. Until it
 * does, the streaming row states no working duration: it cannot tell the
 * same turn still running from a different turn started in the gap.
 */
function reconnectCatchUpUpdates(
  chat: Pick<ChatUIState, 'orchestrationHistoryRevision'> | undefined,
  hasOpenTurn: boolean,
): Partial<ChatUIState> {
  return {
    orchestrationHistoryRevision: (chat?.orchestrationHistoryRevision ?? 0) + 1,
    streamingMessage: undefined,
    ...(hasOpenTurn
      ? { openTurnShellSuperseded: true, openTurnStartedAt: undefined }
      : {}),
  };
}

export type OrchestrationSnapshotSyncPlan = {
  sessionUpdates: Array<{
    /** The chat STORE key the updates apply to (see `selectSnapshotRows`). */
    threadId: string;
    updates: Partial<ChatUIState>;
  }>;
  exitedThreadIds: string[];
};

type SnapshotSession = OrchestrationSnapshotPayload['sessions'][number];

function snapshotRowRecency(session: SnapshotSession): string {
  return session.lastEventAt ?? session.createdAt ?? '';
}

/**
 * #2303: which snapshot row speaks for each tracked chat.
 *
 * A Station conversation is ONE chat, keyed by its conversation id, over MANY
 * execution threads — the root plus a `<root>:session:<uuid>` child per
 * continuation — and the snapshot lists execution threads. An exact
 * `chats[row.threadId]` lookup therefore matched only the conversation ROOT,
 * which finished long ago, and its `hasActiveTurn: false` wrote the running
 * turn closed while the child actually running it was skipped for having no
 * chat of its own.
 *
 * A row reaches every chat it belongs to: its exact execution thread (the
 * store's `getChatKeyForExecutionSession` rules — exact key, then a chat whose
 * `currentSessionId`/`conversationId` names it) AND its `conversationId`'s
 * chat, resolved the same way. The conversation id is the key that survives a
 * stale `currentSessionId`: a reopened conversation points at the child the
 * open resolved to, and the next turn runs in a newer one.
 *
 * That includes a chat keyed by some child K that itself declares
 * `conversationId: C` (a legacy child-keyed tab) whose own row is no longer
 * in the snapshot: it is reached through C's rows, reconciled from them, and
 * is not marked exited. Deliberate — the chat says it is a view of C, and C
 * is still live; marking it exited while C's turn runs is the defect.
 *
 * #2309 — WITH a server activity record (any row reaching the chat carries
 * one; the newest by `asOfSequence` is the chat's record): liveness is the
 * record's, for the chat and for every row reaching it, and it reached the
 * chat through the store before this plan runs. The row chosen here carries
 * only the non-liveness fields (model, provider, exit), and it is:
 * 1. the child the record's open turn names, when a turn is open;
 * 2. otherwise the child the chat is bound to (`currentSessionId`), so a
 *    just-finished child's model reads, not the root's first-turn model;
 * 3. otherwise the chat's own exact-key row, then the most recent row.
 *
 * WITHOUT a record (an older server) — #2303's inference, kept as the
 * fallback — the row that speaks for the chat is:
 * 1. the one with an explicitly open turn (`hasActiveTurn === true`), latest
 *    by `lastEventAt`/`createdAt` if several — an idle sibling is not
 *    evidence that the conversation is idle, so it can never overwrite it;
 * 2. otherwise the chat's own exact-key row, which is exactly the row the
 *    pre-#2303 lookup used, so an idle conversation keeps today's semantics
 *    (model fields included);
 * 3. otherwise the most recent row, so a conversation whose root row is
 *    absent is still reconciled rather than marked exited.
 *
 * Model fields ride with the chosen row. For (1) that is deliberate: the
 * child running the turn is the execution actually using the conversation's
 * current model, while the root reports whatever the FIRST turn launched with
 * — acknowledging a pending model request against the root would compare it
 * to a stale answer.
 */
type SelectedSnapshotRow = {
  row: SnapshotSession;
  /** The chat's record (newest across its rows), when any row carries one. */
  record: ConversationRecord | undefined;
};

function selectSnapshotRows(
  payload: OrchestrationSnapshotPayload,
  chats: Record<string, SnapshotChatState>,
): Map<string, SelectedSnapshotRow> {
  const keyByExecutionIdentity = new Map<string, string>();
  for (const [key, chat] of Object.entries(chats)) {
    for (const identity of [chat.currentSessionId, chat.conversationId]) {
      if (identity && !keyByExecutionIdentity.has(identity))
        keyByExecutionIdentity.set(identity, key);
    }
  }
  const resolveChatKey = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    return chats[id] ? id : keyByExecutionIdentity.get(id);
  };

  const candidatesByChat = new Map<string, SnapshotSession[]>();
  for (const session of payload.sessions) {
    const keys = new Set(
      [
        resolveChatKey(session.threadId),
        resolveChatKey(session.conversationId),
      ].filter((key): key is string => key !== undefined),
    );
    for (const key of keys) {
      const candidates = candidatesByChat.get(key);
      if (candidates) candidates.push(session);
      else candidatesByChat.set(key, [session]);
    }
  }

  const selected = new Map<string, SelectedSnapshotRow>();
  for (const [key, candidates] of candidatesByChat) {
    const latest = (rows: SnapshotSession[]) =>
      rows.reduce((best, row) =>
        snapshotRowRecency(row) >= snapshotRowRecency(best) ? row : best,
      );
    // #2309: with a server activity record, liveness is the record's and
    // already reached the chat through the store (fed before this plan runs).
    // The row chosen here carries only the non-liveness fields (model,
    // provider, exit), so the record names it: the child running the open
    // turn when there is one, else the chat's own row, else the latest.
    const record = candidates.reduce<ConversationRecord | undefined>(
      (newest, row) =>
        newerConversationActivity(newest, row.conversationActivity),
      undefined,
    );
    if (record) {
      const running = record.openTurn
        ? candidates.find((row) => row.threadId === record.openTurn?.threadId)
        : undefined;
      const bound = chats[key]?.currentSessionId;
      selected.set(key, {
        row:
          running ??
          (bound
            ? candidates.find((row) => row.threadId === bound)
            : undefined) ??
          candidates.find((row) => row.threadId === key) ??
          latest(candidates),
        record,
      });
      continue;
    }
    // #2303, kept as the OLDER-SERVER fallback (no record): an explicitly
    // open child wins over an idle sibling.
    const open = candidates.filter((row) => row.hasActiveTurn === true);
    selected.set(key, {
      row:
        open.length > 0
          ? latest(open)
          : (candidates.find((row) => row.threadId === key) ??
            latest(candidates)),
      record: undefined,
    });
  }
  return selected;
}

function planSnapshot(
  payload: OrchestrationSnapshotPayload,
  chats: Record<string, SnapshotChatState>,
) {
  const selected = selectSnapshotRows(payload, chats);

  const sessionUpdates = [...selected].map(
    ([chatKey, { row: session, record }]) => {
      const chat = chats[chatKey];
      // #2303: live events for the running child route through
      // `getChatForExecutionSession`, which matches `currentSessionId`; a
      // chat still pointing at an older child would drop every one of them.
      // Repaired exactly the way the live `session.started` path repairs it
      // (`handleOrchestrationEvent`), including re-proving the binding.
      //
      // Only an OPEN row is adopted, and only because the server guarantees an
      // open turn marks the conversation's CURRENT child: it refuses a new
      // continuation child while the predecessor has an active turn
      // (`canResolveConversationContinuation` requires `hasActiveTurn !== true`;
      // context-boundary and handoff reservations require a terminal
      // predecessor with no active turn — conversation-lineage.ts), and a
      // crashed turn is closed with `turn.aborted` rather than left open
      // (interrupted-turn-recovery.ts, station#2235). The live path instead
      // gates on the server's own binding (`conversation.currentSessionId`);
      // the snapshot carries no such binding, so this inference is only as
      // good as those rules. An idle winner (rule 3) is never adopted.
      //
      // Known limitation, shared with the live repair (eventHandlers.ts sets
      // the same `conversationOpenPending: true`): the revalidator that clears
      // it mounts only for the ACTIVE chat (ChatDock's
      // `activeSession.conversationOpenPending` gate), so a background chat
      // stays 'resolving' until opened, and `drainQueuedMessageOnTurnCompleted`
      // (`!conversationCanMutate`) holds its queued follow-up until then.
      //
      // #2309: with a server activity record the running child is not
      // inferred from a row's `hasActiveTurn`: the record names it
      // (`openTurn.threadId`, the conversation's CURRENT child by the server's
      // own resolution), and that is what is adopted. The inference above
      // remains only for an older server that sends no record.
      // The CHAT's record (newest across every row reaching it), never only the
      // chosen row's own: a record-less row with a stale `hasActiveTurn` must
      // not contradict a sibling's record.
      const runningChild = record
        ? record.openTurn?.threadId
        : session.hasActiveTurn === true
          ? session.threadId
          : undefined;
      const adoptsOpenChild =
        runningChild !== undefined &&
        runningChild !== chatKey &&
        chat?.currentSessionId !== runningChild;
      return {
        threadId: chatKey,
        updates: {
          provider: session.provider,
          model:
            session.reportedModel ?? session.effectiveModel ?? session.model,
          ...(acknowledgesModelRequest(
            chat?.requestedModel,
            chat?.defaultModel,
            session.reportedModel ?? session.effectiveModel ?? session.model,
          )
            ? {
                // The model can acknowledge independently from controls: a
                // late B+high report must not consume a newer B+low request.
                requestedModel: undefined,
                requestedModelSource: undefined,
                ...(modelControlOptionsMatch(
                  chat?.requestedProviderOptions,
                  session.effectiveModelOptions,
                )
                  ? { requestedProviderOptions: undefined }
                  : {}),
                ...(chat?.requestedModel !== null
                  ? {
                      modelSource: chat?.requestedModelSource,
                    }
                  : {}),
              }
            : {}),
          ...(session.effectiveModel
            ? {
                providerOptions: replaceModelControlOptions(
                  chat?.providerOptions ?? {},
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
            session.status === 'running' && !rowTurnIsOpen(session, record)
              ? 'idle'
              : session.status,
          // Reseed the client turn fold only from an EXPLICIT server
          // verdict (archive#1076) — a reconnect during an in-turn approval must
          // let the next live 'running' state-change re-engage. A legacy
          // payload without the field must NOT persist turnIsOpen's
          // conservative default into the long-lived fold: nothing would
          // ever clear it and an attach-only 'running' would re-engage the
          // shell (closure-round). Absent field → fold untouched.
          ...(rowTurnVerdict(session, record) === undefined
            ? {}
            : { orchestrationTurnOpen: rowTurnVerdict(session, record) }),
          // #2309: liveness itself is the conversation's activity record
          // (applied to the store before this plan runs); this keeps the
          // coarse fields consistent with it for readers that still use them.
          status:
            session.status === 'running' && rowTurnIsOpen(session, record)
              ? 'sending'
              : 'idle',
          ...(adoptsOpenChild
            ? {
                currentSessionId: runningChild,
                conversationOpenPending: true,
                conversationOpenFailed: false,
              }
            : {}),
        } satisfies Partial<ChatUIState>,
      };
    },
  );

  // A chat is exited only when NO row reached it — its own key being an idle
  // root while the live child runs elsewhere is not an exit (#2303).
  const exitedThreadIds = Object.entries(chats)
    .filter(
      ([threadId, chat]) =>
        chat.provider !== 'bedrock' &&
        chat.orchestrationSessionStarted &&
        !selected.has(threadId),
    )
    .map(([threadId]) => threadId);

  const openTurnChatKeys = new Set(
    [...selected]
      .filter(([, { row, record }]) => rowTurnIsOpen(row, record))
      .map(([chatKey]) => chatKey),
  );

  return {
    plan: {
      sessionUpdates,
      exitedThreadIds,
    } satisfies OrchestrationSnapshotSyncPlan,
    openTurnChatKeys,
  };
}

export function buildOrchestrationSnapshotSyncPlan(
  payload: OrchestrationSnapshotPayload,
  chats: Record<string, SnapshotChatState>,
): OrchestrationSnapshotSyncPlan {
  return planSnapshot(payload, chats).plan;
}

export interface ApplyOrchestrationSnapshotOptions {
  replayThreadId?: string;
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
   * back to raw internal names. #2307: `ensureOrchestrationEventStream`
   * passes the client currently registered for this apiBase — `ChatDock`'s
   * `useQueryClient()`, i.e. the active authority's — resolved when the
   * snapshot arrives, since neither that module nor this one is a hook.
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
  const replayId = options?.replayThreadId;
  if (replayId && !isReplayThread(replayId))
    throw new Error('Snapshot replay requires a registered replay thread');
  if (!replayId) backgroundTasksStore.reconcileSnapshot(payload);

  const snapshot = Object.fromEntries(
    Object.entries(activeChatsStore.getSnapshot()).filter(([id]) =>
      replayId ? id === replayId : !isReplayThread(id),
    ),
  );
  const { plan, openTurnChatKeys } = planSnapshot(payload, snapshot);
  const isReconnectFallback = options?.isReconnectFallback === true;
  // #2309: every row carries its conversation's activity. Feed the store
  // first, keyed by conversation, so liveness is the server's record for
  // every chat on the conversation whichever row speaks for it, and the
  // plan's writes below merge onto it. A replayed snapshot never feeds the
  // live store.
  if (!replayId) {
    for (const session of payload.sessions) {
      activeChatsStore.applyConversationActivity(session.conversationActivity);
    }
  }

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
            openTurnChatKeys.has(threadId),
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

  // #2456: the snapshot is the only thing a client that missed live deltas
  // hears about child work, so each row's `childWork` view reaches the chat
  // through the same reducer a live delta does. A replay never feeds it.
  // The live stream's snapshot is FULL (never thread-filtered), so a
  // recorded reporter it no longer lists is gone (D2).
  if (!replayId) {
    reconcileChildWorkSnapshot(payload.sessions);
    // A snapshot names its Station; one without (no caller today) folds into
    // no partition rather than a guessed one.
    if (options?.apiBase)
      childWorkGlobalStore.reconcileSnapshot(options.apiBase, payload.sessions);
  }

  if (!isReconnectFallback || !options || replayId) return;
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
