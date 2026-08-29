import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  conversationQueries,
  orchestrationQueries,
  telemetry,
  useAcknowledgeConversationMutation,
  useAgentConnectionsQuery,
  useConversationInventoryQuery,
  useGenerateSessionSummaryMutation,
  useInvalidateQuery,
  useOrchestrationSessionsQuery,
} from '@kontourai/station-sdk';
import {
  applyReturnFocus,
  captureReturnFocus,
} from '@kontourai/station-shared/return-focus';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveViewFromPath } from '../../app-shell/routing';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../../contexts/ActiveChatsContext';
import {
  type AgentData,
  useAgents,
  useAgentsLoaded,
} from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { activeChatDurableId } from '../../contexts/active-chats-state';
import { CONFIG_DEFAULTS, useConfig } from '../../contexts/ConfigContext';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import {
  setShortcutContext,
  useKeyboardShortcuts,
} from '../../contexts/KeyboardShortcutsContext';
import { useModelsCatalog } from '../../contexts/ModelsContext';
import { useNavigation } from '../../contexts/NavigationContext';
import {
  type ChatFocusTarget,
  openChatsStore,
  useOpenChats,
} from '../../contexts/open-chats-store';
import { useProjects } from '../../contexts/ProjectsContext';
import { useToast } from '../../contexts/ToastContext';
import { ensureOrchestrationEventStream } from '../../hooks/orchestration/ensureOrchestrationEventStream';
import { useRehydrateSessions } from '../../hooks/useActiveChatSessions';
import { useActiveProject } from '../../hooks/useActiveProject';
import { useChatBackgroundTasksRunningCount } from '../../hooks/useBackgroundTasks';
import {
  type OpenConversationOptions,
  useChatDockActions,
} from '../../hooks/useChatDockActions';
import { useChatDockKeyboardShortcuts } from '../../hooks/useChatDockKeyboardShortcuts';
import { useChatDockState } from '../../hooks/useChatDockState';
import { useChatInput } from '../../hooks/useChatInput';
import { useDerivedSessions } from '../../hooks/useDerivedSessions';
import { useDockShellChrome } from '../../hooks/useDockShellChrome';
import { useExitTransition } from '../../hooks/useExitTransition';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import type { ChatSession, FileAttachment, NavigationView } from '../../types';
import {
  type EffectiveModelSource,
  isSessionExecutionActive,
} from '../../utils/execution';
import {
  buildHomeTaskItems,
  chatTaskSessionId,
} from '../../views/home/home-view-model';
import type { HomeViewNavigation } from '../../views/home/useHomeViewModel';
import type { AmbientDockShellApi } from '../../workspace-panes/AmbientChatDockPaneHost';
import type { WorkspacePaneDockAction } from '../../workspace-panes/WorkspacePaneDockContext';
import { agentRunnability } from '../agent-runnability';
import {
  selectChatReadyAgents,
  selectDirectNewChatAgent,
} from '../agent-selection-policy';
import { ShareIntakeController } from '../chat/ShareIntakeController';
import { ContextPercentage } from '../conversation-stats/ConversationStats';
import { LazyBoundary } from '../LazyBoundary';
import { SkillShortcutRegistrar } from '../SkillShortcutRegistrar';
import {
  ActiveWorkContextFrame,
  ActiveWorkModalBoundary,
  type ActiveWorkPanel,
} from './ActiveWorkContextFrame';
import { useChatAuthRecovery } from './ChatAuthRecoveryContext';
import { ChatDockActiveIdentity } from './ChatDockActiveIdentity';
import { ChatDockContentArea } from './ChatDockContentArea';
import { ChatDockHeader } from './ChatDockHeader';
import { ChatDockMobileHeader } from './ChatDockMobileHeader';
import { ChatDockProjectContext } from './ChatDockProjectContext';
import {
  ChatPaneFileDropBoundary,
  isChatPaneFileDropEnabled,
} from './ChatPaneFileDropBoundary';
import type { ComposerActionsMenuProps } from './ComposerActionsMenu';
import {
  CHAT_DOCK_INBOX_EXIT_MS,
  chatModelLabel,
  effectiveChatModelId,
  inboxPanelMounts,
  markDockFirstRunSeen,
  projectDisplayName,
  resolveDirectNewChatProjectSlug,
  resolveDockBadgeProjectName,
  resolveNewChatModalDefaultProjectSlug,
  resolveSessionProjectMismatchLabel,
  routeToOpenChatsCollection,
  shouldOpenDockForFirstRun,
  shouldRouteScopedChatProject,
} from './chat-dock-utils';
import { submitCommandLauncherIntent } from './command-launcher-model';
import {
  readConversationContextBoundaryUiState,
  writeConversationContextBoundaryUiState,
} from './conversationContextBoundaryUiState';
import {
  acceptConversationHandoffUiState,
  beginConversationHandoffUiState,
  refuseConversationHandoffUiState,
} from './conversationHandoffUiState';
import type { ConversationOpenRecovery } from './conversationOpenController';
import { conversationCanMutate as canMutateConversation } from './conversationOpenPolicy';
import { commitForkOpenBoundary } from './forkOpenBoundary';
import type { MobileTaskSwitcherMode } from './MobileTaskSwitcher';
import { isDockOwnedViewType, isMobileDockFullscreen } from './mobile-chrome';
import { NewChatUnavailableError } from './newChatErrors';
import {
  activateProjectChat,
  focusRoutableChatSession,
  shouldClearProjectChatScope,
} from './projectChatRequest';
import { useChatDockActiveChatSync } from './useChatDockActiveChatSync';
import { useChatDockViewModel } from './useChatDockViewModel';

/**
 * Re-open an offline queued turn from what its owning session persistently
 * knows. This deliberately carries no execution or capability metadata: the
 * session can vouch only for its agent identity, and resolveAgentExecution
 * already degrades an identity-only agent to honest unknown execution data.
 */
export function agentIdentityFromSession(
  session: Pick<ChatSession, 'agentSlug' | 'agentName'>,
): Pick<AgentData, 'slug' | 'name'> | null {
  if (!session.agentSlug || !session.agentName?.trim()) return null;
  return { slug: session.agentSlug, name: session.agentName };
}

export async function startNewChatWithMessage({
  initialMessage,
  attachments,
  migratedTurnId,
  activeSession,
  agents,
  openChatForAgent,
}: {
  initialMessage?: string;
  attachments?: FileAttachment[];
  migratedTurnId?: string;
  activeSession: ChatSession | undefined;
  agents: AgentData[];
  openChatForAgent: (
    agent: Pick<AgentData, 'slug' | 'name'>,
    projectSlug?: string,
    projectName?: string,
    initialMessage?: string,
    modelOverride?: string,
    modelSource?: EffectiveModelSource,
    defaultModel?: string,
    defaultModelSource?: EffectiveModelSource,
    providerOptions?: Record<string, unknown>,
    initialAttachments?: FileAttachment[],
    providerId?: string,
    providerType?: string,
  ) => void;
}): Promise<void> {
  if (!activeSession) {
    throw new NewChatUnavailableError('no active conversation to copy from');
  }
  const agent =
    agents.find((candidate) => candidate.slug === activeSession.agentSlug) ??
    agentIdentityFromSession(activeSession);
  if (!agent) {
    throw new NewChatUnavailableError(
      'the active conversation has no agent identity to copy from',
    );
  }
  openChatForAgent(
    agent,
    activeSession.projectSlug,
    undefined,
    initialMessage,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    attachments,
    undefined,
    undefined,
  );
  if (migratedTurnId) {
    const { outboundDispatch } = await import('../../lib/outboundQueue');
    await outboundDispatch.discard(migratedTurnId);
  }
}

/**
 * Both launchers are overlays behind an explicit action and render nothing until
 * opened, so neither belongs in the entry chunk. `DelegationLauncher` alone is
 * ~460 lines; its data queries are already `enabled: isOpen`, and remounting it
 * per open matches the reset its own open-transition ref performs. The entry
 * budget in scripts/ui-bundle-budget.mjs is tight enough that this matters (see
 * the note there).
 */
const loadCommandLauncher = () =>
  import('./CommandLauncher').then((module) => ({
    default: module.CommandLauncher,
  }));

const loadDelegationLauncher = () =>
  import('./DelegationLauncher').then((module) => ({
    default: module.DelegationLauncher,
  }));

/**
 * station#1301 slice 1: an overlay behind an explicit trigger (the tab bar's
 * Background tasks button, or the mobile activity switcher's row) that
 * renders nothing until opened — same lazy-load rationale as the two
 * launchers above. Keeps the sheet's markup and its per-row expand state out
 * of the entry chunk; only the small trigger button + the store it reads a
 * running count from ship eagerly.
 */
const loadBackgroundTasksSheet = () =>
  import('./BackgroundTasksSheet').then((module) => ({
    default: module.BackgroundTasksSheet,
  }));

const loadChatDockInboxPanel = () =>
  import('./ChatDockInboxPanel').then((module) => ({
    default: module.ChatDockInboxPanel,
  }));

const loadMobileTaskSwitcher = () =>
  import('./MobileTaskSwitcher').then((module) => ({
    default: module.MobileTaskSwitcher,
  }));

const loadChatDockModalStack = () =>
  import('./ChatDockModalStack').then((module) => ({
    default: module.ChatDockModalStack,
  }));

const loadConversationHandoffDialog = () =>
  import('./ConversationHandoffDialog').then((module) => ({
    default: module.ConversationHandoffDialog,
  }));
const loadConversationContextResetDialog = () =>
  import('./ConversationContextResetDialog').then((module) => ({
    default: module.ConversationContextResetDialog,
  }));
const loadConversationOpenRecoveryNotice = () =>
  import('./ConversationOpenRecoveryNotice').then((module) => ({
    default: module.ConversationOpenRecoveryNotice,
  }));
const loadConversationOpenController = () =>
  import('./conversationOpenController');
const loadConversationOpenRevalidator = () =>
  import('./ConversationOpenRevalidator').then((module) => ({
    default: module.ConversationOpenRevalidator,
  }));

/**
 * The pane-host machinery is ~17KB of entry budget the dock does not need at
 * parse time, so it stays a chunk. But the dock is a persistent shell
 * affordance: waiting for a user gesture to start the request would leave it
 * absent on first paint. The request is therefore started when this module is
 * evaluated — entry time — so the chunk arrives alongside the entry rather
 * than after it, and the boundary resolves without a visible gap.
 *
 * The promise is remembered so React's `lazy` does not re-request it, and
 * dropped on rejection so `LazyBoundary`'s Retry re-runs the import instead of
 * replaying a cached failure.
 */
let ambientChatDockPaneHostModule: Promise<{
  default: typeof import('../../workspace-panes/AmbientChatDockPaneHost').AmbientChatDockPaneHost;
}> | null = null;

const loadAmbientChatDockPaneHost = () => {
  ambientChatDockPaneHostModule ??= import(
    '../../workspace-panes/AmbientChatDockPaneHost'
  )
    .then((module) => ({ default: module.AmbientChatDockPaneHost }))
    .catch((error: unknown) => {
      ambientChatDockPaneHostModule = null;
      throw error;
    });
  return ambientChatDockPaneHostModule;
};

void loadAmbientChatDockPaneHost();

function renderAmbientChatPane(
  _instance: WorkspacePaneInstance,
  onRequestAuth: (() => Promise<boolean> | undefined) | undefined,
  shellChrome: AmbientDockShellApi,
) {
  return (
    <ChatWorkspacePane
      placement="dock"
      onRequestAuth={onRequestAuth}
      shellChrome={shellChrome}
    />
  );
}

export type ChatWorkspacePanePlacement = 'dock' | 'fullscreen';

interface ChatWorkspacePaneSharedProps {
  /** A layout-bound pane has an immutable Project scope. */
  projectSlug?: string;
  /** Required by every fullscreen entry point for cross-project routing. */
  layoutSlug?: string;
  onRequestAuth?: () => Promise<boolean> | undefined;
}

/**
 * Discriminated on `placement` (station#4460 review M3): a docked pane MUST
 * carry the ambient `DockShell`'s chrome (geometry, snap, placement,
 * `dock.toggle`/`dock.maximize`, `dockPane` for the occupant picker) — the
 * shell is the single, persistent owner of that state, so a docked Chat
 * consumes it rather than keeping its own copy. A full-screen placement
 * never mounts inside `DockShell` and so never receives one; it owns an
 * independent local instance instead (see `ChatWorkspacePane` below). Typing
 * it this way lets the compiler prove `shellChrome` is defined wherever
 * `placement === 'dock'`, instead of a non-null assertion at every read.
 */
type ChatWorkspacePaneProps = ChatWorkspacePaneSharedProps &
  (
    | { placement: 'dock'; shellChrome: AmbientDockShellApi }
    | { placement: 'fullscreen'; shellChrome?: never }
  );

const COMMAND_LAUNCHER_MODIFIERS: ('cmd' | 'ctrl' | 'shift' | 'alt')[] = [
  'cmd',
  'shift',
];

type ProjectChatsEventDetail = {
  projectSlug?: string;
  projectName?: string;
};

