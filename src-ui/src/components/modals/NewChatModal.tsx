import { useMaterializeEngineAgentMutation } from '@kontourai/station-sdk';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { useDevicePresentation } from '../../hooks/useDevicePresentation';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useNewChatSelectionModel } from '../../hooks/useNewChatSelectionModel';
import { trackRecentAgent } from '../../hooks/useRecentAgents';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { agentEngineDescriptor } from '../../utils/engine';
import { type EffectiveModelSource } from '../../utils/execution';
import { sanitizeRuntimeOptionsForModel } from '../../utils/modelCapabilities';
import {
  type AgentFixRoute,
  AgentReadinessCell,
  agentFixRoute,
} from '../AgentReadinessCell';
import { agentRunnability } from '../agent-runnability';
import { EngineChip, engineChipLabel } from '../badges/EngineChip';
import { normalizedDisplayLabel } from '../chat/message-bubble/MessageAttribution';
import {
  buildCodingChatInitialMessage,
  type CodingChatContextDraft,
} from '../coding-layout/chatContextDraft';
import { HomeFolderLabel } from '../HomeFolderLabel';
import { AgentIcon } from '../icons/AgentIcon';
import {
  EngineGlyph,
  FolderGlyph,
  GlobeGlyph,
  PlugGlyph,
  TimeGlyph,
  WarningGlyph,
} from '../icons/Glyph';
import { LayoutIcon } from '../icons/LayoutIcon';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { ModelPickerDialogFrame } from '../session/ModelPickerDialogFrame';
import { describeReadFailure, Empty, ErrorState, SkeletonList } from '../state';
import {
  findAuthoredAgentForEngineConnection,
  GLOBAL_CONTEXT,
  NEW_CHAT_AGENT_UNAVAILABLE_FALLBACK,
  type NewChatModalContextOption,
  resolveNewChatAgentEnable,
  resolveNewChatAgentUnavailability,
  resolveNewChatInitialContext,
  resolveNewChatWorkspaceHint,
  scheduleSelectedAgentVisibility,
  splitCwdBreadcrumb,
} from './new-chat-modal-utils';
import {
  type NewChatSetupAuthority,
  useNewChatSetupReturn,
} from './useNewChatSetupReturn';

const SessionModelPicker = React.lazy(() =>
  import('../session/SessionModelPicker').then((module) => ({
    default: module.SessionModelPicker,
  })),
);

export interface NewChatModalMode {
  kind: 'fork';
  /** The current Agent is the default target; alternates are explicit. */
  preferredAgentSlug: string;
  sourceModel?: string;
  disclosure: string;
  pending?: boolean;
  error?: string | null;
}

interface NewChatModalProps {
  agents: AgentData[];
  projects: ProjectMetadata[];
  activeProjectSlug?: string | null;
  onSelect: (
    agent: AgentData,
    projectSlug?: string,
    projectName?: string,
    initialMessage?: string,
    modelOverride?: string,
    modelSource?: EffectiveModelSource,
    defaultModel?: string,
    defaultModelSource?: EffectiveModelSource,
    providerOptions?: Record<string, unknown>,
    providerId?: string,
    providerType?: string,
  ) => void | Promise<void>;
  onClose: () => void;
  draftContext?: CodingChatContextDraft | null;
  mode?: NewChatModalMode;
  requestAuthority?: NewChatSetupAuthority;
}

