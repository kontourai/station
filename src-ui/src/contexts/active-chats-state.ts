import type { ConversationHandoffProjection } from '@kontourai/station-contracts/orchestration';
import type {
  ApprovalMode,
  ProviderKind,
} from '@kontourai/station-contracts/provider';
import type { FlowRunFreshness } from '@kontourai/station-contracts/runtime-events';
import { type ExecutionMode } from '@kontourai/station-contracts/tool';
import type { TurnChangedFiles } from '@kontourai/station-contracts/turn-changed-files';
import type { UIBlock } from '@kontourai/station-contracts/ui-block';
import type {
  ComposerAttachmentStageSnapshot,
  FileAttachment,
  UnsentMessageRecord,
} from '../types';

export type { UnsentMessageRecord } from '../types';

import type { EffectiveModelSource } from '../utils/execution';
import type { PlanArtifact } from '../utils/planArtifacts';

export type ChatRole = 'user' | 'assistant' | 'system';

export type FlowRunBinding = {
  runId: string;
  definitionId: string;
  cwd?: string;
  resumed: boolean;
  /** The run's step at attach time (archive#189). */
  currentStep?: string;
  /**
   * What the run has evaluated, as the SERVER derived it: seeded from
   * `flow.run-attached` and replaced wholesale by each `flow.gate-verdict`
   * for this run. Never computed client-side — see `foldVerdictIntoBinding`.
   * Absent when the server did not report it; present-and-empty is the honest
   * "never evaluated" that the Flow-gated chip and transcript marker must
   * show instead of implying the binding alone means progress. It is
   * PERSISTED, so it must be kept current — a stale attach snapshot would
   * outlive the evaluation it describes and survive a reload.
   */
  freshness?: FlowRunFreshness;
};

export type FlowGateVerdictInfo = {
  runId: string;
  verdict: 'pass' | 'route-back' | 'block' | 'wait';
  gateId?: string;
  summary?: string;
  nextAction?: string;
  routeBackTo?: string;
  attempt?: number;
  maxAttempts?: number;
  missing?: string[];
  reportPaths?: { json: string; markdown: string };
  exceptionRequired?: boolean;
};

export type ChatContentPart = {
  type:
    | 'text'
    | 'reasoning'
    | 'image'
    | 'tool-invocation'
    | 'file'
    | 'ui-block'
    | 'flow-run-attached'
    | 'flow-gate-verdict'
    // Persisted SDK refresh parts arrive as `tool-<toolName>`.
    | (string & {});
  content?: string;
  url?: string;
  /** See `MessagePart.blobRef` — the bytes are fetched, not inline. */
  blobRef?: string;
  image?: string;
  mediaType?: string;
  name?: string;
  uiBlock?: UIBlock;
  toolCallId?: string;
  /** Durable terminal result event; absent on a non-terminal tool part. */
  sourceEventId?: string;
  // Flat `tool-invocation` tool-part fields — the single chat tool vocabulary.
  toolName?: string;
  server?: string;
  originalName?: string;
  args?: any;
  input?: any;
  result?: any;
  output?: any;
  error?: string;
  errorText?: string;
  state?: string;
  isError?: boolean;
  needsApproval?: boolean;
  approvalId?: string;
  cancelled?: boolean;
  approvalStatus?:
    | 'auto-approved'
    | 'user-approved'
    | 'user-denied'
    | 'policy-denied';
  activityAt?: string;
  progressMessage?: string;
  /** Station narrowed engine-supplied tool material before this projection. */
  outputTruncated?: true;
  flowRunAttached?: FlowRunBinding;
  flowGateVerdict?: FlowGateVerdictInfo;
  conversationHandoff?: ConversationHandoffProjection;
};

export type ChatMessage = {
  /** Stable server/event identity when the producer provides one. */
  id?: string;
  role: ChatRole;
  content: string;
  attachments?: any[];
  contentParts?: ChatContentPart[];
  traceId?: string;
  timestamp?: number;
  model?: string;
  modelOptions?: Record<string, string | number | boolean>;
  /**
   * archive#1293: a stable, client-minted id assigned to an optimistically
   * appended user message (`buildOutgoingUserMessage`) so a rejected send's
   * rollback (`rejectedSendRollback`) can remove exactly that entry by id
   * rather than by array-reference identity, which silently no-ops once any
   * intervening `updateChat` (turn finalize, rehydrate, …) has replaced the
   * array. Client-only bookkeeping — never sent to or read from the server.
   */
  clientId?: string;
  /** Durable event identity on a rehydrated authored user row, never optimistic. */
  sourceEventId?: string;
  /** archive#1410: the canonical turn this assistant row projects, when known. */
  turnId?: string;
  /** Execution Session that produced this historical assistant row. */
  sessionId?: string;
  /** True only when Station observed this row settle as a normal completion. */
  answerEligible?: boolean;
  /**
   * archive#1410: the turn's provenance envelope exactly as the server sent
   * it. Untyped on purpose — the render boundary narrows it through
   * `isSupportedTurnProvenanceEnvelope`, so an envelope from a different
   * Station version degrades honestly instead of being partially read.
   */
  provenance?: unknown;
  changedFiles?: TurnChangedFiles;
};

