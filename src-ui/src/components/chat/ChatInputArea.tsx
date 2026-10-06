import type { ToolPolicyDelivery } from '@kontourai/station-contracts/engine-capability-matrix';
import {
  EXECUTION_MODE,
  type ExecutionMode,
} from '@kontourai/station-contracts/tool';
import type { STTState as VoiceState } from '@kontourai/station-sdk';
import { CHAT_INPUT_MAX_CHARS } from '@shared/chat-input-limits';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDeviceSettings } from '../../contexts/DeviceSettingsContext';
import { setShortcutContext } from '../../contexts/KeyboardShortcutsContext';
import { useDockSlotDevice, useIsMobile } from '../../hooks/useIsMobile';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import type { SlashCommand } from '../../hooks/useSlashCommands';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import type {
  ComposerAttachmentStageSnapshot,
  FileAttachment,
} from '../../types';
import type { AdvertisedAcpMode } from '../../utils/acpSessionMode';
import type { SavedAnswerQuote } from '../../utils/answer-quotes';
import {
  type ApprovalMode,
  approvalModeKnobSupported,
  type SessionApprovalOverride,
} from '../../utils/approvalMode';
import { filesFromDataTransfer } from '../../utils/attachment-file-transfer';
import {
  type EffectiveModelSource,
  modelSourceLabel,
} from '../../utils/execution';
import {
  type ModelProviderOption,
  modelIdentityLabel,
  resolvedModelLabel,
  type SelectableModel,
} from '../../utils/modelCapabilities';
import { Button } from '../Button';
import { ApprovalModeChip } from '../badges/ApprovalModeChip';
import {
  ComposerActionsMenu,
  type ComposerActionsMenuProps,
} from '../chat-dock/ComposerActionsMenu';
import { ArrowDownGlyph } from '../icons/Glyph';
import { ResponsiveDialogSurface } from '../ResponsiveDialogSurface';
import { VoiceOrb } from '../voice/VoiceOrb';
import { ComposerIconAction } from './ComposerIconAction';
import { ComposerStopButton } from './ComposerStopButton';
import {
  appendComposerSessionReference,
  composerDisplayValue,
  composerMentionWireLength,
  insertComposerMention,
  mentionQueryAt,
  parseComposerTokens,
  reconcileComposerDisplay,
  sessionReferenceBlockReason,
} from './composer-mentions';
import {
  CONVERSATION_REFERENCE_DRAG_TYPE,
  draggedConversationReference,
  endConversationReferenceDrag,
} from './conversationReferenceDrag';
import './chat.css';
import { SkeletonBlock, SkeletonList } from '../state';

const SessionModelPicker = React.lazy(() =>
  import('../session/SessionModelPicker').then((module) => ({
    default: module.SessionModelPicker,
  })),
);

const PortableDraftsMenu = React.lazy(() =>
  import('./PortableDraftsMenu').then((module) => ({
    default: module.PortableDraftsMenu,
  })),
);

const AcpSessionModeChip = React.lazy(() =>
  import('../badges/AcpSessionModeChip').then((module) => ({
    default: module.AcpSessionModeChip,
  })),
);

const FileMentionAutocomplete = React.lazy(() =>
  import('./FileMentionAutocomplete').then((module) => ({
    default: module.FileMentionAutocomplete,
  })),
);
const SessionReferencePicker = React.lazy(() =>
  import('./SessionReferencePicker').then((module) => ({
    default: module.SessionReferencePicker,
  })),
);
const ComposerAttachmentStrip = React.lazy(() =>
  import('./ComposerAttachmentStrip').then((module) => ({
    default: module.ComposerAttachmentStrip,
  })),
);
const FileAttachmentInput = React.lazy(() =>
  import('./FileAttachmentInput').then((module) => ({
    default: module.FileAttachmentInput,
  })),
);
const SlashCommandSelector = React.lazy(() =>
  import('./SlashCommandSelector').then((module) => ({
    default: module.SlashCommandSelector,
  })),
);
const ModelCatalogUnavailableState = React.lazy(() =>
  import('../session/ModelCatalogUnavailableState').then((module) => ({
    default: module.ModelCatalogUnavailableState,
  })),
);
const ModelSelectorAutocomplete = React.lazy(() =>
  import('../ModelSelector').then((module) => ({
    default: module.ModelSelectorAutocomplete,
  })),
);
const ComposerMentionChips = React.lazy(() =>
  import('./ComposerMentionChips').then((module) => ({
    default: module.ComposerMentionChips,
  })),
);

function isPortableDraftShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return event.key === 's' && (event.metaKey || event.ctrlKey);
}

