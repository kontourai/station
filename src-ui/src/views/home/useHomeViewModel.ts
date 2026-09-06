import {
  useAcknowledgeConversationMutation,
  useConversationInventoryQuery,
  useModelPickerCatalogQuery,
  useOrchestrationSessionsQuery,
  useProjectsQuery,
  useRemoteSessionsQuery,
  useTasksQuery,
} from '@kontourai/station-sdk';
import { useMemo, useReducer } from 'react';
import { useAgents, useAgentsLoaded } from '../../contexts/AgentsContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { openChatsStore, useOpenChats } from '../../contexts/open-chats-store';
import { useShowSurface } from '../../contexts/useShowSurface';
import { useDegradedQueryState } from '../../hooks/useDegradedQueryState';
import { useNewChatSelectionModel } from '../../hooks/useNewChatSelectionModel';
import type { NavigationView } from '../../types';
import { runtimeCatalogVisibleModels } from '../../utils/execution';
import { modelIdentityLabel } from '../../utils/modelCapabilities';
import { buildHomeWorkItems, type HomeWorkItem } from './home-view-model';
import {
  focusChatEventDetailForAction,
  resolveWorkItemOpenAction,
} from './work-item-open-policy';

export type HomeViewNavigation = Extract<
  NavigationView,
  { type: 'layout' } | { type: 'project' }
>;

interface HomeWorkData {
  projects: ReturnType<typeof useProjectsQuery>['data'];
  /**
   * The agent catalog, exposed because Home's rows draw an agent icon and
   * that icon must resolve against the SAME catalog the rows' labels were
   * built from (`buildHomeWorkItems` already receives it). A row component
   * fetching its own would be a second read that can disagree.
   */
  agents: ReturnType<typeof useAgents>;
  defaultSelection: ReturnType<
    typeof useNewChatSelectionModel
  >['defaultSelection'];
  actionsLoading: boolean;
  workItems: HomeWorkItem[];
  workLoading: boolean;
  workDegraded: boolean;
  workError: boolean;
  retryWork: () => void;
  remoteUnavailable: NonNullable<
    ReturnType<typeof useRemoteSessionsQuery>['data']
  >['unavailable'];
  remoteAuthenticationRequired: NonNullable<
    ReturnType<typeof useRemoteSessionsQuery>['data']
  >['authenticationRequired'];
}