export function ChatWorkspacePane(props: ChatWorkspacePaneProps) {
  const { placement, projectSlug, layoutSlug, onRequestAuth } = props;
  const isFullscreenPlacement = placement === 'fullscreen';
  // A full-screen placement never mounts inside the ambient `DockShell`, so
  // it owns an independent chrome instance (cmd+D / cmd+M keep working
  // there, and it never reserves ambient route space). A docked placement
  // consumes the shell's own instance instead of a second local copy — this
  // hook call still has to happen unconditionally (rules of hooks), but its
  // effects/state are simply unused when docked (`chrome` below reads from
  // `props.shellChrome` in that case). `registersDockShortcuts` is the other
  // half of that: this LOCAL instance must only register `dock.toggle` /
  // `dock.maximize` for the full-screen case — a docked Chat's local
  // instance registering too would fight `DockShell`'s real registration for
  // the same ids after an occupant switch (station#4460 review H1).
  const localShellChrome = useDockShellChrome({
    publishesDockSlotClearance: false,
    registersDockShortcuts: isFullscreenPlacement,
  });
  // Narrowed on `props.placement` directly (not a destructured alias) so
  // TypeScript proves `props.shellChrome` is defined in the docked branch —
  // no non-null assertion (station#4460 review M3). `occupantPicker` is a
  // pre-rendered node the ambient host already built (review round M4) —
  // Chat renders it as-is, the same way Home/Activity do, instead of
  // importing `DockOccupantPicker` into this eager module itself.
  const { chrome, occupantPicker } =
    props.placement === 'fullscreen'
      ? { chrome: localShellChrome, occupantPicker: undefined }
      : {
          chrome: props.shellChrome,
          occupantPicker: props.shellChrome.occupantPicker,
        };
  const recoverAuth = useChatAuthRecovery();
  const requestAuth = onRequestAuth ?? recoverAuth;
  // The composer's grouped "+" actions menu is the only persistently
  // mounted anchor for Delegate/Commands/Files/Task-context (the menu
  // items themselves unmount when the popover closes) — every launched
  // surface below restores focus here on close.
  const composerMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const composerAgentTriggerRef = useRef<HTMLButtonElement>(null);
  const handoffReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const taskSwitcherTriggerRef = useRef<HTMLButtonElement>(null);
  // Get data from contexts
  const { apiBase } = useApiBase();
  const sessionInventoryMountRef = useRef<HTMLDivElement>(null);
  const {
    isDockOpen,
    isDockMaximized,
    dockMode,
    activeChat,
    pathname,
    navigate,
    setActiveChat,
    setDockState,
    setDockMode,
    setProject,
    setLayout,
  } = useNavigation();
  // Placement, viewport and placement-commit are shell CHROME (station#4460)
  // — read from `chrome` (the shared ambient instance when docked, this
  // placement's own instance when full-screen) rather than a second local
  // derivation, so Chat, Home and Activity never disagree about them.
  const {
    isMobile,
    visualViewport,
    availableDockSlotPlacements,
    effectiveDockSlotPlacement,
    commitDockPlacement,
  } = chrome;
  const agents = useAgents();
  const agentsLoaded = useAgentsLoaded();
  const { projects } = useProjects();
  const { showToast } = useToast();
  // station#3687 seams 3/5: an inbox click that opened nothing says so.
  const showInboxOpenFailure = useCallback(
    (message: string) => void showToast(message),
    [showToast],
  );
  const invalidate = useInvalidateQuery();
  // station#4525 review MED-3: the New Chat modal's project-step default,
  // for the ambient dock, falls back to this (the route-level "project I
  // am currently viewing") only when there is no shell-owned binding —
  // restoring the pre-station#4525 behavior for a user who has never bound
  // one. See `resolveNewChatModalDefaultProjectSlug`.
  const { projectSlug: routeActiveProjectSlug } = useActiveProject();
  const {
    models: availableModels,
    isLiveConfirmed: globalModelsLiveConfirmed,
    modelsLoading: globalModelsLoading,
  } = useModelsCatalog();
  const appConfig = useConfig();
  const { isMac } = useKeyboardShortcuts();
  const defaultFontSize =
    appConfig?.defaultChatFontSize ?? CONFIG_DEFAULTS.defaultChatFontSize;

  // A full-screen layout is a placement of this exact controller, not a
  // maximized dock. It remains usable when the ambient dock is collapsed and
  // intentionally leaves that dock's persisted snap state untouched.
  const isPaneOpen = isFullscreenPlacement || isDockOpen;
  const isPaneMaximized = isFullscreenPlacement || isDockMaximized;

  // Derive sessions first so activeSessionCount is available for useChatDockState
  const [projectFilter, _setProjectFilter] = useState<string | null>(null);
  const hasImmutableProjectScope = isFullscreenPlacement;
  const scopedProjectSlug = hasImmutableProjectScope
    ? projectSlug
    : projectFilter;
  const setProjectFilter = useCallback(
    (nextProjectSlug: string | null) => {
      if (!hasImmutableProjectScope) _setProjectFilter(nextProjectSlug);
    },
    [hasImmutableProjectScope],
  );
  const [newChatProjectOverride, setNewChatProjectOverride] = useState<{
    slug: string;
    name: string;
  } | null>(null);
  const [handoffSource, setHandoffSource] = useState<{
    id: string;
    agentSlug: string;
  } | null>(null);
  const [forkSource, setForkSource] = useState<{
    id: string;
    agentSlug: string;
    turnId: string;
    projectSlug?: string;
    projectName?: string;
    model?: string;
    modelSource?: EffectiveModelSource;
    defaultModel?: string;
    defaultModelSource?: EffectiveModelSource;
    providerOptions?: Record<string, unknown>;
    providerId?: string;
    providerType?: string;
    sourceSessionId?: string;
    idempotencyKey: string;
  } | null>(null);
  const [forkOperation, setForkOperation] = useState<{
    pending: boolean;
    error: string | null;
  }>({ pending: false, error: null });
  const forkAbortRef = useRef<AbortController | null>(null);
  const forkGenerationRef = useRef(0);
  const cancelFork = useCallback(() => {
    forkGenerationRef.current += 1;
    forkAbortRef.current?.abort();
    forkAbortRef.current = null;
    setForkOperation({ pending: false, error: null });
    setForkSource(null);
  }, []);
  const forkEligibleAgents = useMemo(() => {
    if (!forkSource) return agents;
    return agents
      .filter((agent) => agentRunnability(agent).runnable)
      .sort((left, right) => {
        if (left.slug === forkSource.agentSlug) return -1;
        if (right.slug === forkSource.agentSlug) return 1;
        return 0;
      });
  }, [agents, forkSource]);
  const [contextResetSource, setContextResetSource] = useState<{
    id: string;
  } | null>(null);
  // Scope is a dock presentation filter over the active tabs, not a separate
  // inventory. Keep the unfiltered source for a new sidebar request: React
  // has not applied `_setProjectFilter` yet while that handler is selecting
  // the latest matching tab.
  // The dock and its Inbox are global surfaces. A route-selected Agent (for
  // example while editing /agents/codex) is page context, not a hidden dock
  // filter; applying it here made the header count disagree with the global
  // Inbox rows. Explicit Project scope remains a presentation filter below.
  const allSessions = useDerivedSessions(apiBase, null);
  const sessions = useMemo(
    () =>
      scopedProjectSlug
        ? allSessions.filter(
            (session) => session.projectSlug === scopedProjectSlug,
          )
        : allSessions,
    [allSessions, scopedProjectSlug],
  );
  // Stabilized for `ChatDockInboxPanel`'s `memo()` wrap (review r1 MEDIUM
  // finding): mapping `sessions` inline at the call site allocated a new
  // array every render, which defeats `React.memo`'s shallow prop
  // comparison regardless of the wrap.
  const openInboxChatSessionIds = useMemo(
    () => sessions.map((session) => session.id),
    [sessions],
  );
  // UX audit T5: the query's own state travels with its data. `data` defaults
  // to `[]` while the read is pending or failed, and the dock used to read
  // that empty array as "this session does not exist on the server".
  const {
    data: orchestrationSessions = [],
    status: orchestrationSessionsStatus,
    refetch: refetchOrchestrationSessions,
  } = useOrchestrationSessionsQuery();
  const openChatItems = useOpenChats(agents, orchestrationSessions);
  const inventory = useConversationInventoryQuery();
  const acknowledgeConversation = useAcknowledgeConversationMutation();
  const inventoryById = useMemo(
    () =>
      new Map(
        (inventory.data ?? []).map((conversation) => [
          conversation.id,
          conversation,
        ]),
      ),
    [inventory.data],
  );
  const taskItems = useMemo(() => {
    const currentSessionIdByConversation = new Map(
      allSessions.flatMap((session) =>
        session.conversationId && session.currentSessionId
          ? [[session.conversationId, session.currentSessionId] as const]
          : [],
      ),
    );
    return buildHomeTaskItems({
      chats: {},
      sessions: orchestrationSessions,
      agents,
      chatItems: openChatItems,
      currentSessionIdByConversation,
    }).map((item) => {
      const conversation = inventoryById.get(item.id);
      if (!conversation) return item;
      const acknowledgedAt = conversation.acknowledgedAt
        ? Date.parse(conversation.acknowledgedAt)
        : Number.NaN;
      return {
        ...item,
        conversationUpdatedAt: conversation.updatedAt,
        ...(Number.isFinite(acknowledgedAt) ? { acknowledgedAt } : {}),
      };
    });
  }, [
    agents,
    allSessions,
    inventoryById,
    openChatItems,
    orchestrationSessions,
  ]);
  const acknowledgeTaskConversation = useCallback(
    (item: { id: string; conversationUpdatedAt?: string }) => {
      if (!item.conversationUpdatedAt) return;
      acknowledgeConversation.mutate({
        conversationId: item.id,
        updatedAt: item.conversationUpdatedAt,
      });
    },
    [acknowledgeConversation],
  );
  const activeSessionCount = sessions.filter(isSessionExecutionActive).length;

  // Dock CHROME (snap/geometry/dragging) lives in `chrome` now — owned by
  // the persistent DockShell (or, for a full-screen placement, this
  // placement's own local instance), never reset by an ambient occupant
  // switch. Aliased to the SAME names the rest of this component already
  // used them by, so the (large, pre-existing) body below needed no further
  // changes.
  const {
    dockSnap,
    dockHeight,
    isDragging,
    applyDockSnap,
    restoreDockToDocked,
    onMobileHeaderDragPointerDown,
    onMobileHeaderDragClickCapture,
    // A drag that starts from Collapsed previews the real body at the live
    // pointer height without committing the open/half navigation state — the
    // release snap is the only owner of that transition. Derived once inside
    // `useDockShellChrome` (station#4460 review L4), not re-derived here, so
    // `DockShell` and this occupant can never disagree about it mid-render.
    isCollapsedDragPreview,
    // station#4525: the dock's own remembered project binding — destructured
    // (not read through `chrome.foo`) so these stay the SAME stable
    // `useCallback` references `useDockShellChrome` returns, matching every
    // other chrome field aliased here.
    activeProjectSlug: dockChromeProjectSlug,
    setActiveProjectSlug,
  } = chrome;

  // Idle auto-collapse: collapse an open, idle dock down to the Collapsed bar.
  // This reuses the Collapsed snap path so the bar and its drag/resize handle
  // stay mounted on-screen — the dock never hides or translates off-screen.
  const handleAutoCollapse = useCallback(() => {
    applyDockSnap('collapsed');
  }, [applyDockSnap]);

  // Consolidated UI state — occupant-owned display preferences only; dock
  // chrome moved to `chrome` above (station#4460).
  const {
    chatFontSize,
    setChatFontSize,
    showStatsPanel,
    setShowStatsPanel,
    showReasoning,
    setShowReasoning,
    showToolDetails,
    setShowToolDetails,
    showChatSettings,
    setShowChatSettings,
    showNewChatModal,
    setShowNewChatModal,
    showSessionPicker,
    setShowSessionPicker,
    activeSessionId,
    setActiveSessionId,
    autoHideEnabled,
    setAutoHideEnabled,
    resetAutoHide,
  } = useChatDockState({
    defaultFontSize,
    isDockOpen: isPaneOpen,
    isDockMaximized: isPaneMaximized,
    activeSessionCount,
    onAutoCollapse: handleAutoCollapse,
  });
  // A non-tab recovery is still committed UI state (not a toast). It is used
  // only when Station cannot safely hydrate an existing transcript into a
  // tab; once a tab exists its `conversationOpenState` is the canonical copy.
  const [conversationOpenRecovery, setConversationOpenRecovery] =
    useState<ConversationOpenRecovery | null>(null);

  // station#1301 slice 1: the active session's running-background-task count,
  // for the tab bar's badge and the mobile switcher's row label.
  const backgroundTasksRunningCount =
    useChatBackgroundTasksRunningCount(activeSessionId);

  // #869 / #1298: a maximized dock is opaque and full-height, so navigating
  // to another part of the app changed the view *underneath* it and nothing
  // moved — from the user's side the click did nothing. `chrome.restoreDockToDocked`
  // (and the pathname-watching effect that drives it on every plain route
  // change) now lives in `useDockShellChrome` — this is the one remaining
  // explicit-seam caller (#1298), for a navigation that only changes a query
  // param and so never fires that effect's pathname delta.
  //
  // #1298: a pathname-only backstop misses a real case — a dock-owned
  // surface (an inbox row, the project badge, a delegation toast) can
  // navigate to a route that is ALREADY the current pathname with just a
  // different query param (e.g. two inbox rows that both fall back to
  // `/activity?session=<id>` for a session Station can't rehydrate, each
  // naming a different session). The effect above only fires on a pathname
  // CHANGE, so that case would never collapse the dock even though the
  // content underneath it just changed. Call this explicitly at each such
  // seam instead of only reacting to `pathname`.
  const collapseDockForNavigation = useCallback(() => {
    if (isFullscreenPlacement || !isDockMaximized) return;
    restoreDockToDocked();
  }, [isDockMaximized, isFullscreenPlacement, restoreDockToDocked]);

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  // Persisted via the device-settings store (station#settings-revamp
  // slice 2 — previously its own raw `station.inbox.open` localStorage key).
  const { inboxOpen: isInboxOpen } = useDeviceSettings();
  // station#3309: keep the panel mounted for its exit beat so collapsing gives
  // its column back as it leaves, instead of deleting it between two frames.
  // The hook, not the CSS, owns the reduced-motion case — that branch has to
  // decline to keep the element mounted at all.
  const inboxPresence = useExitTransition(isInboxOpen, CHAT_DOCK_INBOX_EXIT_MS);
  const { setDeviceSetting } = useDeviceSettingsActions();
  const [isCommandLauncherOpen, setIsCommandLauncherOpen] = useState(false);
  const [isDelegationLauncherOpen, setIsDelegationLauncherOpen] =
    useState(false);
  const [activeWorkPanel, setActiveWorkPanel] =
    useState<ActiveWorkPanel | null>(null);
  const [isTaskSwitcherOpen, setIsTaskSwitcherOpen] = useState(false);
  // Which entry point opened the switcher — the chat-title chevron (full list)
  // or the header's activity button (running / just-finished first).
  const [taskSwitcherMode, setTaskSwitcherMode] =
    useState<MobileTaskSwitcherMode>('tasks');
  const activityTriggerRef = useRef<HTMLButtonElement>(null);
  // station#1301 slice 1: one shared open/close boolean for the Background
  // tasks sheet, opened from either entry point (desktop tab-bar button,
  // mobile activity-switcher row, or the transcript banner tap target).
  // `backgroundTasksTriggerRef` is the desktop anchor; on mobile it is never
  // populated (the button that owns it doesn't render there), so
  // `ResponsiveDialogSurface` falls back to its un-anchored bottom sheet.
  const [isBackgroundTasksOpen, setIsBackgroundTasksOpen] = useState(false);
  const backgroundTasksTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isMobile) setIsTaskSwitcherOpen(false);
  }, [isMobile]);

  const rehydrateSessions = useRehydrateSessions(apiBase);
  const {
    chatEngineConnection,
    activeSession,
    activeOrchestrationSession,
    activeOrchestrationSessionRead,
    activeSessionForHook,
    agentDefaultModelId,
    bindingStatus,
    connectionApprovalModeDefault,
    toolPolicyDelivery,
    effectiveModels,
    fileAttachmentsSupported,
    imageAttachmentRefusal,
    gitStatus,
    modelSupportsAttachments,
    modelProviderLabel,
    modelProviders,
    modelsLoading,
    modelsStale,
    sessionCodingLayout,
    sessionDisplayCwd,
    sessionProjectName,
    unreadCount,
  } = useChatDockViewModel({
    activeSessionId,
    availableModels,
    globalModelsLoading,
    globalModelsLiveConfirmed,
    agents,
    sessions,
    orchestrationSessions,
    orchestrationSessionsStatus,
  });
  const inventoryChatStoreId = activeSession?.id;
  const conversationCanMutate = activeSession
    ? canMutateConversation(activeSession)
    : false;
  const inventoryExecutionId = conversationCanMutate
    ? (activeSession?.currentSessionId ?? inventoryChatStoreId)
    : undefined;
  const inventoryProjectSlug = activeSession?.projectSlug;
  const inventoryProjectId = inventoryProjectSlug
    ? projects.find((project) => project.slug === inventoryProjectSlug)?.id
    : undefined;
  const activeConversationId = activeSession?.conversationId ?? '';
  const [contextBoundaryStored, setContextBoundaryStored] = useState(() =>
    activeConversationId
      ? readConversationContextBoundaryUiState(activeConversationId)
      : null,
  );
  useEffect(() => {
    setContextBoundaryStored(
      activeConversationId
        ? readConversationContextBoundaryUiState(activeConversationId)
        : null,
    );
    const onStorage = () =>
      setContextBoundaryStored(
        activeConversationId
          ? readConversationContextBoundaryUiState(activeConversationId)
          : null,
      );
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [activeConversationId]);
  // This dock chrome is eagerly mounted. Keep the status client's query
  // implementation lazy with the reset dialog instead of charging every
  // first paint for a rare conversation action.
  const contextBoundaryStatusQuery = useQuery({
    queryKey: [
      'conversation-context-boundary',
      apiBase,
      activeConversationId,
      contextBoundaryStored?.idempotencyKey,
    ],
    enabled: Boolean(activeConversationId && contextBoundaryStored),
    queryFn: async () => {
      const { getConversationContextBoundaryStatus } = await import(
        '@kontourai/station-sdk/client'
      );
      return getConversationContextBoundaryStatus(
        apiBase,
        activeConversationId,
        contextBoundaryStored!.idempotencyKey,
      );
    },
    staleTime: 2_000,
    refetchInterval: 2_000,
    retry: false,
  });
  useEffect(() => {
    if (!contextBoundaryStored || !contextBoundaryStatusQuery.data) return;
    if (
      contextBoundaryStored.status === contextBoundaryStatusQuery.data.status &&
      contextBoundaryStored.boundaryId ===
        contextBoundaryStatusQuery.data.boundaryId &&
      contextBoundaryStored.policy === contextBoundaryStatusQuery.data.policy
    )
      return;
    setContextBoundaryStored(
      writeConversationContextBoundaryUiState(
        contextBoundaryStored.idempotencyKey,
        contextBoundaryStatusQuery.data,
      ),
    );
  }, [contextBoundaryStatusQuery.data, contextBoundaryStored]);
  // station#4525: the dock header's project binding is DockShell-owned state
  // (`chrome.activeProjectSlug`), not a derivation of the active session's
  // own `projectSlug` — that derivation was the actual reset mechanism (see
  // the Phase-1 investigation on the issue): a docked Chat occupant remounts
  // on every occupant switch (`WorkspacePaneHostTree`'s chromeless host only
  // ever renders the ONE active occupant) and a directly-created new chat
  // never carried a project at all, so a session-derived badge fell back to
  // null in both cases even though nothing the user did asked for that.
  // `chrome.activeProjectSlug` survives both because it is owned by the
  // persistent `DockShell`, not the remounting occupant, and persisted
  // (`chatDockProjectSlug`) so it also survives a reload. `scopedProjectSlug`
  // (the project CHAT-SCOPE filter, or a full-screen placement's own
  // immutable project) still wins when active — it is a stronger, explicit
  // statement of "only this project's chats" than the dock's ambient memory.
  const dockProjectSlug = scopedProjectSlug ?? dockChromeProjectSlug;
  // station#4525 review HIGH-2/MED-1: the badge names the BOUND project
  // (`resolveDockBadgeProjectName`, shared by the desktop and mobile
  // triggers so the two can never disagree) — but the session's own
  // directory/git/coding-layout facts are NOT gated on it (see the JSX
  // below: they read straight off `sessionDisplayCwd`/`gitStatus`/
  // `sessionCodingLayout`, exactly as pre-station#4525, unconditionally).
  // `sessionSourceProjectSlug`/`sessionSourceProjectName` are threaded
  // through to both derivations rather than reading `activeSession` inline
  // twice, so the badge name and the mismatch label can never read two
  // different "the session's project" facts.
  const sessionSourceProjectSlug = activeSession?.projectSlug;
  const dockBadgeProjectName = resolveDockBadgeProjectName({
    scopedProjectSlug,
    dockProjectSlug,
    sessionProjectSlug: sessionSourceProjectSlug,
    sessionProjectName,
    projects,
  });
  // station#4525 review MED-1 (owner design ruling): non-null only when the
  // chat actually on screen belongs to a DIFFERENT project than the bound
  // badge — the muted lead-in the facts row shows so the header never
  // implies the visible transcript belongs to the badge's project, without
  // suppressing (HIGH-2) the facts themselves.
  const sessionProjectMismatchLabel = resolveSessionProjectMismatchLabel({
    scopedProjectSlug,
    dockProjectSlug,
    sessionProjectSlug: sessionSourceProjectSlug,
    sessionProjectName,
  });
  const attachmentCapabilities = useMemo(
    () => ({
      images: modelSupportsAttachments,
      files: fileAttachmentsSupported,
      imageRefusal: imageAttachmentRefusal,
    }),
    [
      fileAttachmentsSupported,
      imageAttachmentRefusal,
      modelSupportsAttachments,
    ],
  );

  // Chat input hook - encapsulates autocomplete, history, and input handling
  const chatInput = useChatInput({
    apiBase,
    sessionId: activeSessionId,
    agentSlug: activeSessionForHook?.agentSlug || null,
    conversationId: activeSessionForHook?.conversationId,
    availableModels: effectiveModels,
    modelsStale,
    bindingStatus,
    runtimeConnection: chatEngineConnection,
    agentDefaultModel: agentDefaultModelId,
    attachmentCapabilities,
    defaultModelSource: activeSessionForHook?.defaultModelSource,
    onSessionMigrate: (newSessionId) => {
      setActiveSessionId(newSessionId);
      // station#3782: stamp this chat's durable identity — the conversation id
      // its first successful turn just assigned, or its session id if that
      // promotion has not happened. This used to write `conversationId ?? null`
      // and so ERASED `?chat=` for exactly the chat the user is sending in,
      // leaving a reload with nothing to reopen (#3765).
      setActiveChat(
        activeChatDurableId(
          newSessionId,
          activeChatsStore.getSnapshot()[newSessionId],
        ),
      );
    },
    onAuthError: () => requestAuth?.(),
    onOpenNewChat: () => setShowNewChatModal(true),
    // station#1294 review (SHOULD-FIX-4): a send failing while the dock is
    // collapsed has nowhere visible to render the transcript notice — the
    // generic toast must not be suppressed in that case.
    isChatVisible: isPaneOpen,
  });

  // The enriched catalog row for the chat the dock is showing, resolved once
  // for every surface that renders its identity (station#3309).
  const activeChatAgent = activeSession
    ? agents.find((agent) => agent.slug === activeSession.agentSlug)
    : undefined;

  // station#3309: the model the dock header names — the same answer the
  // composer's model pill gives, arrived at the same way. `effectiveChatModelId`
  // picks WHICH id; then, exactly as `ChatInputArea` does, an alias that the
  // engine has resolved renders as the concrete model it resolved TO (#1012)
  // and everything else falls through to the shared `modelDisplayLabel`.
  //
  // Caught live rather than reasoned about: without the `resolvedModelLabel`
  // arm the header read "Default (recommended)" beside a composer pill naming
  // the actual model — one fact, two stories, which is the whole reason both
  // of these helpers exist. No id reported means no chip, not a placeholder.
  const activeChatModelId = effectiveChatModelId({
    composerModel: chatInput.currentModel,
    sessionModel: activeSession?.model,
    agentDefaultModel: agentDefaultModelId,
  });
  const activeChatModelLabel = chatModelLabel(
    activeChatModelId,
    effectiveModels,
  );

  /**
   * station#1259. `DelegationLauncher`'s `onClose` restores focus itself, but
   * it is not the only way the launcher goes away: delegating successfully
   * closes it, and so does switching task. Both left focus on `<body>`
   * (station#1126). `CommandLauncher` restores on its own close path only, so
   * the task-switch route past it had the same hole.
   *
   * The trigger is read live inside the frame rather than captured on open —
   * the composer survives both of these, so a snapshot would be strictly worse
   * (station#1259 assessment of the `onClose` restore). Routing through
   * `applyReturnFocus` is what is new: it declines when the new session's own
   * initial focus has already claimed the frame (station#1206 gap 1) and
   * verifies the focus actually landed.
   */
  const restoreComposerMenuFocus = useCallback(() => {
    requestAnimationFrame(() =>
      applyReturnFocus(captureReturnFocus(composerMenuTriggerRef.current)),
    );
  }, []);

  // The panel belongs to one task. Close it instead of showing stale context
  // when the active session changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSessionId is the reset signal
  useEffect(() => {
    setActiveWorkPanel(null);
    if (isCommandLauncherOpen || isDelegationLauncherOpen) {
      restoreComposerMenuFocus();
    }
    setIsCommandLauncherOpen(false);
    setIsDelegationLauncherOpen(false);
  }, [activeSessionId]);

  const openCommandLauncher = useCallback(() => {
    setActiveWorkPanel(null);
    setIsCommandLauncherOpen(true);
  }, []);

  const openDelegationLauncher = useCallback(() => {
    setActiveWorkPanel(null);
    setIsCommandLauncherOpen(false);
    setIsDelegationLauncherOpen(true);
  }, []);

  // Stable callback identities for the memoized dock subtree (
  // ChatDockProjectContext / ChatDockContentArea): the dock re-renders every
  // rAF-coalesced frame while a resize drag is live, and inline arrow props
  // would defeat React.memo by changing identity on every one of those
  // renders even though the callbacks themselves never change behavior.
  const toggleHistory = useCallback(() => setIsHistoryOpen((v) => !v), []);
  const toggleInbox = useCallback(
    () => setDeviceSetting('inboxOpen', !isInboxOpen),
    [isInboxOpen, setDeviceSetting],
  );
  const openInboxHistory = useCallback(() => setIsHistoryOpen(true), []);
  // #1298: falling back to /activity is a dock-owned navigation seam —
  // collapse a maximized dock first so the destination is actually visible.
  // Same stabilization reason as the block comment above: this used to be
  // an inline closure at the `ChatDockInboxPanel` call site.
  const onOpenInboxSession = useCallback(
    (threadId: string) => {
      collapseDockForNavigation();
      navigate('/activity', { session: threadId });
    },
    [collapseDockForNavigation, navigate],
  );
  const openChatSettings = useCallback(
    () => setShowChatSettings(true),
    [setShowChatSettings],
  );
  const closeHistory = useCallback(() => setIsHistoryOpen(false), []);
  // #1298: the project-context badge is a dock-owned navigation seam —
  // collapse a maximized dock first so the destination project/layout is
  // actually visible.
  const routeToScopedChatProject = useCallback(
    (targetProjectSlug: string | undefined) => {
      if (
        !shouldRouteScopedChatProject({
          hasImmutableProjectScope,
          targetProjectSlug,
          currentProjectSlug: projectSlug,
          layoutSlug,
        })
      )
        return false;
      // The predicate guarantees layoutSlug here; the assertion keeps the
      // claim-equals-act contract visible at the only mutation site.
      setLayout(targetProjectSlug as string, layoutSlug as string);
      return true;
    },
    [hasImmutableProjectScope, layoutSlug, projectSlug, setLayout],
  );
  const handleSelectProject = useCallback(
    (projectSlug: string) => {
      if (routeToScopedChatProject(projectSlug)) return;
      // #3319: the opened project otherwise lands BEHIND the dock — collapse
      // (never close: the session survives on the collapsed bar) so the
      // destination is visible. Supersedes the maximized-only restore this
      // path used to ride; fullscreen placement has no ambient dock geometry.
      if (!isFullscreenPlacement) applyDockSnap('collapsed');
      setProject(projectSlug);
    },
    [
      applyDockSnap,
      isFullscreenPlacement,
      routeToScopedChatProject,
      setProject,
    ],
  );
  const handleOpenLayout = useCallback(
    (projectSlug: string, layoutSlug: string) => {
      collapseDockForNavigation();
      setLayout(projectSlug, layoutSlug);
    },
    [collapseDockForNavigation, setLayout],
  );
  // station#4524: the project switcher's row action switches the dock's own
  // project context directly — no navigation, no chat creation. Previously
  // ("Continue in <project>") it silently opened the New Chat modal, which
  // is exactly the coupling #4524 reported: picking a project should not by
  // itself start or open a chat. Mirrors `handleSelectProject`'s fullscreen
  // routing guard so a project-scoped layout's picker still navigates
  // exactly as before; outside that immutable scope (the ambient dock,
  // where both #4524 and #4525 live) it only ever rebinds the shell's
  // `chrome.activeProjectSlug` — the New Chat modal's own project step
  // (`activeProjectSlug` passed to `ChatDockModalStack` below) already
  // defaults to that same binding, so starting a chat afterward lands in
  // the just-picked project without this handler creating one itself.
  const handleSwitchProject = useCallback(
    (projectSlug: string) => {
      if (routeToScopedChatProject(projectSlug)) return;
      setActiveProjectSlug(projectSlug);
    },
    [routeToScopedChatProject, setActiveProjectSlug],
  );
  const handleToggleActiveWorkPanel = useCallback(
    (panel: ActiveWorkPanel) =>
      setActiveWorkPanel((current) => (current === panel ? null : panel)),
    [],
  );

  const commandLauncherEnabled = Boolean(
    isPaneOpen &&
      conversationCanMutate &&
      activeSession?.projectSlug &&
      activeSession.status !== 'sending',
  );
  useKeyboardShortcut(
    'active-command-launcher',
    'l',
    COMMAND_LAUNCHER_MODIFIERS,
    'Open active-work command launcher',
    openCommandLauncher,
    commandLauncherEnabled,
  );
  const commandLauncherShortcut = isMac ? '⌘⇧L' : 'Ctrl+Shift+L';

  const durableHandoffQueue = useQuery({
    queryKey: [
      'conversation-handoff-outbound-queue',
      activeSession?.conversationId,
      activeSession?.id,
    ],
    enabled: Boolean(activeSession?.conversationId),
    queryFn: async () => {
      const { outboundDispatch } = await import('../../lib/outboundQueue');
      const turns = await outboundDispatch.snapshot();
      return turns.filter(
        (turn) =>
          turn.conversationId === activeSession?.conversationId ||
          turn.sessionId === activeSession?.id,
      ).length;
    },
    staleTime: 0,
    refetchInterval: 1_000,
  });
  const contextBoundaryStatus =
    contextBoundaryStatusQuery.data?.status ?? contextBoundaryStored?.status;
  const contextBoundaryLabel =
    contextBoundaryStatus === 'reserved'
      ? `Next engine start: ${(contextBoundaryStatusQuery.data?.policy ?? contextBoundaryStored?.policy) === 'empty-next-cold-start' ? 'Empty' : 'Re-anchor'}`
      : contextBoundaryStatus === 'claimed'
        ? 'Engine start reconciling'
        : contextBoundaryStatus === 'indeterminate'
          ? 'Engine start needs inspection'
          : contextBoundaryStatus === 'failed'
            ? 'Start failed; retry available'
            : undefined;
  const hasLocalDeferredMessages = Boolean(
    activeSession?.queuedMessages?.length ||
      activeSession?.queuedMessageFailure ||
      activeSession?.unsentMessages?.length,
  );
  const contextBoundarySessionId =
    activeSession?.currentSessionId ?? activeSession?.id;
  const handoffDisabledReason = !activeSession?.conversationId
    ? 'Send a message before changing Agent.'
    : isSessionExecutionActive(activeSession)
      ? 'Wait for the current turn to finish before changing Agent.'
      : hasLocalDeferredMessages
        ? 'Resolve queued or offline messages before changing Agent.'
        : durableHandoffQueue.isPending
          ? 'Checking queued messages before changing Agent.'
          : durableHandoffQueue.isError
            ? 'Queued message state is unavailable. Try again.'
            : (durableHandoffQueue.data ?? 0) > 0
              ? 'Resolve queued or offline messages before changing Agent.'
              : undefined;

  const openConversationHandoff = useCallback(
    (returnFocusTarget: HTMLButtonElement | null) => {
      if (!activeSession?.conversationId) return;
      handoffReturnFocusRef.current = returnFocusTarget;
      setHandoffSource({
        id: activeSession.conversationId,
        agentSlug: activeSession.agentSlug,
      });
    },
    [activeSession],
  );

  // Project actions remain project-scoped. Agent handoff is a conversation
  // action, so the same menu is also present for global conversations.
  const secondaryActions: ComposerActionsMenuProps | undefined =
    activeSession && conversationCanMutate
      ? {
          triggerRef: composerMenuTriggerRef,
          projectActionsAvailable: Boolean(activeSession.projectSlug),
          commandLauncherDisabled: !commandLauncherEnabled,
          commandLauncherShortcut,
          filesActive: activeWorkPanel === 'files',
          taskContextActive: activeWorkPanel === 'context',
          filesCount: gitStatus?.isRepo ? gitStatus.changes.length : undefined,
          onOpenDelegation: openDelegationLauncher,
          onOpenCommandLauncher: openCommandLauncher,
          onToggleFiles: () => handleToggleActiveWorkPanel('files'),
          onToggleTaskContext: () => handleToggleActiveWorkPanel('context'),
          onOpenHandoff: () =>
            openConversationHandoff(composerMenuTriggerRef.current),
          handoffDisabled: Boolean(handoffDisabledReason),
          handoffDisabledReason,
          onOpenContextReset: () =>
            activeSession.conversationId &&
            setContextResetSource({ id: activeSession.conversationId }),
          contextBoundaryStatus: contextBoundaryLabel,
        }
      : undefined;
  const handoffSession = handoffSource
    ? allSessions.find(
        (session) =>
          session.conversationId === handoffSource.id ||
          session.id === handoffSource.id,
      )
    : undefined;

  const commandLauncherContext = useMemo(
    () => ({
      project: sessionProjectName,
      agent:
        activeSession?.agentName ||
        agents.find((agent) => agent.slug === activeSession?.agentSlug)?.name,
      model:
        chatInput.currentModel ?? activeSession?.model ?? agentDefaultModelId,
      mode: effectiveDockSlotPlacement,
      attachments: chatInput.attachments.map((attachment) => attachment.name),
    }),
    [
      activeSession,
      agentDefaultModelId,
      agents,
      chatInput.attachments,
      chatInput.currentModel,
      effectiveDockSlotPlacement,
      sessionProjectName,
    ],
  );

  // Rehydrate sessions on mount
  useEffect(() => {
    rehydrateSessions();
  }, [rehydrateSessions]);

  // First-run nudge: surface the chat dock once so a new user discovers the
  // primary surface (skipped for automated/e2e sessions — see the helper). The
  // localStorage flag, not the deps, is what makes this fire once; re-runs are
  // a no-op once the flag is set.
  useEffect(() => {
    if (isFullscreenPlacement) return;
    if (!shouldOpenDockForFirstRun()) return;
    markDockFirstRunSeen();
    if (!isDockOpen) setDockState(true);
  }, [isDockOpen, isFullscreenPlacement, setDockState]);

  // Get updateChat from context
  const { updateChat } = useActiveChatActions();

  // Stable identity for the memoized ChatDockContentArea subtree (see the
  // other stable callbacks above) — declared here since it depends on
  // `updateChat`, which isn't available until this destructure.
  const handleTitleUpdate = useCallback(
    (sessionId: string, title: string) => updateChat(sessionId, { title }),
    [updateChat],
  );

  // Session management actions
  const { focusSession, removeSession, openChatForAgent, openConversation } =
    useChatDockActions({
      // Project scope is presentation-only. Global focus events from the
      // sidebar/status surfaces must still resolve a tab from another project
      // so selecting it can clear the stale scope.
      sessions: allSessions,
      agents,
      activeSessionId,
      setActiveSessionId,
    });
  const focusSessionInPane = useCallback(
    (sessionId: string) => focusSession(sessionId, !isFullscreenPlacement),
    [focusSession, isFullscreenPlacement],
  );
  // A conversation-row click is an explicit choice of the project context in
  // which the person wants to continue.  Keep that intent at this UI seam:
  // URL hydration, external focus requests, handoff refocus, and other
  // programmatic session selection must not silently rewrite the DockShell's
  // ambient binding.  A projectless conversation likewise has no project
  // choice to make, so it preserves the current binding.
  const focusUserSelectedSessionInPane = useCallback(
    (sessionId: string) => {
      const selectedProjectSlug = allSessions.find(
        (session) => session.id === sessionId,
      )?.projectSlug;
      if (selectedProjectSlug) setActiveProjectSlug(selectedProjectSlug);
      focusSessionInPane(sessionId);
    },
    [allSessions, focusSessionInPane, setActiveProjectSlug],
  );
  const openChatForAgentInScopedPane = useCallback(
    (
      agent: AgentData,
      targetProjectSlug?: string,
      targetProjectName?: string,
      initialMessage?: string,
      modelOverride?: string,
      modelSource?: EffectiveModelSource,
      defaultModel?: string,
      defaultModelSource?: EffectiveModelSource,
      providerOptions?: Record<string, unknown>,
      initialAttachments?: FileAttachment[],
      providerId?: string,
      providerType?: string,
    ) => {
      if (routeToScopedChatProject(targetProjectSlug)) return;
      const effectiveProjectSlug = hasImmutableProjectScope
        ? projectSlug
        : targetProjectSlug;
      const effectiveProjectName = hasImmutableProjectScope
        ? (projects.find((project) => project.slug === projectSlug)?.name ??
          targetProjectName)
        : targetProjectName;
      const sessionId = openChatForAgent(
        agent,
        effectiveProjectSlug,
        effectiveProjectName,
        initialMessage,
        modelOverride,
        modelSource,
        defaultModel,
        defaultModelSource,
        providerOptions,
        !isFullscreenPlacement,
        initialAttachments,
        providerId,
        providerType,
      );
      if (!hasImmutableProjectScope && effectiveProjectSlug) {
        setActiveProjectSlug(effectiveProjectSlug);
      }
      return sessionId;
    },
    [
      hasImmutableProjectScope,
      isFullscreenPlacement,
      openChatForAgent,
      projectSlug,
      projects,
      routeToScopedChatProject,
      setActiveProjectSlug,
    ],
  );
  const handleStartNewChatWithMessage = useCallback(
    async (
      initialMessage?: string,
      attachments?: FileAttachment[],
      migratedTurnId?: string,
    ) => {
      if (!initialMessage?.trim() && !attachments?.length) {
        setShowNewChatModal(true);
        return;
      }
      await startNewChatWithMessage({
        initialMessage,
        attachments,
        migratedTurnId,
        activeSession: activeSession ?? undefined,
        agents,
        openChatForAgent: openChatForAgentInScopedPane,
      });
    },
    [activeSession, agents, openChatForAgentInScopedPane, setShowNewChatModal],
  );
  // #3309: the retired tab strip's "New" behavior, now behind the header's
  // New button — exactly one chat-ready agent opens directly, else the modal.
  const { data: agentConnections = [] } = useAgentConnectionsQuery() as {
    data?: ConnectionConfig[];
  };
  // #3310: fires from the chat-settings menu; the transcript's summary card
  // observes progress/failure through the shared mutation key.
  const generateSessionSummary = useGenerateSessionSummaryMutation();
  // station#4525 Phase 2: the single-ready-agent direct-New path used to
  // call `openChatForAgentInScopedPane(direct)` with no project at all,
  // which is the OTHER reset mechanism the investigation named — the fresh
  // session's own `projectSlug` came back `undefined`, and the badge (at the
  // time, derived straight from the active session) fell to "No project"
  // even though the dock had one bound a moment earlier. The new chat now
  // inherits the dock's own binding by default, so both the real session and
  // the badge agree from the start.
  const openNewChatDirect = useCallback(() => {
    const direct = selectDirectNewChatAgent(
      selectChatReadyAgents({ agents, agentConnections }),
    );
    if (direct) {
      // station#4525 review HIGH-3 (blocking): an immutably project-scoped
      // placement (a project's own Coding layout) must target its OWN
      // project, never the dock's ambient, device-global binding — passing
      // the binding there tripped `routeToScopedChatProject` into
      // navigating away instead of creating a chat. See
      // `resolveDirectNewChatProjectSlug`.
      const targetProjectSlug = resolveDirectNewChatProjectSlug({
        hasImmutableProjectScope,
        immutableProjectSlug: projectSlug,
        dockChromeProjectSlug,
      });
      openChatForAgentInScopedPane(
        direct,
        targetProjectSlug,
        projectDisplayName(targetProjectSlug, projects) ?? undefined,
      );
    } else setShowNewChatModal(true);
  }, [
    agentConnections,
    agents,
    dockChromeProjectSlug,
    hasImmutableProjectScope,
    openChatForAgentInScopedPane,
    projectSlug,
    projects,
    setShowNewChatModal,
  ]);
  const openConversationInScopedPane = useCallback(
    (
      conversationId: string,
      agentSlug: string,
      targetProjectSlug?: string,
      projectName?: string,
      model?: string,
      conversationUpdatedAt?: string,
      acceptedModel?: string,
      execution?: Pick<
        OpenConversationOptions,
        | 'modelSource'
        | 'defaultModel'
        | 'defaultModelSource'
        | 'providerOptions'
        | 'providerId'
        | 'providerType'
        | 'hydrateMessages'
        | 'signal'
      >,
    ) => {
      // #3724 review (BLOCKING): classify BEFORE navigating. Routing first
      // and then discovering the catalog cannot answer produced a
      // 'catalog-pending' whose "nothing was navigated" claim was false —
      // the user had already been teleported to the other project. An
      // unanswered catalog refuses here, before any navigation.
      if (!agentsLoaded || execution?.signal?.aborted) return false;
      // station#3687 seam 2: routing to the row's project used to RETURN
      // here (`undefined`), so a cross-project click navigated the whole app
      // and then opened nothing — and `undefined` also skipped the #801
      // deleted-agent fallback in the open policy. Teleporting is the
      // intended half (the destination project is where the conversation
      // lives); the click's promise is the conversation, so open it there.
      routeToScopedChatProject(targetProjectSlug);
      return openConversation(conversationId, agentSlug, {
        projectSlug: targetProjectSlug,
        projectName,
        model,
        acceptedModel,
        ...execution,
        revealDock: !isFullscreenPlacement,
        conversationUpdatedAt,
      });
    },
    [
      agentsLoaded,
      isFullscreenPlacement,
      openConversation,
      routeToScopedChatProject,
    ],
  );
  // The cold-row half of `focusUserSelectedSessionInPane`: a History, Inbox,
  // or mobile task-switcher item may not be an in-memory tab yet.  Bind only
  // after its open succeeds, and only when that row names a project.
  const openUserSelectedConversationInScopedPane = useCallback(
    async (...args: Parameters<typeof openConversationInScopedPane>) => {
      const opened = await openConversationInScopedPane(...args);
      const targetProjectSlug = args[2];
      if (opened && targetProjectSlug) setActiveProjectSlug(targetProjectSlug);
      return opened;
    },
    [openConversationInScopedPane, setActiveProjectSlug],
  );
  const openConversationForDock = useCallback(
    async (conversation: ConversationOpenRecovery['conversation']) => {
      const controller = await loadConversationOpenController();
      return controller.openConversationForDock(conversation, {
        apiBase,
        open: openUserSelectedConversationInScopedPane,
        projectName: (slug) =>
          projects.find((project) => project.slug === slug)?.name,
        findTab: (conversationId) =>
          Object.entries(activeChatsStore.getSnapshot()).find(
            ([, chat]) => chat.conversationId === conversationId,
          )?.[0],
        updateChat,
        setRecovery: setConversationOpenRecovery,
      });
    },
    [apiBase, openUserSelectedConversationInScopedPane, projects, updateChat],
  );
  const retryActiveConversationOpen = useCallback(async () => {
    if (!activeSession?.conversationId) return;
    const controller = await loadConversationOpenController();
    await controller.retryActiveConversationForDock(
      activeSession.id,
      activeSession.conversationId,
      apiBase,
      updateChat,
      () => showToast('Conversation resolution is unavailable. Try again.'),
    );
  }, [activeSession, apiBase, showToast, updateChat]);
  const retryConversationOpenRecovery = useCallback(async () => {
    if (!conversationOpenRecovery) return;
    await openConversationForDock(conversationOpenRecovery.conversation);
  }, [conversationOpenRecovery, openConversationForDock]);
  const startNewFromConversationRecovery = useCallback(() => {
    // Direct-new creates and selects a replacement synchronously. If a picker
    // is required it creates nothing, so keep the failed recovery visible
    // until the user has actually selected a replacement there.
    const before = new Set(Object.keys(activeChatsStore.getSnapshot()));
    openNewChatDirect();
    if (
      Object.keys(activeChatsStore.getSnapshot()).some((id) => !before.has(id))
    ) {
      setConversationOpenRecovery(null);
    }
  }, [openNewChatDirect]);
  const openWorkItemConversationInScopedPane = useCallback(
    (
      conversationId: string,
      agentSlug: string,
      targetProjectSlug?: string,
      projectName?: string,
      model?: string,
      conversationUpdatedAt?: string,
      acceptedModel?: string,
    ) =>
      openConversationInScopedPane(
        conversationId,
        agentSlug,
        targetProjectSlug,
        projectName,
        model,
        conversationUpdatedAt,
        acceptedModel,
      ),
    [openConversationInScopedPane],
  );
  const openColdConversationInScopedPane = useCallback(
    (
      conversationId: string,
      agentSlug: string,
      options?: OpenConversationOptions,
    ) =>
      openConversationInScopedPane(
        conversationId,
        agentSlug,
        options?.projectSlug,
        options?.projectName,
        options?.model,
        options?.conversationUpdatedAt,
        options?.acceptedModel,
      ),
    [openConversationInScopedPane],
  );
  useEffect(() => {
    const openNewChat = () => setShowNewChatModal(true);
    // station#1297: `HomeView.continueWork` / `ProjectSidebar` request focus
    // from outside the ChatDock subtree. The request used to carry only
    // `sessionId` and silently drop when that id wasn't a live in-memory
    // tab — the same rehydrate-vs-navigate accident the inbox had. Fall
    // through to `openConversation` (rehydrate) and finally `/activity`
    // (a session Station cannot rehydrate) instead of no-oping.
    const focusChat = (detail: ChatFocusTarget) => {
      const {
        sessionId,
        conversationId,
        agentSlug,
        projectSlug,
        projectName,
        model,
        conversationUpdatedAt,
        messageId,
        threadId,
      } = detail;
      // The message list consumes this stable runtime anchor once its bounded
      // transcript window arrives.  It is intentionally a hash (not routing
      // state): a message selection does not change the conversation identity.
      if (messageId) {
        window.location.hash = `station-message=${encodeURIComponent(messageId)}`;
      }
      const focusedSession = sessionId
        ? allSessions.find((session) => session.id === sessionId)
        : undefined;
      // #3724 review (HIGH): these used to route and RETURN, leaving the
      // session unfocused / the conversation unopened after the teleport —
      // the same seam-2 shape on the external focus-event path. Route, then
      // fall through to the open below (focusRoutableChatSession focuses by
      // id and only clears a stale filter, so it is safe after setLayout).
      if (focusedSession) {
        routeToScopedChatProject(focusedSession.projectSlug);
      }
      // A bare project route (no session, no conversation) is a pure
      // navigation event and may still return; when a conversation is named,
      // openWorkItemConversationInScopedPane routes internally.
      if (
        !sessionId &&
        !conversationId &&
        projectSlug &&
        routeToScopedChatProject(projectSlug)
      )
        return;
      if (
        sessionId &&
        focusRoutableChatSession(
          allSessions,
          sessionId,
          scopedProjectSlug ?? null,
          () => setProjectFilter(null),
          focusSessionInPane,
        )
      ) {
        return;
      }
      if (conversationId && agentSlug) {
        void Promise.resolve(
          openWorkItemConversationInScopedPane(
            conversationId,
            agentSlug,
            projectSlug,
            projectName,
            model,
            conversationUpdatedAt,
          ),
        ).then((opened) => {
          if (opened === false) {
            // Same catalog rule as the inbox click path (#3724 review): an
            // unanswered catalog is not a deleted agent — say to wait
            // instead of bouncing to /activity.
            if (!agentsLoaded) {
              showInboxOpenFailure(
                'Still loading your agents — try this item again in a moment.',
              );
              return;
            }
            if (threadId) {
              collapseDockForNavigation();
              navigate('/activity', { session: threadId });
            }
          }
        });
        return;
      }
      if (threadId) {
        collapseDockForNavigation();
        navigate('/activity', { session: threadId });
      }
    };
    const unregisterOpenChatsNavigation = openChatsStore.registerNavigation({
      focus: focusChat,
      // Remote transcript rendering has no safe cross-Station reader in this
      // slice. Route selection to its named connection instead of treating an
      // opaque remote conversation ID as a local one.
      focusRemote: ({ sourceInstanceId }) => {
        collapseDockForNavigation();
        navigate(
          `/connections?environment=${encodeURIComponent(sourceInstanceId)}`,
        );
      },
      openCollection: () => {
        // The open-chats collection has a DIFFERENT home in each chrome, and
        // only the dock knows which one is mounted. Routing lives here so a
        // caller (the sidebar's "Open chats" heading, its "N more") cannot
        // promise a destination that this chrome has no surface for (#3314
        // review SF-1: on mobile the drawer used to close and the dock snap
        // to half, showing the CURRENT chat and no list at all).
        const route = routeToOpenChatsCollection({
          isMobile,
          dockMode: effectiveDockSlotPlacement,
          isFullscreenPlacement,
        });
        if (route.surface === 'task-switcher-sheet') {
          setTaskSwitcherMode('tasks');
          setIsTaskSwitcherOpen(true);
          return;
        }
        // An edge placement has no panel for `inboxOpen` to reveal, so put the
        // dock somewhere the destination actually mounts first.
        if (route.switchToBottomMode) setDockMode('bottom');
        setDeviceSetting('inboxOpen', true);
        if (route.snapHalf) applyDockSnap('half');
      },
    });
    window.addEventListener('station:open-new-chat', openNewChat);
    return () => {
      window.removeEventListener('station:open-new-chat', openNewChat);
      unregisterOpenChatsNavigation();
    };
  }, [
    applyDockSnap,
    collapseDockForNavigation,
    focusSessionInPane,
    navigate,
    openWorkItemConversationInScopedPane,
    allSessions,
    routeToScopedChatProject,
    scopedProjectSlug,
    setProjectFilter,
    setShowNewChatModal,
    isFullscreenPlacement,
    isMobile,
    effectiveDockSlotPlacement,
    setDockMode,
    setDeviceSetting,
    showInboxOpenFailure,
    agentsLoaded,
  ]);

  // Sync activeChat (conversationId) from URL to local state
  useChatDockActiveChatSync({
    activeChat,
    agentCatalogKey: agents
      .map((agent) => agent.slug)
      .sort()
      .join('\u0000'),
    agentsLoaded,
    apiBase,
    sessions,
    openConversation: openColdConversationInScopedPane,
    setActiveSessionId,
    navigate,
  });

  useEffect(() => {
    const openProjectChats = (event: Event) => {
      const detail = (event as CustomEvent<ProjectChatsEventDetail>).detail;
      if (!detail?.projectSlug) return;
      if (routeToScopedChatProject(detail.projectSlug)) return;

      const projectName = detail.projectName || detail.projectSlug;
      setProjectFilter(detail.projectSlug);
      if (isFullscreenPlacement) {
        const session = allSessions.find(
          (candidate) => candidate.projectSlug === detail.projectSlug,
        );
        if (session) {
          focusSessionInPane(session.id);
          return;
        }
        setActiveSessionId(null);
        setActiveChat(null);
        setNewChatProjectOverride({
          slug: detail.projectSlug,
          name: projectName,
        });
        setShowNewChatModal(true);
        return;
      }
      const outcome = activateProjectChat({
        sessions: allSessions,
        projectSlug: detail.projectSlug,
        focusSession: focusSessionInPane,
        applyDockSnap,
      });
      if (outcome === 'focused') {
        telemetry.track('ui.chat.entry', {
          source: 'project-sidebar',
          outcome: 'focused',
          projectScoped: 1,
        });
        return;
      }

      setActiveSessionId(null);
      setActiveChat(null);
      setNewChatProjectOverride({
        slug: detail.projectSlug,
        name: projectName,
      });
      setShowNewChatModal(true);
      telemetry.track('ui.chat.entry', {
        source: 'project-sidebar',
        outcome: 'new-chat',
        projectScoped: 1,
      });
    };
    window.addEventListener('station:open-project-chats', openProjectChats);
    return () => {
      window.removeEventListener(
        'station:open-project-chats',
        openProjectChats,
      );
    };
  }, [
    applyDockSnap,
    allSessions,
    focusSessionInPane,
    isFullscreenPlacement,
    routeToScopedChatProject,
    setActiveChat,
    setActiveSessionId,
    setProjectFilter,
    setShowNewChatModal,
  ]);

  // A global launcher (header help, skill chords, share intake) can activate a
  // chat while a prior project-only view is still scoped. Clear that stale
  // presentation filter before active-chat synchronization so the newly
  // selected tab cannot be hidden behind an unrelated project scope.
  useEffect(() => {
    if (
      !hasImmutableProjectScope &&
      shouldClearProjectChatScope(projectFilter, activeChat, allSessions)
    ) {
      setProjectFilter(null);
    }
  }, [
    activeChat,
    allSessions,
    hasImmutableProjectScope,
    projectFilter,
    setProjectFilter,
  ]);

  // Keyboard shortcuts — chat's own (new chat, open conversation, close tab,
  // session switching, cancel). `dock.toggle` / `dock.maximize` are
  // registered by `chrome` (`useDockShellChrome`), not here.
  useChatDockKeyboardShortcuts({
    sessions,
    activeSessionId,
    activeSession,
    setActiveSessionId,
    setShowSessionPicker,
    focusSession: focusSessionInPane,
  });

  useEffect(() => {
    ensureOrchestrationEventStream(apiBase);
  }, [apiBase]);

  return (
    <>
      <SkillShortcutRegistrar
        hasContext={Boolean(activeSessionId && activeSessionForHook)}
        onRun={useCallback(
          (target: { cmd: string; name: string }) => {
            void chatInput.handleCommandSelect({
              cmd: target.cmd,
              description: target.name,
            });
          },
          [chatInput.handleCommandSelect],
        )}
      />
      <ChatPaneFileDropBoundary
        id={isFullscreenPlacement ? 'chat-workspace-pane' : undefined}
        className={
          isFullscreenPlacement
            ? 'chat-dock chat-workspace-pane chat-workspace-pane--fullscreen'
            : undefined
        }
        style={
          isFullscreenPlacement
            ? { minHeight: 0, height: '100%' }
            : // Docked: `DockShell` already owns the `.chat-dock` box — its
              // size, placement classes and transition. This boundary
              // contributes file-drop behavior only, not a second box
              // inside it (station#4460).
              { display: 'contents' }
        }
        enabled={isChatPaneFileDropEnabled({
          hasAttachmentOwner: activeSessionForHook !== null,
          isPaneOpen,
          isCollapsedDragPreview,
        })}
        onActivity={resetAutoHide}
        onFocusWithinChange={(isFocused) => {
          setShortcutContext('dockFocused', isFocused);
        }}
        reportError={chatInput.setAttachmentError}
        resetKey={[
          pathname,
          activeSessionId ?? '',
          scopedProjectSlug ?? '',
          projectSlug ?? '',
          layoutSlug ?? '',
          placement,
          dockMode,
          isPaneMaximized ? 'pane-maximized' : 'pane-restored',
          isDockMaximized ? 'dock-maximized' : 'dock-restored',
          dockSnap,
          isPaneOpen ? 'open' : 'collapsed',
          isCollapsedDragPreview ? 'drag-preview' : 'stable',
        ].join('|')}
        selectFiles={chatInput.selectAttachmentFiles}
      >
        <ActiveWorkModalBoundary
          active={Boolean(
            isCommandLauncherOpen ||
              isDelegationLauncherOpen ||
              isTaskSwitcherOpen ||
              (isMobile && activeWorkPanel),
          )}
        >
          {/* The resize handle (bottom drag/snap, or the side-panel width
              grip) is `DockShell`'s job now for a docked placement —
              rendered once outside every occupant (station#4460). A
              full-screen placement never had one. */}
          {isMobile ? (
            <ChatDockMobileHeader
              // Only when the app toolbar is hidden — otherwise its drawer
              // toggle and this one are two controls with one accessible name.
              showDrawerToggle={isMobileDockFullscreen({
                isMobile,
                isDockOpen: isPaneOpen,
                isDockMaximized: isPaneMaximized,
                // A fullscreen-placed chat pane IS the dock-owned view (a
                // Chat workspace layout hides the toolbar via its own
                // App.tsx disjunct, so this header must carry the drawer
                // toggle — sol review of #2636, finding 1). Otherwise the
                // route decides, through the same parser App.tsx's
                // displayCurrentView rides.
                isDockOwnedView:
                  isFullscreenPlacement ||
                  isDockOwnedViewType(resolveViewFromPath(pathname).type),
              })}
              sessionTitle={activeSession?.title || 'Chat'}
              // station#3309: same identity the desktop header leads with,
              // from the same session-committed slug — artwork only when the
              // catalog resolved this agent, identicon from the slug otherwise.
              agentIdentity={
                activeSession
                  ? {
                      name: activeChatAgent?.name ?? activeSession.agentName,
                      slug: activeSession.agentSlug,
                      icon: activeChatAgent?.icon,
                    }
                  : null
              }
              // station#1803 (part 3): always populated, project bound or
              // not — mirrors the desktop project-context row's fix. A
              // no-project chat gets "No project" as the switcher's current
              // value and stays reachable via the same trigger, rather than
              // losing the affordance entirely.
              projectSwitcher={{
                projectSlug: dockProjectSlug ?? '',
                projectName: dockBadgeProjectName ?? 'No project',
                projects,
                onOpenProject: handleSelectProject,
                onSwitchProject: handleSwitchProject,
              }}
              projectScope={
                scopedProjectSlug && !hasImmutableProjectScope
                  ? {
                      name:
                        projects.find(
                          (project) => project.slug === scopedProjectSlug,
                        )?.name ?? scopedProjectSlug,
                      onClear: () => setProjectFilter(null),
                    }
                  : undefined
              }
              branchLabel={gitStatus?.isRepo ? gitStatus.branch : null}
              activeCount={activeSessionCount}
              unreadCount={unreadCount}
              taskSwitcherTriggerRef={taskSwitcherTriggerRef}
              activityTriggerRef={activityTriggerRef}
              onOpenTaskSwitcher={() => {
                setTaskSwitcherMode('tasks');
                setIsTaskSwitcherOpen(true);
              }}
              onOpenActivity={() => {
                setTaskSwitcherMode('activity');
                setIsTaskSwitcherOpen(true);
              }}
              onToggleSidebar={(trigger) =>
                window.dispatchEvent(
                  new CustomEvent('toggle-sidebar', { detail: { trigger } }),
                )
              }
              onDragPointerDown={
                isFullscreenPlacement ? () => {} : onMobileHeaderDragPointerDown
              }
              onDragClickCapture={
                isFullscreenPlacement
                  ? () => {}
                  : onMobileHeaderDragClickCapture
              }
              dockToggle={
                isFullscreenPlacement
                  ? null
                  : {
                      state: isPaneOpen ? 'open' : 'collapsed',
                      onExpand: () => applyDockSnap('half'),
                      // Collapse clears Maximized too (#795) — same snap path
                      // the overflow action rides.
                      onCollapse: () => applyDockSnap('collapsed'),
                    }
              }
              // #3309: New chat is the bar's pinned far-right icon now, with
              // the same single-ready-agent shortcut the desktop New has.
              onNewChat={openNewChatDirect}
              overflow={{
                onOpenConversation: () => setShowSessionPicker(true),
                onToggleHistory: toggleHistory,
                onOpenChatSettings: openChatSettings,
                onOpenProject: activeSession?.projectSlug
                  ? () => setProject(activeSession.projectSlug!)
                  : null,
                openProjectName: activeSession?.projectSlug
                  ? (sessionProjectName ?? activeSession.projectSlug)
                  : null,
                onOpenProfile: () => navigate('/profile'),
                onOpenAppSettings: () => navigate('/settings'),
                sessionInventory:
                  !conversationOpenRecovery &&
                  inventoryExecutionId &&
                  activeOrchestrationSessionRead === 'present'
                    ? {
                        sessionId: inventoryExecutionId,
                        chatStoreId: activeSession!.id,
                      }
                    : undefined,
                // Collapsing must clear Maximized (#795) — an independent
                // `is-maximized` class surviving a collapse leaves a
                // full-height dock with an emptied body.
                onCollapseDock: () => applyDockSnap('collapsed'),
                // Mirrors the drag-to-full gesture for keyboard/agent callers.
                onExpandDock: () => applyDockSnap('full'),
                onRestoreDock: () => applyDockSnap('half'),
                isDockMaximized: isPaneMaximized,
                dockControls: !isFullscreenPlacement,
              }}
            />
          ) : (
            <ChatDockHeader
              chatIdentity={
                activeSession ? (
                  <ChatDockActiveIdentity
                    session={activeSession}
                    agent={activeChatAgent}
                    modelLabel={activeChatModelLabel}
                    onClose={removeSession}
                  />
                ) : null
              }
              projectContext={
                // station#1803 (part 3): the row (and its picker) renders
                // whenever the dock has a project surface at all, project
                // bound or not — a chat with no project is exactly the one
                // that most needs the picker reachable, not the one it gets
                // hidden for. `ChatDockProjectContext` itself renders "No
                // project" and keeps the badge switchable when
                // `dockProjectSlug` is null.
                !isMobile ? (
                  <ChatDockProjectContext
                    projectSlug={dockProjectSlug}
                    projectName={dockBadgeProjectName}
                    // station#4525 review HIGH-2 (blocking): these three
                    // facts are truth about the SESSION actually on screen
                    // and never gate on the badge — station#1146 fixed this
                    // exact defect once already (a badge-driven fact row
                    // showing "~ (defaults to home)" for a session that
                    // genuinely has a directory). Unconditional, exactly as
                    // pre-station#4525, other than the pre-existing
                    // `scopedProjectSlug` guard (a project chat-scope filter
                    // has never shown session-specific facts).
                    workingDirectory={
                      scopedProjectSlug ? null : sessionDisplayCwd
                    }
                    codingLayoutSlug={
                      scopedProjectSlug
                        ? null
                        : (sessionCodingLayout?.slug ?? null)
                    }
                    gitStatus={scopedProjectSlug ? undefined : gitStatus}
                    sessionProjectMismatchLabel={sessionProjectMismatchLabel}
                    projects={projects}
                    onSelectProject={handleSelectProject}
                    onOpenLayout={handleOpenLayout}
                    onSwitchProject={handleSwitchProject}
                    onClearProjectScope={
                      scopedProjectSlug && !hasImmutableProjectScope
                        ? () => setProjectFilter(null)
                        : undefined
                    }
                  />
                ) : null
              }
              chatControls={{
                sessions,
                unreadCount,
                focusSession: focusSessionInPane,
                onNewChat: () => setShowNewChatModal(true),
                setShowChatSettings,
              }}
              isDragging={isDragging}
              onDockSnap={applyDockSnap}
              fullscreen={isFullscreenPlacement}
              availableDockSlotPlacements={availableDockSlotPlacements}
              effectiveDockSlotPlacement={effectiveDockSlotPlacement}
              onDockPlacementChange={commitDockPlacement}
              // station#4460: Chat is one entry in the SAME occupant
              // switcher Home/Activity carry — not a special case with no
              // way to leave. Absent for a full-screen placement, which has
              // no ambient dock to switch away from.
              occupantPicker={occupantPicker}
              // #3309: the tab strip's controls fold into the header — one
              // chrome bar, every reclaimed pixel is transcript space. Only
              // while the pane is open; the collapsed bar stays minimal.
              workspaceControls={
                isPaneOpen || isCollapsedDragPreview
                  ? {
                      // Whether to OFFER the panel is the same question as
                      // whether it mounts, so it reads the same predicate
                      // rather than restating it — a third independent copy
                      // is how the toggle ends up advertising a panel that
                      // never appears (#3314 review SF-1, again).
                      showInboxToggle: inboxPanelMounts({
                        isMobile,
                        dockMode: effectiveDockSlotPlacement,
                        isFullscreenPlacement,
                      }),
                      isInboxOpen,
                      onToggleInbox: toggleInbox,
                      backgroundTasksTriggerRef,
                      backgroundTasksRunningCount,
                      isBackgroundTasksOpen,
                      onToggleBackgroundTasks: () =>
                        setIsBackgroundTasksOpen((open) => !open),
                      sessionInventory:
                        !conversationOpenRecovery && inventoryExecutionId
                          ? {
                              chatStoreId: inventoryChatStoreId!,
                              executionId: inventoryExecutionId,
                              projectId: inventoryProjectId,
                              executionRead: activeOrchestrationSessionRead,
                              mountRef: sessionInventoryMountRef,
                              dockMode: effectiveDockSlotPlacement,
                              fullscreen: isFullscreenPlacement,
                            }
                          : undefined,
                      onOpenConversation: () => setShowSessionPicker(true),
                      onNewChat: openNewChatDirect,
                    }
                  : undefined
              }
              contextMeter={
                (isPaneOpen || isCollapsedDragPreview) &&
                activeSession?.conversationId &&
                openChatItems.some(
                  (item) => chatTaskSessionId(item) === activeSession.id,
                ) ? (
                  <ContextPercentage
                    agentSlug={activeSession.agentSlug}
                    conversationId={activeSession.conversationId}
                    apiBase={apiBase}
                    messageCount={activeSession.messages.length}
                    liveUsage={activeSession.liveUsage}
                    onClick={() => setShowStatsPanel(true)}
                  />
                ) : null
              }
            />
          )}

          {(isPaneOpen || isCollapsedDragPreview) && (
            <>
              {/* The old second chrome bar (`ChatDockTabBar`) is retired on
                  desktop too (#3309) — mobile absorbed its rows into one bar
                  first (#1066), and the header above now carries its
                  controls. #1064's no-third-bar decision stands. */}
              <div className="chat-dock__workspace">
                {/* The right-mode dock is a ~400px column; the inbox panel's
                    240px floor would crush the conversation surface, so the
                    panel (and its toggle) only exist in bottom mode.
                    station#1797: the panel itself mounts only while
                    expanded — collapsed means collapsed, with no rail
                    duplicating the header's own expand/collapse toggle
                    (`chat-dock__inbox-toggle`, the single control for this
                    now). */}
                {inboxPanelMounts({
                  isMobile,
                  dockMode: effectiveDockSlotPlacement,
                  isFullscreenPlacement,
                }) &&
                  inboxPresence.mounted && (
                    <LazyBoundary
                      load={loadChatDockInboxPanel}
                      componentProps={{
                        exiting: inboxPresence.exiting,
                        items: taskItems,
                        agents,
                        activeChatSessionId: activeSessionId,
                        openChatSessionIds: openInboxChatSessionIds,
                        onFocusChat: focusUserSelectedSessionInPane,
                        onOpenConversation:
                          openUserSelectedConversationInScopedPane,
                        onOpenSession: onOpenInboxSession,
                        onCloseChat: removeSession,
                        onAcknowledgeConversation: acknowledgeTaskConversation,
                        onOpenHistory: openInboxHistory,
                        agentsLoaded,
                        onOpenFailed: showInboxOpenFailure,
                      }}
                      pending={null}
                    />
                  )}
                {activeWorkPanel && activeSession?.projectSlug && !isMobile && (
                  <ActiveWorkContextFrame
                    panel={activeWorkPanel}
                    isMobile={false}
                    session={activeSession}
                    gitStatus={gitStatus}
                    canOpenFiles={!!sessionCodingLayout}
                    onClose={() => setActiveWorkPanel(null)}
                    onOpenFile={(file) => {
                      if (sessionCodingLayout) {
                        setLayout(
                          activeSession.projectSlug!,
                          sessionCodingLayout.slug,
                          {
                            openFilePreviewIntent: {
                              projectSlug: activeSession.projectSlug!,
                              path: file,
                            },
                          },
                        );
                      }
                    }}
                    onOpenProjectContext={() =>
                      setProject(activeSession.projectSlug!)
                    }
                  />
                )}
                <div className="chat-dock__conversation-surface">
                  <div ref={sessionInventoryMountRef} />
                  {conversationOpenRecovery ? (
                    <LazyBoundary
                      load={loadConversationOpenRecoveryNotice}
                      componentProps={{
                        title: conversationOpenRecovery.conversation.title,
                        state:
                          conversationOpenRecovery.status === 'error'
                            ? 'unavailable'
                            : conversationOpenRecovery.status,
                        onRetry: () => void retryConversationOpenRecovery(),
                        onStartNew: startNewFromConversationRecovery,
                      }}
                      pending={
                        <div className="session-history-error" role="status">
                          Conversation recovery is loading. This conversation
                          remains read-only.
                        </div>
                      }
                    />
                  ) : null}
                  {!conversationOpenRecovery ? (
                    <ChatDockContentArea
                      onNewChat={handleStartNewChatWithMessage}
                      onRetryConversationOpen={retryActiveConversationOpen}
                      activeSession={activeSession}
                      activeOrchestrationSession={activeOrchestrationSession}
                      activeOrchestrationSessionRead={
                        activeOrchestrationSessionRead
                      }
                      onRetryOrchestrationSessions={() => {
                        void refetchOrchestrationSessions();
                      }}
                      activeSessionId={activeSessionId}
                      sessions={sessions}
                      agents={agents}
                      projects={projects}
                      projectScope={
                        scopedProjectSlug
                          ? {
                              slug: scopedProjectSlug,
                              name:
                                projects.find(
                                  (project) =>
                                    project.slug === scopedProjectSlug,
                                )?.name ?? scopedProjectSlug,
                            }
                          : null
                      }
                      chatFontSize={chatFontSize}
                      dockHeight={dockHeight}
                      showStatsPanel={showStatsPanel}
                      showReasoning={showReasoning}
                      showToolDetails={showToolDetails}
                      modelSupportsAttachments={modelSupportsAttachments}
                      fileAttachmentsSupported={fileAttachmentsSupported}
                      modelProviderLabel={modelProviderLabel}
                      modelProviders={modelProviders}
                      agentDefaultModelId={agentDefaultModelId ?? null}
                      connectionApprovalModeDefault={
                        connectionApprovalModeDefault
                      }
                      toolPolicyDelivery={toolPolicyDelivery}
                      availableModels={effectiveModels}
                      modelsLoading={modelsLoading}
                      chatInput={chatInput}
                      secondaryActions={secondaryActions}
                      onOpenAgentHandoff={() =>
                        openConversationHandoff(composerAgentTriggerRef.current)
                      }
                      agentHandoffTriggerRef={composerAgentTriggerRef}
                      isHistoryOpen={isHistoryOpen}
                      onCloseHistory={closeHistory}
                      onToggleStatsPanel={setShowStatsPanel}
                      onTitleUpdate={handleTitleUpdate}
                      onDeleteSession={removeSession}
                      onFocusSession={focusUserSelectedSessionInPane}
                      onOpenConversation={
                        openUserSelectedConversationInScopedPane
                      }
                      onForkFromTurn={(source) => {
                        if (!activeSession?.conversationId) return;
                        const conversationId = activeSession.conversationId;
                        const generation = ++forkGenerationRef.current;
                        void Promise.all([
                          import('./forkAttemptKey'),
                          import('./forkSourceExecution'),
                        ]).then(
                          ([
                            { getOrCreateForkAttemptKey },
                            { resolveHistoricalForkExecution },
                          ]) => {
                            if (generation !== forkGenerationRef.current)
                              return;
                            const sourceExecution =
                              resolveHistoricalForkExecution(
                                source.sessionId,
                                orchestrationSessions,
                              );
                            setForkSource({
                              id: conversationId,
                              agentSlug: source.agentSlug,
                              turnId: source.turnId,
                              projectSlug: activeSession.projectSlug,
                              projectName: activeSession.projectName,
                              model: source.model,
                              modelSource: source.model ? 'runtime' : undefined,
                              defaultModel: source.model,
                              defaultModelSource: source.model
                                ? 'runtime'
                                : undefined,
                              providerType:
                                source.provider ?? sourceExecution.providerType,
                              providerId: sourceExecution.providerId,
                              providerOptions: sourceExecution.providerOptions,
                              sourceSessionId: source.sessionId,
                              idempotencyKey: getOrCreateForkAttemptKey(
                                conversationId,
                                source.turnId,
                              ),
                            });
                            setForkOperation({ pending: false, error: null });
                            setShowNewChatModal(true);
                          },
                        );
                      }}
                      onOpenBackgroundTasks={() =>
                        setIsBackgroundTasksOpen(true)
                      }
                    />
                  ) : null}
                </div>
              </div>
            </>
          )}
        </ActiveWorkModalBoundary>
        {activeWorkPanel && activeSession?.projectSlug && isMobile && (
          <ActiveWorkContextFrame
            panel={activeWorkPanel}
            isMobile
            session={activeSession}
            gitStatus={gitStatus}
            canOpenFiles={!!sessionCodingLayout}
            visualViewportStyle={visualViewport.style}
            returnFocusTarget={composerMenuTriggerRef.current}
            onClose={() => setActiveWorkPanel(null)}
            onOpenFile={(file) => {
              setActiveWorkPanel(null);
              if (sessionCodingLayout) {
                setLayout(
                  activeSession.projectSlug!,
                  sessionCodingLayout.slug,
                  {
                    openFilePreviewIntent: {
                      projectSlug: activeSession.projectSlug!,
                      path: file,
                    },
                  },
                );
              }
            }}
            onOpenProjectContext={() => {
              setActiveWorkPanel(null);
              setProject(activeSession.projectSlug!);
            }}
          />
        )}
        {isMobile && isTaskSwitcherOpen && (
          <LazyBoundary
            load={loadMobileTaskSwitcher}
            componentProps={{
              open: isMobile && isTaskSwitcherOpen,
              mode: taskSwitcherMode,
              tasks: taskItems,
              agents,
              openChatSessionIds: openInboxChatSessionIds,
              activeChatSessionId: activeSessionId,
              visualViewportStyle: visualViewport.style,
              triggerRef:
                taskSwitcherMode === 'activity'
                  ? activityTriggerRef
                  : taskSwitcherTriggerRef,
              onClose: () => setIsTaskSwitcherOpen(false),
              onFocusChat: focusUserSelectedSessionInPane,
              onOpenConversation: openUserSelectedConversationInScopedPane,
              onCloseChat: removeSession,
              onAcknowledgeConversation: acknowledgeTaskConversation,
              agentsLoaded,
              onOpenFailed: showInboxOpenFailure,
              backgroundTaskCount: backgroundTasksRunningCount,
              onOpenBackgroundTasks: () => {
                setIsTaskSwitcherOpen(false);
                setIsBackgroundTasksOpen(true);
              },
              onOpenSession: (threadId) => {
                if (isFullscreenPlacement) {
                  navigate('/activity', { session: threadId });
                  return;
                }
                // Sessions must remain usable on a phone, so the dock closes.
                // Reviewer correction (#945 HIGH): a prior version of this
                // handler routed around `setDockState` to leave `maximize` in
                // the URL while closing, on the theory that the mobile bottom
                // dock's inline height guard (`!isDockOpen` checked before
                // `isDockMaximized`) made a closed-but-maximized URL state safe
                // here. That is false — the mobile `@media (max-width: 768px)`
                // rule for `.chat-dock.is-maximized` (index.css, "Maximized dock
                // on a phone") matches on `is-maximized` alone, independent of
                // `is-collapsed`, and sets `height: ... !important`, which beats
                // the plain (non-`!important`) inline style. A closed dock with
                // `maximize=true` still gets forced to full visual-viewport
                // height while its body is omitted (`isDockOpen` false below) —
                // the #795 blank full-height shell, reachable on mobile after
                // all. `setDockState`'s "a closed dock is never maximized"
                // invariant stays universal; the maximize preference survives
                // this round trip through `lastDockMaximized` (navigation-store)
                // instead, which `focusSession` already reads on the way back in.
                setDockState(false, isDockMaximized);
                navigate('/activity', { session: threadId });
              },
            }}
            pending={null}
          />
        )}
      </ChatPaneFileDropBoundary>

      {isBackgroundTasksOpen && activeSessionId && (
        <LazyBoundary
          load={loadBackgroundTasksSheet}
          componentProps={{
            chatThreadId: activeSessionId,
            anchorRef: backgroundTasksTriggerRef,
            returnFocusTarget: backgroundTasksTriggerRef.current,
            onOpenTranscript: (threadId) => {
              setIsBackgroundTasksOpen(false);
              setDockState(false, isDockMaximized);
              navigate('/activity', { session: threadId });
            },
            onClose: () => setIsBackgroundTasksOpen(false),
          }}
          pending={null}
        />
      )}

      {isCommandLauncherOpen && activeSession?.projectSlug && (
        <LazyBoundary
          load={loadCommandLauncher}
          componentProps={{
            context: commandLauncherContext,
            returnFocusTarget: composerMenuTriggerRef.current,
            onClose: () => setIsCommandLauncherOpen(false),
            onConfirm: (intent) => {
              void submitCommandLauncherIntent(
                intent,
                chatInput.attachments,
                chatInput,
              );
            },
          }}
          pending={null}
        />
      )}

      {isDelegationLauncherOpen && (
        <LazyBoundary
          load={loadDelegationLauncher}
          componentProps={{
            isOpen: isDelegationLauncherOpen,
            apiBase,
            projectSlug: activeSession?.projectSlug,
            projectName: sessionProjectName,
            currentAgentId: activeSession?.agentSlug,
            currentModel: activeChatModelId,
            parentTaskId: activeSession?.id,
            parentTaskLabel: activeSession?.title,
            initialPrompt: chatInput.input,
            onClose: () => {
              setIsDelegationLauncherOpen(false);
              requestAnimationFrame(() =>
                composerMenuTriggerRef.current?.focus(),
              );
            },
            onDelegated: (task, targetName) => {
              setIsDelegationLauncherOpen(false);
              restoreComposerMenuFocus();
              invalidate(orchestrationQueries.sessions().queryKey);
              showToast(`Delegated to ${targetName}`, task.sessionId, 10_000, [
                {
                  label: 'Open task',
                  variant: 'primary',
                  onClick: () => {
                    // #1298: an attention-style link routed through the dock
                    // — collapse a maximized dock first, same as the other
                    // dock-owned navigation seams.
                    collapseDockForNavigation();
                    navigate('/activity', { session: task.sessionId });
                  },
                },
              ]);
            },
          }}
          pending={null}
        />
      )}

      {handoffSource && handoffSession?.conversationId && (
        <LazyBoundary
          load={loadConversationHandoffDialog}
          componentProps={{
            apiBase,
            conversationId: handoffSession.conversationId,
            sessionId: handoffSession.id,
            currentAgentId: handoffSession.agentSlug,
            projectSlug: handoffSession.projectSlug,
            agents,
            projects,
            initialMessage:
              handoffSession.id === activeSession?.id ? chatInput.input : '',
            attachments:
              handoffSession.id === activeSession?.id
                ? chatInput.attachments
                : [],
            blockedReason:
              handoffSession.id === activeSession?.id
                ? handoffDisabledReason
                : undefined,
            onDispatchStarted: ({ message, clientTurnId }) => {
              const state = activeChatsStore.getSnapshot()[handoffSession.id];
              updateChat(
                handoffSession.id,
                beginConversationHandoffUiState(state, {
                  message,
                  clientTurnId,
                  now: Date.now(),
                }),
              );
            },
            onDefiniteFailure: (clientTurnId) => {
              const state = activeChatsStore.getSnapshot()[handoffSession.id];
              updateChat(
                handoffSession.id,
                refuseConversationHandoffUiState(state, clientTurnId),
              );
            },
            onClose: () => {
              setHandoffSource(null);
              requestAnimationFrame(() =>
                handoffReturnFocusRef.current?.focus(),
              );
            },
            onAccepted: ({ receipt, target, targetId }) => {
              const state = activeChatsStore.getSnapshot()[handoffSession.id];
              updateChat(
                handoffSession.id,
                acceptConversationHandoffUiState(state, target, receipt),
              );
              if (handoffSession.id === activeSession?.id) {
                chatInput.handleClearInput();
                chatInput.handleClearAttachments();
              } else {
                focusSessionInPane(handoffSession.id);
              }
              invalidate(orchestrationQueries.sessions().queryKey);
              invalidate(conversationQueries.inventory().queryKey);
              setHandoffSource(null);
              showToast(
                `Continuing with ${target?.name ?? `deleted Agent “${targetId}”`}`,
                'success',
              );
            },
          }}
          pending={null}
        />
      )}
      {contextResetSource &&
        activeSession?.conversationId === contextResetSource.id && (
          <LazyBoundary
            load={loadConversationContextResetDialog}
            componentProps={{
              apiBase,
              conversationId: activeSession.conversationId,
              sessionId: contextBoundarySessionId ?? activeSession.id,
              session: activeSession,
              sessionRead: activeOrchestrationSessionRead,
              orchestrationSession: activeOrchestrationSession,
              hasLocalDeferredMessages,
              onStoppedSessionRefreshed: async () => {
                const refreshed = await refetchOrchestrationSessions();
                return (
                  refreshed.data?.find(
                    (session) =>
                      session.threadId ===
                      (contextBoundarySessionId ?? activeSession.id),
                  ) ?? null
                );
              },
              onClose: () => {
                setContextResetSource(null);
                requestAnimationFrame(() =>
                  composerMenuTriggerRef.current?.focus(),
                );
              },
              onReserved: (boundary, idempotencyKey) => {
                setContextBoundaryStored(
                  writeConversationContextBoundaryUiState(
                    idempotencyKey,
                    boundary,
                  ),
                );
                invalidate(orchestrationQueries.sessions().queryKey);
                if (boundary.status === 'reserved')
                  showToast('Next engine context reserved', 'success');
              },
            }}
            pending={null}
          />
        )}

      <LazyBoundary
        load={loadChatDockModalStack}
        componentProps={{
          agents: forkEligibleAgents,
          projects:
            hasImmutableProjectScope && projectSlug
              ? projects.filter((project) => project.slug === projectSlug)
              : projects,
          // station#4525 Phase 3 / review MED-3: the New Chat modal's own
          // project step defaults to the dock's shell-owned binding when
          // one is set (it agrees with what the header badge shows, unlike
          // the pre-station#4525 route-level "currently viewed project"
          // default, which the dock's New button is reachable without ever
          // having visited) — but for a user who has never bound one, this
          // restores that pre-fix `useActiveProject` fallback rather than
          // leaving the picker unbound. A fork confirmation always wins
          // outright. See `resolveNewChatModalDefaultProjectSlug`.
          activeProjectSlug: resolveNewChatModalDefaultProjectSlug({
            forkProjectSlug: forkSource?.projectSlug,
            hasImmutableProjectScope,
            immutableProjectSlug: projectSlug,
            dockChromeProjectSlug,
            routeActiveProjectSlug,
          }),
          newChatProjectOverride,
          sessions,
          showNewChatModal,
          showChatSettings,
          showSessionPicker,
          chatFontSize,
          defaultFontSize,
          showReasoning,
          showToolDetails,
          dockMode: effectiveDockSlotPlacement,
          // The stored preference, not the effective one: on a phone they
          // differ, and the panel needs both to say what is in effect AND what
          // is being kept for a wider screen (station#3928).
          storedDockSlotPlacement: dockMode,
          availableDockSlotPlacements,
          pathname,
          autoHideEnabled,
          onSelectNewChat: (
            agent,
            projectSlug,
            projectName,
            initialMessage,
            modelOverride,
            modelSource,
            defaultModel,
            defaultModelSource,
            providerOptions,
            providerId,
            providerType,
          ) => {
            // station#4525: an explicit project choice inside the New Chat
            // modal is exactly as deliberate as a picker pick (#4524's
            // acceptance names an explicit picker change or deletion as the
            // only things that may move the binding) — sync it so the
            // header agrees with the chat that's about to open instead of
            // the new session immediately diverging from a stale badge.
            // Never CLEARS the binding: a modal chat started with no project
            // chosen leaves it exactly where it was (the same "new chats
            // preserve the binding" contract `openNewChatDirect` follows).
            const sessionId = openChatForAgentInScopedPane(
              agent,
              projectSlug,
              projectName,
              initialMessage,
              modelOverride,
              modelSource,
              defaultModel,
              defaultModelSource,
              providerOptions,
              undefined,
              providerId,
              providerType,
            );
            if (sessionId) navigate(pathname, { chat: sessionId });
            setShowNewChatModal(false);
            setNewChatProjectOverride(null);
            setHandoffSource(null);
          },
          forkSource,
          forkMode: forkSource
            ? {
                kind: 'fork',
                preferredAgentSlug: forkSource.agentSlug,
                sourceModel: forkSource.model,
                pending: forkOperation.pending,
                error: forkOperation.error,
              }
            : undefined,
          onForkAgentSelect: async (
            agent,
            projectSlug,
            projectName,
            _initialMessage,
            modelOverride,
            modelSource,
            defaultModel,
            defaultModelSource,
            providerOptions,
            providerId,
            providerType,
          ) => {
            if (!forkSource || forkOperation.pending) return;
            const generation = ++forkGenerationRef.current;
            const controller = new AbortController();
            forkAbortRef.current = controller;
            setForkOperation({ pending: true, error: null });
            try {
              const sameAgent = agent.slug === forkSource.agentSlug;
              const { forkConversation } = await import(
                '@kontourai/station-sdk'
              );
              if (generation !== forkGenerationRef.current) return;
              const result = await forkConversation(
                forkSource.agentSlug,
                forkSource.id,
                agent.slug,
                {
                  branchPointTurnId: forkSource.turnId,
                  targetProjectSlug: projectSlug,
                  idempotencyKey: forkSource.idempotencyKey,
                  signal: controller.signal,
                },
              );
              if (generation !== forkGenerationRef.current) return;
              const { completeForkAttempt } = await import('./forkAttemptKey');
              completeForkAttempt(
                forkSource.id,
                forkSource.turnId,
                forkSource.idempotencyKey,
              );
              const opened = await openConversation(
                result.conversationId,
                agent.slug,
                {
                  projectSlug,
                  projectName,
                  model:
                    modelOverride ?? (sameAgent ? forkSource.model : undefined),
                  modelSource:
                    modelSource ??
                    (sameAgent ? forkSource.modelSource : undefined),
                  defaultModel:
                    defaultModel ??
                    (sameAgent ? forkSource.defaultModel : undefined),
                  defaultModelSource:
                    defaultModelSource ??
                    (sameAgent ? forkSource.defaultModelSource : undefined),
                  providerOptions:
                    providerOptions ??
                    (sameAgent ? forkSource.providerOptions : undefined),
                  providerId:
                    providerId ??
                    (sameAgent ? forkSource.providerId : undefined),
                  providerType:
                    providerType ??
                    (sameAgent ? forkSource.providerType : undefined),
                  hydrateMessages: true,
                  signal: controller.signal,
                  revealDock: !isFullscreenPlacement,
                  beforeFocus: () =>
                    commitForkOpenBoundary({
                      signal: controller.signal,
                      generation,
                      currentGeneration: () => forkGenerationRef.current,
                      route: () => routeToScopedChatProject(projectSlug),
                    }),
                },
              );
              if (generation !== forkGenerationRef.current) return;
              if (!opened)
                throw new Error(
                  'The fork was created but could not be opened.',
                );
              invalidate(conversationQueries.inventory().queryKey);
              invalidate(orchestrationQueries.sessions().queryKey);
              cancelFork();
              setShowNewChatModal(false);
            } catch (error) {
              if (
                generation !== forkGenerationRef.current ||
                controller.signal.aborted
              )
                return;
              setForkOperation({
                pending: false,
                error:
                  error instanceof Error
                    ? error.message
                    : 'Could not create the fork. Try again.',
              });
            } finally {
              if (forkAbortRef.current === controller)
                forkAbortRef.current = null;
            }
          },
          onCloseNewChat: () => {
            setShowNewChatModal(false);
            setNewChatProjectOverride(null);
            setHandoffSource(null);
            cancelFork();
          },
          onCloseSettings: () => setShowChatSettings(() => false),
          // #3310: "Summarize session" demoted out of the transcript — this
          // gear panel is the entry point; the card renders only once a
          // summary exists, generation is in flight, or generation failed.
          sessionSummary:
            activeSession?.conversationId && activeSession.agentSlug
              ? {
                  isGenerating: generateSessionSummary.isPending,
                  onGenerate: () =>
                    generateSessionSummary.mutate({
                      agentSlug: activeSession.agentSlug,
                      conversationId: activeSession.conversationId!,
                    }),
                  agentSlug: activeSession.agentSlug,
                  conversationId: activeSession.conversationId,
                }
              : undefined,
          onCloseSessionPicker: () => setShowSessionPicker(false),
          // Discovery is not proof that a writable Session exists. The lazy
          // controller resolves, opens, and binds this row as one command.
          onSessionPickerSelect: openConversationForDock,
          onChatFontSizeChange: setChatFontSize,
          onShowReasoningChange: setShowReasoning,
          onShowToolDetailsChange: setShowToolDetails,
          onAutoHideChange: setAutoHideEnabled,
          onDockModeChange: (mode) => commitDockPlacement(mode),
        }}
        pending={null}
      />

      {activeSession?.conversationId &&
      activeSession.conversationOpenPending ? (
        <LazyBoundary
          load={loadConversationOpenRevalidator}
          componentProps={{
            sessionId: activeSession.id,
            conversationId: activeSession.conversationId,
            apiBase,
            updateChat,
          }}
          pending={null}
        />
      ) : null}

      <ShareIntakeController />
    </>
  );
}

/** The ambient application placement of the shared Chat workspace pane. */
export function ChatDock({
  onRequestAuth,
  homeContinuation = null,
  onNavigate,
  onDockActionChange,
}: {
  onRequestAuth?: () => Promise<boolean> | undefined;
  homeContinuation?: HomeViewNavigation | null;
  onNavigate: (view: NavigationView) => void;
  onDockActionChange?: (action: WorkspacePaneDockAction | null) => void;
}) {
  // Mounted directly, not behind a LazyBoundary. The chromeless presentation
  // renders a frame and the occupant — there is no tab or split controller to
  // defer — and a `pending={null}` boundary would make the dock, a persistent
  // shell affordance, blink out on a slow chunk and vanish entirely on a
  // failed one. An absent dock is indistinguishable from one Station never
  // had, which is the whole reason this codebase does not hide affordances.
  return (
    <LazyBoundary
      load={loadAmbientChatDockPaneHost}
      componentProps={{
        onRequestAuth,
        renderChatPane: renderAmbientChatPane,
        homeContinuation,
        onNavigate,
        onDockActionChange,
      }}
      pending={null}
    />
  );
}
