import type { InstalledSkillExperienceV1 } from '@kontourai/station-contracts/skill-experience';
import { useSkillExperienceInventoryQuery } from '@kontourai/station-sdk';
import {
  sameSkillExperienceIdentity,
  skillExperienceInputDefaults,
  skillExperiencesCanExecute,
} from '@kontourai/station-shared/skill-experience-values';
import React, {
  type ComponentProps,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { useDevicePresentation } from '../../hooks/useDevicePresentation';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useNewChatSelectionModel } from '../../hooks/useNewChatSelectionModel';
import { resolveStartContextFromProjectSlug } from '../../hooks/useNewChatStartContext';
import {
  trackContextAgent,
  trackRecentAgent,
} from '../../hooks/useRecentAgents';
import {
  useBindStartProject,
  useStartSelection,
} from '../../hooks/useStartSelection';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import type {
  NewChatHandoff,
  NewChatStartSelection,
} from '../../lib/newChatIntent';
import type { SkillExperienceDraft } from '../../lib/skill-experience-draft';
import { userFacingErrorMessage } from '../../utils/errorText';
import {
  type EffectiveModelSource,
  modelSourceLabel,
} from '../../utils/execution';
import {
  type NewChatModelChoice,
  sanitizeRuntimeOptionsForModel,
} from '../../utils/modelCapabilities';
import {
  type AgentFixRoute,
  AgentReadinessCell,
  agentFixRoute,
} from '../AgentReadinessCell';
import { agentRunnability } from '../agent-runnability';
import { Button } from '../Button';
import { AgentPickerGroups } from '../chat-start/AgentPickerRow';
import {
  ContextLabelSeparator,
  ContextPickerOptions,
  CwdBreadcrumb,
  contextGlyph,
} from '../chat-start/ContextPickerOptions';
import type { RecentChatList as RecentList } from '../chat-start/RecentChatList';
import {
  type StartAgentChip,
  StartComposer,
  type StartProjectChip,
} from '../chat-start/StartComposer';
import { StartStationControl } from '../chat-start/StartStationControl';
import { useAgentEnable } from '../chat-start/useAgentEnable';
import {
  buildCodingChatInitialMessage,
  type CodingChatContextDraft,
  composeStartMessage,
} from '../coding-layout/chatContextDraft';
import '../chat-start/ChatStart.css';
import { HomeFolderLabel } from '../HomeFolderLabel';
import { ArrowDownGlyph, WarningGlyph } from '../icons/Glyph';
import { LayoutIcon } from '../icons/LayoutIcon';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { ModelPickerDialogFrame } from '../session/ModelPickerDialogFrame';
import { SkillExperiencePicker } from '../skill-experiences/SkillExperiencePicker';
import { describeReadFailure, Empty, ErrorState, SkeletonList } from '../state';
import { AutomaticEnginePreparation } from './AutomaticEnginePreparation';
import {
  GLOBAL_CONTEXT,
  modelPickerProviders,
  NEW_CHAT_AGENT_UNAVAILABLE_FALLBACK,
  NO_PROJECT_LABEL,
  resolveNewChatAgentEnable,
  resolveNewChatInitialContext,
  resolveNewChatWorkspaceHint,
  scheduleSelectedAgentVisibility,
  workspaceHintText,
} from './new-chat-modal-utils';
import {
  type NewChatSetupAuthority,
  useNewChatSetupReturn,
} from './useNewChatSetupReturn';

const ChatSetupHelper = React.lazy(() =>
  import('../chat-start/ChatSetupHelper').then((module) => ({
    default: module.ChatSetupHelper,
  })),
);
const RecentChatList = React.lazy(() =>
  import('../chat-start/RecentChatList').then((module) => ({
    default: module.RecentChatList,
  })),
);

const SessionModelPicker = React.lazy(() =>
  import('../session/SessionModelPicker').then((module) => ({
    default: module.SessionModelPicker,
  })),
);
const StartAgentMenu = React.lazy(() =>
  import('../chat-start/StartMenus').then((module) => ({
    default: module.StartAgentMenu,
  })),
);
const StartProjectMenu = React.lazy(() =>
  import('../chat-start/StartMenus').then((module) => ({
    default: module.StartProjectMenu,
  })),
);
const StartModelPicker = React.lazy(() =>
  import('../chat-start/StartMenus').then((module) => ({
    default: module.StartModelPicker,
  })),
);

/** Re-exported for callers that imported it from here before it moved. */
export { ContextPickerOptions };

