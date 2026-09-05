import type { ToolPolicyDelivery } from '@kontourai/station-contracts/engine-capability-matrix';
import {
  EXECUTION_MODE,
  type ExecutionMode,
} from '@kontourai/station-contracts/tool';
import type { STTState as VoiceState } from '@kontourai/station-sdk';
import { CHAT_INPUT_MAX_CHARS } from '@shared/chat-input-limits';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { setShortcutContext } from '../../contexts/KeyboardShortcutsContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import type { SlashCommand } from '../../hooks/useSlashCommands';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import type {
  ComposerAttachmentStageSnapshot,
  FileAttachment,
} from '../../types';
import type { ApprovalMode } from '../../utils/approvalMode';
import { filesFromDataTransfer } from '../../utils/attachment-file-transfer';
import {
  type EffectiveModelSource,
  modelSourceLabel,
} from '../../utils/execution';
import {
  type ModelProviderOption,
  resolvedModelLabel,
  type SelectableModel,
} from '../../utils/modelCapabilities';
import { ApprovalModeChip } from '../badges/ApprovalModeChip';
import {
  ComposerActionsMenu,
  type ComposerActionsMenuProps,
} from '../chat-dock/ComposerActionsMenu';
import { ArrowDownGlyph } from '../icons/Glyph';
import { ModelSelectorAutocomplete } from '../ModelSelector';
import { ResponsiveDialogSurface } from '../ResponsiveDialogSurface';
import { VoiceOrb } from '../voice/VoiceOrb';
import { ComposerAttachmentStrip } from './ComposerAttachmentStrip';
import { FileAttachmentInput } from './FileAttachmentInput';
import { SlashCommandSelector } from './SlashCommandSelector';
import './chat.css';
import { ModelCatalogUnavailableState } from '../session/ModelCatalogUnavailableState';
import { SkeletonList } from '../state';

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

export function isPortableDraftShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return event.key === 's' && (event.metaKey || event.ctrlKey);
}