export type EphemeralMessage = ChatMessage & {
  action?: { label: string; handler: () => void };
  terminalSession?: boolean;
  id?: string;
  timestamp?: number;
  /** archive#1292: the one flag every ephemeral-notice reader checks. Always
   * set by `createEphemeralMessageState` — every producer goes through
   * `addEphemeralMessage` so this (and `id`/`timestamp`) is never missing. */
  ephemeral?: boolean;
};

export type ToolCallState = {
  id: string;
  name: string;
  args: any;
  result?: any;
  state?: string;
  error?: string;
};

export type StreamingMessage = {
  role: 'assistant';
  content: string;
  contentParts?: ChatContentPart[];
};

/**
 * Transient "what is the agent doing right now" hint for the streaming
 * indicator, fed by provider extension notifications (e.g. Claude Code's
 * `thinking/tokens` during the redacted-thinking phase, when no content
 * deltas flow at all). Cleared as soon as real content arrives and on turn
 * finalize/abort. Never persisted.
 */
export type ChatActivityHint = {
  kind: 'thinking' | 'compacting' | 'requesting';
  detail?: string;
};

/**
 * A provider-reported background task/subagent that outlives the assistant
 * turn (e.g. Claude Code backgrounded Task). Drives the persistent
 * "background agent working" affordance while the session is otherwise
 * idle. Sourced from `claude-code` `task/registry` notifications and
 * cleared by `task/settled`.
 */
export type ChatBackgroundTask = {
  taskId: string;
  toolCallId?: string;
  description?: string;
  subagentType?: string;
  backgrounded?: boolean;
};

/**
 * Raw numbers off the most recent `token-usage.updated` event for this
 * thread (archive#1299). Deliberately NOT reconciled into a
 * running session total here — the server-side fold
 * (`@kontourai/station-shared/usage-fold`) already handles the fact that
 * different engines report this event differently (Claude Code: a
 * per-turn delta; Codex: a cumulative running total — see
 * `foldUsageEvents`'s `CUMULATIVE_USAGE_PROVIDERS` docblock), and
 * reproducing that distinction client-side for a live, in-flight glimpse
 * is not worth the duplication. The authoritative post-turn number still
 * comes from the stats route (`ContextPercentage`'s refetch on
 * `messageCount` change) — this is a minimal, best-effort mirror for a
 * future live indicator, not itself wired into one yet.
 */
export type ChatLiveUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextTokens?: number;
  contextWindowTokens?: number;
};