const NO_ACCENTS: ReadonlyMap<string, string> = new Map();

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
    experienceDraft?: SkillExperienceDraft,
    sendInitialMessage?: boolean,
  ) => void | Promise<void>;
  onClose: () => void;
  draftContext?: CodingChatContextDraft | null;
  mode?: NewChatModalMode;
  requestAuthority?: NewChatSetupAuthority;
  startWithDefault?: boolean;
  initialPrompt?: string;
  startSurface?: boolean;
  recentChats?: Omit<ComponentProps<typeof RecentList>, 'context' | 'agents'>;
  /**
   * What Home's composer chose (its chips), carried with a start or a
   * hand-off. A start uses exactly this; it never substitutes a default.
   */
  startSelection?: NewChatStartSelection;
  /** Work Home's composer handed over: a setup journey, or visual skills. */
  handoff?: NewChatHandoff;
  /** Home sent choices that did not parse: say so, keep the message. */
  selectionInvalid?: boolean;
  /** The draft's text as it changes, so a dismissal can hand it back. */
  onDraftChange?: (text: string) => void;
  /**
   * Whether the project chip may rebind the dock (`chatDockProjectSlug`).
   * False for a dock scoped to one project, which never moves the ambient
   * binding.
   */
  projectBindable?: boolean;
  /** False while `projects` is the pending, not-yet-loaded list (#3350). */
  projectsLoaded?: boolean;
  /**
   * The sidebar's colours over its whole project list (`useProjectAccents`,
   * read by the dock), so a dock scoped to one project still paints that
   * project in the sidebar's colour.
   */
  projectAccentBySlug?: ReadonlyMap<string, string>;
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
  startWithDefault = false,
  initialPrompt,
  startSurface = false,
  recentChats,
  startSelection,
  handoff,
  selectionInvalid = false,
  onDraftChange,
  projectBindable = false,
  projectsLoaded = true,
  projectAccentBySlug = NO_ACCENTS,
}: NewChatModalProps) {
  const { namespace, status: authorityStatus } = useAuthorityPersistence();
  // In the automatic start, "Chat options" (or a start that cannot use
  // Home's choice) drops back to the composer, prompt and all.
  const [showChatOptions, setShowChatOptions] = useState(false);
  const automaticMode = startWithDefault && !mode && !showChatOptions;
  const experienceInventory = useSkillExperienceInventoryQuery({
    enabled: !mode && !automaticMode,
    refetchOnMount: 'always',
  });
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [experience, setExperience] =
    useState<InstalledSkillExperienceV1 | null>(null);
  const [experienceInputs, setExperienceInputs] = useState<
    Record<string, string>
  >({});
  const currentExperience = experienceInventory.data?.experiences.find(
    (entry) =>
      experience &&
      sameSkillExperienceIdentity(entry.identity, experience.identity),
  );
  const isMobile = useIsMobile();
  const devicePresentation = useDevicePresentation();
  const requestActive = useRef(true);
  const initialAuthority = useRef(requestAuthority);
  useEffect(() => {
    requestActive.current = true;
    return () => {
      requestActive.current = false;
    };
  }, []);
  const automaticStartAttempted = useRef(false);
  const [discoveryCompleted, setDiscoveryCompleted] = useState(false);
  const [discoveryInProgress, setDiscoveryInProgress] = useState(false);
  const [preparedEngineId, setPreparedEngineId] = useState<
    string | undefined
  >();
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
  const [taskNotice, setTaskNotice] = useState<string | null>(null);
  const reportDraft = useEffectEvent((text: string) => onDraftChange?.(text));
  useEffect(() => {
    reportDraft(prompt);
  }, [prompt]);
  const [submitting, setSubmitting] = useState(false);
  const submitInFlight = useRef(false);
  // The control that opened the model picker; focus returns there on close.
  const modelPickerTrigger = useRef<HTMLElement | null>(null);
  // Every opening goes through here so the picker always knows where to
  // return focus: the clicked control when there is one, otherwise whatever
  // holds focus (Send or the message after a setup return).
  const openModelPicker = (agent: AgentData, trigger?: HTMLElement) => {
    modelPickerTrigger.current =
      trigger ??
      (document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : null);
    setModelPickerAgent(agent);
  };
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // The start composer is the dock's whole start surface: drafts with
  // context, visual skills and hand-offs from Home all open in it. Only a
  // fork keeps the Agent list (it forks; it does not start).
  const composerFirst = startSurface && !mode;
  const showStart = composerFirst && !automaticMode;
  // Which chip menu is open, and the control that opened it.
  const [chipMenu, setChipMenu] = useState<{
    kind: 'agents' | 'project' | 'model';
    trigger: HTMLElement | null;
    agentSlug?: string;
  } | null>(null);
  const [agentSearch, setAgentSearch] = useState('');
  const preservedAgentSlug = useRef<string | undefined>(undefined);
  const preserveSetupContext = useRef(false);
  const [returnedFromSetup, setReturnedFromSetup] = useState(false);
  const [admissionError, setAdmissionError] = useState<unknown>(undefined);
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0);
  // Home's choice, when it sent one, is the context; otherwise the same
  // resolution Home uses (`resolveStartContextFromProjectSlug`), which is
  // unknown while the dock names a project the list has not loaded (#3350).
  const [selectedContext, setSelectedContext] = useState<string>(
    () =>
      startSelection?.context ??
      resolveStartContextFromProjectSlug(
        activeProjectSlug,
        projects,
        projectsLoaded,
      ) ??
      GLOBAL_CONTEXT,
  );
  const [contextChosen, setContextChosen] = useState(Boolean(startSelection));
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
  const [contextOpen, setContextOpen] = useState(false);
  const [selectedDraftContextIds, setSelectedDraftContextIds] = useState<
    string[]
  >(() => draftContext?.items.map((item) => item.id) || []);
  const contextRef = useRef<HTMLDivElement>(null);
  const contextSelectionTouchedRef = useRef(Boolean(startSelection));
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const contextSheetPanelRef = useRef<HTMLDivElement>(null);
  const contextSheetWasOpenRef = useRef(false);
  const agentInputRef = useRef<HTMLInputElement>(null);
  const selectedAgentRef = useCallback((element: HTMLButtonElement | null) => {
    scheduleSelectedAgentVisibility(element);
  }, []);

  const selectionModel = useNewChatSelectionModel({
    agents,
    projects,
    selectedContext,
    contextSearch,
    agentSearch,
    revalidateSelection: startSurface || startWithDefault || returnedFromSetup,
  });
  const {
    viewModel,
    defaultSelection,
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
    agentConnections = [],
    modelConnections = [],
    modelChoices,
    setModelChoices,
    modelPickerAgent,
    setModelPickerAgent,
    modelsForAgent,
    modelChoiceKey,
    defaultEffectiveModelForAgent,
    selectedContextResolved = true,
  } = selectionModel;
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
  // The composer's chips: the same selection Home's composer derives.
  const start = useStartSelection(selectionModel, selectedContext);
  const draftAgent = start.agent;
  const bindProject = useBindStartProject();
  // #3350: the dock names a project the list has not loaded yet. Until it
  // has, nothing can say which context (and so which Agent and Model) a
  // start would use: the chips wait and Start is unavailable.
  // It also covers the one render after the list arrives and before the
  // context effect below moves the selection onto the dock's project.
  const resolvedStartContext = resolveStartContextFromProjectSlug(
    activeProjectSlug,
    projects,
    projectsLoaded,
  );
  const contextPending =
    !contextChosen &&
    !contextSelectionTouchedRef.current &&
    (resolvedStartContext === undefined ||
      (selectedContext === GLOBAL_CONTEXT &&
        resolvedStartContext !== GLOBAL_CONTEXT));
  const preferredAgentSlug = mode?.preferredAgentSlug;
  const preferredAgentIndex = preferredAgentSlug
    ? flatList.findIndex((agent) => agent.slug === preferredAgentSlug)
    : 0;
  const setupReturn = useNewChatSetupReturn({
    authority: requestAuthority,
    readyToResume:
      startWithDefault &&
      !runtimeFetching &&
      !modelsFetching &&
      !setupFetching &&
      !runtimeError &&
      !modelsError &&
      !setupError &&
      Boolean(
        preservedAgentSlug.current
          ? flatList.some(
              (agent) =>
                agent.slug === preservedAgentSlug.current &&
                (agentRunnability(agent).runnable ||
                  (resolveNewChatAgentEnable(agent) &&
                    agentFixRoute(agent) === 'enable')),
            )
          : defaultSelection?.agent,
      ),
    onCancel: onClose,
    allowedPaths: ['/registry', '/connections', '/agents'],
    revalidate: async () => {
      // Visual skills can show in the composer (opened there, or handed
      // over from Home with a message), so a Registry round trip refetches
      // them whenever this is not a fork.
      if (!mode) await experienceInventory.refetch();
      if (refreshSetup) await refreshSetup();
      else
        await Promise.all([
          refetchAgentConnections?.(),
          refetchModelConnections?.(),
        ]);
    },
    onResume: (error) => {
      if (showStart) setAgentSearch('');
      setAdmissionError(error);
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
    },
  });
  const beginSetup = (path: string, agentSlug?: string) => {
    if (showStart && agentSlug) start.chooseAgent(agentSlug);
    if (!setupReturn.begin(path)) {
      setSelectFeedback('Reconnect to this Station before opening setup.');
      return;
    }
    preservedAgentSlug.current =
      agentSlug ?? flatList[selectedAgentIndex]?.slug;
    preserveSetupContext.current = true;
    contextSelectionTouchedRef.current = true;
    setContextOpen(false);
    setChipMenu(null);
    setModelPickerAgent(null);
  };
  const checkingSetup =
    returnedFromSetup && (setupFetching || runtimeFetching || modelsFetching);
  const returnError = returnedFromSetup
    ? (admissionError ?? setupError ?? runtimeError ?? modelsError)
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
    if (!preferredAgentSlug || agentSearch) return;
    if (preferredAgentIndex >= 0) setSelectedAgentIndex(preferredAgentIndex);
  }, [agentSearch, preferredAgentIndex, preferredAgentSlug]);
  // archive#1089: the directory the highlighted agent will actually be
  // launched in. Derived from the agent, not just the project, because an
  // engine connection's own Working Directory outranks `$HOME` for a project
  // that names no directory — see resolveNewChatWorkspaceHint.
  const workspaceHint = resolveNewChatWorkspaceHint({
    agent: showStart ? draftAgent : flatList[selectedAgentIndex],
    project: selectedProject,
    acpConnections,
  });
  // Where a project with no folder would run with this Agent.
  const folderlessHint = resolveNewChatWorkspaceHint({
    agent: showStart ? draftAgent : flatList[selectedAgentIndex],
    project: undefined,
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
    if (!isMobile && !contextOpen) {
      if (showStart) promptRef.current?.focus();
      else agentInputRef.current?.focus();
    }
  }, [contextOpen, isMobile, showStart]);

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

  // Keyed on the item ids: the dock builds a new draft object every render,
  // and re-selecting on each one would bring back a chip the user removed.
  const draftContextKey = draftContext?.items
    .map((item) => item.id)
    .join('\u001f');
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftContextKey is the identity of draftContext's items; the effect reads the current object.
  useEffect(() => {
    setSelectedDraftContextIds((current) =>
      preserveSetupContext.current
        ? current.filter((id) =>
            draftContext?.items.some((item) => item.id === id),
          )
        : draftContext?.items.map((item) => item.id) || [],
    );
  }, [draftContextKey]);

  useEffect(() => {
    const selectedProjectStillExists = projects.some(
      (project) => project?.slug === selectedContext,
    );
    if (selectedContext !== GLOBAL_CONTEXT && !selectedProjectStillExists) {
      // Home's chosen project is kept, never swapped for a default; the start
      // refuses it out loud once the list says it is gone.
      if (startSelection && selectedContext === startSelection.context) {
        if (projectCatalogResolved && projectsLoaded) refuseMissingProject();
        return;
      }
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
      setSelectedAgentIndex(Math.max(0, preferredAgentIndex));
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
        setSelectedAgentIndex(Math.max(0, preferredAgentIndex));
      }
    }
  }, [
    activeProjectSlug,
    projects,
    selectedContext,
    returnedFromSetup,
    projectCatalogResolved,
    projectsLoaded,
    startSelection,
    preferredAgentIndex,
    setSelectFeedback,
  ]);

  const handleSelect = (
    agent: AgentData,
    options: {
      /** Started from the composer: its prompt and context are the message. */
      composer?: boolean;
      /** Home's Model choice, used as given (a start from Home). */
      choice?: NewChatModelChoice;
    } = {},
  ) => {
    const composer = options.composer === true;
    // A typed message is sent; context alone (or a visual skill) is placed in
    // the new chat's composer to review, as an Agent-row start always did.
    const sendInitialMessage =
      composer && Boolean(prompt.trim()) && !experience;
    if (
      !requestActive.current ||
      (initialAuthority.current && !initialAuthority.current.isCurrent())
    )
      return;
    if (mode?.pending || setupReturn.pending) return;
    if (
      composer &&
      (runtimeError ||
        modelsError ||
        setupError ||
        setupFetching ||
        runtimeFetching ||
        modelsFetching ||
        !projectCatalogResolved)
    ) {
      setSelectFeedback(
        'Wait for chat setup to finish checking, or retry the failed connection read.',
      );
      return;
    }
    if (checkingSetup) {
      setSelectFeedback('Wait for connections to finish checking.');
      return;
    }
    if (
      returnedFromSetup &&
      (admissionError || setupError || runtimeError || modelsError)
    ) {
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
    const initialMessage = composer
      ? composeStartMessage(prompt, draftItems, draftContext?.framing)
      : (initialPrompt ??
        buildCodingChatInitialMessage(draftItems, draftContext?.framing));
    const defaultEffectiveModel = defaultEffectiveModelForAgent(agent);
    const choice =
      options.choice ??
      (composer
        ? start.modelChoiceFor(agent)
        : modelChoices[modelChoiceKey(agent)]);
    // A Model chosen before this dialog (Home's chip, or before a setup
    // journey) can have gone meanwhile: check it before starting on it.
    if (
      (returnedFromSetup || options.choice !== undefined) &&
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
      // An automatic start shows the composer, message kept, to choose one.
      setShowChatOptions(true);
      openModelPicker(agent);
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
      if (
        experience &&
        (experienceInventory.error ||
          experienceInventory.isFetching ||
          !currentExperience ||
          !skillExperiencesCanExecute(experienceInventory.data) ||
          authorityStatus !== 'verified' ||
          !namespace ||
          !requestAuthority?.isCurrent())
      ) {
        setSelectFeedback(
          'This visual skill cannot start on this Station. Refresh its source and check Station support; your input is retained.',
        );
        return;
      }
      if (
        experience?.definition.requiredContext.some(
          (context) => context.kind === 'project' && context.required,
        ) &&
        !projectSlug
      ) {
        setSelectFeedback('Choose a workspace for this visual skill.');
        return;
      }
      if (
        experience?.definition.requiredContext.some(
          (context) => context.kind === 'conversation' && context.required,
        )
      ) {
        setSelectFeedback(
          'This visual skill requires an existing conversation. Open it there.',
        );
        return;
      }
      const experienceDraft: SkillExperienceDraft | undefined =
        experience && namespace && requestAuthority
          ? {
              namespace,
              apiBase: requestAuthority.apiBase,
              definition: experience.definition,
              start: {
                identity: experience.identity,
                inputs: experienceInputs,
              },
            }
          : undefined;
      const startOptions: [SkillExperienceDraft?, boolean?] = sendInitialMessage
        ? [experienceDraft, true]
        : experienceDraft
          ? [experienceDraft]
          : [];
      try {
        if (composer && submitInFlight.current) return;
        if (composer) {
          submitInFlight.current = true;
          setSubmitting(true);
        }
        void Promise.resolve(
          onSelect(
            agent,
            projectSlug,
            projectName,
            initialMessage ||
              (experience
                ? `Start ${experience.definition.title}.`
                : undefined),
            sessionModel,
            modelSource,
            defaultEffectiveModel.id || undefined,
            defaultEffectiveModel.source,
            choice?.providerOptions,
            choice?.providerId,
            choice?.providerType,
            ...startOptions,
          ),
        )
          .then(() => {
            try {
              trackContextAgent(namespace, selectedContext, agent.slug);
            } catch {
              /* Recency must not block a started chat. */
            }
          })
          .catch((error) => {
            submitInFlight.current = false;
            setSubmitting(false);
            console.error(
              mode?.kind === 'fork'
                ? 'Conversation fork failed:'
                : 'New chat start failed:',
              error,
            );
            setSelectFeedback(
              'Could not start the chat. Try again; if it keeps failing, restart Station.',
            );
          });
      } catch (error) {
        submitInFlight.current = false;
        setSubmitting(false);
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
        'This chat needs a project — pick one, or choose "No project".',
      );
    }
  };

  const modelChoiceFor = (agent: AgentData) =>
    modelChoices[modelChoiceKey(agent)];
  // The model-gone picker reads the composer's shared choice when the
  // composer shows, and a fork's local one otherwise.
  const pickerChoiceFor = (agent: AgentData) =>
    showStart ? start.modelChoiceFor(agent) : modelChoiceFor(agent);
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
  const pickerProviders = modelPickerProviders(
    modelPickerModels,
    modelConnections,
  );

  // archive#3027: Enable, shared with Home's composer. In the composer it
  // chooses the Agent (nothing starts); in the list and the automatic start
  // it behaves as if the user picked the resulting Agent.
  const { enable: handleEnable, inFlight: enableInFlight } = useAgentEnable({
    scopedAgents,
    selectedProjectSlug: selectedProject?.slug,
    isCurrent: () =>
      requestActive.current &&
      (!initialAuthority.current || initialAuthority.current.isCurrent()),
    onFeedback: setSelectFeedback,
    refreshSetup,
    onReady: (agent, created) => {
      if (showStart) {
        start.chooseAgent(agent.slug);
        setChipMenu(null);
        if (created && refreshSetup) void refreshSetup().catch(() => undefined);
      } else handleSelect(agent);
    },
  });

  const repairAgent = (agent: AgentData, route: AgentFixRoute) => {
    if (route === 'enable' && resolveNewChatAgentEnable(agent)) {
      if (!enableInFlight) void handleEnable(agent);
      return;
    }
    beginSetup(
      route === 'edit'
        ? `/agents/${encodeURIComponent(agent.slug)}`
        : route === 'models'
          ? '/connections/models'
          : agent.execution?.agentConnectionId
            ? `/connections/engines/${encodeURIComponent(agent.execution.agentConnectionId)}`
            : '/connections/engines',
      agent.slug,
    );
  };

  const startWorkingDefaults = useEffectEvent(
    (ready?: AgentData, prepare?: AgentData) => {
      if (ready) handleSelect(ready, { choice: startSelection?.model });
      else if (prepare) void handleEnable(prepare);
    },
  );
  // Home's chips chose an Agent this dock cannot start: say so and show the
  // composer, prompt and choices intact, rather than start another Agent.
  const refusePinnedStart = useEffectEvent(() => {
    setShowChatOptions(true);
    setSelectFeedback(
      'The Agent you chose is not ready here. Choose an Agent to continue; your message is kept.',
    );
  });

  const refuseMissingProject = useEffectEvent(() => {
    setShowChatOptions(true);
    setSelectFeedback(
      'The project you chose is no longer available. Choose a project to continue; your message is kept.',
    );
  });

  // Seed what Home handed over (a start that fell back, or a hand-off): the
  // chosen Agent, then that Agent's Model choice once it resolves.
  const seededSelection = useRef(false);
  useEffect(() => {
    // Only once the composer shows: an automatic start uses the selection as
    // given and must not write it to memory before anything starts.
    if (seededSelection.current || !startSelection?.agentSlug || automaticMode)
      return;
    seededSelection.current = true;
    start.chooseAgent(startSelection.agentSlug);
  }, [start, startSelection, automaticMode]);
  const seededModel = useRef(false);
  useEffect(() => {
    if (
      seededModel.current ||
      automaticMode ||
      !startSelection?.model ||
      !draftAgent ||
      draftAgent.slug !== startSelection.agentSlug
    )
      return;
    seededModel.current = true;
    start.seedModelChoice(draftAgent, startSelection.model);
  }, [automaticMode, draftAgent, start, startSelection]);

  useEffect(() => {
    if (
      !automaticMode ||
      discoveryInProgress ||
      selectFeedback ||
      automaticStartAttempted.current ||
      setupReturn.pending ||
      runtimeLoading ||
      modelsLoading ||
      runtimeFetching ||
      modelsFetching ||
      setupFetching ||
      checkingSetup ||
      setupError ||
      runtimeError ||
      modelsError ||
      returnError ||
      contextPending ||
      !selectedContextResolved ||
      (!isGlobal && !projectCatalogResolved)
    )
      return;
    const pinnedSlug = startSelection?.agentSlug;
    if (startSelection && !isGlobal && !selectedProject) {
      // Not yet known: the dock's own list is still loading.
      if (!projectsLoaded) return;
      automaticStartAttempted.current = true;
      refuseMissingProject();
      return;
    }
    if (pinnedSlug) {
      const pinned = flatList.find((agent) => agent.slug === pinnedSlug);
      automaticStartAttempted.current = true;
      if (pinned && agentRunnability(pinned).runnable)
        startWorkingDefaults(pinned);
      else refusePinnedStart();
      return;
    }
    const ready = defaultSelection?.agent;
    const prepare = ready
      ? undefined
      : flatList.find(
          (agent) =>
            resolveNewChatAgentEnable(agent) &&
            agentFixRoute(agent) === 'enable',
        );
    if (!ready && !prepare) return;
    automaticStartAttempted.current = true;
    startWorkingDefaults(ready, prepare);
  }, [
    automaticMode,
    discoveryInProgress,
    selectFeedback,
    setupReturn.pending,
    runtimeLoading,
    modelsLoading,
    runtimeFetching,
    modelsFetching,
    setupFetching,
    checkingSetup,
    setupError,
    runtimeError,
    modelsError,
    returnError,
    isGlobal,
    projectCatalogResolved,
    contextPending,
    selectedContextResolved,
    startSelection,
    selectedProject,
    projectsLoaded,
    defaultSelection?.agent,
    flatList,
  ]);

  // A hand-off from Home's composer: run the setup journey (or open visual
  // skills) here, where the draft survives the page change. Once.
  const handoffRan = useRef(false);
  const runHandoffRepair = useEffectEvent(
    (agent: AgentData, route: AgentFixRoute) => repairAgent(agent, route),
  );
  const runHandoffSetup = useEffectEvent(() =>
    beginSetup('/connections/engines'),
  );
  useEffect(() => {
    if (!handoff || handoffRan.current || !showStart) return;
    if (handoff.kind === 'skills') {
      handoffRan.current = true;
      setSkillsOpen(true);
      return;
    }
    if (handoff.kind === 'connections') {
      handoffRan.current = true;
      runHandoffSetup();
      return;
    }
    if (runtimeLoading || modelsLoading || contextPending) return;
    handoffRan.current = true;
    const agent =
      flatList.find((candidate) => candidate.slug === handoff.agentSlug) ??
      scopedAgents.find((candidate) => candidate.slug === handoff.agentSlug);
    if (agent) runHandoffRepair(agent, handoff.route);
    else
      setSelectFeedback(
        'The Agent you selected is no longer available here. Choose an available Agent to continue.',
      );
  }, [
    handoff,
    showStart,
    runtimeLoading,
    modelsLoading,
    contextPending,
    flatList,
    scopedAgents,
    setSelectFeedback,
  ]);

  // The composer's chips: a skeleton while the start path cannot yet say
  // what it will use, never a guess.
  const accents = projectAccentBySlug;
  const draftModelLabel = draftAgent
    ? start.modelFor(draftAgent).label
    : undefined;
  const agentChip: StartAgentChip =
    runtimeLoading ||
    modelsLoading ||
    contextPending ||
    !selectedContextResolved
      ? { status: 'loading' }
      : {
          status: 'ready',
          agent: draftAgent,
          modelLabel: draftModelLabel,
          needsSetup: draftAgent
            ? !agentRunnability(draftAgent).runnable
            : false,
        };
  const projectChip: StartProjectChip = contextPending
    ? { status: 'loading' }
    : {
        status: 'ready',
        // A project the list no longer has keeps its own name (its slug),
        // never a No project the start would not use.
        label:
          currentContextOption?.label ??
          (isGlobal ? NO_PROJECT_LABEL : selectedContext),
        isGlobal,
        accent: isGlobal ? undefined : accents.get(selectedContext),
        folder: workspaceHintText(workspaceHint),
      };
  const contextSelected = Boolean(
    draftContext?.items.some((item) =>
      selectedDraftContextIds.includes(item.id),
    ),
  );
  const canStart =
    (Boolean(prompt.trim()) || Boolean(experience) || contextSelected) &&
    Boolean(draftAgent && agentRunnability(draftAgent).runnable) &&
    !contextPending &&
    selectedContextResolved &&
    !runtimeLoading &&
    !modelsLoading &&
    !checkingSetup &&
    !setupReturn.pending &&
    !(returnError || runtimeError || modelsError || setupError) &&
    !setupFetching &&
    !runtimeFetching &&
    !modelsFetching &&
    projectCatalogResolved;
  const chooseContext = (value: string) => {
    contextSelectionTouchedRef.current = true;
    setContextChosen(true);
    preservedAgentSlug.current = undefined;
    setSelectedContext(value);
    setSelectedAgentIndex(0);
    // The project chip is remembered: it rebinds the dock, as the project
    // switcher does, so Home and the dock open on the same project next.
    if (projectBindable) bindProject(value);
  };
  const chipMenuAgent =
    chipMenu?.kind === 'model'
      ? (flatList.find((agent) => agent.slug === chipMenu.agentSlug) ??
        draftAgent)
      : undefined;

  const closeChatRequest = () => {
    if (setupReturn.close()) requestActive.current = false;
  };

  if (setupReturn.suspended) return null;

  if (automaticMode) {
    const readError = returnError ?? setupError ?? runtimeError ?? modelsError;
    const preparing =
      runtimeLoading ||
      modelsLoading ||
      setupFetching ||
      runtimeFetching ||
      modelsFetching ||
      checkingSetup ||
      enableInFlight;
    const needsAttention =
      (preparedEngineId
        ? flatList.find((agent) => agent.engineId === preparedEngineId)
        : undefined) ??
      flatList.find((agent) => agentFixRoute(agent)) ??
      flatList[0];
    const canEnableAgent = flatList.some(
      (agent) =>
        resolveNewChatAgentEnable(agent) && agentFixRoute(agent) === 'enable',
    );
    return (
      <ResponsiveDialogSurface
        layer="dialog"
        ariaLabel="New chat"
        overlayClassName="new-chat-modal__overlay"
        panelClassName="new-chat-modal"
        onClose={closeChatRequest}
      >
        <div className="new-chat-modal__header">
          <div className="new-chat-modal__title-row">
            <h3 className="new-chat-modal__title">New chat</h3>
            <ResponsiveDialogCloseButton
              label="Close new chat"
              onClick={closeChatRequest}
            />
          </div>
        </div>
        <div className="new-chat-modal__body">
          {readError || (selectFeedback && !enableInFlight) ? (
            <ErrorState
              variant="compact"
              title="Could not prepare your chat"
              description={
                selectFeedback?.text ?? describeReadFailure(readError)
              }
              action={
                <Button
                  onClick={() => {
                    automaticStartAttempted.current = false;
                    setSelectFeedback(null);
                    if (returnedFromSetup) setupReturn.retry();
                    else if (refreshSetup)
                      void refreshSetup().catch(() => undefined);
                    else {
                      void refetchAgentConnections?.();
                      void refetchModelConnections?.();
                    }
                  }}
                >
                  Try again
                </Button>
              }
            />
          ) : discoveryInProgress ||
            (!discoveryCompleted &&
              isGlobal &&
              !preparing &&
              !canEnableAgent &&
              !defaultSelection?.agent &&
              !automaticStartAttempted.current) ? (
            <AutomaticEnginePreparation
              agents={scopedAgents}
              refresh={async () => {
                if (refreshSetup) await refreshSetup();
              }}
              onStart={() => setDiscoveryInProgress(true)}
              isCurrent={() =>
                requestActive.current &&
                (!initialAuthority.current ||
                  initialAuthority.current.isCurrent())
              }
              onComplete={(engineId, failure) => {
                setDiscoveryInProgress(false);
                setPreparedEngineId(engineId);
                setDiscoveryCompleted(true);
                if (failure) setSelectFeedback(failure);
              }}
            />
          ) : preparing ||
            canEnableAgent ||
            defaultSelection?.agent ||
            automaticStartAttempted.current ? (
            <SkeletonList
              count={1}
              label={
                enableInFlight ? 'Preparing your AI app' : 'Opening your chat'
              }
            />
          ) : needsAttention ? (
            <>
              <p>
                Station needs one thing before it can use{' '}
                {needsAttention.engineDisplayName ?? needsAttention.name}.
              </p>
              <AgentReadinessCell
                agent={needsAttention}
                devicePresentation={devicePresentation}
                onFix={(route) => repairAgent(needsAttention, route)}
              />
            </>
          ) : (
            <Empty
              variant="compact"
              label="Connect an AI account"
              description="Station needs access to an AI account before it can help."
              action={
                <Button onClick={() => beginSetup('/connections/engines')}>
                  Connect an AI app
                </Button>
              }
            />
          )}
          <Button variant="link" onClick={() => setShowChatOptions(true)}>
            Chat options
          </Button>
        </div>
      </ResponsiveDialogSurface>
    );
  }

  return (
    <ResponsiveDialogSurface
      layer="dialog"
      ariaLabel={
        mode?.kind === 'fork'
          ? 'Fork from here'
          : showStart
            ? 'New chat'
            : 'New Chat'
      }
      overlayClassName="new-chat-modal__overlay"
      panelClassName="new-chat-modal"
      initialFocusRef={showStart ? promptRef : agentInputRef}
      initialFocusPolicy="desktop"
      onClose={closeChatRequest}
    >
      <div className="new-chat-modal__header">
        <div className="new-chat-modal__title-row">
          <h3 className="new-chat-modal__title">
            {mode?.kind === 'fork' ? 'Fork from here' : 'New chat'}
          </h3>
          <ResponsiveDialogCloseButton
            label={mode?.kind === 'fork' ? 'Cancel fork' : 'Close new chat'}
            onClick={closeChatRequest}
          />
        </div>

        {mode?.kind === 'fork' && (
          <div className="new-chat-modal__compat-warning" role="note">
            <strong>New independent conversation.</strong> {mode.disclosure}
          </div>
        )}

        {!showStart && !mode && !startWithDefault && !initialPrompt && (
          <SkillExperiencePicker
            query={experienceInventory}
            selected={experience}
            current={Boolean(currentExperience)}
            inputs={experienceInputs}
            onChange={setExperienceInputs}
            onSelect={(entry) => {
              if (
                experience &&
                sameSkillExperienceIdentity(experience.identity, entry.identity)
              )
                return;
              setExperience(entry);
              setExperienceInputs(
                skillExperienceInputDefaults(entry.definition),
              );
            }}
            onRemove={() => setExperience(null)}
            onBrowse={() => {
              preservedAgentSlug.current = flatList[selectedAgentIndex]?.slug;
              preserveSetupContext.current = true;
              setupReturn.begin('/registry');
            }}
          />
        )}

        {/* Context picker (the list; the composer has its project chip) */}
        {!showStart && (
          <div className="new-chat-modal__context-picker" ref={contextRef}>
            <span className="new-chat-modal__context-label-text">
              Workspace
            </span>
            <button
              ref={contextButtonRef}
              type="button"
              className="new-chat-modal__context-button"
              aria-label={`Project: ${currentContextOption?.label || 'Select project'}`}
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
                {currentContextOption?.label || 'Select project'}
              </span>
              {'path' in workspaceHint && (
                <>
                  <ContextLabelSeparator />
                  <span className="new-chat-modal__context-dir">
                    <CwdBreadcrumb path={workspaceHint.path} />
                  </span>
                </>
              )}
              {workspaceHint.kind === 'home' && (
                <>
                  <ContextLabelSeparator />
                  <HomeFolderLabel
                    className="new-chat-modal__context-dir new-chat-modal__context-dir--fallback"
                    title={
                      isGlobal
                        ? '~ (your home folder)'
                        : '~ (no project folder set — chats start in your home folder)'
                    }
                  />
                </>
              )}
              <ArrowDownGlyph className="choice-caret" />
            </button>

            {contextOpen && !isMobile && (
              <div className="new-chat-modal__dropdown">
                <ContextPickerOptions
                  folderlessHint={folderlessHint}
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
                  aria-label="Select project"
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
                      folderlessHint={folderlessHint}
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
        )}

        {!showStart && (
          <>
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
                ) {
                  handleSelect(flatList[selectedAgentIndex]);
                }
              }}
              className="new-chat-modal__search"
            />
          </>
        )}

        {!showStart && draftContext && draftContext.items.length > 0 && (
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

      {showStart ? (
        <div className="chat-start__body">
          {selectionInvalid && (
            <p role="alert">
              The choices sent with this chat could not be read. Choose an Agent
              and project to continue; your message is kept.
            </p>
          )}
          {defaultSelection?.missingPreferredAgentSlug && !draftAgent && (
            <p role="alert">
              Your previous Agent is no longer available in this workspace.
              Choose an Agent to continue.
            </p>
          )}
          <StartComposer
            prompt={prompt}
            onPromptChange={setPrompt}
            textareaRef={promptRef}
            agent={agentChip}
            onOpenModel={(trigger) =>
              setChipMenu({
                kind: 'model',
                trigger,
                agentSlug: draftAgent?.slug,
              })
            }
            stationControl={
              <StartStationControl
                prompt={prompt}
                projectSlug={viewModel.selectedProject?.slug}
                projectName={viewModel.selectedProject?.name}
                defaultEnvironment={
                  viewModel.selectedProject?.defaultEnvironment
                }
                agentSlug={draftAgent?.slug}
                model={
                  draftAgent
                    ? start.modelChoiceFor(draftAgent)?.modelId
                    : undefined
                }
                disabled={
                  submitting ||
                  Boolean(experience) ||
                  Boolean(draftContext) ||
                  !selectedContextResolved
                }
                onPromptChange={setPrompt}
                onStarted={(_task, station, sentPrompt) => {
                  setPrompt((current) =>
                    current === sentPrompt ? '' : current,
                  );
                  setTaskNotice(
                    `Task started on ${station}. Open Activity to follow its progress.`,
                  );
                }}
              />
            }
            onOpenAgents={(trigger) => {
              setAgentSearch('');
              setChipMenu({ kind: 'agents', trigger });
            }}
            project={projectChip}
            onOpenProject={(trigger) =>
              setChipMenu({ kind: 'project', trigger })
            }
            overflowActions={[
              {
                key: 'skills',
                label: 'Use a visual skill',
                checked: skillsOpen || Boolean(experience),
                onSelect: () => setSkillsOpen((open) => !open),
              },
            ]}
            skill={
              experience
                ? {
                    title: experience.definition.title,
                    onRemove: () => setExperience(null),
                  }
                : undefined
            }
            contextItems={draftContext?.items.map((item) => ({
              id: item.id,
              label: item.label,
              detail: item.detail,
              selected: selectedDraftContextIds.includes(item.id),
            }))}
            onToggleContextItem={(id) =>
              setSelectedDraftContextIds((current) =>
                current.includes(id)
                  ? current.filter((value) => value !== id)
                  : [...current, id],
              )
            }
            canStart={canStart}
            pending={submitting}
            onStart={() => {
              if (draftAgent) handleSelect(draftAgent, { composer: true });
            }}
            note={
              !prompt.trim() && contextSelected && !experience
                ? 'With no message, Start puts this context in the new chat’s composer for you to send.'
                : undefined
            }
          >
            {taskNotice && <p role="status">{taskNotice}</p>}
            {(skillsOpen || experience) && (
              <SkillExperiencePicker
                query={experienceInventory}
                selected={experience}
                current={Boolean(currentExperience)}
                inputs={experienceInputs}
                onChange={setExperienceInputs}
                startHint="Start prepares this skill in the new chat’s composer. Attach required files there, then send explicitly."
                onSelect={(entry) => {
                  if (
                    experience &&
                    sameSkillExperienceIdentity(
                      experience.identity,
                      entry.identity,
                    )
                  )
                    return;
                  setExperience(entry);
                  setExperienceInputs(
                    skillExperienceInputDefaults(entry.definition),
                  );
                }}
                onRemove={() => setExperience(null)}
                onBrowse={() => {
                  preservedAgentSlug.current = draftAgent?.slug;
                  preserveSetupContext.current = true;
                  setupReturn.begin('/registry');
                }}
              />
            )}
          </StartComposer>
          {/* setupError covers the project list too: a failed read is said,
              never shown as a guessed project chip. */}
          {(selectFeedback || returnError || setupError) && (
            <p role="alert">
              {selectFeedback?.text ??
                describeReadFailure(returnError ?? setupError)}
            </p>
          )}
          {runtimeLoading || modelsLoading ? (
            <SkeletonList count={1} label="Checking chat setup" />
          ) : !draftAgent || !agentRunnability(draftAgent).runnable ? (
            <React.Suspense
              fallback={
                <SkeletonList count={1} label="Loading setup options" />
              }
            >
              <ChatSetupHelper
                agents={
                  draftAgent
                    ? [draftAgent]
                    : flatList.filter(
                        (agent) => !agentRunnability(agent).runnable,
                      )
                }
                connections={agentConnections}
                devicePresentation={devicePresentation}
                busy={
                  enableInFlight ||
                  setupFetching ||
                  runtimeFetching ||
                  modelsFetching
                }
                onRepair={repairAgent}
                onSetup={(agent) =>
                  beginSetup(
                    agent?.execution?.agentConnectionId
                      ? `/connections/engines/${encodeURIComponent(agent.execution.agentConnectionId)}`
                      : '/connections/engines',
                    agent?.slug ?? draftAgent?.slug,
                  )
                }
                onModels={() =>
                  beginSetup('/connections/models', draftAgent?.slug)
                }
                onCheck={() => {
                  if (refreshSetup)
                    void refreshSetup().catch((error) =>
                      setSelectFeedback(userFacingErrorMessage(error)),
                    );
                }}
              />
            </React.Suspense>
          ) : null}
          {recentChats && (
            <React.Suspense
              fallback={<SkeletonList count={1} label="Loading recent chats" />}
            >
              <RecentChatList
                {...recentChats}
                context={selectedContext}
                agents={agents}
              />
            </React.Suspense>
          )}
        </div>
      ) : (
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
                      if (returnedFromSetup) {
                        if (!setupReturn.retry())
                          setSelectFeedback(
                            'Reconnect to this Station before checking setup.',
                          );
                        return;
                      }
                      if (refreshSetup) {
                        void refreshSetup().catch(() => undefined);
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
          {checkingSetup ? (
            <SkeletonList count={1} label="Checking connections" />
          ) : null}
          {flatList.length > 0 && returnError ? (
            <ErrorState
              variant="compact"
              title="Couldn't recheck chat setup"
              description={describeReadFailure(returnError)}
              action={
                <button
                  type="button"
                  onClick={() => {
                    if (returnedFromSetup) {
                      if (!setupReturn.retry())
                        setSelectFeedback(
                          'Reconnect to this Station before checking setup.',
                        );
                      return;
                    }
                    if (refreshSetup) {
                      void refreshSetup().catch(() => undefined);
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
          {!admissionError && (
            <AgentPickerGroups
              groups={groups}
              flatList={flatList}
              selectedIndex={selectedAgentIndex}
              selectedRef={selectedAgentRef}
              onChoose={(agent) => handleSelect(agent)}
              onHover={(idx) => {
                if (!checkingSetup) {
                  preservedAgentSlug.current = undefined;
                  setSelectedAgentIndex(idx);
                }
              }}
              modelLabelFor={(agent) => modelFor(agent).label}
              modelUnavailableFor={(agent) =>
                modelsForAgent(agent).length === 0 && !modelsLoading
              }
              onOpenModel={(agent, trigger) => openModelPicker(agent, trigger)}
              interactionDisabled={
                mode?.pending || checkingSetup || setupReturn.pending
              }
              fixDisabledFor={(agent) =>
                agentFixRoute(agent) === 'enable' &&
                resolveNewChatAgentEnable(agent)
                  ? enableInFlight
                  : undefined
              }
              onFix={repairAgent}
            />
          )}
        </div>
      )}
      {showStart && chipMenu && (
        <React.Suspense fallback={null}>
          {chipMenu.kind === 'agents' ? (
            <StartAgentMenu
              anchor={chipMenu.trigger}
              layer="dialog"
              groups={groups}
              flatList={flatList}
              selectedSlug={draftAgent?.slug}
              loading={runtimeLoading || modelsLoading}
              error={runtimeError ?? modelsError}
              onRetry={() => {
                if (refreshSetup) void refreshSetup().catch(() => undefined);
                else {
                  void refetchAgentConnections?.();
                  void refetchModelConnections?.();
                }
              }}
              onSetUpConnections={() => beginSetup('/connections')}
              modelLabelFor={(agent) => start.modelFor(agent).label}
              modelUnavailableFor={(agent) =>
                modelsForAgent(agent).length === 0 && !modelsLoading
              }
              // The Agent list closes for the Model picker, so the picker
              // anchors to (and returns focus to) the Agent chip, not the
              // row's trigger that goes with the list.
              onOpenModel={(agent) =>
                setChipMenu({
                  kind: 'model',
                  trigger: chipMenu.trigger,
                  agentSlug: agent.slug,
                })
              }
              onChoose={(agent) => {
                start.chooseAgent(agent.slug);
                setSelectFeedback(null);
                setAgentSearch('');
                setChipMenu(null);
              }}
              onFix={repairAgent}
              fixDisabledFor={(agent) =>
                agentFixRoute(agent) === 'enable' &&
                resolveNewChatAgentEnable(agent)
                  ? enableInFlight
                  : undefined
              }
              interactionDisabled={checkingSetup || setupReturn.pending}
              search={agentSearch}
              onSearch={setAgentSearch}
              notice={compatibilityMessage}
              onClose={() => {
                setAgentSearch('');
                setChipMenu(null);
              }}
            />
          ) : chipMenu.kind === 'project' ? (
            <StartProjectMenu
              anchor={chipMenu.trigger}
              layer="dialog"
              options={viewModel.contextOptions ?? filteredContextOptions}
              selectedContext={selectedContext}
              workspaceHint={workspaceHint}
              folderlessHint={folderlessHint}
              onChoose={(value) => {
                chooseContext(value);
                setChipMenu(null);
              }}
              onClose={() => setChipMenu(null)}
            />
          ) : chipMenuAgent ? (
            <StartModelPicker
              anchor={chipMenu.trigger}
              layer="dialog"
              models={modelsForAgent(chipMenuAgent)}
              loading={modelsLoading}
              modelConnections={modelConnections}
              choice={start.modelChoiceFor(chipMenuAgent)}
              defaultModel={defaultEffectiveModelForAgent(chipMenuAgent)}
              onSelect={(model) => start.chooseModel(chipMenuAgent, model)}
              onReset={() => start.resetModel(chipMenuAgent)}
              onRuntimeOptionChange={(key, value) =>
                start.setRuntimeOption(chipMenuAgent, key, value)
              }
              onClose={() => setChipMenu(null)}
            />
          ) : null}
        </React.Suspense>
      )}
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
                  returnFocusTarget={modelPickerTrigger.current}
                >
                  <SkeletonList count={3} label="Loading models" />
                </ModelPickerDialogFrame>
              }
            >
              <SessionModelPicker
                returnFocusTarget={modelPickerTrigger.current}
                models={modelPickerModels}
                loading={modelPickerLoading}
                providers={pickerProviders}
                currentProviderId={
                  pickerChoiceFor(modelPickerAgent)?.providerId ??
                  modelPickerDefault?.providerId
                }
                currentModel={pickerChoiceFor(modelPickerAgent)?.modelId}
                defaultModel={modelPickerDefault?.id ?? undefined}
                // Names what reset restores: a fork's preferred Agent returns
                // to the source turn's Model, not the Agent default.
                defaultSourceLabel={
                  mode?.kind === 'fork' &&
                  modelPickerAgent.slug === mode.preferredAgentSlug &&
                  mode.sourceModel
                    ? 'source turn'
                    : (modelPickerDefault?.source &&
                        modelSourceLabel(
                          modelPickerDefault.source,
                        ).toLowerCase()) ||
                      'default model'
                }
                runtimeOptions={
                  pickerChoiceFor(modelPickerAgent)?.providerOptions
                }
                onSelect={(model) => {
                  // The composer's choices are remembered wherever they are
                  // made; a fork's list keeps its choice local.
                  if (showStart) {
                    start.chooseModel(modelPickerAgent, model);
                  } else {
                    updateModelChoice(modelPickerAgent, (current) => ({
                      ...current,
                      modelId: model.id,
                      providerId: model.providerId,
                      providerType: model.providerType,
                      providerOptions: sanitizeRuntimeOptionsForModel(
                        model,
                        current.providerOptions,
                      ),
                    }));
                  }
                  setModelPickerAgent(null);
                }}
                onReset={() => {
                  if (showStart) {
                    start.resetModel(modelPickerAgent);
                  } else {
                    const key = modelChoiceKey(modelPickerAgent);
                    setModelChoices((current) => {
                      const { [key]: _removed, ...rest } = current;
                      return rest;
                    });
                  }
                  setModelPickerAgent(null);
                }}
                onRuntimeOptionChange={(key, value) =>
                  showStart
                    ? start.setRuntimeOption(modelPickerAgent, key, value)
                    : updateModelChoice(modelPickerAgent, (current) => ({
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
