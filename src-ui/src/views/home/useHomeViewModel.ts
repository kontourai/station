import {
  useAcknowledgeConversationMutation,
  useConversationInventoryQuery,
  useOrchestrationSessionsQuery,
  useRemoteSessionsQuery,
  useTasksQuery,
} from '@kontourai/station-sdk';
import { listProjectLayouts } from '@kontourai/station-sdk/client';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useReducer } from 'react';
import { useAgents, useAgentsLoaded } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import {
  openChatsStore,
  useOpenWorkChats,
} from '../../contexts/open-chats-store';
import { useScopedProjectsQuery } from '../../contexts/ProjectsContext';
import { useShowSurface } from '../../contexts/useShowSurface';
import { useCatalogModelLabel } from '../../hooks/useCatalogModelLabel';
import { useDegradedQueryState } from '../../hooks/useDegradedQueryState';
import {
  availablePlacements,
  dockFoldsToOneRegion,
  useDockSlotDevice,
} from '../../hooks/useIsMobile';
import type { NavigationView } from '../../types';
import { buildHomeWorkItems, type HomeWorkItem } from './home-view-model';
import { useWorkFacts } from './useWorkFacts';
import type { WorkFactsById } from './work-facts';
import {
  focusChatEventDetailForAction,
  resolveWorkItemOpenAction,
} from './work-item-open-policy';

export type HomeViewNavigation = Extract<
  NavigationView,
  { type: 'layout' } | { type: 'project' }
>;

interface HomeWorkData {
  projects: NonNullable<ReturnType<typeof useScopedProjectsQuery>['data']>;
  /**
   * The agent catalog, exposed because Home's rows draw an agent icon and
   * that icon must resolve against the SAME catalog the rows' labels were
   * built from (`buildHomeWorkItems` already receives it). A row component
   * fetching its own would be a second read that can disagree.
   */
  agents: ReturnType<typeof useAgents>;
  actionsLoading: boolean;
  workItems: HomeWorkItem[];
  /**
   * Status facts by item id (`buildWorkFacts`), derived beside `workItems`
   * from the same session, chat and Task records rather than carried on the
   * items: `HomeWorkItem` is the Home role's projection surface.
   */
  workFacts?: WorkFactsById;
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
  const projectsQuery = useScopedProjectsQuery();
  const projects = projectsQuery.data ?? [];
  const sessions = useOrchestrationSessionsQuery();
  const inventory = useConversationInventoryQuery();
  const tasks = useTasksQuery();
  const { data: remoteSessionsResult } = useRemoteSessionsQuery();
  const agents = useAgents();
  const agentsLoaded = useAgentsLoaded();
  // archive#3391: Home's rows name a model the way the New Chat surfaces
  // do — through the connection catalogs, not the stored id.
  const { resolveModelLabel, isLoading: pickerCatalogLoading } =
    useCatalogModelLabel();
  // #1582 B9: Home names WORK, so a chat nothing has been put into is not one
  // of its items. The inboxes list every open chat — see `useInboxWorkItems`
  // and `useOpenWorkChats`.
  const openChatItems = useOpenWorkChats(
    agents,
    sessions.data ?? [],
    resolveModelLabel,
  );
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
  const factSources = useMemo(
    () => ({ tasks: tasks.data ?? [], remoteEnvironments }),
    [remoteEnvironments, tasks.data],
  );
  const workFacts = useWorkFacts(workItems, sessions.data ?? [], factSources);
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
    actionsLoading:
      !agentsLoaded || projectsQuery.isLoading || pickerCatalogLoading,
    workItems,
    workFacts,
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

/**
 * U1 (design round 2026-10): where a chat opened from Home LIVES. A chat
 * whose project has a Coding layout belongs in that layout's centre, not in
 * a dock squeezed under Home; a chat with no project, or whose project has
 * no Coding layout, stays in the dock, and a device that folds every region
 * into the bottom dock (a phone) keeps the dock everywhere. Resolves to the
 * layout's slug, or `null` when the dock is the destination. Read from the
 * query cache, fetched once when cold; a failed read means "no layout".
 */
type CodingLayoutFor = (
  projectSlug: string | undefined,
) => Promise<string | null>;

function createContinueWork(
  onNavigate: (view: NavigationView) => void,
  // #928: Activity is a region surface, not a route, so "open this session"
  // reveals the surface with the session as its intent rather than navigating
  // to a placement that no longer exists. `showSurface` is the one seam that
  // does both halves — it commands the region model, and falls back to the
  // canonical deep link when no region host is mounted.
  showActivitySession: (sessionId: string) => void,
  acknowledge: (conversationId: string, updatedAt: string) => void,
  codingLayoutFor: CodingLayoutFor,
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
    // The chat is focused first, synchronously: the shared focus action is
    // what opens or rehydrates it, and the layout route below keeps the
    // active chat (`navigation-store` carries `chat` across a route change),
    // so the Coding host centres the chat it finds active.
    openChatsStore.focus(detail);
    const { projectSlug } = task;
    if (!projectSlug) return;
    void codingLayoutFor(projectSlug).then((layoutSlug) => {
      if (layoutSlug) onNavigate({ type: 'layout', projectSlug, layoutSlug });
    });
  };
}

export function useHomeViewModel(onNavigate: (view: NavigationView) => void) {
  const data = useHomeWorkData();
  const acknowledge = useAcknowledgeConversationMutation();
  const showSurface = useShowSurface();
  const queryClient = useQueryClient();
  const { apiBase } = useApiBase();
  // The same fold the region model uses to decide the dock is the only
  // region: on such a device the Coding layout's chat IS the dock, so the
  // route adds nothing but a page change.
  const bottomOnly = dockFoldsToOneRegion(
    availablePlacements(useDockSlotDevice()),
  );
  const codingLayoutFor: CodingLayoutFor = async (projectSlug) => {
    if (!projectSlug || bottomOnly) return null;
    try {
      // The same key `useProjectLayoutsQuery` writes, so a sidebar that has
      // already listed this project's layouts answers without a request.
      const layouts: Array<{ slug: string; type?: string }> =
        await queryClient.fetchQuery({
          queryKey: ['projects', projectSlug, 'layouts'],
          queryFn: () => listProjectLayouts(apiBase, projectSlug),
          staleTime: 60_000,
        });
      return layouts.find((layout) => layout.type === 'coding')?.slug ?? null;
    } catch {
      return null;
    }
  };
  return {
    ...data,
    // #2310 review M3: the "Continue" card must name work. A Draft
    // has none — nothing was ever sent — and stays reachable in its lane.
    primaryWorkItem: data.workItems.find(
      (task) =>
        task.kind !== 'remote-session' && task.lifecycleLabel !== 'Draft',
    ),
    continueWork: createContinueWork(
      onNavigate,
      (sessionId) => showSurface('activity', { session: sessionId }),
      (conversationId, updatedAt) =>
        acknowledge.mutate({ conversationId, updatedAt }),
      codingLayoutFor,
    ),
  };
}