interface ChatInputAreaProps {
  // Session info
  /**
   * The active chat session's stable identity (thread id) — used only to
   * key the approval-mode chip so its local confirm state resets on a
   * session switch instead of leaking onto the newly active session
   * (archive#727 3). Not otherwise read by this component.
   */
  sessionId?: string;
  // Input state
  input: string;
  attachments: FileAttachment[];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  // Status
  disabled: boolean;
  isSending: boolean;
  /**
   * A turn is outstanding — see `isTurnInFlight` (active-chats-state.ts) for
   * the derivation. Renamed from `hasAbortController` in the fix:
   * the old name WAS the defect, because holding a browser abort controller
   * stopped being true seconds into a turn that ran for minutes.
   */
  turnInFlight: boolean;
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
  approvalModeConnectionDefault?: unknown;
  toolPolicyDelivery?: ToolPolicyDelivery;
  lastAppliedApprovalMode?: unknown;
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
  attachmentStages?: ComposerAttachmentStageSnapshot[];
  sendBlockedReason?: string;
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
  onCommandSelect: (command: SlashCommand) => Promise<void>;
  onCommandClose: () => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  onRestorePortableDraft?: (
    text: string,
    attachments: FileAttachment[],
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

export function ChatInputArea({
  sessionId,
  input,
  attachments,
  textareaRef,
  disabled,
  isSending,
  turnInFlight,
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
  approvalModeConnectionDefault,
  toolPolicyDelivery,
  lastAppliedApprovalMode,
  commandQuery,
  slashCommands,
  onInputChange,
  onSend,
  onCancel,
  onClearInput,
  selectAttachmentFiles = async () => {},
  attachmentError = null,
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
  const [portableDraftsOpen, setPortableDraftsOpen] = useState(false);
  const isComposing = useRef(false);
  // Anchors the model picker popover to its trigger on desktop (archive#999).
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const visualViewport = useMobileVisualViewport();
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
  const modelLabel = resolvedLabel ?? aliasLabel;
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
  const fullModelIdentity = resolvedLabel
    ? `${aliasLabel} → ${resolvedLabel}`
    : modelLabel;
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
  const safeMaxHeight = Math.max(dockHeight - 200, 120);
  const isMobile = useIsMobile();
  // A turn is in flight, so this send queues behind it rather than starting
  // one. Say so in the placeholder instead of letting "Type a message" imply
  // the agent is idle — Station really does queue (see QueuedMessages).
  const placeholder = workspaceRefused
    ? 'This conversation continues from its original workspace — start a new chat to work here'
    : turnInFlight
      ? 'Queue a follow-up...'
      : isMobile
        ? 'Type a message...'
        : 'Type a message... (Enter to send, Shift+Enter for new line)';

  // archive#2807: the draft's size against the same limit every server
  // turn-starting schema derives from (chatSchema AND the orchestration
  // seam this composer actually posts to). A courtesy check only — the
  // server is the authority — but it lets the composer say exactly how
  // much to remove instead of letting the turn fail as a provider error.
  const overLimitBy = input.length - CHAT_INPUT_MAX_CHARS;
  const isOverLimit = overLimitBy > 0;

  useLayoutEffect(() => {
    // Value changes are a resize trigger even though the measurement reads DOM.
    void input;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = 'auto';
      const availableHeight = visualViewport.height || dockHeight;
      const maxHeight = Math.min(160, Math.max(88, availableHeight * 0.3));
      const height = Math.min(textarea.scrollHeight, maxHeight);
      textarea.style.height = `${height}px`;
      textarea.style.overflowY =
        textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    };
    resize();
  }, [dockHeight, input, textareaRef, visualViewport.height]);

  // A producer that unmounts while focused never fires blur; without this
  // the context stays true globally and every {not:'composerFocused'}
  // shortcut stays dead.
  useEffect(() => () => setShortcutContext('composerFocused', false), []);

  return (
    <div className="chat-input">
      {modelQuery !== null && !input.startsWith('/model ') && (
        <ResponsiveDialogSurface
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
              <ModelCatalogUnavailableState stale={modelsStale} />
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

      {/* Session state, as pills above the input rather than peers of Send.
          The rail scrolls instead of wrapping — wrapping is what used to push
          Send onto a fourth row and off the bottom of a phone screen. */}
      <div className="chat-input__meta">
        {onOpenAgentHandoff && (
          <button
            ref={agentHandoffTriggerRef}
            type="button"
            className="chat-input__agent-btn"
            onClick={agentHandoffDisabled ? undefined : onOpenAgentHandoff}
            aria-disabled={agentHandoffDisabled}
            aria-haspopup="dialog"
            aria-label={agentAccessibleLabel}
            title={agentAccessibleLabel}
          >
            <span className="chat-input__agent-name">
              {agentLabel ?? 'Current Agent'}
            </span>
            <ArrowDownGlyph className="chat-input__choice-caret" />
          </button>
        )}
        <button
          ref={modelButtonRef}
          type="button"
          onClick={canModelSelect ? onModelOpen : undefined}
          aria-disabled={!canModelSelect}
          className={`chat-input__model-btn ${isOverride ? 'chat-input__model-btn--override' : 'chat-input__model-btn--default'}`}
          aria-haspopup="dialog"
          aria-expanded={modelQuery !== null && !input.startsWith('/model ')}
          aria-label={modelAccessibleLabel}
          title={modelAccessibleLabel}
        >
          <span className="chat-input__model-name" aria-hidden="true">
            {modelLabel}
          </span>
          <ArrowDownGlyph className="chat-input__choice-caret" />
        </button>
        {isOverride && (
          <button
            type="button"
            className="chat-input__model-reset"
            onClick={onModelReset}
            title="Reset this session to its default model"
          >
            Use{' '}
            {defaultModelSource
              ? modelSourceLabel(defaultModelSource).toLowerCase()
              : 'default'}
          </button>
        )}
        {executionMode === EXECUTION_MODE.EXTERNAL && (
          <ApprovalModeChip
            // Structural reset (not blur-dependent) for the chip's local
            // confirm state when the active session changes — this
            // subtree persists across session switches with no natural
            // remount otherwise (archive#727 3).
            key={sessionId}
            engineConnectionId={agentConnectionId}
            toolPolicyDelivery={toolPolicyDelivery}
            sessionOverride={modelRuntimeOptions?.approvalMode}
            connectionDefault={approvalModeConnectionDefault}
            lastAppliedApprovalMode={lastAppliedApprovalMode}
            onChange={onApprovalModeChange}
          />
        )}
      </div>

      <div className="chat-input__capsule">
        <fieldset
          className="chat-input__textarea-wrapper"
          aria-label="Message composer"
        >
          <ComposerAttachmentStrip
            attachments={attachments}
            stages={attachmentStages}
            onRemove={onRemoveAttachment}
            onRetry={onRetryAttachmentStage}
            onCancel={onCancelAttachmentStage}
            onReplaceFile={onReplaceAttachmentFile}
          />
          {modelQuery !== null && input.startsWith('/model ') && (
            <ModelSelectorAutocomplete
              query={modelQuery}
              models={availableModels.map((m) => ({
                ...m,
                originalId: m.originalId || m.id,
              }))}
              currentModel={currentModel}
              agentDefaultModel={agentDefaultModel}
              maxHeight={`${safeMaxHeight}px`}
              onSelect={onModelSelect}
              onClose={onModelClose}
            />
          )}
          {commandQuery !== null && (
            <SlashCommandSelector
              query={commandQuery}
              commands={slashCommands}
              maxHeight={`${safeMaxHeight}px`}
              onSelect={onCommandSelect}
              onClose={onCommandClose}
            />
          )}
          <textarea
            ref={textareaRef}
            placeholder={placeholder}
            value={input}
            disabled={disabled}
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
              onInputChange(e.target.value);
              updateFromInput(e.target.value);
            }}
            onPaste={(event) => {
              const files = filesFromDataTransfer(event.clipboardData);
              if (files.length === 0) return;
              event.preventDefault();
              void selectAttachmentFiles(files);
            }}
            onKeyDown={async (e) => {
              if (e.defaultPrevented) return;

              if (isPortableDraftShortcut(e)) {
                e.preventDefault();
                setPortableDraftsOpen(true);
                return;
              }

              if (
                e.key === 'Escape' &&
                (commandQuery !== null || modelQuery !== null)
              ) {
                e.preventDefault();
                closeAll();
                return;
              }

              if (e.key === 'Tab' && !e.shiftKey) return;

              if (e.key === 'ArrowUp') {
                e.preventDefault();
                onHistoryUp();
                return;
              }

              if (e.key === 'ArrowDown') {
                e.preventDefault();
                onHistoryDown();
                return;
              }

              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !isComposing.current &&
                !isComposingKeyEvent(e)
              ) {
                e.preventDefault();
                if (workspaceRefused && !isOverLimit) {
                  await onStartNewChat?.(input, attachments);
                } else if (input.trim() && !isOverLimit && !sendBlockedReason)
                  await onSend();
              }
            }}
            onCompositionStart={() => {
              isComposing.current = true;
            }}
            onCompositionEnd={() => {
              isComposing.current = false;
            }}
            style={{
              fontSize: `${fontSize}px`,
              flex: 1,
              resize: 'none',
              minHeight: 0,
            }}
          />

          {input && (
            <button
              type="button"
              onClick={onClearInput}
              className="chat-input__clear"
              aria-label="Clear input"
              title="Clear input"
            >
              ×
            </button>
          )}
          {isOverLimit && (
            <div className="chat-input__attachment-error" role="alert">
              {overLimitBy.toLocaleString('en-US')} characters over the limit
              &mdash; remove that many to send
            </div>
          )}
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
            </div>
          )}
          {voiceState === 'error' && voiceError && (
            <div className="chat-input__attachment-error" role="alert">
              {voiceError}
            </div>
          )}
        </fieldset>
        <div className="chat-controls-row">
          {secondaryActions && <ComposerActionsMenu {...secondaryActions} />}
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
          />
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
              attachments={attachments}
              open={portableDraftsOpen}
              onOpenChange={setPortableDraftsOpen}
              onRestore={(draft) => {
                onRestorePortableDraft?.(draft.text, draft.attachments);
              }}
            />
          </React.Suspense>
          <span className="chat-controls-row__spacer" />
          {turnInFlight ? (
            <button
              type="button"
              onClick={onCancel}
              tabIndex={0}
              disabled={stopPending}
              aria-busy={stopPending || undefined}
              className="send-button chat-input__stop-btn"
              aria-label={
                stopPending
                  ? 'Stop requested — waiting for the engine'
                  : 'Stop the current turn'
              }
              title={
                stopPending
                  ? 'Stop requested — waiting for the engine'
                  : 'Stop the current turn'
              }
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                aria-hidden="true"
                focusable="false"
              >
                <rect x="7" y="7" width="10" height="10" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={async () => {
                if (workspaceRefused && !isOverLimit) {
                  await onStartNewChat?.(input, attachments);
                } else if (
                  (input.trim() || attachments.length > 0) &&
                  !isOverLimit
                ) {
                  await onSend();
                }
              }}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !isOverLimit &&
                  (workspaceRefused || input.trim() || attachments.length > 0)
                ) {
                  e.preventDefault();
                  if (workspaceRefused) {
                    void onStartNewChat?.(input, attachments);
                  } else {
                    void onSend();
                  }
                }
              }}
              disabled={
                isOverLimit ||
                !!sendBlockedReason ||
                (workspaceRefused
                  ? !onStartNewChat
                  : !input.trim() && attachments.length === 0)
              }
              tabIndex={0}
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
                (workspaceRefused || input.trim() || attachments.length > 0)
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
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
