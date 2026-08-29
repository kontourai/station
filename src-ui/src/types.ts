import type {
  AgentExecutionConfig,
  AgentSource,
  AgentTools,
  AgentUIConfig,
  SlashCommand,
} from '@kontourai/station-contracts/agent';
import type {
  AgentId,
  EngineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { StagedAttachmentReference } from '@kontourai/station-contracts/attachment-staging';
import type { BoardReference } from '@kontourai/station-contracts/board';
import type {
  ApprovalMode,
  ProviderKind,
} from '@kontourai/station-contracts/provider';
import type { ExecutionMode } from '@kontourai/station-contracts/tool';
import type { TurnChangedFiles } from '@kontourai/station-contracts/turn-changed-files';
import type { UIBlock } from '@kontourai/station-contracts/ui-block';
import type { RegistryCatalogTab } from '@kontourai/station-sdk';
import type {
  ChatActivityHint,
  ChatBackgroundTask,
  ChatLiveUsage,
  FlowGateVerdictInfo,
  FlowRunBinding,
} from './contexts/active-chats-state';
import type { EffectiveModelSource } from './utils/execution';
import type { TransformationReceipt } from './utils/heif-normalizer';
import type { PlanArtifact } from './utils/planArtifacts';

export type {
  LayoutAction,
  LayoutComponentRef,
  LayoutDefinition,
  LayoutDefinitionMetadata,
  LayoutSkill,
  LayoutTab,
} from '@kontourai/station-contracts/layout';
export type { WorkflowMetadata } from '@kontourai/station-contracts/runtime';
export type {
  FlowGateVerdictInfo,
  FlowRunBinding,
} from './contexts/active-chats-state';

export interface AgentCommands {
  [commandName: string]: SlashCommand;
}

export interface AgentSummary {
  slug: AgentId;
  name: string;
  model?: string;
  updatedAt?: string;
  description?: string;
  icon?: string;
  source?: AgentSource;
  ui?: AgentUIConfig;
  commands?: AgentCommands;
  /**
   * Derived, not restated. A hand-listed copy of this shape once omitted a
   * field the contract defined, which is how the editor silently destroyed it
   * on every save (archive#2693) — a type that claims to BE the whole tools
   * object has to come from the contract.
   */
  toolsConfig?: Partial<AgentTools>;
  execution?: AgentExecutionConfig;
  workflowWarnings?: string[];
  modelOptions?: Array<{ id: string; name: string; originalId: string }> | null;
  /** Owning project slug; absent = global scope (agent-engine-unification.md §3.3). */
  project?: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string; // base64 or URL
  preview?: string; // For images
  /**
   * Present only when the composer shrank the image to fit the attachment caps
   * (archive#3375). `name`, `type`, `size` and `data` all describe what will
   * actually be sent; this describes what the user chose, so the composer can
   * say the image was resized instead of implying the original went out.
   */
  resized?: {
    /** Decoded byte count of the file the user selected or pasted. */
    fromBytes: number;
    fromMimeType: string;
    width: number;
    height: number;
  };
  /**
   * Byte-free local provenance for an image that changed containers before it
   * entered the archive#4134 staging seam. It contains digests and bounded metadata,
   * never source bytes, EXIF, a path, or a native capability grant.
   */
  transformation?: TransformationReceipt;
}

/**
 * Persistable composer staging state. It deliberately contains neither the
 * selected File/data URL nor a short-lived upload grant; those stay only in
 * the mounted composer's memory while an upload is supervised.
 */
export interface ComposerAttachmentStageSnapshot {
  clientAttachmentId: string;
  name: string;
  mimeType: string;
  size: number;
  state:
    | 'queued'
    | 'uploading'
    | 'retryable'
    | 'complete'
    /** Server accepted the bound turn; its upload bytes were deliberately released. */
    | 'accepted'
    | 'cancelled'
    | 'failed';
  progress: number;
  stageId?: string;
  reference?: StagedAttachmentReference;
  /** Older validated Station hosts intentionally use inline delivery. */
  delivery?: 'legacy-inline' | 'staged';
  /** A reload has retained the stage reference but cannot retain File bytes. */
  needsFile?: boolean;
  error?: string;
  /** Retained provenance is safe across reload; source bytes are never retained. */
  transformation?: TransformationReceipt;
}

export interface ChatMessage {
  /** Stable server/event identity when the projection can provide one. */
  id?: string;
  /** Stable client identity while an optimistic user row awaits persistence. */
  clientId?: string;
  /** Durable event identity on a rehydrated authored user row, never optimistic. */
  sourceEventId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  modelOptions?: Record<string, string | number | boolean>;
  /** archive#1292: set only on entries in `ChatUIState.ephemeralMessages` — the
   * dismissible transcript notice flag. Every notice is created through
   * `addEphemeralMessage`/`createEphemeralMessageState`, which always sets
   * this; there is no writer that sets it on any other message. */
  ephemeral?: boolean;
  showContinue?: boolean;
  timestamp?: number;
  traceId?: string;
  fromPrompt?: boolean;
  contentParts?: Array<{
    type:
      | 'text'
      | 'image'
      | 'file'
      | 'tool-invocation'
      | 'reasoning'
      | 'ui-block'
      | 'flow-run-attached'
      | 'flow-gate-verdict'
      // Persisted SDK refresh parts arrive as `tool-<toolName>`.
      | (string & {});
    content?: string;
    image?: string;
    mediaType?: string;
    url?: string;
    name?: string;
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
    /** archive#3769: the durable projection's own runtime.error marker — see
     * `MessagePart.runtimeError` in `packages/shared/src/conversation-message.ts`. */
    runtimeError?: boolean;
    /** #765 A1: the structured `RuntimeErrorEvent.code` carried beside
     * `runtimeError`, so a rehydrated failure translates like the live one. */
    runtimeErrorCode?: string;
    uiBlock?: UIBlock;
    toolCallId?: string;
    flowRunAttached?: FlowRunBinding;
    flowGateVerdict?: FlowGateVerdictInfo;
    conversationHandoff?: import('@kontourai/station-contracts/orchestration').ConversationHandoffProjection;
    conversationContextBoundary?: import('@kontourai/station-contracts/conversation-context-boundary').ConversationContextBoundaryTranscriptMarker;
  }>;
  attachments?: FileAttachment[];
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    args: any;
    result?: any;
    state?: string;
    error?: string;
  }>;
  /** archive#1410: the canonical turn this assistant row projects, when known. */
  turnId?: string;
  /** Execution Session that produced this historical assistant row. */
  sessionId?: string;
  /**
   * Agent selected by the execution Session that produced this row.  This is
   * transcript lineage, not the current conversation selection: after a
   * handoff those are intentionally different facts.
   */
  agentSlug?: AgentId;
  agentDisplayName?: string;
  agentIcon?: string;
  /** True only for a normally completed assistant turn. */
  answerEligible?: boolean;
  /**
   * archive#1410: the turn's provenance envelope exactly as the server sent
   * it. Untyped on purpose — see `TurnProvenanceCard`, which narrows it
   * through `isSupportedTurnProvenanceEnvelope` so an envelope this build
   * does not understand degrades to an honest unavailable state.
   */
  provenance?: unknown;
  /** Workspace effect between this turn's captured baseline and settle. */
  changedFiles?: TurnChangedFiles;
}