export type ChatUIState = {
  input: string;
  attachments: FileAttachment[];
  /** Byte-free attachment supervision projection, safe across reload/reconnect. */
  attachmentStages?: ComposerAttachmentStageSnapshot[];
  queuedMessages: string[];
  /** Durable offline turns, projected from IndexedDB after every app launch. */
  outboundQueuedTurns?: Array<{
    clientTurnId: string;
    content: string;
    attachments?: FileAttachment[];
    createdAt: number;
    status: 'pending' | 'invoking' | 'accepted' | 'failed' | 'may-have-started';
    lastError?: string;
    /** Preserved by the durable queue projection for pre-send merge undo. */
    mergedTurns?: Array<{ content: string }>;
  }>;
  inputHistory: string[];
  historyIndex?: number;
  savedInput?: string;
  /**
   * archive#1795: epoch ms this chat was created, stamped once by
   * `createDefaultChatState` at `initChat` time and never updated afterward
   * a stable creation floor, not a live "now" that would re-inflate on
   * every render (that was archive#1311's bug, fixed elsewhere by anchoring
   * on a real server `updatedAt` instead of `Date.now` at read time; see
   * `useActiveChatSessions.helpers.ts`). `latestChatTimestamp`
   * (`home-view-model.ts`) seeds its reduce over `messages`/
   * `ephemeralMessages` with this instead of a literal `0`: a chat with no
   * messages yet has neither array populated, so the reduce used to bottom
   * out at its seed and epoch-0 flowed into both the recency sort and the
   * inbox bucket split, rendering as "Earlier" stamped "20668d" (days since
   * 1970). A chat that exists has an age, and it is not 56 years.
   */
  createdAt?: number;
  /**
   * archive#1224 (offline): `'queued'` means this session's latest
   * turn is sitting in the persisted outbound queue waiting for
   * reconnect — the composer stays usable (unlike `'sending'`) and the
   * turn's own pending state renders via its ephemeral system notice.
   */
  status?: 'idle' | 'sending' | 'error' | 'queued';
  isProcessingStep?: boolean;
  error?: string | null;
  hasUnread: boolean;
  abortController?: AbortController;
  /**
   * a Stop request is in flight for this session. Set before the
   * interrupt is dispatched and cleared in the `finally` that releases the
   * local stream, so the composer can disable Stop (no second command, no
   * second receipt) and show the indeterminate "Stop requested — waiting for
   * the engine" state instead of an instant claim. Session-scoped
   * bookkeeping, deliberately NOT persisted: a request in flight cannot
   * survive the page that issued it, and a restored `true` would be a
   * pending state with nothing pending behind it.
   */
  stopPending?: boolean;
  /**
   * review: the per-turn idempotency key of a dispatch that has
   * been sent but whose `turn.started` has not arrived yet. Stop sends it with
   * the interrupt so a cancel the server has to hold (the engine session does
   * not exist yet) is bound to the turn THAT dispatch produces, instead of
   * staying armed on the thread and interrupting whatever starts next.
   * Session-scoped and not persisted — a dispatch cannot outlive its page.
   */
  pendingClientTurnId?: string;
  agentSlug?: string;
  agentName?: string;
  title?: string;
  conversationId?: string;
  /**
   * Replaceable execution-session identity for the next live command. The
   * store key and `conversationId` remain the durable, human-visible
   * conversation identity; this only routes session-keyed SSE, approvals and
   * interrupts after a continuation creates a child session.
   */
  currentSessionId?: string;
  projectSlug?: string;
  projectName?: string;
  focusDirectoryId?: string;
  executionMode?: ExecutionMode;
  executionScope?: 'project' | 'global';
  agentConnectionId?: string;
  providerId?: string;
  defaultProviderId?: string;
  provider?: ProviderKind;
  providerOptions?: Record<string, unknown>;
  /**
   * The approval posture the adapter last confirmed as actually applied
   * (from `session.configured` at start, then refreshed by every
   * `turn.started`'s metadata). Not persisted — deliberately ephemeral,
   * re-derived fresh from the next server event on reconnect
   * (archive#727). Used only to detect "an escalation to `never` was
   * confirmed client-side but not yet applied server-side" so the composer
   * chip can show a pending state instead of overclaiming.
   */
  lastAppliedApprovalMode?: ApprovalMode;
  orchestrationSessionStarted?: boolean;
  orchestrationProvider?: ProviderKind;
  orchestrationModel?: string;
  orchestrationStatus?: string;
  /**
   * Client mirror of the server's turn-level fold (archive#761): true from
   * turn.started until a terminal turn event (turn.completed/turn.aborted/
   * runtime.error/session.exited); reseeded from the snapshot's
   * hasActiveTurn on reconnect. The authority for "is a turn open" — UI
   * `status` is not (it drops to 'idle' during an in-turn approval), which
   * is why archive#1076's live-status guard reads this instead.
   */
  orchestrationTurnOpen?: boolean;
  /**
   * archive#1410: the turn id of the currently-open turn, stamped by
   * `turn.started`. Exists so a terminal event can be checked against the
   * turn whose text is actually buffered in `streamingMessage` — adapters do
   * emit a terminal for an EARLIER turn after the next one has begun
   * streaming, and attaching that turn's provenance to this turn's bubble
   * would report the wrong engine, model, tools, and usage with full
   * confidence. Mirrors the server-side projection's own identity guard
   * (`runtime-event-projection.ts`'s `adoptTerminalIdentity`), so the live
   * render and a later reload agree.
   *
   * Session-scoped bookkeeping, deliberately NOT persisted: a reload
   * rehydrates the transcript from the server, where the same guard has
   * already been applied.
   */
  openTurnId?: string;
  /**
   * archive#3352: `true` once the local streaming shell has STOPPED being the
   * authority for `openTurnId`'s content, because a reconnect-fallback
   * snapshot refetched that turn from the bounded window instead
   * (`applyOrchestrationSnapshot`). The shell only ever holds what arrived on
   * THIS connection, so after a missed-event gap it is the less complete of
   * the two copies; `useActiveChatTranscript`'s open-turn suppression (which
   * exists so the shell and the projection do not both render the same turn)
   * has to reverse for exactly that turn or the refetched text is fetched and
   * then discarded. Cleared by `turn.started`, which opens a turn the shell
   * does own from its first token; inert once `orchestrationTurnOpen` goes
   * false, since the suppression it disables is gated on that too.
   *
   * Session-scoped bookkeeping, deliberately NOT persisted (the persistence
   * allow-list below never reads it), exactly like `openTurnId`.
   */
  openTurnShellSuperseded?: boolean;
  orchestrationHistoryRevision?: number;
  messages?: ChatMessage[];
  ephemeralMessages?: EphemeralMessage[];
  toolCalls?: ToolCallState[];
  streamingMessage?: StreamingMessage;
  model?: string;
  modelSource?: EffectiveModelSource;
  /**
   * Picker-owned request; server events exclusively own the reported `model`.
   * `undefined` means no outstanding picker request, a string is a requested
   * override, and `null` is an explicit request to use the engine default.
   */
  requestedModel?: string | null;
  requestedModelSource?: EffectiveModelSource;
  requestedProviderOptions?: Record<string, unknown>;
  defaultModel?: string;
  defaultModelSource?: EffectiveModelSource;
  sessionAutoApprove?: string[];
  pendingApprovals?: string[];
  approvalToasts?: Map<string, string>;
  /**
   * why the last drain of `queuedMessages` failed, kept as a
   * durable field rather than only as an ephemeral notice. The retained text
   * survived a reload only if the queue did, and the REASON did not survive at
   * all (ephemeral notices are deliberately never persisted, archive#1292), so
   * a user who reloaded found their follow-up either gone or sitting in the
   * queue with no explanation and no way to act on it.
   */
  queuedMessageFailure?: {
    message: string;
    /** The server's own refusal code, when it supplied one. */
    code?: string;
    at: number;
  };
  /**
   * archive#3706: a queued follow-up the drain permanently REFUSED — dropped
   * from `queuedMessages`, its optimistic bubble rolled back. Before this
   * field, the only surviving copy of the user's text was the ephemeral
   * notice's echo, and ephemeral notices are deliberately never persisted
   * (archive#1292) — so a reload before the user copied it lost text the
   * notice had explicitly offered back. Same principle as
   * `queuedMessages`: user-authored content Station held on their behalf, so
   * losing it on reload is data loss, not state cleanup.
   *
   * NOT a queue: nothing drains it, nothing retries it (the refusal is
   * permanent for this conversation), and it never marks the chat failed.
   * Rows leave only by the user's own dismiss.
   */
  unsentMessages?: UnsentMessageRecord[];
  isEditingQueue?: boolean;
  currentModeId?: string | null;
  planArtifact?: PlanArtifact | null;
  flowRun?: FlowRunBinding | null;
  activityHint?: ChatActivityHint;
  backgroundTasks?: ChatBackgroundTask[];
  liveUsage?: ChatLiveUsage;
};

