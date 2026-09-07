import {
  ACP_MODEL_OVERRIDE_PER_TURN,
  resolveEngineCapabilityMatrix,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { EXECUTION_MODE } from '@kontourai/station-contracts/tool';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildLastChosenModelBindingKey,
  isProviderManagedAgent,
} from '../components/modals/new-chat-modal-utils';
import {
  type ChatUIState,
  useActiveChatActions,
  useActiveChatSelector,
} from '../contexts/ActiveChatsContext';
import { useAgent } from '../contexts/AgentsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import { useToast } from '../contexts/ToastContext';
import { resolveTurnModel } from '../lib/turnModel';
import type { FileAttachment } from '../types';
import type { ApprovalMode } from '../utils/approvalMode';
import { approvalModeLabel } from '../utils/approvalMode';
import {
  type BindingStatus,
  type EffectiveModelSource,
  resolveBindingStatus,
} from '../utils/execution';
import {
  type SelectableModel,
  sanitizeRuntimeOptionsForModel,
} from '../utils/modelCapabilities';
import { sanitizeChatInput } from '../utils/sanitizeChatInput';
import { clearLastChosenModel } from './lastChosenModel';
import { describeStopTurnOutcome } from './useActiveChatSessionMessaging';
import { useCancelMessage, useSendMessage } from './useActiveChatSessions';
import { useAutocompleteState } from './useAutocompleteState';
import { useComposerAttachments } from './useComposerAttachments';
import { useSlashCommandHandler } from './useSlashCommandHandler';
import type { SlashCommand } from './useSlashCommands';
import { useSlashCommands } from './useSlashCommands';

// The composer only ever reads this subset of ChatUIState (see the reads
// below plus resolveBindingStatus's/useSlashCommands' chatState params).
// Selecting just these fields — instead of the whole session via
// useActiveChatState — means an unrelated field changing elsewhere in the
// session (e.g. `messages` growing while streaming) no longer forces this
// hook, and the components that call it, to recompute.
type ComposerChatSlice = Pick<
  ChatUIState,
  | 'input'
  | 'attachments'
  | 'attachmentStages'
  | 'model'
  | 'requestedModel'
  | 'requestedModelSource'
  | 'requestedProviderOptions'
  | 'agentConnectionId'
  | 'providerOptions'
  | 'executionMode'
  | 'provider'
  | 'providerId'
  | 'defaultProviderId'
  | 'orchestrationProvider'
>;

function selectComposerSlice(
  state: ChatUIState | null,
): ComposerChatSlice | null {
  if (!state) return null;
  return {
    input: state.input,
    attachments: state.attachments,
    attachmentStages: state.attachmentStages,
    model: state.model,
    requestedModel: state.requestedModel,
    requestedModelSource: state.requestedModelSource,
    requestedProviderOptions: state.requestedProviderOptions,
    agentConnectionId: state.agentConnectionId,
    providerOptions: state.providerOptions,
    executionMode: state.executionMode,
    provider: state.provider,
    providerId: state.providerId,
    defaultProviderId: state.defaultProviderId,
    orchestrationProvider: state.orchestrationProvider,
  };
}

interface UseChatInputOptions {
  apiBase: string;
  sessionId: string | null;
  agentSlug: string | null;
  conversationId?: string;
  availableModels: SelectableModel[];
  modelsStale?: boolean;
  bindingStatus?: BindingStatus;
  /**
   * The chat's backing engine connection (a model connection for
   * Station-engine chats, the runtime connection otherwise). Carries the
   * canonical `engineId` the capability-matrix resolver needs — without it
   * every external engine resolves to the unknown matrix and the model
   * button renders disabled as "does not support model selection"
   * (caught by the new-chat provider-managed E2E lane).
   */
  runtimeConnection?: {
    engineId?: string;
    type?: string;
    config?: { engineId?: unknown };
  } | null;
  agentDefaultModel?: string;
  defaultModelSource?: EffectiveModelSource;
  onSessionMigrate?: (newSessionId: string) => void;
  onAuthError?: () => void;
  onOpenNewChat?: () => void;
  /**
   * archive#1294: whether the transcript this
   * session's send-failure notice would render into is actually visible
   * right now — e.g. `ChatDock`'s `isDockOpen`. Defaults to `true` for
   * callers (like `ACPChatPanel`) that only ever mount while their own
   * transcript is on screen. `hasSessionContext` alone (below) checks store
   * *existence*, not visibility: a send failing while the dock is
   * collapsed has a chat state to write the notice into, but nothing on
   * screen renders it — suppressing the toast in that case would leave the
   * failure with NO visible surface at all.
   */
  isChatVisible?: boolean;
  attachmentCapabilities?: {
    images: boolean;
    files: boolean;
    imageRefusal?: string;
  };
}

