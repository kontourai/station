import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useAllActiveChats } from '../contexts/ActiveChatsContext';
import { type AgentData, useAgents } from '../contexts/AgentsContext';
import type { ChatUIState } from '../contexts/active-chats-state';
import { conversationsStore } from '../contexts/ConversationsContext';
import type { ChatSession } from '../types';
import { deriveLatestPlanArtifactFromMessages } from '../utils/planArtifacts';

type ConversationsSnapshot = ReturnType<typeof conversationsStore.getSnapshot>;
type ConversationMeta = ConversationsSnapshot['conversations'][string][number];

// A session with no stored conversations/backend messages yet would
// otherwise fall back to a fresh `[]` literal on every derive pass — a new
// reference every render defeats the per-session cache below exactly the
// same way a fresh object literal would (see relevantChatStateFieldsEqual).
const EMPTY_CONVERSATIONS_LIST: ConversationsSnapshot['conversations'][string] =
  [];
const EMPTY_BACKEND_MESSAGES: any[] = [];

/**
 * archive#1293: identity key for reconciling a locally-held (optimistic)
 * message against the backend transcript. Neither `ChatMessage` (client) nor
 * the backend's `MessageData` carries a stable server-assigned id, so
 * `(role, content)` is the best identity available — see the doc comment on
 * `dedupeOptimisticMessages` for why this beats the old count-based slice.
 */
function messageIdentityKey(message: { role: string; content: string }) {
  return `${message.role}:${message.content}`;
}

/**
 * Returns the entries of `localMessages` that are NOT already represented in
 * `backendMessages` — i.e. the genuinely optimistic tail still waiting on a
 * backend round-trip.
 *
 * archive#1293: the old implementation was
 * `chatState.messages.slice(backendMessages.length)` — pure position, no
 * identity. That silently breaks the moment `chatState.messages` and
 * `backendMessages` fall out of 1:1 lockstep: a client-only row with no
 * backend counterpart (an assistant error bubble `finalizeAssistantTurn`
 * appended, a slash-command echo, a queue-drain optimistic append) shifts
 * every message after it by one, so a real user message that HAS already
 * landed on the backend gets sliced into the "optimistic" bucket and
 * rendered a second time next to its own backend copy — the duplicate user
 * bubble from #1293's report.
 *
 * This walks `localMessages` in order and, for each one, checks it off
 * against a multiset of `(role, content)` pairs still available in
 * `backendMessages` — a message is only treated as "already on the backend"
 * once per matching backend row, so two genuinely repeated turns (the user
 * sending "hi" twice) are never conflated into one. Anything left over after
 * matching is the real optimistic remainder, appended after the backend
 * transcript below.
 */
export function dedupeOptimisticMessages(
  localMessages: any[],
  backendMessages: any[],
): any[] {
  const remainingBackendCounts = new Map<string, number>();
  for (const message of backendMessages) {
    const key = messageIdentityKey(message);
    remainingBackendCounts.set(key, (remainingBackendCounts.get(key) || 0) + 1);
  }

  const optimisticOnly: any[] = [];
  for (const message of localMessages) {
    const key = messageIdentityKey(message);
    const remaining = remainingBackendCounts.get(key) || 0;
    if (remaining > 0) {
      remainingBackendCounts.set(key, remaining - 1);
      continue;
    }
    optimisticOnly.push(message);
  }
  return optimisticOnly;
}

function buildSessionMessages(
  chatState: ChatUIState,
  backendMessages: any[],
  sessionStatus: string,
) {
  let messages: any[];
  if (
    sessionStatus === 'sending' &&
    chatState.messages &&
    chatState.messages.length > 0
  ) {
    messages = chatState.messages.map((message) => ({
      ...message,
      timestamp: message.timestamp || Date.now(),
      optimistic: true,
    }));
  } else {
    const effectiveBackend =
      backendMessages.length > 0 ? backendMessages : chatState.messages || [];
    const optimisticMessages = dedupeOptimisticMessages(
      chatState.messages || [],
      effectiveBackend,
    ).map((message) => ({
      ...message,
      timestamp: message.timestamp || Date.now(),
      optimistic: true,
    }));

    messages = [...effectiveBackend, ...optimisticMessages];
  }

  const messagesWithTimestamps = messages.map((message, index) => ({
    ...message,
    timestamp:
      message.timestamp || Date.now() - (messages.length - index) * 1000,
  }));

  // archive#1292: every entry in `ephemeralMessages` already carries
  // `ephemeral: true` (set once, by `createEphemeralMessageState` —
  // `addEphemeralMessage` is the only producer) and a real timestamp, so it
  // no longer needs tagging or normalizing here; it just joins the sorted
  // transcript.
  return [
    ...messagesWithTimestamps,
    ...(chatState.ephemeralMessages || []),
  ].sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
}