export type ActiveChatsMap = Record<string, ChatUIState>;

export type ActiveChatMetadata = {
  agentSlug: string;
  agentName: string;
  title: string;
  conversationId?: string;
  currentSessionId?: string;
  projectSlug?: string;
  projectName?: string;
  executionMode?: ExecutionMode;
  executionScope?: 'project' | 'global';
  agentConnectionId?: string;
  providerId?: string;
  defaultProviderId?: string;
  provider?: ProviderKind;
  model?: string;
  modelSource?: EffectiveModelSource;
  requestedModel?: string | null;
  requestedModelSource?: EffectiveModelSource;
  requestedProviderOptions?: Record<string, unknown>;
  defaultModel?: string;
  defaultModelSource?: EffectiveModelSource;
  providerOptions?: Record<string, unknown>;
  orchestrationSessionStarted?: boolean;
  currentModeId?: string | null;
  planArtifact?: PlanArtifact | null;
};

export type PersistedActiveChat = {
  sessionId: string;
  /**
   * Absent for a chat persisted ONLY because it holds unsent records
   * (archive#3706): a drop can land while a new chat is still awaiting
   * conversation promotion, and filtering those chats out of serialization
   * silently destroyed the record's one durable copy.
   */
  conversationId?: string;
  agentSlug: string;
  /** archive#1795: carried through reload so a rehydrated chat keeps its
   * real creation floor instead of losing it (and falling back to the
   * `latestChatTimestamp` 0-seed) the moment `hydrateActiveChats` runs. */
  createdAt?: number;
  /** archive#1566: the (user-set or auto-generated) conversation title, so
   * it survives a reload instead of showing the default until the next
   * conversation-list fetch resolves. */
  title?: string;
  model?: string;
  modelSource?: EffectiveModelSource;
  requestedModel?: string | null;
  requestedModelSource?: EffectiveModelSource;
  requestedProviderOptions?: Record<string, unknown>;
  defaultModel?: string;
  defaultModelSource?: EffectiveModelSource;
  projectSlug?: string;
  projectName?: string;
  executionMode?: ExecutionMode;
  executionScope?: 'project' | 'global';
  agentConnectionId?: string;
  providerId?: string;
  defaultProviderId?: string;
  provider?: ProviderKind;
  providerOptions?: Record<string, unknown>;
  orchestrationSessionStarted?: boolean;
  orchestrationProvider?: ProviderKind;
  orchestrationModel?: string;
  orchestrationStatus?: string;
  orchestrationTurnOpen?: boolean;
  sessionAutoApprove?: string[];
  // archive#1292: ephemeral notices are deliberately NOT persisted — they're
  // transient turn-completion/error/offline state, not durable transcript
  // content, and persisting them let a stale one survive reload and
  // reappear next to the rehydrated durable `[CHAT_ERROR]` block. There is
  // no `ephemeralMessages` field here any more; `hydrateActiveChats` always
  // starts a rehydrated session with an empty array, including for legacy
  // sessionStorage payloads that still carry the old field.
  inputHistory?: string[];
  /**
   * a follow-up the user typed and Station accepted into the
   * queue is user-authored content that Station is holding on their behalf —
   * losing it on reload is data loss, not state cleanup. Persisted with the
   * reason the last drain failed so the queue can explain itself and offer a
   * retry after a reload. Deliberately unlike `ephemeralMessages`
   * (archive#1292): those are transient notices ABOUT a turn, this is the
   * turn the user is still waiting to send.
   */
  queuedMessages?: string[];
  queuedMessageFailure?: {
    message: string;
    code?: string;
    at: number;
  };
  /** archive#3706 — see ChatUIState.unsentMessages. */
  unsentMessages?: UnsentMessageRecord[];
  currentModeId?: string | null;
  planArtifact?: PlanArtifact | null;
  flowRun?: FlowRunBinding | null;
  /** Never contains File bytes or upload grants. */
  attachmentStages?: ComposerAttachmentStageSnapshot[];
};