export function useChatInput({
  apiBase,
  sessionId,
  agentSlug,
  conversationId,
  availableModels,
  modelsStale = false,
  bindingStatus,
  runtimeConnection,
  agentDefaultModel,
  defaultModelSource,
  onSessionMigrate,
  onAuthError,
  onOpenNewChat,
  isChatVisible = true,
  attachmentCapabilities = { images: false, files: false },
}: UseChatInputOptions) {
  const { showToast } = useToast();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Autocomplete state
  const {
    commandQuery,
    modelQuery,
    updateFromInput,
    closeCommand,
    closeModel,
    openModel,
    closeAll,
    onInputCleared,
  } = useAutocompleteState();

  // History navigation index
  const [, setHistoryIndex] = useState<Map<string, number>>(new Map());

  // Get actions from context
  const {
    updateChat,
    clearInput,
    addEphemeralMessage,
    addToInputHistory,
    navigateHistoryUp,
    navigateHistoryDown,
    setDraft = () => {},
    getDraft = () => '',
    clearDraft = () => {},
  } = useActiveChatActions();
  const activeChatState = useActiveChatSelector(
    sessionId || '',
    selectComposerSlice,
  );
  const currentAgent = useAgent(agentSlug || '');
  const cancelMessage = useCancelMessage(apiBase);

  // Slash commands
  const { commands: slashCommands } = useSlashCommands(
    agentSlug,
    activeChatState,
    bindingStatus,
    availableModels,
  );
  const handleSlashCommand = useSlashCommandHandler();

  // Wrap slash command handler
  const slashCommandHandler = useCallback(
    async (sid: string, command: string) => {
      return handleSlashCommand(sid, command, {
        onInputCleared,
        availableModels,
        bindingStatus:
          bindingStatus ??
          resolveBindingStatus({
            agent: currentAgent,
            chatState: activeChatState,
            globalModels: availableModels.map((model) => ({
              id: model.id,
              name: model.name,
              originalId: model.originalId ?? model.id,
              capabilities: model.capabilities,
            })),
          }),
        autocomplete: {
          openModel,
          openNewChat: onOpenNewChat || (() => {}),
          closeCommand,
          closeAll,
        },
      });
    },
    [
      handleSlashCommand,
      openModel,
      onOpenNewChat,
      closeCommand,
      closeAll,
      onInputCleared,
      availableModels,
      bindingStatus,
      currentAgent,
      activeChatState,
    ],
  );

  // Send message
  const sendMessageAction = useSendMessage(
    apiBase,
    (newSessionId) => onSessionMigrate?.(newSessionId),
    (error) => {
      if (error.message.includes('401')) {
        onAuthError?.();
        return;
      }
      // archive#1294: a send failure renders its own transcript notice —
      // the ephemeral "Retry" strip (archive#1292) for a live session, or
      // the durable `[CHAT_ERROR]` block on reload — as the single owner of
      // this failure's presentation. Showing this toast on top of that
      // notice was the exact "same failure text twice" overlap archive#1294
      // reported. Only fall back to the toast when that notice has no
      // visible surface to render into — the toast is then the only signal
      // left, so it must not be suppressed.
      const hasSessionContext = !!(
        sessionId && activeChatsStore.getSnapshot()[sessionId]
      );
      // archive#1294: `hasSessionContext` alone
      // checks store *existence*, not visibility — a send failing while
      // the dock is collapsed still has a chat state to write the notice
      // into, but the notice renders nowhere on screen, and nothing else
      // (e.g. an unread badge) backstops it today. Suppress the toast only
      // when the notice is BOTH backed by live session state AND actually
      // visible.
      const noticeHasVisibleSurface = hasSessionContext && isChatVisible;
      if (!noticeHasVisibleSurface) {
        showToast(`Error: ${error.message}`, 'error');
      }
    },
    slashCommandHandler,
  );

  // Input value
  const input = activeChatState?.input || '';
  const attachments = activeChatState?.attachments || [];
  const attachmentStages = activeChatState?.attachmentStages || [];
  // Through the SAME resolver the dispatcher uses, so the chip cannot name a
  // model the turn will not ask for. The old expression substituted
  // `agentDefaultModel` when `requestedModel === null` — but that is exactly
  // the case where no override is sent and the engine keeps the model it
  // already retained, which the client is holding in `activeChatState.model`.
  // It displayed the default while running the retained one (archive#3149).
  //
  // When nothing is requested and nothing has been reported, there is no
  // model to name; `undefined` lets the chip say so instead of inventing one.
  const resolvedTurnModel = resolveTurnModel({
    requestedModel: activeChatState?.requestedModel,
    model: activeChatState?.model,
  });
  const currentModel =
    resolvedTurnModel.kind === 'override'
      ? resolvedTurnModel.modelId
      : activeChatState?.model;
  const resolvedBindingStatus =
    bindingStatus ??
    resolveBindingStatus({
      agent: currentAgent,
      chatState: activeChatState,
      globalModels: availableModels.map((model) => ({
        id: model.id,
        name: model.name,
        originalId: model.originalId ?? model.id,
        capabilities: model.capabilities,
      })),
    });
  const support = resolvedBindingStatus.capabilityState;
  const runtimeHasSessionOptions = availableModels.some((model) => {
    const capabilities = model.capabilities;
    return (
      (capabilities?.supportsEffort === true &&
        (capabilities.supportedEffortLevels?.length ?? 0) > 0) ||
      capabilities?.supportsAdaptiveThinking === true ||
      capabilities?.supportsFastMode === true ||
      capabilities?.supportsAutoMode === true
    );
  });
  // Matrix delivery says an engine has *some* model-selection channel. The
  // launch declaration decides whether this existing conversation can accept
  // a per-turn override. ACP is start-only, so keep its picker available for
  // a fresh chat but refuse to present an unusable continuation control.
  const engineModelSelection = resolveEngineCapabilityMatrix(
    activeChatState?.agentConnectionId,
    activeChatState?.executionMode === EXECUTION_MODE.STATION
      ? { engineId: 'station' }
      : (runtimeConnection ?? { type: activeChatState?.provider }),
  ).modelSelection;
  const continuationOverrideUnsupported =
    Boolean(conversationId) &&
    activeChatState?.provider === 'acp' &&
    !ACP_MODEL_OVERRIDE_PER_TURN;
  const modelSelectionReason = continuationOverrideUnsupported
    ? 'This engine can choose a model for a new chat, but cannot change it in an existing conversation.'
    : engineModelSelection.state === 'unsupported'
      ? 'This engine does not support model selection for a chat session.'
      : availableModels.length === 0
        ? 'This engine reported no selectable models.'
        : undefined;
  const requiresObservedModelCatalog =
    engineModelSelection.state === 'session' &&
    engineModelSelection.channel === 'wire';
  const hasObservedModelCatalog =
    resolvedBindingStatus.catalogSource === 'live' &&
    availableModels.length > 0;
  const canModelSelect =
    !continuationOverrideUnsupported &&
    engineModelSelection.state !== 'unsupported' &&
    (!requiresObservedModelCatalog || hasObservedModelCatalog) &&
    (availableModels.length === 0 ||
      support.model_selection ||
      runtimeHasSessionOptions);

  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftRef = useRef<{ sessionId: string; text: string } | null>(
    null,
  );
  const flushDraft = useCallback(() => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    const pending = pendingDraftRef.current;
    pendingDraftRef.current = null;
    if (pending) setDraft(pending.sessionId, pending.text);
  }, [setDraft]);

  useEffect(() => {
    if (!sessionId) return;
    const restored = getDraft(sessionId);
    if (
      restored &&
      activeChatsStore.getSnapshot()[sessionId]?.input !== restored
    ) {
      updateChat(sessionId, { input: restored });
    }
  }, [sessionId, getDraft, updateChat]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushDraft();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      flushDraft();
    };
  }, [flushDraft]);

  // Handlers
  const handleInputChange = useCallback(
    (value: string) => {
      if (!sessionId) return;
      const cleanValue = sanitizeChatInput(value);
      updateChat(sessionId, { input: cleanValue });
      pendingDraftRef.current = { sessionId, text: cleanValue };
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = setTimeout(flushDraft, 500);
      setHistoryIndex((prev) => new Map(prev).set(sessionId, -1));
    },
    [sessionId, updateChat, flushDraft],
  );

  const handleSend = useCallback(
    async (
      overrideText?: string,
      overrideAttachments?: FileAttachment[],
      options?: {
        /**
         * Ambient, model-facing context (timezone, geolocation, …) delivered
         * out-of-band (archive#685) — never spliced into the sent/persisted text.
         */
        ambientContext?: string;
      },
    ) => {
      if (!sessionId || !agentSlug) return;
      // An override lets callers (e.g. context-composing send) supply the exact
      // text to send synchronously, avoiding a stale-closure read of `input`
      // after a just-issued handleInputChange.
      // Explicit overrides bypass the persisted composer value, so sanitize at
      // the shared send boundary as well as on ordinary input updates.
      const text = sanitizeChatInput(
        overrideText !== undefined ? overrideText : input,
      );
      const selectedAttachments = overrideAttachments ?? attachments;
      if (
        !text.trim() &&
        selectedAttachments.length === 0 &&
        attachmentStages.length === 0
      )
        return;
      const incomplete = attachmentStages.some(
        (stage) => stage.state !== 'complete',
      );
      if (incomplete) return;

      if (text.trim()) {
        addToInputHistory(sessionId, text.trim());
        setHistoryIndex((prev) => new Map(prev).set(sessionId, -1));
      }
      const sent = await sendMessageAction(
        sessionId,
        agentSlug,
        conversationId,
        text.trim(),
        selectedAttachments,
        options?.ambientContext,
      );
      // A durable offline row owns queued text. Clearing its draft prevents
      // the composer from rendering a second editable copy after a resume.
      //
      // #765 A2: the same ownership transfer applies to the mid-turn queue —
      // a send while a turn is running lands in `chat.queuedMessages`
      // (rendered as "N messages queued", with its own retry/steer controls)
      // and returns neither `true` nor a `'queued'` status. Leaving the
      // debounce-persisted draft behind meant every queued message ALSO
      // surfaced as a global "Unsent draft" row in the sidebar, forever.
      const postSendState = activeChatsStore.getSnapshot()[sessionId];
      if (
        sent === true ||
        postSendState?.status === 'queued' ||
        postSendState?.queuedMessages?.includes(text.trim())
      ) {
        pendingDraftRef.current = null;
        if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
        clearDraft(sessionId);
      }
    },
    [
      sessionId,
      agentSlug,
      conversationId,
      input,
      attachments,
      attachmentStages,
      sendMessageAction,
      addToInputHistory,
      clearDraft,
    ],
  );

  const handleCancel = useCallback(async () => {
    if (!sessionId) return;
    const currentChat = activeChatsStore.getSnapshot()[sessionId];
    // A restored durable conversation can have a child execution session.
    // Until the authorized conversation window identifies that child, Stop
    // must remain unavailable rather than guessing the legacy/root id and
    // supervising the wrong execution context.
    if (currentChat?.conversationId && !currentChat.currentSessionId) {
      showToast(
        'Restoring this conversation before Stop is available.',
        'info',
      );
      return;
    }
    // the notice used to be written BEFORE anything was known —
    // "User canceled the ongoing request" was posted whether the interrupt
    // succeeded, was refused, or never answered, and it described the user's
    // intent rather than the engine's outcome. Now it renders the outcome the
    // server derived (cooperative / forced / already-finished) or an honest
    // indeterminate/failed state, and nothing at all when there was no turn.
    // Pass the tab's store key: useCancelMessage keys its activeChatsStore
    // snapshot by this id and resolves the receipted child session itself.
    // Passing currentSessionId here made that lookup miss whenever the child
    // id drifted from the tab id, so Stop silently answered not-running.
    const outcome = await cancelMessage(sessionId);
    if (outcome.kind === 'not-running') return;
    addEphemeralMessage(sessionId, {
      role: 'system',
      content: describeStopTurnOutcome(outcome),
    });
  }, [sessionId, cancelMessage, addEphemeralMessage, showToast]);

  const handleClearInput = useCallback(() => {
    if (!sessionId) return;
    pendingDraftRef.current = null;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    clearDraft(sessionId);
    clearInput(sessionId);
    onInputCleared();
  }, [sessionId, clearDraft, clearInput, onInputCleared]);

  const handleAddAttachments = useCallback(
    (files: FileAttachment[]) => {
      if (!sessionId) return;
      const existing = attachments;
      updateChat(sessionId, { attachments: [...existing, ...files] });
    },
    [sessionId, attachments, updateChat],
  );

  const {
    error: attachmentError,
    selectFiles: selectAttachmentFiles,
    replaceFile: replaceAttachmentFile,
    setError: setAttachmentError,
    retry: retryAttachmentStage,
    cancel: cancelAttachmentStage,
    remove: removeAttachmentStage,
    sendBlockedReason,
  } = useComposerAttachments({
    apiBase,
    attachments,
    stages: attachmentStages,
    capabilities: attachmentCapabilities,
    onAddAttachments: handleAddAttachments,
    onReplaceAttachment: (replacement) => {
      if (!sessionId) return;
      const current =
        activeChatsStore.getSnapshot()[sessionId]?.attachments ?? [];
      const exists = current.some(
        (attachment) => attachment.id === replacement.id,
      );
      updateChat(sessionId, {
        attachments: exists
          ? current.map((attachment) =>
              attachment.id === replacement.id ? replacement : attachment,
            )
          : [...current, replacement],
      });
    },
    onStagesChange: (nextStages) => {
      if (sessionId) updateChat(sessionId, { attachmentStages: nextStages });
    },
  });

  const handleRemoveAttachment = useCallback(
    (id: string) => {
      if (!sessionId) return;
      void removeAttachmentStage(id);
      const newAttachments = attachments.filter((a) => a.id !== id);
      updateChat(sessionId, {
        attachments: newAttachments,
        attachmentStages: attachmentStages.filter(
          (stage) => stage.clientAttachmentId !== id,
        ),
      });
    },
    [
      sessionId,
      attachments,
      attachmentStages,
      updateChat,
      removeAttachmentStage,
    ],
  );

  const handleClearAttachments = useCallback(() => {
    if (!sessionId) return;
    for (const stage of attachmentStages)
      void cancelAttachmentStage(stage.clientAttachmentId);
    updateChat(sessionId, { attachments: [], attachmentStages: [] });
  }, [sessionId, attachmentStages, updateChat, cancelAttachmentStage]);

  const handleModelSelect = useCallback(
    (model: SelectableModel) => {
      if (!sessionId) return;
      const agentModelId =
        typeof agentDefaultModel === 'string' ? agentDefaultModel : undefined;
      const currentModelStr = currentModel || agentModelId || '';
      const isProviderSwitch =
        activeChatState?.executionMode === EXECUTION_MODE.STATION &&
        !!model.providerId &&
        model.providerId !== activeChatState.providerId;
      const isAlreadyActive = currentModelStr === model.id && !isProviderSwitch;

      updateChat(sessionId, {
        requestedModel: model.id,
        requestedModelSource: 'session override',
        ...(isProviderSwitch
          ? {
              providerId: model.providerId,
              defaultProviderId:
                activeChatState.defaultProviderId ?? activeChatState.providerId,
              provider: model.providerType,
            }
          : {}),
        requestedProviderOptions: sanitizeRuntimeOptionsForModel(
          model,
          activeChatState?.providerOptions ?? {},
        ),
      });

      if (!isAlreadyActive) {
        addEphemeralMessage(sessionId, {
          role: 'system',
          content: `Model changed to **${model.providerName ? `${model.providerName} · ` : ''}${model.name}**`,
        });
      }
      closeModel();
    },
    [
      sessionId,
      currentModel,
      agentDefaultModel,
      activeChatState?.providerOptions,
      activeChatState?.executionMode,
      activeChatState?.providerId,
      activeChatState?.defaultProviderId,
      updateChat,
      addEphemeralMessage,
      closeModel,
    ],
  );

  const handleModelOpen = useCallback(() => {
    if (!sessionId) return;
    if (!canModelSelect) {
      showToast(
        modelSelectionReason ?? 'You can’t change the model for this chat.',
        'warning',
      );
      return;
    }
    closeCommand();
    openModel();
  }, [
    sessionId,
    canModelSelect,
    modelSelectionReason,
    showToast,
    closeCommand,
    openModel,
  ]);

  const handleModelRuntimeOptionChange = useCallback(
    (key: string, value: string | number | boolean | undefined) => {
      if (!sessionId) return;
      const providerOptions = {
        ...(activeChatState?.requestedProviderOptions ??
          activeChatState?.providerOptions ??
          {}),
      };
      if (value === undefined) delete providerOptions[key];
      else providerOptions[key] = value;
      updateChat(sessionId, {
        requestedProviderOptions: providerOptions,
      });
    },
    [
      activeChatState?.providerOptions,
      activeChatState?.requestedProviderOptions,
      sessionId,
      updateChat,
    ],
  );

  const handleApprovalModeChange = useCallback(
    (mode: ApprovalMode) => {
      if (!sessionId) return;
      const previousMode =
        activeChatState?.requestedProviderOptions?.approvalMode ??
        activeChatState?.providerOptions?.approvalMode;
      if (previousMode === mode) return;
      updateChat(sessionId, {
        requestedProviderOptions: {
          ...(activeChatState?.requestedProviderOptions ??
            activeChatState?.providerOptions ??
            {}),
          approvalMode: mode,
        },
      });
      addEphemeralMessage(sessionId, {
        role: 'system',
        content: `Approval mode changed to **${approvalModeLabel(mode)}**`,
      });
    },
    [
      activeChatState?.providerOptions,
      activeChatState?.requestedProviderOptions,
      activeChatState?.requestedProviderOptions?.approvalMode,
      sessionId,
      updateChat,
      addEphemeralMessage,
    ],
  );

  const handleModelReset = useCallback(() => {
    if (!sessionId) return;
    const defaultModel =
      typeof agentDefaultModel === 'string' ? agentDefaultModel : undefined;
    const defaultModelOption = availableModels.find(
      (model) =>
        model.id === defaultModel &&
        (!activeChatState?.defaultProviderId ||
          model.providerId === activeChatState.defaultProviderId),
    );
    const defaultProviderId = activeChatState?.defaultProviderId;
    updateChat(sessionId, {
      // `null` is a deliberate request to omit overrides on the next send;
      // `undefined` would mean no picker request and fall back to the last
      // runtime-reported model/options at the send seam.
      requestedModel: null,
      requestedModelSource: defaultModelSource ?? 'agent default',
      requestedProviderOptions: undefined,
      ...(defaultProviderId
        ? {
            providerId: defaultProviderId,
            provider:
              defaultModelOption?.providerType ?? activeChatState?.provider,
          }
        : {}),
    });
    // Resetting is choosing the default: forget the remembered choice so
    // the next New Chat opens on the default too, not the one the user
    // just walked away from. Two exceptions:
    // - Station-engine sessions never touch this memory (same live-state
    //   gate as the select path).
    // - When the session's default IS the remembered choice
    //   (defaultModelSource 'last chosen'), the reset re-affirms that
    //   memory rather than renouncing it — clearing here would contradict
    //   the "Model reset to last chosen" message shown below.
    if (
      currentAgent &&
      activeChatState?.executionMode !== EXECUTION_MODE.STATION &&
      !isProviderManagedAgent(currentAgent) &&
      defaultModelSource !== 'last chosen'
    ) {
      try {
        clearLastChosenModel(buildLastChosenModelBindingKey(currentAgent));
      } catch {
        // Best-effort memory — never block the reset.
      }
    }
    // Says what clearing the override DOES, not what the default happens to
    // be. Clearing sends no override, so the engine keeps whatever model it
    // retained — which is frequently not `defaultModel`. The old wording
    // announced "Model reset to agent default <X>" while the session kept
    // running <Y>, printing the falsehood into the transcript (archive#3149).
    addEphemeralMessage(sessionId, {
      role: 'system',
      content:
        'Model override cleared. This session keeps the model the engine already has; the next new chat starts on the default.',
    });
    closeModel();
  }, [
    addEphemeralMessage,
    activeChatState?.defaultProviderId,
    activeChatState?.provider,
    activeChatState?.executionMode,
    agentDefaultModel,
    availableModels,
    currentAgent,
    defaultModelSource,
    sessionId,
    updateChat,
    closeModel,
  ]);

  const handleCommandSelect = useCallback(
    async (command: SlashCommand) => {
      if (!sessionId || !agentSlug) return;
      await sendMessageAction(
        sessionId,
        agentSlug,
        conversationId,
        command.cmd,
      );
      textareaRef.current?.focus();
    },
    [sessionId, agentSlug, conversationId, sendMessageAction],
  );

  const handleHistoryUp = useCallback(() => {
    if (!sessionId) return;
    navigateHistoryUp(sessionId);
  }, [sessionId, navigateHistoryUp]);

  const handleHistoryDown = useCallback(() => {
    if (!sessionId) return;
    navigateHistoryDown(sessionId);
  }, [sessionId, navigateHistoryDown]);

  const handleRestorePortableDraft = useCallback(
    (text: string, restoredAttachments: FileAttachment[]) => {
      if (!sessionId) return;
      const cleanValue = sanitizeChatInput(text);
      updateChat(sessionId, {
        input: cleanValue,
        attachments: restoredAttachments,
        attachmentStages: [],
      });
      pendingDraftRef.current = { sessionId, text: cleanValue };
      flushDraft();
      textareaRef.current?.focus();
    },
    [sessionId, updateChat, flushDraft],
  );

  // Memoized: this object is passed whole as the `chatInput` prop to the
  // memoized ChatDockContentArea — returning a fresh literal every render
  // would defeat that memo on every unrelated re-render (e.g. the resize
  // drag's per-frame renders). Every handler here is already a stable
  // `useCallback`, so the object only changes identity when one of the
  // actual state values below changes.
  return useMemo(
    () => ({
      // Refs
      textareaRef,
      // State
      input,
      attachments,
      attachmentError,
      attachmentStages,
      sendBlockedReason,
      currentModel,
      canModelSelect,
      modelSelectionReason,
      modelsStale,
      modelQuery,
      commandQuery,
      slashCommands,
      // Handlers
      handleInputChange,
      handleSend,
      handleCancel,
      handleClearInput,
      handleAddAttachments,
      selectAttachmentFiles,
      replaceAttachmentFile,
      setAttachmentError,
      retryAttachmentStage,
      cancelAttachmentStage,
      handleRemoveAttachment,
      handleClearAttachments,
      handleModelSelect,
      handleModelReset,
      handleModelRuntimeOptionChange,
      handleApprovalModeChange,
      handleModelOpen,
      handleModelClose: closeModel,
      handleCommandSelect,
      handleCommandClose: closeCommand,
      handleHistoryUp,
      handleHistoryDown,
      handleRestorePortableDraft,
      updateFromInput,
      closeAll,
    }),
    [
      input,
      attachments,
      attachmentError,
      attachmentStages,
      sendBlockedReason,
      currentModel,
      canModelSelect,
      modelSelectionReason,
      modelsStale,
      modelQuery,
      commandQuery,
      slashCommands,
      handleInputChange,
      handleSend,
      handleCancel,
      handleClearInput,
      handleAddAttachments,
      selectAttachmentFiles,
      replaceAttachmentFile,
      setAttachmentError,
      retryAttachmentStage,
      cancelAttachmentStage,
      handleRemoveAttachment,
      handleClearAttachments,
      handleModelSelect,
      handleModelReset,
      handleModelRuntimeOptionChange,
      handleApprovalModeChange,
      handleModelOpen,
      closeModel,
      handleCommandSelect,
      closeCommand,
      handleHistoryUp,
      handleHistoryDown,
      handleRestorePortableDraft,
      updateFromInput,
      closeAll,
    ],
  );
}