// Fields that change on every composer keystroke (or history-nav step) but
// never feed the derived ChatSession's transcript-relevant output — nothing
// downstream reads `.input`/`.inputHistory` off a *derived* session; live
// composer state comes from useChatInput's own selector
// (ActiveChatsContext.useActiveChatSelector). Excluding them from the
// per-session cache fingerprint below is what stops a keystroke in one tab
// from rebuilding every open tab's ChatSession + messages array
// (archive#726 — the primary ChatDock surface, not just ACPChatPanel).
// `attachments` is deliberately NOT excluded: ActiveWorkContextFrame reads
// it off the derived session, and it only changes on explicit add/remove,
// never per keystroke.
const FIELDS_EXCLUDED_FROM_FINGERPRINT = new Set<keyof ChatUIState>([
  'input',
  'inputHistory',
  'historyIndex',
  'savedInput',
  'streamingMessage',
]);

// `planArtifact` is deliberately NOT in FIELDS_EXCLUDED_FROM_FINGERPRINT: the
// derived session carries it, so a plan change must still produce a new
// session identity (the plan panel reads it off the derived session). But it
// is excluded from the transcript-rebuild comparison below — a plan-only
// change reuses the previously built messages array by reference instead of
// re-running buildSessionMessages (two spreads per message plus a sort) on
// every streamed token of a plan-like answer.
//
// Keeping that array reference stable is what stops a markdown re-parse of
// every mounted row, per token, on the ChatDock path. Not through
// buildSessionMessages itself -- its spread preserves each row's contentParts
// reference, and MessageContent's comparator keys on exactly that -- but
// through useActiveChatTranscript, which the dock renders from once an
// orchestration session is started. Its projection memo lists
// `session.messages` among its dependencies and rebuilds contentParts with a
// fresh.map per message, so a new messages array per token yields new part
// references, which miss MessageContent's memo. Downstream of that,
// ChatMessageList's transcriptRows memo (dep: `messages`) re-runs too.
const FIELDS_EXCLUDED_FROM_MESSAGES_REUSE = new Set<keyof ChatUIState>([
  'planArtifact',
]);

const EMPTY_KEY_SET = new Set<keyof ChatUIState>();

/**
 * True when every field of `a`/`b` relevant to `deriveSession`'s output is
 * equal by reference/value. `mergeChatUpdates` (active-chats-store) always
 * replaces the session's whole ChatUIState object on every updateChat —
 * but fields the update didn't touch keep their prior reference, so this
 * reliably distinguishes "session actually changed" from "the store handed
 * us a new wrapper object again."
 */