export type ChatSessionSource = 'manual' | 'prompt' | 'workflow';

export type ChatSessionStatus = 'idle' | 'sending' | 'error' | 'queued';

/**
 * One permanently refused follow-up (archive#3706). `content` is the user's
 * own text; `reason` is the refusal as it was shown to them; `id` is the
 * dismiss/render identity (`at` is a timestamp for ordering, NOT an identity —
 * two drains can settle in the same millisecond).
 */
export interface UnsentMessageRecord {
  id: string;
  content: string;
  reason: string;
  at: number;
}

export interface ChatSession {
  id: string;
  conversationId?: string;
  /** Replaceable execution context beneath this durable conversation. */
  currentSessionId?: string;
  agentSlug: AgentId;
  agentName: string;
  title: string;
  source: ChatSessionSource;
  sourceId?: string;
  messages: ChatMessage[];
  input: string;
  attachments: FileAttachment[];
  queuedMessages: string[];
  /** See ChatUIState.queuedMessageFailure (active-chats-state.ts) — persisted. */
  queuedMessageFailure?: { message: string; code?: string; at: number };
  /** See ChatUIState.unsentMessages (archive#3706) — persisted, not a queue. */
  unsentMessages?: UnsentMessageRecord[];
  outboundQueuedTurns?: Array<{
    clientTurnId: string;
    content: string;
    attachments?: FileAttachment[];
    createdAt: number;
    status: 'pending' | 'invoking' | 'accepted' | 'failed' | 'may-have-started';
    lastError?: string;
  }>;
  status: ChatSessionStatus;
  isThinking?: boolean;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
  hasUnread: boolean;
  provider?: ProviderKind;
  providerOptions?: Record<string, unknown>;
  /** See ChatUIState.lastAppliedApprovalMode (active-chats-state.ts) — not persisted. */
  lastAppliedApprovalMode?: ApprovalMode;
  /** See ChatUIState.stopPending (active-chats-state.ts) — not persisted. */
  stopPending?: boolean;
  model?: string;
  modelSource?: EffectiveModelSource;
  requestedModel?: string;
  requestedModelSource?: EffectiveModelSource;
  requestedProviderOptions?: Record<string, unknown>;
  defaultModel?: string;
  defaultModelSource?: EffectiveModelSource;
  orchestrationProvider?: ProviderKind;
  orchestrationModel?: string;
  orchestrationStatus?: string;
  /** This tab's transcript is served by the bounded orchestration window. */
  orchestrationSessionStarted?: boolean;
  /** Authoritative live-turn fold; it stays true while approval is pending. */
  orchestrationTurnOpen?: boolean;
  /** The one current turn whose streaming row must remain unfolded. */
  openTurnId?: string;
  /** See ChatUIState.openTurnShellSuperseded (active-chats-state.ts). */
  openTurnShellSuperseded?: boolean;
  /** Incremented only when bounded persisted history must reconcile. */
  orchestrationHistoryRevision?: number;
  inputHistory: string[];
  abortController?: AbortController;
  projectSlug?: string;
  projectName?: string;
  focusDirectoryId?: string;
  executionMode?: ExecutionMode;
  executionScope?: 'project' | 'global';
  agentConnectionId?: EngineConnectionId;
  providerId?: string;
  defaultProviderId?: string;
  currentModeId?: string | null;
  planArtifact?: PlanArtifact | null;
  pendingApprovals?: string[];
  isProcessingStep?: boolean;
  flowRun?: FlowRunBinding | null;
  /** See ChatUIState.activityHint — transient streaming-indicator hint. */
  activityHint?: ChatActivityHint;
  /** See ChatUIState.backgroundTasks — live provider background tasks. */
  backgroundTasks?: ChatBackgroundTask[];
  /** Latest provider-reported usage observation for the live context meter. */
  liveUsage?: ChatLiveUsage;
}