export type BackendTimestampMessage = {
  timestamp?: string | number | Date;
};

export type ActiveChatsStoreOptions = {
  storageKey?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  getBackendMessages?: (
    agentSlug: string,
    conversationId: string,
  ) => BackendTimestampMessage[];
  now?: () => number;
  randomId?: () => string;
};

export function defaultBackendMessages(): BackendTimestampMessage[] {
  return [];
}

function readTimestamp(value: BackendTimestampMessage['timestamp']): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return new Date(value).getTime();
  }
  return 0;
}

/**
 * Is a turn in flight for this chat?
 *
 * (live verification): the composer gated Stop on
 * `abortController`, which the send path clears the moment the orchestration
 * POST returns its receipt — seconds BEFORE the engine's provider session even
 * exists, and long before the turn it started finishes streaming. Stop was
 * therefore offered for the first few seconds of a turn and absent for the
 * rest of it, which is the whole of the time a user actually wants it.
 *
 * The three signals below are the three ways this client knows a turn is
 * outstanding, and every consumer (composer control, cancel hook, ctrl-c
 * shortcut) reads this one derivation:
 * - `abortController` — an HTTP stream this browser is still holding.
 * - `status === 'sending'` — a dispatch this composer made and no terminal
 *   turn event has closed (`turnHandlers` returns it to `idle`).
 * - `orchestrationTurnOpen` — the client mirror of the SERVER's own turn fold,
 *   which also covers a turn started elsewhere and observed here.
 */
export function isTurnInFlight(
  chat:
    | Pick<ChatUIState, 'abortController' | 'status' | 'orchestrationTurnOpen'>
    | null
    | undefined,
): boolean {
  if (!chat) return false;
  return (
    !!chat.abortController ||
    chat.status === 'sending' ||
    !!chat.orchestrationTurnOpen
  );
}

export function createDefaultChatState(
  metadata?: ActiveChatMetadata,
  /**
   * archive#1795: the chat's creation time, stamped by the caller (the
   * store's own `this.now`) so it is real, testable, and never
   * `Date.now` read again later (that would reinflate recency on every
   * render — see the `ChatUIState.createdAt` doc comment). Defaults to
   * `Date.now` for the handful of direct callers (tests, mostly) that
   * don't thread a clock through.
   */
  createdAt: number = Date.now(),
): ChatUIState {
  return {
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    hasUnread: false,
    providerOptions: {},
    orchestrationSessionStarted: false,
    createdAt,
    ...metadata,
  };
}