function relevantChatStateFieldsEqual(
  a: ChatUIState,
  b: ChatUIState,
  extraExcluded: Set<keyof ChatUIState> = EMPTY_KEY_SET,
): boolean {
  if (a === b) return true;
  const keys = new Set<keyof ChatUIState>([
    ...(Object.keys(a) as (keyof ChatUIState)[]),
    ...(Object.keys(b) as (keyof ChatUIState)[]),
  ]);
  for (const key of keys) {
    if (FIELDS_EXCLUDED_FROM_FINGERPRINT.has(key)) continue;
    if (extraExcluded.has(key)) continue;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

function deriveSession(
  chatId: string,
  chatState: ChatUIState,
  agent: AgentData | undefined,
  conversationMeta: ConversationMeta | undefined,
  backendMessages: any[],
  // When only `planArtifact` moved since the last derivation, the transcript
  // is unchanged (buildSessionMessages reads no plan-dependent field), so the
  // previously built array is passed back in by reference — a fresh build
  // would spend two spreads per message plus a sort per streamed token, and
  // mint new row identities that re-run ChatMessageList's transcriptRows
  // useMemo and useActiveChatTranscript's projection (which rebuilds each
  // row's contentParts, and so misses MessageContent's memo).
  //
  // NOT fixed by this: deriveSession still mints a new ChatSession per token
  // by design (rawText must advance for the plan panel), so ChatDock,
  // ChatMessageList and every MessageBubble still re-render per token. What
  // stops at the row is the markdown re-parse, not the render.
  reusedMessages?: any[],
): ChatSession {
  const sessionStatus = chatState.status || 'idle';
  const allMessages =
    reusedMessages ??
    buildSessionMessages(chatState, backendMessages, sessionStatus);
  const latestPlanArtifact =
    chatState.planArtifact ||
    deriveLatestPlanArtifactFromMessages(
      allMessages.filter((message) => !message.ephemeral) as any,
    );

  // Compute isThinking: sending but not actively processing a step
  const isThinking = sessionStatus === 'sending' && !chatState.isProcessingStep;

  // Derive agent name and title reactively
  const agentName = agent?.name || chatState.agentSlug || 'Unknown Agent';
  const title = conversationMeta?.title || chatState.title || 'New chat';

  return {
    id: chatId,
    conversationId: chatState.conversationId,
    agentSlug: agentId(chatState.agentSlug!),
    agentName,
    title,
    messages: allMessages,
    input: chatState.input || '',
    attachments: chatState.attachments || [],
    queuedMessages: chatState.queuedMessages || [],
    queuedMessageFailure: chatState.queuedMessageFailure,
    unsentMessages: chatState.unsentMessages,
    outboundQueuedTurns: chatState.outboundQueuedTurns || [],
    inputHistory: chatState.inputHistory || [],
    hasUnread: chatState.hasUnread || false,
    error: chatState.error,
    status: sessionStatus,
    isThinking,
    abortController: chatState.abortController,
    stopPending: chatState.stopPending,
    source: 'manual' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provider: chatState.provider,
    providerOptions: chatState.providerOptions,
    lastAppliedApprovalMode: chatState.lastAppliedApprovalMode,
    model: chatState.model,
    modelSource: chatState.modelSource,
    defaultModel: chatState.defaultModel,
    defaultModelSource: chatState.defaultModelSource,
    executionMode: chatState.executionMode,
    executionScope: chatState.executionScope,
    agentConnectionId: chatState.agentConnectionId
      ? engineConnectionId(chatState.agentConnectionId)
      : undefined,
    providerId: chatState.providerId,
    defaultProviderId: chatState.defaultProviderId,
    orchestrationProvider: chatState.orchestrationProvider,
    orchestrationModel: chatState.orchestrationModel,
    orchestrationStatus: chatState.orchestrationStatus,
    orchestrationSessionStarted: chatState.orchestrationSessionStarted,
    orchestrationTurnOpen: chatState.orchestrationTurnOpen,
    openTurnId: chatState.openTurnId,
    openTurnShellSuperseded: chatState.openTurnShellSuperseded,
    orchestrationHistoryRevision: chatState.orchestrationHistoryRevision,
    projectSlug: chatState.projectSlug,
    projectName: chatState.projectName,
    focusDirectoryId: chatState.focusDirectoryId,
    currentModeId: chatState.currentModeId,
    planArtifact: latestPlanArtifact,
    pendingApprovals: chatState.pendingApprovals,
    isProcessingStep: chatState.isProcessingStep,
    flowRun: chatState.flowRun,
    activityHint: chatState.activityHint,
    backgroundTasks: chatState.backgroundTasks,
    liveUsage: chatState.liveUsage,
  };
}

type SessionCacheEntry = {
  chatState: ChatUIState;
  agent: AgentData | undefined;
  conversationMeta: ConversationMeta | undefined;
  backendMessages: any[];
  derived: ChatSession;
};

// Hook to get all open tabs (with messages loaded from backend)
export function useDerivedSessions(
  _apiBase: string,
  agentSlug: string | null,
  projectSlug?: string | null,
): ChatSession[] {
  const agents = useAgents();
  const allChats = useAllActiveChats();

  // Subscribe to conversations store for messages
  const conversationsSnapshot = useSyncExternalStore(
    conversationsStore.subscribe,
    conversationsStore.getSnapshot,
    conversationsStore.getSnapshot,
  );

  // Persists across renders per hook instance/call site. active-chats-store.notify
  // replaces the *whole* `allChats` map object on every updateChat call,
  // for ANY session (see active-chats-store.ts), which would otherwise
  // force this hook's useMemo to rebuild every session's ChatSession +
  // messages array on every keystroke/streaming tick in any open tab. This
  // cache lets each session's derivation survive renders where nothing it
  // actually reads changed.
  const cacheRef = useRef<Map<string, SessionCacheEntry>>(new Map());
  const previousResultRef = useRef<ChatSession[]>([]);

  return useMemo(() => {
    const cache = cacheRef.current;
    const liveSessionIds = new Set<string>();
    const sessions: ChatSession[] = [];

    // Show all active chats (agentSlug filter is optional for ChatDock)
    for (const [chatId, chatState] of Object.entries(allChats)) {
      // If agentSlug is provided, filter by it (for workspace views)
      if (agentSlug && chatState.agentSlug !== agentSlug) continue;
      // If projectSlug is provided, filter by it
      if (projectSlug && chatState.projectSlug !== projectSlug) continue;

      liveSessionIds.add(chatId);

      const agent = agents.find((a) => a.slug === chatState.agentSlug);

      // Get conversation metadata for title
      const conversationsList =
        conversationsSnapshot.conversations[chatState.agentSlug!] ||
        EMPTY_CONVERSATIONS_LIST;
      const conversationMeta = conversationsList.find(
        (c) => c.id === chatState.conversationId,
      );

      // Get messages from backend
      const messagesKey = chatState.conversationId
        ? `messages:${chatState.agentSlug}:${chatState.conversationId}`
        : null;
      const backendMessages = chatState.orchestrationSessionStarted
        ? EMPTY_BACKEND_MESSAGES
        : messagesKey
          ? conversationsSnapshot.messages[messagesKey] ||
            EMPTY_BACKEND_MESSAGES
          : EMPTY_BACKEND_MESSAGES;

      const cached = cache.get(chatId);
      // Inputs outside ChatUIState — shared by the full-reuse check and the
      // plan-only reuse check below.
      const cacheInputsUnchanged =
        cached !== undefined &&
        cached.agent === agent &&
        cached.conversationMeta === conversationMeta &&
        cached.backendMessages === backendMessages;

      const canReuse =
        cacheInputsUnchanged &&
        relevantChatStateFieldsEqual(cached.chatState, chatState);

      if (cached && canReuse) {
        // Refresh the stored chatState reference (composer-only fields may
        // have moved) without rebuilding `derived` — this is the reuse path
        // that keeps session identity stable across unrelated keystrokes.
        cache.set(chatId, { ...cached, chatState });
        sessions.push(cached.derived);
        continue;
      }

      // Plan-only change: every field buildSessionMessages reads is still
      // reference-identical, so the cached messages array is reused while the
      // session itself is re-derived to carry the fresh planArtifact. Without
      // this branch, a plan-like streaming answer mints a new artifact object
      // per token, busting this cache and rebuilding the whole transcript.
      if (
        cacheInputsUnchanged &&
        relevantChatStateFieldsEqual(
          cached.chatState,
          chatState,
          FIELDS_EXCLUDED_FROM_MESSAGES_REUSE,
        )
      ) {
        const derived = deriveSession(
          chatId,
          chatState,
          agent,
          conversationMeta,
          backendMessages,
          cached.derived.messages,
        );
        cache.set(chatId, {
          chatState,
          agent,
          conversationMeta,
          backendMessages,
          derived,
        });
        sessions.push(derived);
        continue;
      }

      const derived = deriveSession(
        chatId,
        chatState,
        agent,
        conversationMeta,
        backendMessages,
      );
      cache.set(chatId, {
        chatState,
        agent,
        conversationMeta,
        backendMessages,
        derived,
      });
      sessions.push(derived);
    }

    // Drop cache entries for sessions that no longer exist (closed tabs) so
    // this map doesn't grow unbounded over a long-lived session.
    for (const key of cache.keys()) {
      if (!liveSessionIds.has(key)) cache.delete(key);
    }

    // Keep the top-level array identity stable too when every session in it
    // is reference-identical to last render's result — lets consumers that
    // depend on the whole `sessions` array (not just one session) skip work
    // as well.
    const previous = previousResultRef.current;
    const unchanged =
      previous.length === sessions.length &&
      previous.every((session, index) => session === sessions[index]);
    const result = unchanged ? previous : sessions;
    previousResultRef.current = result;
    return result;
  }, [agents, allChats, conversationsSnapshot, agentSlug, projectSlug]);
}

// Hook to get full session data for a specific conversation (with messages and UI state)