/** "Global" sentinel for the context picker */
export function NewChatModal({
  agents,
  projects,
  activeProjectSlug,
  onSelect,
  onClose,
  draftContext = null,
  mode,
  requestAuthority,
}: NewChatModalProps) {
  const isMobile = useIsMobile();
  const [agentSearch, setAgentSearch] = useState('');
  const preservedAgentSlug = useRef<string | undefined>(undefined);
  const preserveSetupContext = useRef(false);
  const [returnedFromSetup, setReturnedFromSetup] = useState(false);
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0);
  const [selectedContext, setSelectedContext] = useState<string>(() =>
    resolveNewChatInitialContext(activeProjectSlug, projects),
  );
  const [contextSearch, setContextSearch] = useState('');
  // archive#3013: a click that neither dispatches nor explains itself is
  // indistinguishable from a broken app. Every handleSelect path either
  // calls onSelect or sets this.
  const [selectFeedback, setSelectFeedbackState] = useState<{
    text: string;
    nonce: number;
  } | null>(null);
  // Nonce: re-setting the SAME message must still remount the alert node so
  // role=alert announces again — React bails on identical state otherwise
  // (archive#3013).
  // useCallback so the setter is referentially stable and can be an honest
  // effect dependency (archive#3021) — the previous render-scoped arrow forced a
  // reasoned lint suppression on the effect below.
  const setSelectFeedback = useCallback(
    (text: string | null) =>
      setSelectFeedbackState((current) =>
        text === null ? null : { text, nonce: (current?.nonce ?? 0) + 1 },
      ),
    [],
  );
  // The remedy for stale-context feedback is picking a workspace; doing so
  // must retire the instruction (archive#3013). The trigger read is
  // explicit so the dependency list is honest rather than suppressed (archive#3021).
  useEffect(() => {
    void selectedContext;
    setSelectFeedback(null);
  }, [selectedContext, setSelectFeedback]);
  // archive#3027: one Enable create at a time. The ref is the guard (two
  // activations in one frame both read pre-render state); the state disables
  // the button for the visible affordance.
  const enableInFlightRef = useRef(false);
  const [enableInFlight, setEnableInFlight] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [selectedDraftContextIds, setSelectedDraftContextIds] = useState<
    string[]
  >(() => draftContext?.items.map((item) => item.id) || []);
  const contextRef = useRef<HTMLDivElement>(null);
  const contextSelectionTouchedRef = useRef(false);
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const contextSheetPanelRef = useRef<HTMLDivElement>(null);
  const contextSheetWasOpenRef = useRef(false);
  const agentInputRef = useRef<HTMLInputElement>(null);
  const selectedAgentRef = useCallback((element: HTMLButtonElement | null) => {
    scheduleSelectedAgentVisibility(element);
  }, []);

  const {
    viewModel,
    // Defaulted: not every consumer/test double of the selection model
    // supplies this list, and a missing engine-connection list must degrade to
    // "no connection directory known", never to a render crash.
    acpConnections = [],
    runtimeLoading,
    modelsLoading,
    runtimeFetching = false,
    modelsFetching = false,
    setupFetching = false,
    projectCatalogResolved = true,
    setupError,
    refreshSetup,
    runtimeError,
    modelsError,
    refetchAgentConnections,
    refetchModelConnections,
    modelConnections = [],
    modelChoices,
    setModelChoices,
    modelPickerAgent,
    setModelPickerAgent,
    modelsForAgent,
    modelChoiceKey,
    defaultEffectiveModelForAgent,
  } = useNewChatSelectionModel({
    agents,
    projects,
    selectedContext,
    contextSearch,
    agentSearch,
  });
  const {
    isGlobal,
    selectedProject,
    currentContextOption,
    filteredContextOptions,
    groups,
    flatList,
    // Defaulted for the same test-double reason as acpConnections above; a
    // missing scoped list must degrade to "create", never a render crash.
    scopedAgents = [],
    compatibilityMessage,
  } = viewModel;
  const setupReturn = useNewChatSetupReturn({
    authority: requestAuthority,
    onCancel: onClose,
    onResume: () => {
      setReturnedFromSetup(true);
      const slug = preservedAgentSlug.current;
      const index = slug
        ? flatList.findIndex((agent) => agent.slug === slug)
        : -1;
      setSelectedAgentIndex(index);
      if (slug && index < 0)
        setSelectFeedback(
          'The Agent you selected is no longer available here. Choose an available Agent to continue.',
        );
      if (
        selectedContext !== GLOBAL_CONTEXT &&
        !projects.some((project) => project.slug === selectedContext)
      ) {
        setSelectFeedback(
          'The workspace you selected is no longer available. Choose a workspace to continue.',
        );
      }
      if (refreshSetup) refreshSetup();
      else {
        void refetchAgentConnections?.();
        void refetchModelConnections?.();
      }
    },
  });
  const beginSetup = (path: string, agentSlug?: string) => {
    if (!setupReturn.begin(path)) {
      setSelectFeedback('Reconnect to this Station before opening setup.');
      return;
    }
    preservedAgentSlug.current =
      agentSlug ?? flatList[selectedAgentIndex]?.slug;
    preserveSetupContext.current = true;
    contextSelectionTouchedRef.current = true;
    setContextOpen(false);
    setModelPickerAgent(null);
  };
  const checkingSetup =
    returnedFromSetup && (setupFetching || runtimeFetching || modelsFetching);
  const returnError = returnedFromSetup
    ? (setupError ?? runtimeError ?? modelsError)
    : undefined;
  useEffect(() => {
    if (
      !returnedFromSetup ||
      checkingSetup ||
      setupError ||
      runtimeError ||
      modelsError
    )
      return;
    const slug = preservedAgentSlug.current;
    if (!slug) return;
    const index = flatList.findIndex((agent) => agent.slug === slug);
    if (index !== selectedAgentIndex) {
      setSelectedAgentIndex(index);
      if (index < 0)
        setSelectFeedback(
          'The Agent you selected is no longer available here. Choose an available Agent to continue.',
        );
    }
  }, [
    checkingSetup,
    returnedFromSetup,
    setupError,
    selectedAgentIndex,
    flatList,
    modelsError,
    runtimeError,
    setSelectFeedback,
  ]);

  // A fork starts on the current Agent even when recency would normally put
  // another row first. The user may still choose any other eligible row.
  useEffect(() => {
    if (!mode || agentSearch) return;
    const preferredIndex = flatList.findIndex(
      (agent) => agent.slug === mode.preferredAgentSlug,
    );
    if (preferredIndex >= 0) setSelectedAgentIndex(preferredIndex);
  }, [agentSearch, flatList, mode]);
  // archive#1089: the directory the highlighted agent will actually be
  // launched in. Derived from the agent, not just the project, because an
  // engine connection's own Working Directory outranks `$HOME` for a project
  // that names no directory — see resolveNewChatWorkspaceHint.
  const workspaceHint = resolveNewChatWorkspaceHint({
    agent: flatList[selectedAgentIndex],
    project: selectedProject,
    acpConnections,
  });
  // Close context dropdown on outside click
  useEffect(() => {
    if (!contextOpen) return;
    const handler = (e: MouseEvent) => {
      if (contextRef.current && !contextRef.current.contains(e.target as Node))
        setContextOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextOpen]);

  // Focus agent input on mount and when context dropdown closes
  useEffect(() => {
    // Opening a picker must never summon the software keyboard before a phone
    // user asks to type. Desktop keeps the fast keyboard-first flow.
    if (!isMobile && !contextOpen) agentInputRef.current?.focus();
  }, [contextOpen, isMobile]);

  // Mobile sheet focus management. The sheet is a DOM sibling of the trigger
  // button (both children of `contextRef`), not a descendant of it, and
  // mobile deliberately skips autofocusing the filter input (see above) to
  // avoid a keyboard-driven viewport jump. Without an explicit focus move,
  // keyboard focus stays on the trigger button when the sheet opens, so
  // Escape bubbles straight past the sheet's own handler to
  // ResponsiveDialogSurface's dialog-wide Escape trap and closes the entire
  // New Chat modal instead of just the sheet. Move focus onto the sheet
  // panel itself (not the filter input) on open, and explicitly return it to
  // the trigger button on close rather than relying on browser default focus
  // (which would otherwise fall back to <body>).
  useEffect(() => {
    if (!isMobile) return;
    if (contextOpen) {
      contextSheetWasOpenRef.current = true;
      contextSheetPanelRef.current?.focus();
    } else if (contextSheetWasOpenRef.current) {
      contextSheetWasOpenRef.current = false;
      contextButtonRef.current?.focus();
    }
  }, [contextOpen, isMobile]);

  useEffect(() => {
    setSelectedDraftContextIds((current) =>
      preserveSetupContext.current
        ? current.filter((id) =>
            draftContext?.items.some((item) => item.id === id),
          )
        : draftContext?.items.map((item) => item.id) || [],
    );
  }, [draftContext]);

  useEffect(() => {
    const selectedProjectStillExists = projects.some(
      (project) => project?.slug === selectedContext,
    );
    if (selectedContext !== GLOBAL_CONTEXT && !selectedProjectStillExists) {
      if (preserveSetupContext.current) {
        if (returnedFromSetup && projectCatalogResolved)
          setSelectFeedback(
            'The workspace you selected is no longer available. Choose a workspace to continue.',
          );
        return;
      }
      setSelectedContext(
        resolveNewChatInitialContext(activeProjectSlug, projects),
      );
      setSelectedAgentIndex(0);
      return;
    }
    if (
      selectedContext === GLOBAL_CONTEXT &&
      !contextSelectionTouchedRef.current
    ) {
      const preferredContext = resolveNewChatInitialContext(
        activeProjectSlug,
        projects,
      );
      if (preferredContext !== GLOBAL_CONTEXT) {
        setSelectedContext(preferredContext);
        setSelectedAgentIndex(0);
      }
    }
  }, [
    activeProjectSlug,
    projects,
    selectedContext,
    returnedFromSetup,
    projectCatalogResolved,
    setSelectFeedback,
  ]);

  const materializeEngineAgent = useMaterializeEngineAgentMutation();

  const handleSelect = (agent: AgentData) => {
    if (mode?.pending) return;
    if (checkingSetup) {
      setSelectFeedback('Wait for connections to finish checking.');
      return;
    }
    if (returnedFromSetup && (setupError || runtimeError || modelsError)) {
      setSelectFeedback(
        'Connections could not be rechecked. Retry before starting a chat.',
      );
      return;
    }
    // Keyboard selection (Enter on the filtered list) reaches here with no
    // availability filter, so this must speak rather than return silently —
    // the pointer path never arrives (the row button is disabled).
    if (agent.available === false) {
      // archive#3027: Enter on an enableable alias row triggers Enable, the
      // same action its visible button offers; non-enableable rows keep
      // speaking their reason. A connection remedy outranks Enable on the
      // keyboard path too (mirrors the row's rendering): fix the connection
      // first.
      if (
        resolveNewChatAgentEnable(agent) &&
        agentFixRoute(agent) === 'enable'
      ) {
        void handleEnable(agent);
        return;
      }
      setSelectFeedback(
        agent.unavailableReason ?? NEW_CHAT_AGENT_UNAVAILABLE_FALLBACK,
      );
      return;
    }
    setSelectFeedback(null);
    try {
      trackRecentAgent(agent.slug);
    } catch {
      // Storage may be unavailable (quota, private browsing) — recency
      // tracking is best-effort and must never block starting the chat.
    }
    const draftItems =
      draftContext?.items.filter((item) =>
        selectedDraftContextIds.includes(item.id),
      ) || [];
    const initialMessage = buildCodingChatInitialMessage(draftItems);
    const defaultEffectiveModel = defaultEffectiveModelForAgent(agent);
    const choice = modelChoices[modelChoiceKey(agent)];
    if (
      returnedFromSetup &&
      choice?.modelId &&
      !modelsForAgent(agent).some(
        (model) =>
          model.id === choice.modelId &&
          model.available !== false &&
          (!choice.providerId || model.providerId === choice.providerId),
      )
    ) {
      setSelectFeedback(
        'The Model you selected is no longer available. Choose a Model to continue.',
      );
      setModelPickerAgent(agent);
      return;
    }
    const isPreferredForkAgent =
      mode?.kind === 'fork' && agent.slug === mode.preferredAgentSlug;
    const sessionModel =
      choice?.modelId ??
      (isPreferredForkAgent ? mode.sourceModel : undefined) ??
      defaultEffectiveModel.id ??
      undefined;
    const modelSource = choice?.modelId
      ? ('session override' as const)
      : defaultEffectiveModel.source;
    // archive#3013: dispatch is guarded because `onSelect` is the parent's handler —
    // a throw there (a failed lazy chunk, a broken route) previously vanished,
    // which from the user's seat is identical to the silent fall-through.
    const dispatch = (projectSlug?: string, projectName?: string) => {
      try {
        void Promise.resolve(
          onSelect(
            agent,
            projectSlug,
            projectName,
            initialMessage || undefined,
            sessionModel,
            modelSource,
            defaultEffectiveModel.id || undefined,
            defaultEffectiveModel.source,
            choice?.providerOptions,
            choice?.providerId,
            choice?.providerType,
          ),
        ).catch((error) => {
          console.error(
            mode?.kind === 'fork'
              ? 'Conversation fork failed:'
              : 'New chat start failed:',
            error,
          );
        });
      } catch (error) {
        console.error('New chat start failed:', error);
        setSelectFeedback(
          'Could not start the chat. Try again; if it keeps failing, restart Station.',
        );
      }
    };
    if (isGlobal) {
      dispatch();
    } else if (selectedProject) {
      dispatch(selectedProject.slug, selectedProject.name);
    } else {
      // The selected context names a project this modal cannot resolve
      // (mid-refetch, or a stale slug the reset effect has not caught yet).
      // Dispatching would target a workspace the server cannot resolve
      // either; swallowing the click is worse. Say what to do.
      setSelectFeedback(
        'This chat needs a workspace — pick one from the Workspace menu above, or choose "No workspace".',
      );
    }
  };

  const modelChoiceFor = (agent: AgentData) =>
    modelChoices[modelChoiceKey(agent)];
  const modelFor = (agent: AgentData) => {
    const choice = modelChoiceFor(agent);
    const effective = defaultEffectiveModelForAgent(agent);
    const selected = choice?.modelId
      ? modelsForAgent(agent).find(
          (model) =>
            model.id === choice.modelId &&
            (!choice.providerId || model.providerId === choice.providerId),
        )
      : undefined;
    const sourceModel =
      mode?.kind === 'fork' &&
      agent.slug === mode.preferredAgentSlug &&
      !choice?.modelId
        ? mode.sourceModel
        : undefined;
    return {
      id: choice?.modelId ?? sourceModel ?? effective.id ?? undefined,
      label: choice?.modelId
        ? (selected?.name ?? choice.modelId)
        : sourceModel
          ? sourceModel
          : effective.label,
      source: choice?.modelId
        ? 'session override'
        : sourceModel
          ? 'source turn'
          : effective.source,
    };
  };
  const updateModelChoice = (
    agent: AgentData,
    update: (
      current: NonNullable<(typeof modelChoices)[string]>,
    ) => NonNullable<(typeof modelChoices)[string]>,
  ) => {
    const key = modelChoiceKey(agent);
    setModelChoices((current) => ({
      ...current,
      [key]: update(current[key] ?? { providerOptions: {} }),
    }));
  };
  const modelPickerModels = modelPickerAgent
    ? modelsForAgent(modelPickerAgent)
    : [];
  const modelPickerDefault = modelPickerAgent
    ? defaultEffectiveModelForAgent(modelPickerAgent)
    : undefined;
  // A pending global catalog must not obscure an already-resolved ACP or
  // Agent-local catalog. When this Agent has no resolved models yet, keep the
  // shared picker mounted so it still owns focus, Escape, and the close action.
  const modelPickerLoading =
    !!modelPickerAgent && modelsLoading && modelPickerModels.length === 0;
  const modelPickerProviders = Array.from(
    new Map(
      modelPickerModels
        .filter((model) => model.providerId)
        .map((model) => {
          const connection = modelConnections.find(
            (candidate) => candidate.id === model.providerId,
          );
          // The rail represents a connection, not whichever model entry was
          // last encountered. Station-mode choices are eligibility-filtered in
          // the selection hook; external catalogs retain their own status.
          const available = connection
            ? connection.enabled && connection.status === 'ready'
            : model.available !== false;
          return [
            model.providerId!,
            {
              id: model.providerId!,
              name: model.providerName ?? model.providerId!,
              available,
              ...(!available
                ? {
                    detail:
                      model.unavailableReason ??
                      connection?.status ??
                      'Unavailable',
                  }
                : {}),
            },
          ];
        }),
    ).values(),
  );

  // archive#3027: one-click Enable for an engine-default alias row — then
  // behave as if the user picked the resulting Agent. Every path either
  // dispatches or speaks through the selectFeedback alert channel (archive#3013
  // invariant); nothing here may fail silently or reject unhandled.
  //
  // The find-or-create itself is the SERVER's, not this component's. Enable
  // used to POST a draft named "<engine> Agent", which landed as a second
  // row beside the engine's own — so the create half now posts the engine id
  // to `/agents/materialize-engine`, the one path boot adoption, ACP
  // connect, and first run's batch also take. The local FIND below stays: it
  // short-circuits WITHOUT a write and, unlike the server, knows this
  // context's scope.
  const handleEnable = async (agent: AgentData) => {
    const enable = resolveNewChatAgentEnable(agent);
    if (!enable) return;
    // In-flight guard (ref, not just state: two clicks in one frame both see
    // the pre-render state). The second activation is deliberately ignored —
    // progress was already announced by the first.
    if (enableInFlightRef.current) return;
    // FIND runs over the SAME scope-filtered set the view model derives
    // from, never the raw agents prop: an out-of-scope authored Agent
    // (owned by another project, or excluded by the project's agents
    // filter) must not be silently selected into this context (archive#3027).
    const existing = findAuthoredAgentForEngineConnection(
      scopedAgents,
      enable.engineConnectionId,
    );
    if (existing) {
      handleSelect(existing);
      return;
    }
    const engineLabel = agent.engineDisplayName ?? agent.name;
    enableInFlightRef.current = true;
    setEnableInFlight(true);
    setSelectFeedback(`Setting up ${engineLabel}…`);
    try {
      // Selection keys off the RESPONSE (the full spec), not the agents
      // list: the enriched catalog activates deferred and its last-stable
      // cache may lag minutes behind this write. The mutation already
      // invalidates the agents query for eventual consistency.
      const { data } = await materializeEngineAgent.mutateAsync(
        enable.engineConnectionId,
      );
      const materialized = data as AgentData;
      // The server's find-or-create is scope-blind by design (identity is
      // global). If what it returned is owned by a DIFFERENT project than
      // this context, selecting it would smuggle an out-of-scope Agent into
      // the chat the same way a raw catalog FIND would (archive#3027) — say so
      // instead.
      if (
        materialized.project !== undefined &&
        materialized.project !== selectedProject?.slug
      ) {
        setSelectFeedback(
          `${materialized.name} is owned by project “${materialized.project}”. Open that project to chat with it.`,
        );
        return;
      }
      setSelectFeedback(null);
      handleSelect(materialized);
    } catch (error) {
      setSelectFeedback(
        `Could not enable ${engineLabel}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      enableInFlightRef.current = false;
      setEnableInFlight(false);
    }
  };

  if (setupReturn.suspended) return null;

  return (
    <ResponsiveDialogSurface
      ariaLabel={mode?.kind === 'fork' ? 'Fork from here' : 'New Chat'}
      overlayClassName="new-chat-modal__overlay"
      panelClassName="new-chat-modal"
      initialFocusRef={agentInputRef}
      initialFocusPolicy="desktop"
      onClose={setupReturn.close}
    >
      <div className="new-chat-modal__header">
        <div className="new-chat-modal__title-row">
          <h3 className="new-chat-modal__title">
            {mode?.kind === 'fork' ? 'Fork from here' : 'New Chat'}
          </h3>
          <ResponsiveDialogCloseButton
            label={mode?.kind === 'fork' ? 'Cancel fork' : 'Close new chat'}
            onClick={onClose}
          />
        </div>

        {mode?.kind === 'fork' && (
          <div className="new-chat-modal__compat-warning" role="note">
            <strong>New independent conversation.</strong> {mode.disclosure}
          </div>
        )}

        {/* Context picker */}
        <div className="new-chat-modal__context-picker" ref={contextRef}>
          <span className="new-chat-modal__context-label-text">Workspace</span>
          <button
            ref={contextButtonRef}
            type="button"
            className="new-chat-modal__context-button"
            aria-label={`Workspace: ${currentContextOption?.label || 'Select workspace'}`}
            onClick={() => {
              setContextOpen((v) => !v);
              setContextSearch('');
            }}
          >
            {currentContextOption && (
              <LayoutIcon
                layout={{
                  name: currentContextOption.label,
                  icon: currentContextOption.icon,
                }}
                fallback={contextGlyph(currentContextOption.glyph)}
                size={28}
              />
            )}
            <span className="new-chat-modal__context-label">
              {currentContextOption?.label || 'Select workspace'}
            </span>
            {workspaceHint.kind !== 'home' && (
              <span className="new-chat-modal__context-dir">
                <CwdBreadcrumb path={workspaceHint.path} />
              </span>
            )}
            {workspaceHint.kind === 'home' && (
              <HomeFolderLabel
                className="new-chat-modal__context-dir new-chat-modal__context-dir--fallback"
                title={
                  isGlobal
                    ? '~ (your home folder)'
                    : '~ (no project folder set — chats start in your home folder)'
                }
              />
            )}
            <span className="new-chat-modal__chevron">▾</span>
          </button>

          {contextOpen && !isMobile && (
            <div className="new-chat-modal__dropdown">
              <ContextPickerOptions
                contextSearch={contextSearch}
                onContextSearchChange={setContextSearch}
                autoFocusFilter
                onEscape={() => setContextOpen(false)}
                filteredContextOptions={filteredContextOptions}
                selectedContext={selectedContext}
                onSelectContext={(value) => {
                  contextSelectionTouchedRef.current = true;
                  preservedAgentSlug.current = undefined;
                  setSelectedContext(value);
                  setContextOpen(false);
                  setSelectedAgentIndex(0);
                }}
              />
            </div>
          )}
          {contextOpen && isMobile && (
            <div
              className="new-chat-modal__context-sheet-overlay"
              role="presentation"
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) setContextOpen(false);
              }}
            >
              <div
                ref={contextSheetPanelRef}
                className="new-chat-modal__context-sheet"
                role="dialog"
                aria-modal="true"
                aria-label="Select workspace"
                tabIndex={-1}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextOpen(false);
                  }
                }}
              >
                <div className="new-chat-modal__context-sheet-list">
                  <ContextPickerOptions
                    contextSearch={contextSearch}
                    onContextSearchChange={setContextSearch}
                    autoFocusFilter={false}
                    onEscape={() => setContextOpen(false)}
                    filteredContextOptions={filteredContextOptions}
                    selectedContext={selectedContext}
                    onSelectContext={(value) => {
                      contextSelectionTouchedRef.current = true;
                      preservedAgentSlug.current = undefined;
                      setSelectedContext(value);
                      setContextOpen(false);
                      setSelectedAgentIndex(0);
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Agent search */}
        <input
          ref={agentInputRef}
          type="text"
          placeholder="Search agents..."
          value={agentSearch}
          onChange={(e) => {
            preservedAgentSlug.current = undefined;
            setAgentSearch(e.target.value);
            setSelectedAgentIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              preservedAgentSlug.current = undefined;
              e.preventDefault();
              setSelectedAgentIndex((p) =>
                Math.min(p + 1, flatList.length - 1),
              );
            } else if (e.key === 'ArrowUp') {
              preservedAgentSlug.current = undefined;
              e.preventDefault();
              setSelectedAgentIndex((p) => Math.max(p - 1, 0));
            } else if (
              e.key === 'Enter' &&
              !isComposingKeyEvent(e) &&
              flatList[selectedAgentIndex]
            )
              handleSelect(flatList[selectedAgentIndex]);
          }}
          className="new-chat-modal__search"
        />

        {draftContext && draftContext.items.length > 0 && (
          <div className="new-chat-modal__draft-context">
            <div className="new-chat-modal__draft-context-title">
              {draftContext.title}
            </div>
            <div className="new-chat-modal__draft-context-desc">
              {draftContext.description}
            </div>
            <div className="new-chat-modal__draft-context-items">
              {draftContext.items.map((item) => {
                const selected = selectedDraftContextIds.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`new-chat-modal__draft-chip${selected ? ' new-chat-modal__draft-chip--selected' : ''}`}
                    onClick={() =>
                      setSelectedDraftContextIds((current) =>
                        current.includes(item.id)
                          ? current.filter((value) => value !== item.id)
                          : [...current, item.id],
                      )
                    }
                  >
                    <span className="new-chat-modal__draft-chip-label">
                      {item.label}
                    </span>
                    <span className="new-chat-modal__draft-chip-detail">
                      {item.detail}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="new-chat-modal__list">
        {compatibilityMessage && (
          <div className="new-chat-modal__compat-warning">
            <WarningGlyph /> {compatibilityMessage}
          </div>
        )}
        {(selectFeedback || mode?.error || mode?.pending) && (
          <div
            key={selectFeedback?.nonce ?? mode?.error ?? 'pending'}
            className="new-chat-modal__compat-warning new-chat-modal__select-feedback"
            role={mode?.pending ? 'status' : 'alert'}
            aria-busy={mode?.pending || undefined}
          >
            <WarningGlyph />{' '}
            {mode?.pending
              ? 'Creating the fork…'
              : (mode?.error ?? selectFeedback?.text)}
          </div>
        )}
        {flatList.length === 0 &&
          (runtimeLoading || modelsLoading ? (
            <div className="new-chat-modal__loading">
              <SkeletonList count={4} label="Loading agents" />
            </div>
          ) : returnError || runtimeError || modelsError ? (
            // archive#771: a settled error here used to fall straight
            // through to "Nothing to chat with yet" — indistinguishable from
            // a host with no connections at all.
            <ErrorState
              variant="compact"
              title={
                returnError
                  ? "Couldn't recheck chat setup"
                  : "Couldn't load engines or models"
              }
              description={describeReadFailure(
                returnError ?? runtimeError ?? modelsError,
              )}
              action={
                <button
                  type="button"
                  onClick={() => {
                    if (refreshSetup) {
                      refreshSetup();
                      return;
                    }
                    if (runtimeError) void refetchAgentConnections?.();
                    if (modelsError) void refetchModelConnections?.();
                  }}
                >
                  Retry
                </button>
              }
            />
          ) : (
            <Empty
              variant="compact"
              label="Nothing to chat with yet"
              description="Connect an engine (Claude Code, Codex, OpenCode…) or add a Model connection, and new chats appear here automatically."
              action={
                <button
                  type="button"
                  className="new-chat-modal__setup-action"
                  onClick={() => beginSetup('/connections')}
                >
                  Set up Connections
                </button>
              }
            />
          ))}
        {checkingSetup ? <p role="status">Checking connections…</p> : null}
        {flatList.length > 0 && returnError ? (
          <ErrorState
            variant="compact"
            title="Couldn't recheck chat setup"
            description={describeReadFailure(returnError)}
            action={
              <button
                type="button"
                onClick={() => {
                  if (refreshSetup) {
                    refreshSetup();
                    return;
                  }
                  if (runtimeError) void refetchAgentConnections?.();
                  if (modelsError) void refetchModelConnections?.();
                }}
              >
                Retry connections
              </button>
            }
          />
        ) : null}
        {groups.map((group, gi) => (
          <React.Fragment key={group.label}>
            <div
              className={`new-chat-modal__group-label ${group.glyph === 'plug' ? 'new-chat-modal__group-label--acp' : ''} ${
                // The rule between groups was an inline border; it is a class
                // now so the header's hairline is declared beside the row
                // hairlines it has to line up with.
                gi > 0 ? 'new-chat-modal__group-label--divided' : ''
              }`.trim()}
            >
              {group.icon || contextGlyph(group.glyph)} {group.label}
            </div>
            {group.agents.map((agent) => {
              const idx = flatList.indexOf(agent);
              const enable = resolveNewChatAgentEnable(agent);
              const fixRoute = agentFixRoute(agent);
              return (
                <AgentRow
                  key={agent.slug}
                  agent={agent}
                  isSelected={idx === selectedAgentIndex}
                  selectedRef={
                    idx === selectedAgentIndex ? selectedAgentRef : undefined
                  }
                  onSelect={() => handleSelect(agent)}
                  onHover={() => {
                    if (!checkingSetup) {
                      preservedAgentSlug.current = undefined;
                      setSelectedAgentIndex(idx);
                    }
                  }}
                  modelLabel={modelFor(agent).label}
                  modelUnavailable={
                    modelsForAgent(agent).length === 0 && !modelsLoading
                  }
                  onOpenModel={() => setModelPickerAgent(agent)}
                  interactionDisabled={mode?.pending || checkingSetup}
                  fixDisabled={
                    fixRoute === 'enable' && enable ? enableInFlight : undefined
                  }
                  onFix={(route) => {
                    // Only the server's `engine-disabled` repair may enable
                    // an alias. Broken and missing connections arrive as
                    // their own unavailableFix kinds and route below.
                    if (route === 'enable' && enable) {
                      if (!enableInFlight) void handleEnable(agent);
                      return;
                    }
                    beginSetup(
                      route === 'edit'
                        ? `/agents/${encodeURIComponent(agent.slug)}`
                        : route === 'models'
                          ? '/connections/models'
                          : '/connections/engines',
                      agent.slug,
                    );
                  }}
                />
              );
            })}
          </React.Fragment>
        ))}
      </div>
      {modelPickerAgent && (
        <div
          className="new-chat-modal__model-picker-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setModelPickerAgent(null);
          }}
        >
          <div className="new-chat-modal__model-picker">
            <React.Suspense
              fallback={
                <ModelPickerDialogFrame
                  onClose={() => setModelPickerAgent(null)}
                >
                  <SkeletonList count={3} label="Loading models" />
                </ModelPickerDialogFrame>
              }
            >
              <SessionModelPicker
                models={modelPickerModels}
                loading={modelPickerLoading}
                providers={modelPickerProviders}
                currentProviderId={
                  modelChoiceFor(modelPickerAgent)?.providerId ??
                  modelPickerDefault?.providerId
                }
                currentModel={modelChoiceFor(modelPickerAgent)?.modelId}
                defaultModel={modelPickerDefault?.id ?? undefined}
                defaultSourceLabel={modelFor(modelPickerAgent).source}
                runtimeOptions={
                  modelChoiceFor(modelPickerAgent)?.providerOptions
                }
                onSelect={(model) =>
                  updateModelChoice(modelPickerAgent, (current) => ({
                    ...current,
                    modelId: model.id,
                    providerId: model.providerId,
                    providerType: model.providerType,
                    providerOptions: sanitizeRuntimeOptionsForModel(
                      model,
                      current.providerOptions,
                    ),
                  }))
                }
                onReset={() => {
                  const key = modelChoiceKey(modelPickerAgent);
                  setModelChoices((current) => {
                    const { [key]: _removed, ...rest } = current;
                    return rest;
                  });
                }}
                onRuntimeOptionChange={(key, value) =>
                  updateModelChoice(modelPickerAgent, (current) => ({
                    ...current,
                    providerOptions: {
                      ...current.providerOptions,
                      [key]: value,
                    },
                  }))
                }
                onClose={() => setModelPickerAgent(null)}
              />
            </React.Suspense>
          </div>
        </div>
      )}
    </ResponsiveDialogSurface>
  );
}

/**
 * Filter input + selectable option list shared by the desktop anchored
 * dropdown and the mobile bottom sheet, so the two presentations never drift
 * out of sync with duplicated markup.
 */
export function ContextPickerOptions({
  contextSearch,
  onContextSearchChange,
  autoFocusFilter,
  onEscape,
  filteredContextOptions,
  selectedContext,
  onSelectContext,
}: {
  contextSearch: string;
  onContextSearchChange: (value: string) => void;
  autoFocusFilter: boolean;
  onEscape: () => void;
  filteredContextOptions: NewChatModalContextOption[];
  selectedContext: string;
  onSelectContext: (value: string) => void;
}) {
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocusFilter) filterRef.current?.focus();
  }, [autoFocusFilter]);

  return (
    <>
      <input
        ref={filterRef}
        className="new-chat-modal__dropdown-search"
        type="text"
        placeholder="Filter..."
        value={contextSearch}
        onChange={(e) => onContextSearchChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onEscape();
          }
        }}
      />
      {filteredContextOptions.map((opt) => (
        <button
          type="button"
          key={opt.value}
          data-context-value={opt.value}
          className={`new-chat-modal__dropdown-item ${opt.value === selectedContext ? 'new-chat-modal__dropdown-item--active' : ''}`}
          onClick={() => onSelectContext(opt.value)}
        >
          <span className="new-chat-modal__dropdown-item-main">
            <span className="new-chat-modal__dropdown-item-label">
              <LayoutIcon
                layout={{ name: opt.label, icon: opt.icon }}
                fallback={contextGlyph(opt.glyph)}
                size={24}
              />
              <span>{opt.label}</span>
            </span>
            {opt.workingDirectory && (
              <span className="new-chat-modal__dropdown-item-dir">
                <CwdBreadcrumb path={opt.workingDirectory} />
              </span>
            )}
          </span>
          {opt.value !== GLOBAL_CONTEXT && !opt.workingDirectory && (
            <span className="new-chat-modal__no-cwd-badge">~/</span>
          )}
        </button>
      ))}
    </>
  );
}

function contextGlyph(
  name: 'engine' | 'folder' | 'globe' | 'plug' | 'time' | undefined,
) {
  switch (name) {
    case 'engine':
      return <EngineGlyph />;
    case 'folder':
      return <FolderGlyph />;
    case 'globe':
      return <GlobeGlyph />;
    case 'plug':
      return <PlugGlyph />;
    case 'time':
      return <TimeGlyph />;
    default:
      return undefined;
  }
}

/** Working directory breadcrumb with explicit, semantically complete separators. */
function CwdBreadcrumb({ path }: { path: string }) {
  const { parent, separator, leaf } = splitCwdBreadcrumb(path);
  return (
    <output
      className="new-chat-modal__cwd-breadcrumb"
      aria-label={`Working directory: ${path}`}
      title={path}
    >
      <span className="new-chat-modal__dir-parent" aria-hidden="true">
        {parent}
      </span>
      <span className="new-chat-modal__dir-separator" aria-hidden="true">
        {separator}
      </span>
      <span className="new-chat-modal__dir-leaf" aria-hidden="true">
        {leaf}
      </span>
    </output>
  );
}

function AgentRow({
  agent,
  isSelected,
  selectedRef,
  onSelect,
  onHover,
  modelLabel,
  modelUnavailable,
  onOpenModel,
  interactionDisabled,
  fixLabel,
  fixDisabled,
  onFix,
}: {
  agent: AgentData;
  isSelected: boolean;
  selectedRef?: (element: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onHover: () => void;
  modelLabel: string;
  modelUnavailable: boolean;
  onOpenModel: () => void;
  interactionDisabled?: boolean;
  /** Set when this host knows Enable cannot be the repair — see the cell. */
  fixLabel?: 'Enable' | 'Connect' | 'Set up';
  fixDisabled?: boolean;
  onFix: (route: AgentFixRoute) => void;
}) {
  const unavailability = resolveNewChatAgentUnavailability(agent);
  // archive#3843: the picker and the Agents list mount the SAME cell, so they
  // must also read the same device projection — a row that named the host in
  // one surface and not the other would be the exact divergence §5 forbids.
  const devicePresentation = useDevicePresentation();
  const engine = agentEngineDescriptor(agent);
  const repeatsAgent =
    normalizedDisplayLabel(engineChipLabel(engine)) ===
    normalizedDisplayLabel(agent.name);
  return (
    <div
      className="new-chat-modal__agent-row"
      // The full server sentence, on the ROW rather than the button: the row
      // button is disabled whenever there is a reason to show, and a disabled
      // button receives no hover in Chromium, so a title there would never
      // appear. Sighted parity for the sentence the chip stands in for.
      title={unavailability?.description}
    >
      <button
        type="button"
        ref={selectedRef}
        data-agent-slug={agent.slug}
        className={`new-chat-modal__agent ${isSelected ? 'new-chat-modal__agent--selected' : ''}`}
        onMouseEnter={onHover}
        onClick={onSelect}
        disabled={interactionDisabled || !agentRunnability(agent).runnable}
        aria-describedby={
          unavailability ? `agent-${agent.slug}-unavailable` : undefined
        }
      >
        <div className="new-chat-modal__agent-header">
          <AgentIcon agent={agent} size="small" />
          <span
            className={`new-chat-modal__agent-name ${
              // archive#3027(d). A row that cannot start drops its NAME
              // a rung so absence reads as absence before the chip is read.
              // TO REVERT: delete this conditional class — the dimming lives
              // entirely in `.new-chat-modal__agent-name--dimmed`'s one
              // `color:` declaration.
              agent.available === false
                ? 'new-chat-modal__agent-name--dimmed'
                : ''
            }`.trim()}
          >
            {agent.name}
          </span>
          <AgentReadinessCell agent={agent} part="status" />
        </div>
        {/* One quiet line beneath the name carrying what the row IS: the
            engine (and model, when the descriptor resolves one) plus the
            agent's own description. Both were already in the row — the engine
            chip competed with the name on line one, and the description sat at
            the name's own rung. */}
        {/* Y1, in §5 as well as §2: a chip that only repeats the name is the
            engine word printed twice — every seeded engine row read
            "Claude Code" with a "Claude Code" chip beneath it. */}
        {!repeatsAgent && (
          <div className="new-chat-modal__agent-meta">
            <EngineChip engine={engine} />
          </div>
        )}
        {unavailability && (
          // Always rendered, always complete: the chip replaces the paragraph
          // VISUALLY, never in the accessibility tree. `--assistive` clips this
          // node to a screen-reader-only box so the aria-describedby target
          // still resolves to the whole sentence.
          // ALWAYS assistive now: `AgentReadinessCell` is the visible
          // statement of this row's state, so painting the sentence here too
          // printed the same refusal twice (the badge read `Needs: connection
          // offline` beside a paragraph reading `connection offline`).
          <div
            id={`agent-${agent.slug}-unavailable`}
            className="new-chat-modal__agent-reason new-chat-modal__agent-reason--assistive"
          >
            {unavailability.description}
          </div>
        )}
      </button>
      {/* State and action, together and right-aligned. The controls used to be
          bare siblings of a full-width button with no layout of their own, so
          every row wrapped them onto a second, left-aligned line under the
          name — the picker's dominant source of height. The row is a two-column
          grid now; neither the chip nor any action changed. */}
      <div className="new-chat-modal__agent-side">
        <button
          type="button"
          className="new-chat-modal__model-trigger"
          onClick={onOpenModel}
          disabled={interactionDisabled}
          aria-label={`Model: ${modelLabel}`}
          title={
            modelUnavailable
              ? 'This Agent has not reported a model catalog'
              : `Choose model: ${modelLabel}`
          }
        >
          Model · {modelLabel}
        </button>
        {/*
          DESIGN.md §5: the SAME readiness cell the Agents list row renders.
          The picker used to draw its own chip ("Not set up" behind a warning
          glyph, and nothing at all for a reason-kind refusal) beside its own
          remedy labels, over the same `agentRunnability` answer the list was
          badging differently one click away. One component, one wording, one
          verb — the row itself stays the Chat action, so no `onChat`.
*/}
        <AgentReadinessCell
          agent={agent}
          agentName={agent.name}
          devicePresentation={devicePresentation}
          fixLabel={fixLabel}
          fixDisabled={fixDisabled}
          className="button button--link"
          onFix={onFix}
          part="action"
        />
      </div>
    </div>
  );
}