export function hydrateActiveChats(
  sessions: PersistedActiveChat[],
): ActiveChatsMap {
  const chats: ActiveChatsMap = {};
  for (const session of sessions) {
    chats[session.sessionId] = {
      input: '',
      attachments: [],
      attachmentStages: session.attachmentStages || [],
      queuedMessages: session.queuedMessages || [],
      ...(session.queuedMessageFailure
        ? { queuedMessageFailure: session.queuedMessageFailure }
        : {}),
      ...(session.unsentMessages?.length
        ? { unsentMessages: session.unsentMessages }
        : {}),
      inputHistory: session.inputHistory || [],
      hasUnread: false,
      agentSlug: session.agentSlug,
      conversationId: session.conversationId,
      createdAt: session.createdAt,
      title: session.title,
      model: session.model,
      modelSource: session.modelSource,
      requestedModel: session.requestedModel,
      requestedModelSource: session.requestedModelSource,
      requestedProviderOptions: session.requestedProviderOptions,
      defaultModel: session.defaultModel,
      defaultModelSource: session.defaultModelSource,
      projectSlug: session.projectSlug,
      projectName: session.projectName,
      executionMode: session.executionMode,
      executionScope: session.executionScope,
      agentConnectionId: session.agentConnectionId,
      providerId: session.providerId,
      defaultProviderId: session.defaultProviderId,
      provider: session.provider,
      providerOptions: session.providerOptions || {},
      orchestrationSessionStarted: session.orchestrationSessionStarted || false,
      orchestrationProvider: session.orchestrationProvider,
      orchestrationModel: session.orchestrationModel,
      // archive#3300: never resurrect a LIVE status claim from storage. The
      // fields that could re-derive it (`orchestrationTurnOpen`, `status`,
      // `streamingMessage`, `openTurnId`) are deliberately not persisted, so
      // a restored 'running'/'awaiting-approval' is a label nothing can
      // verify — and for a turn that settled while the app was hidden it
      // rendered "Working…" under the settled answer. Settled statuses are
      // facts about the past and survive; the SSE snapshot/state-changed
      // sync supplies the live truth after connect.
      orchestrationStatus:
        session.orchestrationStatus === 'running' ||
        session.orchestrationStatus === 'awaiting-approval'
          ? undefined
          : session.orchestrationStatus,
      sessionAutoApprove: session.sessionAutoApprove || [],
      // archive#1292: never read a persisted value here (even from an old
      // payload that still has the field) — a rehydrated session always
      // starts with no ephemeral notices.
      ephemeralMessages: [],
      currentModeId: session.currentModeId,
      planArtifact: session.planArtifact || null,
      flowRun: session.flowRun || null,
    };
  }
  return chats;
}

/**
 * The one derivation of a chat's DURABLE IDENTITY — the id it is addressable
 * by after a reload, and the id `?chat=` carries (archive#3782/archive#3765).
 *
 * A chat is promoted to a conversation by its first successful turn
 * (`useActiveChatSessionMessaging`'s success path assigns the receipt's
 * `conversationId`), and `serializeActiveChats` below persists exactly the
 * chats that reached that point. Until then the session id is the only handle
 * anything has on it, and it is the id `useChatDockActiveChatSync` matches on
 * (`session.conversationId === activeChat || session.id === activeChat`), so
 * both halves resolve to the same chat.
 *
 * What this exists to prevent is the third answer: `null`. Two dock call sites
 * used to read the conversation id and fall back to clearing the URL pointer,
 * which erases a restorable id at the exact moment the chat is being focused
 * or migrated — the observable half of archive#3765 ("the dock reopens with No active
 * session").
 */
export function activeChatDurableId(
  sessionId: string,
  chat: { conversationId?: string } | undefined,
): string {
  return chat?.conversationId ? chat.conversationId : sessionId;
}

export function serializeActiveChats(
  chats: ActiveChatsMap,
): PersistedActiveChat[] {
  return (
    Object.entries(chats)
      // A chat holding unsent records is persisted even before conversation
      // promotion — the record's only durable copy must not depend on timing
      // (archive#3706).
      .filter(([, chat]) => chat.conversationId || chat.unsentMessages?.length)
      .map(([sessionId, chat]) => ({
        sessionId,
        conversationId: chat.conversationId,
        agentSlug: chat.agentSlug!,
        queuedMessages: chat.queuedMessages || [],
        ...(chat.queuedMessageFailure
          ? { queuedMessageFailure: chat.queuedMessageFailure }
          : {}),
        ...(chat.unsentMessages?.length
          ? { unsentMessages: chat.unsentMessages }
          : {}),
        createdAt: chat.createdAt,
        title: chat.title,
        model: chat.model,
        modelSource: chat.modelSource,
        requestedModel: chat.requestedModel,
        requestedModelSource: chat.requestedModelSource,
        requestedProviderOptions: chat.requestedProviderOptions,
        defaultModel: chat.defaultModel,
        defaultModelSource: chat.defaultModelSource,
        projectSlug: chat.projectSlug,
        projectName: chat.projectName,
        executionMode: chat.executionMode,
        executionScope: chat.executionScope,
        agentConnectionId: chat.agentConnectionId,
        providerId: chat.providerId,
        defaultProviderId: chat.defaultProviderId,
        provider: chat.provider,
        providerOptions: chat.providerOptions || {},
        orchestrationSessionStarted: chat.orchestrationSessionStarted || false,
        orchestrationProvider: chat.orchestrationProvider,
        orchestrationModel: chat.orchestrationModel,
        orchestrationStatus: chat.orchestrationStatus,
        sessionAutoApprove: chat.sessionAutoApprove || [],
        // archive#1292: ephemeral notices are intentionally excluded from the
        // persisted shape — see the doc comment on PersistedActiveChat.
        inputHistory: chat.inputHistory || [],
        currentModeId: chat.currentModeId,
        planArtifact: chat.planArtifact || null,
        flowRun: chat.flowRun || null,
        attachmentStages: chat.attachmentStages || [],
      }))
  );
}