export interface Tool {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  kind?: 'mcp' | 'builtin' | 'custom';
  transport?: string;
  icon?: string;
  iconUrl?: string;
  enabled?: boolean;
  parameters?: any;
  server?: string;
  toolName?: string;
}

export type { TemplateVariable } from '@kontourai/station-contracts/config';
export type AppConfig = Partial<
  import('@kontourai/station-contracts/config').AppConfig
>;

export type NavigationView =
  | { type: 'home' }
  | { type: 'agents' }
  | { type: 'agent-new' }
  | {
      type: 'agent-edit';
      slug: string;
      initialTab?: 'basic' | 'tools' | 'commands' | 'skills' | 'connection';
    }
  | {
      type: 'guidance';
      tab?: 'skills' | 'commands';
      /** Narrows the Skills list; see `views/guidance-tab.ts`. */
      filter?: 'commands';
      selectedId?: string;
      redirectFromAlias?: boolean;
    }
  | { type: 'connections' }
  | { type: 'connections-providers' }
  | { type: 'connections-provider-edit'; id: string }
  | { type: 'connections-engines' }
  | { type: 'connections-runtime-edit'; id: string }
  | { type: 'connections-acp-new'; providerId: string }
  | { type: 'connections-tools' }
  | { type: 'connections-tool-edit'; id: string }
  | { type: 'connections-knowledge' }
  | { type: 'connections-computers' }
  | { type: 'plugins' }
  | { type: 'registry'; tab?: RegistryCatalogTab }
  | { type: 'review-queue' }
  | {
      type: 'activity';
      sessionId?: string;
      /**
       * One-shot route intent: land the reader on the selected session's
       * evidence region (receipts/diagnostics). Only meaningful alongside
       * `sessionId`; consumed and cleared by the Activity surface after it is
       * honored, following the `openFilePreviewIntent` idiom
       * (`navigation-store.ts`).
       */
      focus?: 'evidence';
    }
  | { type: 'developer'; tab?: DeveloperTab }
  | { type: 'schedule' }
  | { type: 'settings' }
  | { type: 'profile' }
  | { type: 'notifications' }
  | { type: 'task'; taskId: string }
  // archive#4079: the board face, reached by URL only (no sidebar
  // item this slice — see docs/design/... and page-frame-registry.ts).
  | { type: 'board'; reference: BoardReference }
  | { type: 'project'; slug: string }
  | { type: 'project-session-board'; slug: string }
  | { type: 'project-flow-console'; slug: string; runId?: string }
  | {
      type: 'workspace-pane';
      projectSlug: string;
      descriptorId: string;
      instanceId: string;
      /** Present only for a pane whose renderer is bound to a Project layout. */
      layoutSlug?: string;
    }
  | { type: 'project-new' }
  | { type: 'project-edit'; slug: string }
  // `tab` is the layout tab named by the third path segment
  // (`/projects/<p>/layouts/<l>/<tabId>`), the shape `setLayoutTab` writes.
  | { type: 'layout'; projectSlug: string; layoutSlug: string; tab?: string }
  | { type: 'not-found'; path: string };

export type DeveloperTab =
  | 'logs'
  | 'system'
  | 'telemetry'
  | 'memory'
  | 'archive';

export type DockMode = 'left' | 'bottom' | 'right';

/**
 * Parse a persisted dock-mode value (URL param, sessionStorage override).
 * The desktop overlay bottom mode was retired (archive#1043): `bottom` now means
 * the inline grid placement, and the transitional `bottom-inline` name
 * normalizes to it.
 */
export function normalizeDockMode(
  value: string | null | undefined,
): DockMode | null {
  if (value === 'left' || value === 'bottom' || value === 'right') return value;
  if (value === 'bottom-inline') return 'bottom';
  return null;
}
