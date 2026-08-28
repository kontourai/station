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
import { useAgents } from '../../contexts/AgentsContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { openChatsStore, useOpenChats } from '../../contexts/open-chats-store';
import { useDegradedQueryState } from '../../hooks/useDegradedQueryState';
import { useNewChatSelectionModel } from '../../hooks/useNewChatSelectionModel';
import type { NavigationView } from '../../types';
import { runtimeCatalogVisibleModels } from '../../utils/execution';
import { modelDisplayLabel } from '../../utils/modelCapabilities';
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
  const { data: projects = [] } = useProjectsQuery();
  const sessions = useOrchestrationSessionsQuery();
  const inventory = useConversationInventoryQuery();
  const tasks = useTasksQuery();
  const { data: remoteSessionsResult } = useRemoteSessionsQuery();
  const agents = useAgents();
// archive#3391. Home's rows name a model; the New Chat surfaces name the
// same model through `resolveEffectiveModel`, which reads a connection's
// catalog. Home read the stored id instead, so one session was "Selected
// Test Model" on one card and `model-selected` on the card beside it. This
// is that catalog, unioned across every connection this Station knows —
// a Home row can belong to any of them, not only the default agent's.
  const { data: pickerCatalog } = useModelPickerCatalogQuery();
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
      modelDisplayLabel(modelId, catalog);
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
      onNavigate({ type: 'activity', sessionId: action.threadId });
      return;
    }
    const detail = focusChatEventDetailForAction(action);
    if (!detail) {
      onNavigate({ type: 'activity', sessionId: task.id });
      return;
    }
    openChatsStore.focus(detail);
  };
}

export function useHomeViewModel(onNavigate: (view: NavigationView) => void) {
  const data = useHomeWorkData();
  const acknowledge = useAcknowledgeConversationMutation();
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
    continueWork: createContinueWork(onNavigate, (conversationId, updatedAt) =>
      acknowledge.mutate({ conversationId, updatedAt }),
    ),
  };
}