interface ChatInputAreaProps {
  activity?: React.ReactNode;
  activityRef?: React.Ref<HTMLDivElement>;
  // Session info
  /**
   * The active chat session's stable identity (thread id) — used only to
   * key the approval-mode chip so its local confirm state resets on a
   * session switch instead of leaking onto the newly active session
   * (archive#727 3). Not otherwise read by this component.
   */
  sessionId?: string;
  activeConversationId?: string;
  // Input state
  hasQuotedContext?: boolean;
  draftText?: string;
  quoteContext?: readonly SavedAnswerQuote[];
  input: string;
  workingDirectory?: string | null;
  /**
   * The Project `workingDirectory` belongs to (#2412: file lookups name
   * their Project, and the server refuses a folder outside it). Without one,
   * `@` file mentions are not offered.
   */
  mentionProjectSlug?: string | null;
  mentionRequestScope?: {
    apiBase: string;
    authorityKey: string;
    isCurrent: () => boolean;
  };
  mentionAuthority?: string | null;
  attachments: FileAttachment[];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  // Status
  disabled: boolean;
  /** A busy continuation may accept a draft while sends remain blocked. */
  allowDraftWhileDisabled?: boolean;
  isSending: boolean;
  /**
   * A turn is outstanding — see `isTurnInFlight` (active-chats-state.ts) for
   * the derivation. Renamed from `hasAbortController` in the fix:
   * the old name WAS the defect, because holding a browser abort controller
   * stopped being true seconds into a turn that ran for minutes.
   */
  turnInFlight: boolean;
  /**
   * What Enter does while a turn is in flight. Steer is the default on
   * engines that can take mid-turn input; queue is the only path otherwise
   * (and whenever this send carries attachments).
   */
  busyFollowUp?: 'steer' | 'queue';
  busySteeringKind?: 'native' | 'safe-stop';
  /** Hold the draft as a follow-up instead of steering the open turn. */
  onQueueFollowUp?: () => Promise<void>;
  /**
   * a Stop request is in flight. The control stays visible (the
   * turn is still the thing on screen) but is disabled and labelled with what
   * is actually happening, so a second press cannot dispatch a second cancel.
   */
  stopPending?: boolean;
  modelSupportsAttachments: boolean;
  fileAttachmentsSupported?: boolean;
  /**
   * Why images can't be attached here (archive#3344) — the engine's own
   * `imageInput` reason or the selected model's. Shown at paste time so the
   * refusal names something actionable instead of a generic line.
   */
  modelProviderLabel?: string;
  // Display
  fontSize: number;
  dockHeight: number;
  // Model selector
  currentModel?: string;
  currentModelSource?: EffectiveModelSource;
  canModelSelect: boolean;
  modelSelectionReason?: string;
  modelsStale?: boolean;
  modelsLoading?: boolean;
  agentDefaultModel?: string;
  defaultModelSource?: EffectiveModelSource;
  availableModels: SelectableModel[];
  modelProviders?: ModelProviderOption[];
  currentProviderId?: string;
  modelQuery: string | null;
  agentConnectionId?: string;
  modelRuntimeOptions?: Record<string, unknown>;
  // Approval mode (archive#727) — External-agent sessions only
  executionMode?: ExecutionMode;
  approvalModeAgentDefault?: unknown;
  /** This Station's `AppConfig.defaultApprovalMode` (#2144 slice 6). */
  approvalModeStationDefault?: unknown;
  toolPolicyDelivery?: ToolPolicyDelivery;
  lastAppliedApprovalMode?: unknown;
  /**
   * The session approval override: the pending pick, else the confirmed one
   * (`sessionApprovalOverride`, #2334). Not read from `modelRuntimeOptions`,
   * which holds model controls only.
   */
  approvalModeOverride?: SessionApprovalOverride;
  acpSessionModes?: AdvertisedAcpMode[];
  acpCurrentModeId?: string;
  // Slash commands
  commandQuery: string | null;
  slashCommands: SlashCommand[];
  // Handlers
  onInputChange: (value: string) => void;
  onSend: () => Promise<void>;
  onCancel: () => void;
  onClearInput: () => void;
  selectAttachmentFiles?: (files: File[]) => Promise<void>;
  attachmentError?: string | null;
  /** Non-blocking attach-time note (e.g. image support not yet confirmed). */
  attachmentNotice?: string;
  /**
   * The send is blocked only by its attachments: the validation line offers to
   * remove them, so the fix is reachable where the reason is shown (the
   * transcript's error card can be out of view in a short dock).
   */
  removalUnblocksSend?: boolean;
  /** Why nothing can be attached; tapping the paperclip reports it. */
  attachUnavailableReason?: string;
  onAttachUnavailable?: (reason: string) => void;
  attachmentStages?: ComposerAttachmentStageSnapshot[];
  sendBlockedReason?: string;
  /**
   * The latest send-failure notice, one line. Shown in the composer only when
   * a dock too short for the transcript steps it aside (the notice lives there).
   */
  sendFailureNotice?: string;
  /**
   * A send queued to retry by itself, with its Discard. The controls row shows
   * the button only when the dock is too short to show the transcript that
   * holds the same notice (`data-composer-priority`). It takes no height of its
   * own there (the row is already a touch row), so the draft keeps its floor;
   * the notice's words are its description. A queued send is not a failure, so
   * this is not the send-failure line.
   */
  queuedRetryNotice?: { text: string; onDiscard: () => void };
  onRetryAttachmentStage?: (id: string) => void | Promise<void>;
  onCancelAttachmentStage?: (id: string) => void | Promise<void>;
  onReplaceAttachmentFile?: (id: string, files: File[]) => void | Promise<void>;
  onRemoveAttachment: (id: string) => void;
  onClearAttachments: () => void;
  onModelSelect: (model: SelectableModel) => void;
  onModelReset: () => void;
  onModelClose: () => void;
  onModelOpen: () => void;
  onModelRuntimeOptionChange: (
    key: string,
    value: string | number | boolean | undefined,
  ) => void;
  onApprovalModeChange: (mode: ApprovalMode) => void;
  onAcpSessionModeChange?: (modeId: string) => void;
  onCommandSelect: (command: SlashCommand) => Promise<void>;
  onCommandClose: () => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  onRestorePortableDraft?: (
    text: string,
    attachments: FileAttachment[],
    quotes?: readonly SavedAnswerQuote[],
  ) => void;
  updateFromInput: (value: string) => void;
  closeAll: () => void;
  // Voice mode (optional — omit to hide the mic button)
  voiceState?: VoiceState;
  voiceSupported?: boolean;
  voiceUnsupportedReason?: string;
  voiceError?: string;
  onVoiceStart?: () => void;
  onVoiceStop?: () => void;
  /**
   * Delegate / Commands / Files / Task-context grouped into one "+" menu
   * (docs/design/chat-composer.md §3.2). Omitted when the active session has
   * no project (those actions are project-scoped) — the composer then shows
   * just attach + mic + model + Send.
   */
  secondaryActions?: ComposerActionsMenuProps;
  /** The visible, context-preserving Agent handoff entry point. */
  agentLabel?: string;
  onOpenAgentHandoff?: () => void;
  agentHandoffTriggerRef?: React.RefObject<HTMLButtonElement | null>;
  agentHandoffDisabled?: boolean;
  agentHandoffDisabledReason?: string;
  workspaceRefused?: boolean;
  onStartNewChat?: (
    initialMessage?: string,
    attachments?: FileAttachment[],
  ) => void | Promise<void>;
}

/**
 * The textarea's auto-height, clamped to the viewport, and the draft's floor:
 * two lines (or its whole content, when shorter). In a short dock the draft
 * may shrink to the floor and scroll, never below it.
 *
 * "Its whole content" is measured at one row: an empty textarea is two rows
 * tall by default, and a floor taken from that would reserve two lines for a
 * draft nobody has typed, at the transcript's expense.
 */
function sizeDraft(textarea: HTMLTextAreaElement, availableHeight: number) {
  textarea.style.height = 'auto';
  const rows = textarea.rows;
  textarea.rows = 1;
  const contentHeight = textarea.scrollHeight;
  textarea.rows = rows;
  const maxHeight = Math.min(160, Math.max(88, availableHeight * 0.3));
  const height = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${height}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  const style = getComputedStyle(textarea);
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const line = Number.parseFloat(style.lineHeight) || fontSize * 1.2;
  const chrome =
    (Number.parseFloat(style.paddingTop) || 0) +
    (Number.parseFloat(style.paddingBottom) || 0) +
    (Number.parseFloat(style.borderTopWidth) || 0) +
    (Number.parseFloat(style.borderBottomWidth) || 0);
  const floor = Math.min(height, contentHeight, Math.ceil(2 * line + chrome));
  textarea.style.minHeight = `${floor}px`;
  return floor;
}