/**
 * The most queued follow-ups one chat retains, and the most bytes of them.
 *
 * review: the queue became persisted content, and persisted
 * content in `sessionStorage` needs a ceiling — the store shares one quota
 * with every other chat, and a quota failure is silent at the point where the
 * user believes their text is safe. Bounded oldest-first, with the drop
 * reported (see `boundQueuedMessages`); a ceiling that discards without
 * saying so would be exactly the kind of silent loss this lane exists to
 * remove.
 */
export const QUEUED_MESSAGES_MAX_COUNT = 50;
export const QUEUED_MESSAGES_MAX_BYTES = 64 * 1024;

/**
 * Applies those ceilings, dropping from the FRONT (the oldest, next-to-drain
 * end) — the newest follow-up is the one the user just typed and is watching.
 * Returns the entries removed so the caller can say what happened.
 */
export function boundQueuedMessages(queued: readonly string[]): {
  kept: string[];
  dropped: string[];
} {
  const kept = [...queued];
  const dropped: string[] = [];
  while (kept.length > QUEUED_MESSAGES_MAX_COUNT) {
    dropped.push(kept.shift() as string);
  }
  const size = (entries: readonly string[]) =>
    entries.reduce((total, entry) => total + entry.length * 2, 0);
  while (kept.length > 1 && size(kept) > QUEUED_MESSAGES_MAX_BYTES) {
    dropped.push(kept.shift() as string);
  }
  return { kept, dropped };
}

export function mergeChatUpdates(
  current: ChatUIState,
  updates: Partial<ChatUIState>,
): {
  chat: ChatUIState;
  shouldPersist: boolean;
  /**
   * Queued follow-ups this update pushed past the ceiling. The store turns a
   * non-empty list into a visible notice; nothing is dropped silently.
   */
  droppedQueuedMessages: string[];
} {
  const nextUpdates =
    'input' in updates && !('historyIndex' in updates)
      ? { ...updates, historyIndex: -1 }
      : updates;
  const bounded =
    nextUpdates.queuedMessages !== undefined
      ? boundQueuedMessages(nextUpdates.queuedMessages)
      : { kept: undefined, dropped: [] as string[] };
  const chat = {
    ...current,
    ...nextUpdates,
    ...(bounded.kept ? { queuedMessages: bounded.kept } : {}),
  };
  const shouldPersist =
    'conversationId' in nextUpdates ||
    'title' in nextUpdates ||
    'executionMode' in nextUpdates ||
    'executionScope' in nextUpdates ||
    'agentConnectionId' in nextUpdates ||
    'providerId' in nextUpdates ||
    'defaultProviderId' in nextUpdates ||
    'model' in nextUpdates ||
    'modelSource' in nextUpdates ||
    'requestedModel' in nextUpdates ||
    'requestedModelSource' in nextUpdates ||
    'requestedProviderOptions' in nextUpdates ||
    'defaultModel' in nextUpdates ||
    'defaultModelSource' in nextUpdates ||
    'provider' in nextUpdates ||
    'providerOptions' in nextUpdates ||
    'orchestrationSessionStarted' in nextUpdates ||
    'sessionAutoApprove' in nextUpdates ||
    // archive#1292: ephemeralMessages is deliberately excluded — it is never
    // part of the persisted shape (see PersistedActiveChat), so scheduling a
    // debounced sessionStorage write whenever a notice appears/dismisses
    // would just be wasted work.
    'currentModeId' in nextUpdates ||
    'planArtifact' in nextUpdates ||
    // review : both of these ARE part of the persisted
    // shape (`serializeActiveChats`), and leaving them out of this decision
    // is why enqueueing a follow-up, or recording the reason a drain refused
    // one, called `notify(false)` and scheduled no write at all. Reload
    // survival then depended on some unrelated persistent update happening to
    // fire before the tab went away — which is not retention, it is luck.
    'queuedMessages' in nextUpdates ||
    'queuedMessageFailure' in nextUpdates ||
    // archive#3706: this field IS part of the persisted
    // shape, and a Dismiss writes ONLY it — without this line the dismiss
    // scheduled no storage write, so a dismissed row resurrected on reload.
    // The exact failure the comment above describes: not retention, luck.
    'unsentMessages' in nextUpdates ||
    'flowRun' in nextUpdates ||
    'attachmentStages' in nextUpdates;
  return { chat, shouldPersist, droppedQueuedMessages: bounded.dropped };
}

export function clearInputState(chat: ChatUIState): ChatUIState {
  return {
    ...chat,
    input: '',
    attachments: [],
  };
}

export function appendInputHistory(
  chat: ChatUIState,
  input: string,
): ChatUIState {
  return {
    ...chat,
    inputHistory: [...(chat.inputHistory || []), input],
    historyIndex: -1,
    savedInput: undefined,
  };
}