function useHomeWorkData(): HomeWorkData {
  const projectsQuery = useProjectsQuery();
  const projects = projectsQuery.data ?? [];
  const sessions = useOrchestrationSessionsQuery();
  const inventory = useConversationInventoryQuery();
  const tasks = useTasksQuery();
  const { data: remoteSessionsResult } = useRemoteSessionsQuery();
  const agents = useAgents();
  const agentsLoaded = useAgentsLoaded();
  // archive#3391. Home's rows name a model; the New Chat surfaces name the
  // same model through `resolveEffectiveModel`, which reads a connection's
  // catalog. Home read the stored id instead, so one session was "Selected
  // Test Model" on one card and `model-selected` on the card beside it. This
  // is that catalog, unioned across every connection this Station knows —
  // a Home row can belong to any of them, not only the default agent's.
  const { data: pickerCatalog, isLoading: pickerCatalogLoading } =
    useModelPickerCatalogQuery();
  // Union, so first-match wins if two connections publish the SAME model id
  // under different names (archive#3391). Left as-is deliberately:
  // de-duplicating would have to pick a winner, and the honest winner is the
  // connection the SESSION runs on — which is a per-row lookup this hook does
  // not have and the rows do not carry. Accepted because the case needs two
  // connections to disagree about one id's display name, and because the
  // failure mode is a right-shaped name from the wrong connection rather than
  // the internal id this replaced.
  const resolveModelLabel = useMemo(() => {
    const catalog = [
      ...(pickerCatalog?.agentConnections ?? []),
      ...(pickerCatalog?.modelConnections ?? []),
    ].flatMap((connection) => runtimeCatalogVisibleModels(connection));
    return (modelId: string | null | undefined) =>
      modelIdentityLabel(modelId, catalog);
  }, [pickerCatalog?.agentConnections, pickerCatalog?.modelConnections]);
  const openChatItems = useOpenChats(
    agents,
    sessions.data ?? [],
    resolveModelLabel,
  );
  const { selectedProject } = useNavigation();
  const { defaultSelection } = useNewChatSelectionModel({
    agents,
    projects,
    selectedContext: selectedProject || '__global__',
  });
  const remoteEnvironments = remoteSessionsResult?.environments ?? [];
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
  const workItems = useMemo(() => {
    const items = buildHomeWorkItems({
      chats: {},
      sessions: sessions.data ?? [],
      tasks: tasks.data ?? [],
      agents,
      chatItems: openChatItems,
      remoteEnvironments,
      resolveModelLabel,
    });
    return items.map((item) => {
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
    inventoryById,
    openChatItems,
    remoteEnvironments,
    resolveModelLabel,
    sessions.data,
    tasks.data,
  ]);
  const workLoading =
    workItems.length === 0 &&
    (sessions.isLoading || tasks.isLoading || inventory.isLoading);
  const workError =
    workItems.length === 0 &&
    !workLoading &&
    (sessions.isError || tasks.isError || inventory.isError);
  const [workRetrySeq, bumpWorkRetry] = useReducer((n: number) => n + 1, 0);
  const workQueryState = useDegradedQueryState({
    isPending: workLoading,
    resetKey: workRetrySeq,
  });
  return {
    projects,
    agents,
    defaultSelection,
    actionsLoading:
      !agentsLoaded || projectsQuery.isLoading || pickerCatalogLoading,
    workItems,
    workLoading,
    workDegraded: workQueryState === 'degraded',
    workError,
    retryWork: () => {
      bumpWorkRetry();
      void sessions.refetch();
      void tasks.refetch();
      void inventory.refetch();
    },
    remoteUnavailable: remoteSessionsResult?.unavailable ?? [],
    remoteAuthenticationRequired:
      remoteSessionsResult?.authenticationRequired ?? [],
  };
}

function createContinueWork(
  onNavigate: (view: NavigationView) => void,
  // #928: Activity is a region surface, not a route, so "open this session"
  // reveals the surface with the session as its intent rather than navigating
  // to a placement that no longer exists. `showSurface` is the one seam that
  // does both halves — it commands the region model, and falls back to the
  // canonical deep link when no region host is mounted.
  showActivitySession: (sessionId: string) => void,
  acknowledge: (conversationId: string, updatedAt: string) => void,
) {
  return (task: HomeWorkItem) => {
    if (task.conversationUpdatedAt) {
      acknowledge(task.id, task.conversationUpdatedAt);
    }
    if (task.kind === 'task') {
      onNavigate({ type: 'task', taskId: task.id });
      return;
    }
    if (task.kind === 'remote-session') return;
    const action = resolveWorkItemOpenAction(task);
    if (action.kind === 'navigate') {
      showActivitySession(action.threadId);
      return;
    }
    const detail = focusChatEventDetailForAction(action);
    if (!detail) {
      showActivitySession(task.id);
      return;
    }
    openChatsStore.focus(detail);
  };
}

export function useHomeViewModel(onNavigate: (view: NavigationView) => void) {
  const data = useHomeWorkData();
  const acknowledge = useAcknowledgeConversationMutation();
  const showSurface = useShowSurface();
  return {
    ...data,
    /**
     * Whether the card can honestly recommend anything. False on a home where
     * no Agent is runnable — a fresh install, or one whose engines all need
     * setting up — and the card becomes a set-up CTA rather than naming an
     * Agent the New Chat picker would refuse one click later.
     */
    startReady: data.defaultSelection.agent !== undefined,
    startIdentity: data.defaultSelection.agent
      ? `${data.defaultSelection.agent.name} · ${data.defaultSelection.effectiveModel.label}`
      : 'No agent is ready yet',
    primaryWorkItem: data.workItems.find(
      (task) => task.kind !== 'remote-session',
    ),
    continueWork: createContinueWork(
      onNavigate,
      (sessionId) => showSurface('activity', { session: sessionId }),
      (conversationId, updatedAt) =>
        acknowledge.mutate({ conversationId, updatedAt }),
    ),
  };
}