export function ChatInputArea({
  activity,
  activityRef,
  sessionId,
  activeConversationId,
  input,
  workingDirectory,
  mentionProjectSlug,
  mentionRequestScope,
  mentionAuthority,
  hasQuotedContext = false,
  draftText,
  quoteContext,
  attachments,
  textareaRef,
  disabled,
  allowDraftWhileDisabled = false,
  isSending,
  turnInFlight,
  busySteeringKind = 'native',
  busyFollowUp = 'queue',
  onQueueFollowUp,
  stopPending = false,
  modelSupportsAttachments,
  fileAttachmentsSupported = modelSupportsAttachments,
  modelProviderLabel,
  fontSize,
  dockHeight,
  currentModel,
  currentModelSource,
  canModelSelect,
  modelSelectionReason,
  modelsStale = false,
  modelsLoading = false,
  agentDefaultModel,
  defaultModelSource,
  availableModels,
  modelProviders,
  currentProviderId,
  modelQuery,
  agentConnectionId,
  modelRuntimeOptions,
  executionMode,
  approvalModeAgentDefault,
  approvalModeStationDefault,
  toolPolicyDelivery,
  lastAppliedApprovalMode,
  approvalModeOverride,
  acpSessionModes = [],
  acpCurrentModeId,
  commandQuery,
  slashCommands,
  onInputChange,
  onSend,
  onCancel,
  onClearInput,
  selectAttachmentFiles = async () => {},
  attachmentError = null,
  attachmentNotice,
  sendFailureNotice,
  queuedRetryNotice,
  attachUnavailableReason,
  onAttachUnavailable,
  removalUnblocksSend = false,
  attachmentStages = [],
  sendBlockedReason,
  onRetryAttachmentStage,
  onCancelAttachmentStage,
  onReplaceAttachmentFile,
  onRemoveAttachment,
  onClearAttachments,
  onModelSelect,
  onModelReset,
  onModelClose,
  onModelOpen,
  onModelRuntimeOptionChange,
  onApprovalModeChange,
  onAcpSessionModeChange,
  onCommandSelect,
  onCommandClose,
  onHistoryUp,
  onHistoryDown,
  onRestorePortableDraft,
  updateFromInput,
  closeAll,
  voiceState,
  voiceSupported,
  voiceUnsupportedReason,
  voiceError,
  onVoiceStart,
  onVoiceStop,
  secondaryActions,
  agentLabel,
  onOpenAgentHandoff,
  agentHandoffTriggerRef,
  agentHandoffDisabled = false,
  agentHandoffDisabledReason,
  workspaceRefused = false,
  onStartNewChat,
}: ChatInputAreaProps) {
  const isMobile = useIsMobile();
  const hasSendableDraft = Boolean(
    input.trim() || hasQuotedContext || attachments.length,
  );
  const hideMobileSubmit = isMobile && !hasSendableDraft;
  const [sendMode, setSendMode] = useState<'queue' | 'steer'>('queue');
  const [sendModeOpen, setSendModeOpen] = useState(false);
  useEffect(() => {
    void sessionId;
    setSendMode('queue');
    setSendModeOpen(false);
  }, [sessionId]);
  const { chatReturnBehavior } = useDeviceSettings();
  const { coarsePointer } = useDockSlotDevice();
  const returnSends =
    chatReturnBehavior === 'send' ||
    (chatReturnBehavior === 'auto' && !coarsePointer);
  const submitPending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    if (submitPending.current) return;
    submitPending.current = true;
    setSubmitting(true);
    try {
      if (
        turnInFlight &&
        (sendMode === 'queue' || busyFollowUp !== 'steer') &&
        onQueueFollowUp
      ) {
        await onQueueFollowUp();
      } else {
        await onSend();
      }
    } finally {
      submitPending.current = false;
      setSubmitting(false);
    }
  };
  const [portableDraftsOpen, setPortableDraftsOpen] = useState(false);
  const [sessionReferencesOpen, setSessionReferencesOpen] = useState(false);
  const draggedSessionReference = useRef<{
    id: string;
    title: string;
    projectSlug?: string;
    ownerKey: string;
  } | null>(null);
  const [mentionQuery, setMentionQuery] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const mentionListboxId = React.useId();
  const [mentionActiveDescendant, setMentionActiveDescendant] = useState<
    string | undefined
  >();
  const mentionKeyboardController = useRef<
    ((key: 'ArrowDown' | 'ArrowUp' | 'Enter') => boolean) | null
  >(null);
  const mentionGeneration = useRef(0);
  const isComposing = useRef(false);
  // Anchors the model picker popover to its trigger on desktop (archive#999).
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const visualViewport = useMobileVisualViewport();
  const sessionReferenceOwnerKey = JSON.stringify([
    sessionId ?? '',
    mentionAuthority ?? '',
    mentionRequestScope?.apiBase ?? '',
    mentionRequestScope?.authorityKey ?? '',
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: these identities fence stale mention offsets even though the effect only clears local state.
  useEffect(() => {
    mentionGeneration.current += 1;
    setMentionQuery(null);
    draggedSessionReference.current = null;
    setSessionReferencesOpen(false);
  }, [
    sessionId,
    workingDirectory,
    mentionAuthority,
    mentionRequestScope?.apiBase,
    mentionRequestScope?.authorityKey,
  ]);
  const isOverride = currentModelSource === 'session override';
  const effectiveModelId = currentModel || agentDefaultModel;
  const effectiveModelInfo = availableModels.find(
    (model) => model.id === effectiveModelId,
  );
  // archive#1012: an alias/default entry hides which model the engine actually runs
  // ("Default (recommended)" told the owner nothing while an outdated host
  // silently ran an old model). When the engine reports a resolution, the
  // pill shows the concrete model; the alias identity stays in the accessible
  // label/title below.
  const resolvedLabel = resolvedModelLabel(effectiveModelInfo, availableModels);
  const aliasLabel =
    effectiveModelInfo?.name || effectiveModelId || 'Model & effort';
  // #1536 B5: the visible pill is an identity surface, so it takes the shared
  // identity rule rather than the catalog's own option copy — an unresolved
  // engine default read "Default (recommended)" here while the dock header,
  // Home and the sidebar said something else about the same session. The
  // catalog's option name survives in `aliasLabel`, which is what the
  // accessible label and title carry.
  const modelLabel = effectiveModelId
    ? modelIdentityLabel(effectiveModelId, availableModels)
    : aliasLabel;
  const modelSource =
    currentModelSource ??
    defaultModelSource ??
    (agentDefaultModel ? 'agent default' : 'unknown');
  // Accessible name must carry the active selection, not just the control's
  // static role name — a screen reader user landing on this button by role
  // otherwise has no way to tell which model/connection is active
  // (docs/design/chat-composer.md §3.3; the visible identity spans below
  // are aria-hidden since they're presentational chips, not a name source).
  // The visible pill dropped its source subline (it was the second line that
  // made this control two rows tall on a phone). The source is still carried
  // here, and the override state is still visible via the pill's variant, so
  // no information is lost — only vertical space.
  // #1536 B5: the accessible name is where the fuller statement belongs — the
  // catalog's own option copy for an alias ("Default (recommended)"), or a raw
  // id we have no name for. The visible pill states the identity only.
  const fullModelIdentity = resolvedLabel
    ? `${aliasLabel} → ${resolvedLabel}`
    : aliasLabel;
  const modelAccessibleLabel = [
    'Model:',
    modelProviderLabel
      ? `${modelProviderLabel} — ${fullModelIdentity}`
      : fullModelIdentity,
    modelSource !== 'unknown' ? `(${modelSourceLabel(modelSource)})` : '',
    !canModelSelect
      ? `Unavailable: ${modelSelectionReason ?? 'You can’t change the model for this chat'}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const agentAccessibleLabel = `Agent: ${agentLabel ?? 'current Agent'}. ${agentHandoffDisabled ? (agentHandoffDisabledReason ?? 'Unavailable') : 'Change Agent'}`;
  // A turn is in flight. Steer is the default on engines that can take
  // mid-turn input; otherwise Enter queues until this turn finishes.
  const mentionLocation =
    workingDirectory && mentionProjectSlug
      ? { projectSlug: mentionProjectSlug, workingDir: workingDirectory }
      : null;
  const placeholder = workspaceRefused
    ? 'This conversation continues from its original workspace — start a new chat to work here'
    : allowDraftWhileDisabled
      ? turnInFlight
        ? 'Draft a follow-up while this turn finishes…'
        : 'Waiting on this chat — check again above to send…'
      : turnInFlight
        ? sendMode === 'steer' && busyFollowUp === 'steer'
          ? busySteeringKind === 'native'
            ? 'Steer this turn…'
            : 'Send at a safe boundary…'
          : 'Queue a follow-up…'
        : mentionLocation && mentionRequestScope
          ? 'Type a message — @ files, / for commands…'
          : 'Type a message — / for commands…';
  const composerTokens = parseComposerTokens(input);
  const displayInput = composerDisplayValue(input, composerTokens);

  // archive#2807: the draft's size against the same limit every server
  // turn-starting schema derives from (chatSchema AND the orchestration
  // seam this composer actually posts to). A courtesy check only — the
  // server is the authority — but it lets the composer say exactly how
  // much to remove instead of letting the turn fail as a provider error.
  const overLimitBy =
    (draftText === undefined
      ? composerMentionWireLength(input, composerTokens)
      : composerMentionWireLength(draftText)) - CHAT_INPUT_MAX_CHARS;
  const isOverLimit = overLimitBy > 0;
  const mentionAutocompleteAvailable = Boolean(
    mentionLocation && mentionRequestScope,
  );
  const mentionAutocompleteOpen = Boolean(
    mentionQuery && mentionAutocompleteAvailable,
  );

  const queuedRetryText = queuedRetryNotice?.text;
  const queuedRetryDescriptionId = React.useId();
  const composerRootRef = useRef<HTMLDivElement | null>(null);
  // The draft's two-line floor, written by the per-keystroke sizing below and
  // read by the reservation.
  const draftFloorRef = useRef(0);
  const scheduleReserveRef = useRef<(() => void) | null>(null);

  // Owns the observers and the dock-level reservation. It must not depend on
  // `input`: a keystroke would otherwise rebuild both observers and re-run
  // the forced-reflow measurement for every character.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const root = composerRootRef.current;
    if (!textarea || !root) return;
    draftFloorRef.current = sizeDraft(
      textarea,
      visualViewport.height || dockHeight,
    );
    const body = root.parentElement;
    // The composer reserves room for that floor plus every row that does not
    // shrink (chips, messages, controls). Without this the dock squeezed the
    // composer itself and the controls row painted over the draft; with it,
    // the banner and the transcript give way instead.
    const reserve = () => {
      const floor = draftFloorRef.current;
      // The composer's natural height with the draft at its floor: unsqueezed
      // (no shrink, no cap) so overlapping rows cannot hide height.
      const saved = [
        root.style.minHeight,
        root.style.flexShrink,
        root.style.maxHeight,
        textarea.style.height,
      ] as const;
      const measure = () => {
        root.style.minHeight = '';
        root.style.flexShrink = '0';
        root.style.maxHeight = 'none';
        textarea.style.height = `${floor}px`;
        const height = Math.ceil(root.getBoundingClientRect().height);
        root.style.flexShrink = saved[1];
        root.style.maxHeight = saved[2];
        textarea.style.height = saved[3];
        return height;
      };
      if (!body?.classList.contains('chat-dock__body')) {
        const next = `${measure()}px`;
        root.style.minHeight = saved[0] === next ? saved[0] : next;
        return;
      }
      // In a dock too short for the transcript's and the banner's own frame
      // (padding and border) on top of the composer and its fixed siblings,
      // the banner steps aside and the transcript gives up its padding
      // (data-composer-priority) rather than the composer overflowing its
      // dock. The transcript is never taken out of the layout: this is a
      // measurement, and a reading that went stale must not be able to remove
      // the conversation.
      //
      // Always decided in the plain layout, with the attribute off: what the
      // attribute changes (the banner, the transcript's padding, the
      // send-failure line) then cannot feed back into the decision.
      body.removeAttribute('data-composer-priority');
      let needed = measure();
      // `others`: siblings that keep their size. `yielding`: what the
      // transcript and the banner still occupy once shrunk to their frame.
      let others = 0;
      let yielding = 0;
      for (const child of body.children) {
        if (child === root || !(child instanceof HTMLElement)) continue;
        const style = getComputedStyle(child);
        if (style.display === 'none') continue;
        const edge = (name: string) =>
          Number.parseFloat(style.getPropertyValue(name)) || 0;
        const margins = edge('margin-top') + edge('margin-bottom');
        if (
          child.classList.contains('chat-messages') ||
          child.classList.contains('chat-dock__session-failure')
        ) {
          yielding +=
            margins +
            edge('padding-top') +
            edge('padding-bottom') +
            edge('border-top-width') +
            edge('border-bottom-width');
        } else {
          others += child.getBoundingClientRect().height + margins;
        }
      }
      const priority = needed + others + yielding > body.clientHeight + 0.5;
      if (priority) {
        body.setAttribute('data-composer-priority', '');
        // The send-failure line shows only now, and it is part of what the
        // composer needs.
        needed = measure();
      }
      // The reservation never exceeds what the dock can give: past that point
      // Send staying on screen outranks the draft's two-line floor.
      const granted = Math.max(0, Math.min(needed, body.clientHeight - others));
      // A shortfall comes out of the draft's floor, so it scrolls rather than
      // overflowing onto the controls row.
      textarea.style.minHeight = `${Math.max(0, floor - (needed - granted))}px`;
      const next = `${granted}px`;
      root.style.minHeight = saved[0] === next ? saved[0] : next;
    };
    reserve();

    // A burst of observer callbacks (and the keystroke) measures once a frame.
    let frame = 0;
    let disposed = false;
    const scheduleReserve = () => {
      if (frame || disposed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!disposed) reserve();
      });
    };
    scheduleReserveRef.current = scheduleReserve;
    const cleanup = () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      if (scheduleReserveRef.current === scheduleReserve)
        scheduleReserveRef.current = null;
      // The attribute restyles the transcript and banner through
      // `.chat-dock__body`, which outlives this composer (replay mounts
      // none): do not leave it behind.
      body?.removeAttribute('data-composer-priority');
      root.style.minHeight = '';
      textarea.style.minHeight = '';
    };
    // Rows around the draft mount late (the lazy chip strip) or change size
    // on their own (wrapping chips); re-reserve whenever any of them does.
    if (typeof ResizeObserver === 'undefined') return cleanup;
    const observed =
      '.chat-input__meta, .chat-controls-row, .chat-input__textarea-wrapper > :not(textarea)';
    const observer = new ResizeObserver(scheduleReserve);
    const observeRows = () => {
      observer.disconnect();
      if (body) {
        observer.observe(body);
        // The reservation depends on every sibling's size (a loading
        // skeleton, the status line, the banner), not only on the dock's:
        // one that appears, leaves or resizes without changing the dock's own
        // height must still be re-measured.
        for (const sibling of body.children)
          if (sibling !== root) observer.observe(sibling);
      }
      for (const row of root.querySelectorAll(observed)) observer.observe(row);
    };
    observeRows();
    const mutations = new MutationObserver(() => {
      observeRows();
      scheduleReserve();
    });
    mutations.observe(root, { childList: true, subtree: true });
    if (body) mutations.observe(body, { childList: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
      cleanup();
    };
  }, [dockHeight, textareaRef, visualViewport.height]);

  // Per keystroke (and per row that changes what the composer needs): the
  // textarea's own auto-height, then one coalesced reservation.
  useLayoutEffect(() => {
    // Value changes are a resize trigger even though the measurement reads DOM.
    void input;
    // So are the rows around the draft: they change what the composer needs.
    void attachments.length;
    void attachmentStages.length;
    void sendBlockedReason;
    void attachmentError;
    void attachmentNotice;
    void sendFailureNotice;
    void queuedRetryText;
    const textarea = textareaRef.current;
    if (!textarea) return;
    draftFloorRef.current = sizeDraft(
      textarea,
      visualViewport.height || dockHeight,
    );
    scheduleReserveRef.current?.();
  }, [
    attachmentError,
    attachmentNotice,
    attachmentStages.length,
    attachments.length,
    dockHeight,
    input,
    sendBlockedReason,
    sendFailureNotice,
    queuedRetryText,
    textareaRef,
    visualViewport.height,
  ]);

  // A producer that unmounts while focused never fires blur; without this
  // the context stays true globally and every {not:'composerFocused'}
  // shortcut stays dead.
  useEffect(() => () => setShortcutContext('composerFocused', false), []);

  return (
    <div className="chat-input" ref={composerRootRef}>
      {modelQuery !== null && !input.startsWith('/model ') && (
        <ResponsiveDialogSurface
          layer="popover"
          ariaLabel="Model"
          onClose={onModelClose}
          historyMode="entry"
          anchorRef={modelButtonRef}
          overlayClassName="composer-popover-overlay composer-popover-overlay--start"
          panelClassName="composer-popover-panel chat-input__model-popover-panel"
        >
          {availableModels.length === 0 ? (
            modelsLoading ? (
              // The wrapper keeps its class: index.css uses it to supply the
              // popover's border/radius/shadow while the picker's own chunk
              // (and chat.css) is still loading.
              <div className="session-model-picker__loading">
                <SkeletonList
                  count={3}
                  withIcon={false}
                  label="Loading models"
                />
              </div>
            ) : (
              <React.Suspense
                fallback={<SkeletonBlock label="Model options" />}
              >
                <ModelCatalogUnavailableState stale={modelsStale} />
              </React.Suspense>
            )
          ) : (
            <React.Suspense
              fallback={
                <div className="session-model-picker__loading">
                  <SkeletonList
                    count={3}
                    withIcon={false}
                    label="Loading models"
                  />
                </div>
              }
            >
              <SessionModelPicker
                models={availableModels}
                stale={modelsStale}
                providers={modelProviders}
                currentProviderId={currentProviderId}
                currentModel={currentModel}
                defaultModel={agentDefaultModel}
                defaultSourceLabel={
                  defaultModelSource
                    ? modelSourceLabel(defaultModelSource).toLowerCase()
                    : 'default model'
                }
                runtimeOptions={modelRuntimeOptions}
                onSelect={onModelSelect}
                onReset={onModelReset}
                onRuntimeOptionChange={onModelRuntimeOptionChange}
                onClose={onModelClose}
              />
            </React.Suspense>
          )}
        </ResponsiveDialogSurface>
      )}

      {/* Settings stay in a scrollable rail; activity and reader controls move together. */}
      <div className="chat-input__meta">
        <div className="chat-input__settings">
          {onOpenAgentHandoff && (
            <button
              ref={agentHandoffTriggerRef}
              type="button"
              className="choice-trigger chat-input__agent-btn"
              onClick={agentHandoffDisabled ? undefined : onOpenAgentHandoff}
              aria-disabled={agentHandoffDisabled}
              aria-haspopup="dialog"
              aria-label={agentAccessibleLabel}
              title={agentAccessibleLabel}
            >
              <span className="chat-input__chip-stack">
                <span className="chat-input__chip-caption" aria-hidden="true">
                  Agent
                </span>
                <span className="chat-input__agent-name">
                  {agentLabel ?? 'Current Agent'}
                </span>
              </span>
              <ArrowDownGlyph className="choice-caret" />
            </button>
          )}
          <button
            ref={modelButtonRef}
            type="button"
            onClick={canModelSelect ? onModelOpen : undefined}
            aria-disabled={!canModelSelect}
            className={`choice-trigger chat-input__model-btn ${isOverride ? 'chat-input__model-btn--override' : 'chat-input__model-btn--default'}`}
            aria-haspopup="dialog"
            aria-expanded={modelQuery !== null && !input.startsWith('/model ')}
            aria-label={modelAccessibleLabel}
            title={modelAccessibleLabel}
          >
            <span className="chat-input__chip-stack">
              <span className="chat-input__chip-caption" aria-hidden="true">
                Model
              </span>
              <span className="chat-input__model-name" aria-hidden="true">
                {modelLabel}
              </span>
            </span>
            <ArrowDownGlyph className="choice-caret" />
          </button>
          {isOverride && (
            <button
              type="button"
              className="chat-input__model-reset"
              onClick={onModelReset}
              title="Reset this chat to its default model"
            >
              Use{' '}
              {defaultModelSource
                ? modelSourceLabel(defaultModelSource).toLowerCase()
                : 'default'}
            </button>
          )}
          {acpSessionModes.length > 0 && onAcpSessionModeChange ? (
            <React.Suspense fallback={null}>
              <AcpSessionModeChip
                key={sessionId}
                modes={acpSessionModes}
                currentModeId={
                  typeof modelRuntimeOptions?.mode === 'string'
                    ? modelRuntimeOptions.mode
                    : acpCurrentModeId
                }
                onChange={onAcpSessionModeChange}
              />
            </React.Suspense>
          ) : (
            executionMode === EXECUTION_MODE.EXTERNAL &&
            approvalModeKnobSupported(agentConnectionId) && (
              <ApprovalModeChip
                // Structural reset (not blur-dependent) for the chip's local
                // confirm state when the active session changes — this
                // subtree persists across session switches with no natural
                // remount otherwise (archive#727 3).
                key={sessionId}
                engineConnectionId={agentConnectionId}
                toolPolicyDelivery={toolPolicyDelivery}
                sessionOverride={approvalModeOverride?.mode}
                sessionOverrideState={approvalModeOverride?.state}
                agentDefault={approvalModeAgentDefault}
                stationDefault={approvalModeStationDefault}
                lastAppliedApprovalMode={lastAppliedApprovalMode}
                onChange={onApprovalModeChange}
              />
            )
          )}
        </div>
        <div className="chat-input__activity" ref={activityRef}>
          {activity}
        </div>
      </div>

      <div className="chat-input__capsule">
        <fieldset
          className="chat-input__textarea-wrapper"
          aria-label="Message composer"
        >
          {(attachments.length > 0 || attachmentStages.length > 0) && (
            <React.Suspense
              fallback={<SkeletonBlock label="Attachment controls" />}
            >
              <ComposerAttachmentStrip
                attachments={attachments}
                stages={attachmentStages}
                onRemove={onRemoveAttachment}
                onRetry={onRetryAttachmentStage}
                onCancel={onCancelAttachmentStage}
                onReplaceFile={onReplaceAttachmentFile}
                imagesRefused={!modelSupportsAttachments}
              />
            </React.Suspense>
          )}
          {/* Attachment state sits right under the chips it is about, above
              the draft: in a short dock the draft is what shrinks, so the
              reason Send is blocked (and its fix) stays visible. */}
          {attachmentError && (
            <div className="chat-input__attachment-error" role="alert">
              {attachmentError}
            </div>
          )}
          {sendBlockedReason && !attachmentError && (
            <div
              id={`composer-attachment-send-gate-${sessionId}`}
              className="chat-input__attachment-error"
              role="status"
            >
              {sendBlockedReason}
              {removalUnblocksSend && (
                <span className="chat-input__blocked-actions">
                  <button
                    type="button"
                    className="chat-input__blocked-action"
                    onClick={onClearAttachments}
                  >
                    Remove attachments
                  </button>
                </span>
              )}
            </div>
          )}
          {attachmentNotice && !sendBlockedReason && !attachmentError && (
            <div className="chat-input__attachment-notice" role="status">
              {attachmentNotice}
            </div>
          )}
          {sendFailureNotice && (
            <div className="chat-input__send-failure" role="status">
              {sendFailureNotice}
            </div>
          )}
          {composerTokens.length > 0 && (
            <React.Suspense
              fallback={
                <button type="button" disabled aria-label="Loading attachments">
                  Attach
                </button>
              }
            >
              <ComposerMentionChips
                value={input}
                onChange={(next) => {
                  onInputChange(next);
                  updateFromInput(next);
                }}
                onFocusInput={() => textareaRef.current?.focus()}
                tokens={composerTokens}
              />
            </React.Suspense>
          )}
          {mentionQuery && mentionLocation && mentionRequestScope && (
            <div>
              <React.Suspense
                fallback={
                  <div className="file-mention-picker__status">
                    Finding files…
                  </div>
                }
              >
                <FileMentionAutocomplete
                  location={mentionLocation}
                  requestScope={mentionRequestScope}
                  query={mentionQuery.query}
                  listboxId={mentionListboxId}
                  keyboardController={mentionKeyboardController}
                  onActiveDescendantChange={setMentionActiveDescendant}
                  onSelect={(entry) => {
                    const generation = mentionGeneration.current;
                    const next = insertComposerMention(
                      input,
                      mentionQuery.start,
                      mentionQuery.end,
                      {
                        label: entry.name,
                        path: entry.path,
                        workspace: mentionLocation.workingDir,
                        authority: mentionAuthority ?? '',
                        type: entry.type,
                      },
                    );
                    onInputChange(next);
                    updateFromInput(next);
                    setMentionQuery(null);
                    requestAnimationFrame(() => {
                      if (mentionGeneration.current !== generation) return;
                      const textarea = textareaRef.current;
                      if (!textarea) return;
                      textarea.focus();
                      const cursor = mentionQuery.start + entry.name.length + 2;
                      textarea.setSelectionRange(cursor, cursor);
                    });
                  }}
                />
              </React.Suspense>
            </div>
          )}
          {modelQuery !== null && input.startsWith('/model ') && (
            <React.Suspense fallback={null}>
              <ModelSelectorAutocomplete
                query={modelQuery}
                models={availableModels.map((m) => ({
                  ...m,
                  originalId: m.originalId || m.id,
                }))}
                currentModel={currentModel}
                agentDefaultModel={agentDefaultModel}
                anchorRef={textareaRef}
                onSelect={onModelSelect}
                onClose={onModelClose}
              />
            </React.Suspense>
          )}
          {commandQuery !== null && (
            <React.Suspense fallback={null}>
              <SlashCommandSelector
                query={commandQuery}
                commands={slashCommands}
                anchorRef={textareaRef}
                onSelect={onCommandSelect}
                onClose={onCommandClose}
              />
            </React.Suspense>
          )}
          <textarea
            ref={textareaRef}
            aria-autocomplete={
              mentionAutocompleteAvailable ? 'list' : undefined
            }
            aria-haspopup={mentionAutocompleteAvailable ? 'listbox' : undefined}
            aria-controls={
              mentionAutocompleteOpen ? mentionListboxId : undefined
            }
            aria-activedescendant={
              mentionAutocompleteOpen ? mentionActiveDescendant : undefined
            }
            placeholder={placeholder}
            value={displayInput}
            disabled={disabled && !allowDraftWhileDisabled}
            tabIndex={0}
            onFocus={() => {
              setShortcutContext('composerFocused', true);
              updateFromInput(input);
            }}
            onBlur={() => {
              setShortcutContext('composerFocused', false);
              closeAll();
            }}
            onChange={(e) => {
              const next = reconcileComposerDisplay(input, e.target.value);
              onInputChange(next);
              updateFromInput(next);
              const cursor = e.target.selectionStart ?? e.target.value.length;
              const trigger =
                mentionLocation && mentionRequestScope
                  ? mentionQueryAt(next, cursor)
                  : null;
              setMentionQuery(trigger ? { ...trigger, end: cursor } : null);
            }}
            onPaste={(event) => {
              const files = filesFromDataTransfer(event.clipboardData);
              if (files.length === 0) return;
              event.preventDefault();
              void selectAttachmentFiles(files);
            }}
            onDragOver={(event) => {
              if (
                !event.dataTransfer.types.includes(
                  CONVERSATION_REFERENCE_DRAG_TYPE,
                )
              )
                return;
              const conversationId = event.dataTransfer.getData(
                CONVERSATION_REFERENCE_DRAG_TYPE,
              );
              const candidate =
                draggedSessionReference.current?.id === conversationId &&
                draggedSessionReference.current.ownerKey ===
                  sessionReferenceOwnerKey
                  ? draggedSessionReference.current
                  : draggedConversationReference(
                      conversationId,
                      mentionRequestScope,
                    );
              if (
                (!conversationId || candidate) &&
                !sessionReferenceBlockReason({
                  value: input,
                  conversationId: conversationId || '__dragged__',
                  activeConversationId,
                  authority: mentionAuthority,
                  isCurrent: mentionRequestScope?.isCurrent,
                })
              )
                event.preventDefault();
            }}
            onDrop={(event) => {
              const conversationId = event.dataTransfer.getData(
                CONVERSATION_REFERENCE_DRAG_TYPE,
              );
              if (!conversationId) return;
              event.preventDefault();
              // The picker's own drag, or an Activity or inbox row this
              // window is dragging from the same Station access scope.
              const candidate =
                draggedSessionReference.current?.id === conversationId &&
                draggedSessionReference.current.ownerKey ===
                  sessionReferenceOwnerKey
                  ? draggedSessionReference.current
                  : draggedConversationReference(
                      conversationId,
                      mentionRequestScope,
                    );
              draggedSessionReference.current = null;
              endConversationReferenceDrag();
              if (!candidate) return;
              const reason = sessionReferenceBlockReason({
                value: input,
                conversationId,
                activeConversationId,
                authority: mentionAuthority,
                isCurrent: mentionRequestScope?.isCurrent,
              });
              if (reason) return;
              const next = appendComposerSessionReference(input, {
                label: candidate.title || 'Conversation',
                conversationId,
                projectSlug: candidate.projectSlug,
                authority: mentionAuthority!,
              });
              onInputChange(next);
              updateFromInput(next);
              setSessionReferencesOpen(false);
              textareaRef.current?.focus();
            }}
            onKeyDown={async (e) => {
              if (isComposing.current || isComposingKeyEvent(e)) return;
              if (e.defaultPrevented) return;

              if (
                mentionQuery &&
                (e.key === 'ArrowDown' ||
                  e.key === 'ArrowUp' ||
                  (e.key === 'Enter' && !e.shiftKey))
              ) {
                const handled =
                  mentionKeyboardController.current?.(
                    e.key as 'ArrowDown' | 'ArrowUp' | 'Enter',
                  ) ?? false;
                if (handled || e.key !== 'Enter') {
                  e.preventDefault();
                  return;
                }
              }

              if (isPortableDraftShortcut(e)) {
                e.preventDefault();
                setPortableDraftsOpen(true);
                return;
              }

              if (
                !e.shiftKey &&
                e.currentTarget.selectionStart === e.currentTarget.selectionEnd
              ) {
                const cursor = e.currentTarget.selectionStart;
                const adjacentMention = composerTokens.find((mention) => {
                  if (e.key === 'Backspace')
                    return cursor === mention.displayEnd;
                  if (e.key === 'Delete')
                    return cursor === mention.displayStart;
                  if (e.key === 'ArrowLeft')
                    return (
                      cursor > mention.displayStart &&
                      cursor <= mention.displayEnd
                    );
                  if (e.key === 'ArrowRight')
                    return (
                      cursor >= mention.displayStart &&
                      cursor < mention.displayEnd
                    );
                  return false;
                });
                if (adjacentMention) {
                  e.preventDefault();
                  if (e.key === 'Backspace' || e.key === 'Delete') {
                    const next = `${input.slice(0, adjacentMention.canonicalStart)}${input.slice(adjacentMention.canonicalEnd)}`;
                    onInputChange(next);
                    updateFromInput(next);
                  }
                  const nextCursor =
                    e.key === 'ArrowRight'
                      ? adjacentMention.displayEnd
                      : adjacentMention.displayStart;
                  requestAnimationFrame(() =>
                    textareaRef.current?.setSelectionRange(
                      nextCursor,
                      nextCursor,
                    ),
                  );
                  return;
                }
              }

              if (
                e.key === 'Escape' &&
                (commandQuery !== null ||
                  modelQuery !== null ||
                  mentionQuery !== null)
              ) {
                e.preventDefault();
                closeAll();
                setMentionQuery(null);
                return;
              }

              if (e.key === 'Tab' && !e.shiftKey) return;

              if (e.key === 'ArrowUp' && !input.includes('\n')) {
                e.preventDefault();
                onHistoryUp();
                return;
              }

              if (e.key === 'ArrowDown' && !input.includes('\n')) {
                e.preventDefault();
                onHistoryDown();
                return;
              }

              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.altKey &&
                (e.ctrlKey || e.metaKey || returnSends)
              ) {
                e.preventDefault();
                if (workspaceRefused && !isOverLimit) {
                  await onStartNewChat?.(input, attachments);
                } else if (
                  (input.trim() || hasQuotedContext) &&
                  !isOverLimit &&
                  !sendBlockedReason &&
                  !disabled
                )
                  await submit();
              }
            }}
            onCompositionStart={() => {
              isComposing.current = true;
            }}
            onCompositionEnd={() => {
              isComposing.current = false;
            }}
            style={
              {
                '--composer-font-size': `${fontSize}px`,
                resize: 'none',
                minHeight: 0,
              } as React.CSSProperties
            }
          />
          {isOverLimit && (
            <div className="chat-input__attachment-error" role="alert">
              {overLimitBy.toLocaleString('en-US')} characters over the limit
              &mdash; remove that many to send
            </div>
          )}
          {voiceState === 'error' && voiceError && (
            <div className="chat-input__attachment-error" role="alert">
              {voiceError}
            </div>
          )}
        </fieldset>
        <div className="chat-controls-row">
          {secondaryActions && (
            <ComposerActionsMenu
              {...secondaryActions}
              onOpenConversationReference={
                mentionAuthority && mentionRequestScope?.isCurrent() === true
                  ? () => setSessionReferencesOpen(true)
                  : undefined
              }
            />
          )}
          <React.Suspense fallback={null}>
            <FileAttachmentInput
              attachments={attachments}
              onFilesSelected={selectAttachmentFiles}
              onRemove={onRemoveAttachment}
              onClearAll={onClearAttachments}
              disabled={
                disabled ||
                isSending ||
                (!modelSupportsAttachments && !fileAttachmentsSupported)
              }
              supportsImages={modelSupportsAttachments}
              supportsFiles={fileAttachmentsSupported}
              unavailableReason={
                disabled || isSending ? undefined : attachUnavailableReason
              }
              onUnavailable={onAttachUnavailable}
            />
          </React.Suspense>
          {voiceState !== undefined && onVoiceStart && onVoiceStop && (
            <VoiceOrb
              state={voiceState}
              supported={voiceSupported ?? false}
              unsupportedReason={voiceUnsupportedReason}
              disabled={disabled || isSending}
              onStart={onVoiceStart}
              onStop={onVoiceStop}
            />
          )}
          <React.Suspense fallback={null}>
            <PortableDraftsMenu
              input={input}
              quotes={quoteContext}
              attachments={attachments}
              open={portableDraftsOpen}
              onOpenChange={setPortableDraftsOpen}
              onRestore={(draft) => {
                onRestorePortableDraft?.(
                  draft.text,
                  draft.attachments,
                  draft.quotes,
                );
              }}
            />
          </React.Suspense>
          {input && (
            <ComposerIconAction
              label="Clear message"
              className="chat-input__clear"
              onClick={onClearInput}
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
              </svg>
            </ComposerIconAction>
          )}
          {queuedRetryNotice && (
            <span className="chat-input__queued-retry-actions">
              <button
                type="button"
                aria-describedby={queuedRetryDescriptionId}
                onClick={queuedRetryNotice.onDiscard}
              >
                Discard
              </button>
              <span id={queuedRetryDescriptionId} className="sr-only">
                {queuedRetryNotice.text}
              </span>
            </span>
          )}
          <span className="chat-controls-row__spacer" />
          <div className="chat-input__send-group">
            {turnInFlight && (
              <ComposerStopButton
                onCancel={onCancel}
                stopPending={stopPending}
              />
            )}
            <div
              className="chat-input__submit-controls"
              aria-hidden={hideMobileSubmit || undefined}
              data-concealed={hideMobileSubmit || undefined}
            >
              <button
                type="button"
                onClick={async () => {
                  if (workspaceRefused && !isOverLimit) {
                    await onStartNewChat?.(input, attachments);
                  } else if (
                    (input.trim() ||
                      hasQuotedContext ||
                      attachments.length > 0) &&
                    !isOverLimit
                  ) {
                    await submit();
                  }
                }}
                onKeyDown={(e) => {
                  if (
                    !disabled &&
                    e.key === 'Enter' &&
                    !isOverLimit &&
                    (workspaceRefused ||
                      input.trim() ||
                      hasQuotedContext ||
                      attachments.length > 0)
                  ) {
                    e.preventDefault();
                    if (workspaceRefused) {
                      void onStartNewChat?.(input, attachments);
                    } else {
                      void submit();
                    }
                  }
                }}
                disabled={
                  disabled ||
                  submitting ||
                  isOverLimit ||
                  !!sendBlockedReason ||
                  (workspaceRefused
                    ? !onStartNewChat
                    : !input.trim() &&
                      !hasQuotedContext &&
                      attachments.length === 0)
                }
                tabIndex={hideMobileSubmit ? -1 : 0}
                aria-label={workspaceRefused ? 'Start new chat' : 'Send'}
                aria-describedby={
                  sendBlockedReason
                    ? `composer-attachment-send-gate-${sessionId}`
                    : undefined
                }
                title={
                  workspaceRefused
                    ? 'Start new chat'
                    : (sendBlockedReason ?? 'Send')
                }
                className={`send-button chat-input__send-btn ${
                  !isOverLimit &&
                  // A blocked Send is disabled; it must not keep the active
                  // accent that reads as "ready".
                  !sendBlockedReason &&
                  (
                    workspaceRefused ||
                      input.trim() ||
                      hasQuotedContext ||
                      attachments.length > 0
                  )
                    ? 'chat-input__send-btn--active'
                    : 'chat-input__send-btn--inactive'
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
                <span className="chat-input__send-label">Send</span>
              </button>
              {turnInFlight && onQueueFollowUp && (
                <button
                  type="button"
                  className="choice-trigger chat-input__send-mode"
                  aria-label={`Send mode: ${sendMode === 'steer' && busyFollowUp === 'steer' ? 'Steer' : 'Queue'}`}
                  title={`Send mode: ${sendMode === 'steer' && busyFollowUp === 'steer' ? 'Steer' : 'Queue'}`}
                  tabIndex={hideMobileSubmit ? -1 : 0}
                  aria-haspopup="dialog"
                  aria-expanded={sendModeOpen}
                  onClick={() => setSendModeOpen(true)}
                >
                  <span className="chat-input__mode-label">
                    {sendMode === 'steer' && busyFollowUp === 'steer'
                      ? 'Steer'
                      : 'Queue'}
                  </span>
                  <ArrowDownGlyph />
                </button>
              )}
              {!(turnInFlight && onQueueFollowUp) && (
                <span className="chat-input__mode-slot" aria-hidden="true" />
              )}
            </div>
          </div>
          {sendModeOpen && (
            <ResponsiveDialogSurface
              layer="popover"
              ariaLabel="Send mode"
              onClose={() => setSendModeOpen(false)}
              overlayClassName="composer-popover-overlay composer-popover-overlay--end"
              panelClassName="composer-popover-panel"
            >
              <Button
                variant="ghost"
                className="chat-input__mode-option"
                type="button"
                onClick={() => {
                  setSendMode('queue');
                  setSendModeOpen(false);
                }}
              >
                Queue for next turn
              </Button>
              <Button
                variant="ghost"
                className="chat-input__mode-option"
                type="button"
                disabled={busyFollowUp !== 'steer'}
                onClick={() => {
                  setSendMode('steer');
                  setSendModeOpen(false);
                }}
              >
                {busySteeringKind === 'native'
                  ? 'Steer this turn'
                  : 'Steer when safe'}
              </Button>
            </ResponsiveDialogSurface>
          )}
        </div>
        {sessionReferencesOpen && (
          <React.Suspense
            fallback={<SkeletonBlock label="Conversation reference picker" />}
          >
            <SessionReferencePicker
              value={input}
              activeConversationId={activeConversationId}
              authority={mentionAuthority}
              requestScope={mentionRequestScope}
              onChange={(next) => {
                onInputChange(next);
                updateFromInput(next);
              }}
              onClose={() => setSessionReferencesOpen(false)}
              onCandidateDragged={(candidate) =>
                (draggedSessionReference.current = candidate
                  ? { ...candidate, ownerKey: sessionReferenceOwnerKey }
                  : null)
              }
            />
          </React.Suspense>
        )}
      </div>
    </div>
  );
}