export function navigateHistoryUpState(chat: ChatUIState): ChatUIState | null {
  const history = chat.inputHistory || [];
  if (history.length === 0) {
    return null;
  }
  const currentIndex = chat.historyIndex ?? -1;
  if (currentIndex === -1) {
    return {
      ...chat,
      input: history[history.length - 1],
      historyIndex: history.length - 1,
      savedInput: chat.input || '',
    };
  }
  if (currentIndex === 0) {
    return null;
  }
  return {
    ...chat,
    input: history[currentIndex - 1],
    historyIndex: currentIndex - 1,
  };
}

export function navigateHistoryDownState(
  chat: ChatUIState,
): ChatUIState | null {
  const currentIndex = chat.historyIndex ?? -1;
  if (currentIndex === -1) {
    return null;
  }
  const history = chat.inputHistory || [];
  const nextIndex = currentIndex + 1;
  if (nextIndex >= history.length) {
    return {
      ...chat,
      input: chat.savedInput || '',
      historyIndex: -1,
      savedInput: undefined,
    };
  }
  return {
    ...chat,
    input: history[nextIndex],
    historyIndex: nextIndex,
  };
}

export function clearEphemeralMessagesState(chat: ChatUIState): ChatUIState {
  return {
    ...chat,
    ephemeralMessages: [],
  };
}

export function assignConversationIdState(
  chat: ChatUIState,
  conversationId: string,
): ChatUIState {
  return {
    ...chat,
    conversationId,
  };
}

export function removeQueuedMessageState(
  chat: ChatUIState,
  index: number,
): ChatUIState {
  const queuedMessages = [...(chat.queuedMessages || [])];
  queuedMessages.splice(index, 1);
  return {
    ...chat,
    queuedMessages,
  };
}

export function editQueuedMessageState(
  chat: ChatUIState,
  index: number,
  newContent: string,
): ChatUIState {
  const queuedMessages = [...(chat.queuedMessages || [])];
  queuedMessages[index] = newContent;
  return {
    ...chat,
    queuedMessages,
  };
}

/**
 * Moves a queued message from `fromIndex` to `toIndex` (used by the ▲/▼
 * reorder buttons — see QueuedMessages.tsx). `toIndex` is clamped into the
 * valid range; an out-of-range `fromIndex` or a clamped move that resolves
 * to the same position is a no-op that returns the identical `chat` object
 * (siblings like removeQueuedMessageState always return a new object —
 * this one deliberately doesn't, so callers can skip a re-render/notify
 * when nothing actually moved).
 */
export function reorderQueuedMessageState(
  chat: ChatUIState,
  fromIndex: number,
  toIndex: number,
): ChatUIState {
  const queuedMessages = chat.queuedMessages || [];
  const length = queuedMessages.length;
  if (fromIndex < 0 || fromIndex >= length) {
    return chat;
  }
  const clampedToIndex = Math.max(0, Math.min(toIndex, length - 1));
  if (clampedToIndex === fromIndex) {
    return chat;
  }
  const nextQueuedMessages = [...queuedMessages];
  const [moved] = nextQueuedMessages.splice(fromIndex, 1);
  nextQueuedMessages.splice(clampedToIndex, 0, moved);
  return {
    ...chat,
    queuedMessages: nextQueuedMessages,
  };
}

export function clearQueueState(chat: ChatUIState): ChatUIState {
  return {
    ...chat,
    queuedMessages: [],
  };
}

export function createEphemeralMessageState(
  chat: ChatUIState,
  message: {
    role: ChatRole;
    content: string;
    attachments?: any[];
    action?: { label: string; handler: () => void };
  },
  now: () => number,
  randomId: () => string,
  getBackendMessages: (
    agentSlug: string,
    conversationId: string,
  ) => BackendTimestampMessage[],
  backendConversationId?: string,
): ChatUIState | null {
  if (!chat) {
    return null;
  }
  const current = chat.ephemeralMessages || [];
  const conversationId = backendConversationId ?? chat.conversationId ?? '';
  const backendMessages =
    chat.agentSlug && conversationId
      ? getBackendMessages(chat.agentSlug, conversationId)
      : [];
  const latestTimestamp =
    backendMessages.length > 0
      ? Math.max(
          ...backendMessages.map((entry) => readTimestamp(entry.timestamp)),
        )
      : now();
  return {
    ...chat,
    ephemeralMessages: [
      ...current,
      {
        ...message,
        id: `ephemeral-${now()}-${randomId()}`,
        // archive#1292: every notice gets a real, monotonically-later-than-
        // backend timestamp here — the transcript sort in
        // useDerivedSessions.buildSessionMessages relies on this being
        // present (never falls back to 0) to keep the notice from sorting
        // ahead of the whole transcript. The old, since-deleted
        // `insertAfterCount` field would have needed a second read site to
        // do anything; this guaranteed timestamp alone is sufficient
        // ordering, so it was dropped rather than implemented.
        timestamp: latestTimestamp + 1,
        ephemeral: true,
      },
    ],
  };
}
