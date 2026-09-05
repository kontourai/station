import type { AgentId } from '@kontourai/station-contracts/agent-identity';
import {
  FullScreenError,
  FullScreenLoader,
  LayoutNavigationProvider,
  StationHttpError,
  useProjectLayoutQuery,
  useProjectQuery,
} from '@kontourai/station-sdk';
import { useWorkspacePaneHostActionsQuery } from '@kontourai/station-sdk/workspace-pane';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorState } from '../components/state';
import { useAgents } from '../contexts/AgentsContext';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../contexts/ApiBaseContext';
import { useNavigation } from '../contexts/NavigationContext';
import { LAST_PROJECT_LAYOUT_KEY } from '../contexts/navigation-store';
import { SDKAdapter } from '../core/SDKAdapter';
import {
  useCreateChatSession,
  useSendMessage,
} from '../hooks/useActiveChatSessions';
import { useSlashCommandHandler } from '../hooks/useSlashCommandHandler';
import { LayoutRenderer } from '../layouts';
import { focusWorkspacePaneHostAction } from '../workspace-panes/workspacePaneHostActionFocus';
import {
  annotateUnavailableAgentLabel,
  type ProjectAgentFilterState,
  resolveLayoutLaunchAgent,
} from './layoutViewUtils';

export function LayoutView({
  projectSlug,
  layoutSlug,
}: {
  projectSlug: string;
  layoutSlug: string;
}) {
  const { apiBase } = useApiBase();
  const { activeTab, setDockState, setLayoutTab, setActiveChat, navigate } =
    useNavigation();

  const agents = useAgents();
  const {
    data: layoutData,
    isLoading: layoutLoading,
    error: layoutQueryError,
    refetch: refetchLayout,
  } = useProjectLayoutQuery(projectSlug, layoutSlug);
  // The 404 the API actually answered. `StationHttpError.status` is the
  // derivation; the message check is the compatibility tail for a fetcher
  // that has not been migrated to it (it is what this view read before).
  const layoutMissing =
    !layoutLoading &&
    (layoutQueryError instanceof StationHttpError
      ? layoutQueryError.status === 404
      : layoutQueryError instanceof Error &&
        layoutQueryError.message.toLowerCase().includes('not found'));
  // A layout that is gone must not stay the restore target for `/`, or the
  // next cold load routes straight back into this not-found state. Done in an
  // effect, not in render: this is a write, and the render that discovered the
  // 404 may be discarded or replayed.
  useEffect(() => {
    if (!layoutMissing) return;
    try {
      localStorage.removeItem(LAST_PROJECT_LAYOUT_KEY);
    } catch {}
  }, [layoutMissing]);
  // The real two-input rule (archive#1004 closure residual)
  // needs this project's `ProjectConfig.agents` opt-in filter, not just
  // ownership — cache-shared with any other mounted consumer of the same
  // `['projects', projectSlug]` query key (project settings, sidebar), so
  // this rarely costs a fresh request.
  //
  // `isSuccess` (not just `data` truthiness) drives the ready/unknown
  // discriminant (archive#1004 closure, new): a project
  // legitimately without an `agents` filter still resolves `data` to an
  // object with `agents: undefined`, so gating on `data` alone can't tell
  // "no filter" apart from "haven't fetched yet" / "errored" — both read
  // as `undefined` either way. Only a SETTLED, SUCCESSFUL fetch may assert
  // "ready"; a still-loading or permanently-errored query stays 'unknown'
  // forever, so launches stay refused rather than failing open.
  const { data: projectConfig, isSuccess: projectConfigReady } =
    useProjectQuery(projectSlug);
  const hostAuthority = useHostRequestAuthorityScope();
  const hostActions = useWorkspacePaneHostActionsQuery(projectSlug, {
    requestScope: hostAuthority,
    enabled: Boolean(hostAuthority),
  });
  const packageId = layoutData?.config?.plugin;
  // The host bar owns declared package-global actions. Keep unknown capability
  // reads inactive instead of briefly activating a stale persisted legacy path.
  const hostOwnsGlobalActions =
    typeof packageId === 'string' &&
    (!hostActions.isSuccess ||
      !hostActions.data.complete ||
      hostActions.data.contributions.some(
        ({ projection }) => projection.owner.pluginId === packageId,
      ));
  const projectAgentFilterAgents = projectConfig?.agents;
  const projectAgentFilter: ProjectAgentFilterState = useMemo(
    () =>
      projectConfigReady
        ? { status: 'ready' as const, agents: projectAgentFilterAgents }
        : { status: 'unknown' as const },
    [projectConfigReady, projectAgentFilterAgents],
  );

  // §3.3 two-input rule at launch time (archive#1004): every
  // prompt/action agent ref is annotated — never silently dropped — when
  // its `agent` isn't available in THIS project (owned by another project,
  // or global-but-excluded-by-the-project's-filter). `handleLaunchPrompt`
  // below independently refuses to launch it regardless of this
  // annotation.
  const annotateAgentRef = <T extends { label: string; agent?: AgentId }>(
    item: T,
  ): T =>
    annotateUnavailableAgentLabel(
      item,
      agents,
      projectSlug,
      projectAgentFilter,
    );

  // Map LayoutConfig → workspace shape
  const layout = layoutData
    ? {
        slug: layoutData.slug,
        name: layoutData.name,
        icon: layoutData.icon,
        description: layoutData.description,
        tabs: (layoutData.config?.tabs ?? []).map((t: any) => ({
          id: t.id,
          label: t.label,
          component: t.component,
          icon: t.icon,
          description: t.description,
          actions: (t.actions ?? []).map(annotateAgentRef),
          skills: (t.skills ?? []).map(annotateAgentRef),
        })),
        globalSkills: (hostOwnsGlobalActions
          ? []
          : (layoutData.config?.globalSkills ?? [])
        ).map(annotateAgentRef),
        actions: hostOwnsGlobalActions
          ? []
          : layoutData.config?.actions?.map(annotateAgentRef),
        defaultAgent: layoutData.config?.defaultAgent,
        availableAgents: layoutData.config?.availableAgents,
        // Host-owned, read-only metadata used by the builtin standard-view
        // fallback. It never authorizes a Kit action or interprets Kit code.
        kit: layoutData.config?.kit,
      }
    : null;

  const createChatSession = useCreateChatSession();
  const slashCommandHandler = useSlashCommandHandler();

  // Set active tab via NavigationContext
  const setActiveTabId = useCallback(
    (tabId: string) => {
      setLayoutTab(layoutSlug, tabId);
    },
    [layoutSlug, setLayoutTab],
  );

  // Use the active tab when it still exists in this layout; otherwise fall back
  // to the first tab. Guarding against a stale id matters because a remembered
  // tab (restored on layout switch) may have since been deleted.
  const layoutTabs = layout?.tabs ?? [];
  const activeTabId =
    (activeTab && layoutTabs.some((t: any) => t.id === activeTab)
      ? activeTab
      : layoutTabs[0]?.id) || '';

  const [refreshKey, setRefreshKey] = useState(0);
  const queryClient = useQueryClient();
  const isFetching = useIsFetching();

  // Wrap slash command handler to match useSendMessage signature
  const handleSlashCommand = useCallback(
    async (sessionId: string, content: string) => {
      return await slashCommandHandler(sessionId, content, {
        autocomplete: {
          openModel: () => {},
          openNewChat: () => {},
          closeCommand: () => {},
          closeAll: () => {},
        },
      });
    },
    [slashCommandHandler],
  );

  const sendMessage = useSendMessage(
    apiBase,
    undefined,
    undefined,
    handleSlashCommand,
  );

  const activeTabObject = layout?.tabs?.find((t: any) => t.id === activeTabId);
  const agent = agents.find((a) => a.slug === layout?.defaultAgent);

  const handleLaunchPrompt = useCallback(
    async (prompt: any) => {
      // Migrated tab links review the single host control. Labels/bodies never
      // become a second launch route or an unqualified Agent fallback.
      if (
        hostOwnsGlobalActions &&
        typeof packageId === 'string' &&
        typeof prompt.id === 'string' &&
        prompt.id.startsWith(`${packageId}:`)
      ) {
        const actionId = prompt.id.slice(packageId.length + 1);
        const contribution = hostActions.data?.contributions.find(
          ({ projection }) => projection.owner.pluginId === packageId,
        );
        if (
          hostAuthority?.isCurrent() &&
          contribution?.projection.actions.some(
            (action) => action.id === actionId,
          )
        )
          focusWorkspacePaneHostAction(projectSlug, packageId, actionId);
        return;
      }
      // Never a silent launch (archive#1004): resolves only
      // to an agent actually available in THIS project — an agent owned by
      // a different project is refused here even if it was somehow still
      // clickable (e.g. a stale annotation, a plugin-rendered custom tab
      // that ignores the label marker above).
      const targetAgent = resolveLayoutLaunchAgent(
        prompt.agent || layout?.defaultAgent,
        agents,
        projectSlug,
        projectAgentFilter,
      );
      if (!targetAgent) return;

      // The layout declaration carries the message text itself; there is no
      // second server-side store to resolve an id against.
      const promptText = prompt.prompt;

      const sessionId = createChatSession(
        targetAgent.slug,
        targetAgent.name,
        prompt.label,
        projectSlug,
      );
      setDockState(true);
      setActiveChat(null); // New chat, no conversation yet

      await sendMessage(sessionId, targetAgent.slug, undefined, promptText);
    },
    [
      hostOwnsGlobalActions,
      packageId,
      hostActions.data,
      hostAuthority,
      agents,
      layout?.defaultAgent,
      createChatSession,
      sendMessage,
      setDockState,
      setActiveChat,
      projectSlug,
      projectAgentFilter,
    ],
  );

  const handleRefresh = useCallback(() => {
    // Clear layout-scoped sessionStorage (context state + tab navigation hashes)
    const slug = layoutSlug;
    const prefixes = [`layout:${slug}`, `layout-${slug}-tab-`];
    prefixes.push(`layout:${projectSlug}:${slug}`);

    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && prefixes.some((p) => key.startsWith(p))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => sessionStorage.removeItem(key));

    // Invalidate all active React Query caches — only mounted queries refetch
    queryClient.invalidateQueries();

    setRefreshKey((prev) => prev + 1);
  }, [projectSlug, layoutSlug, queryClient]);

  const backToProject = (
    <button
      type="button"
      className="editor-btn editor-btn--primary"
      onClick={() => navigate(`/projects/${projectSlug}`)}
    >
      Back to project
    </button>
  );

  // 4-HOME-009. A layout that does not exist is a 404 the API already
  // answered; it used to `navigate` from inside render — a side effect React
  // does not guarantee, which is why the whimsical loader rotated forever over
  // an answered request — and a silent redirect hid the broken deep link
  // anyway. Render the shared not-found state with a way back instead.
  if (layoutMissing) {
    return (
      <ErrorState
        title="Layout not found"
        description={
          <>
            This project has no layout called <code>{layoutSlug}</code>. It may
            have been removed, or the link may be out of date.
          </>
        }
        action={backToProject}
      />
    );
  }

  if (layoutQueryError && !layoutLoading) {
    return (
      <FullScreenError
        title="Failed to load layout"
        description="Something went wrong loading this layout. It might be a temporary issue."
        onRetry={() => refetchLayout()}
        secondaryAction={{
          label: 'Back to project',
          onClick: () => navigate(`/projects/${projectSlug}`),
        }}
      />
    );
  }

  if (layoutLoading) {
    return <FullScreenLoader label="layout" action={backToProject} />;
  }

  // The loader's bound: the query has settled, and it did not produce a
  // layout this view can render. Previously this fell back into the same
  // indefinite loader as a request still in flight, so an empty or
  // unrenderable answer looked exactly like a slow one.
  if (!layout) {
    return (
      <ErrorState
        title="This layout could not be loaded"
        description="Station received an answer for this layout but could not read it."
        action={
          <>
            <button
              type="button"
              className="editor-btn"
              onClick={() => void refetchLayout()}
            >
              Try again
            </button>
            {backToProject}
          </>
        }
      />
    );
  }

  return (
    <SDKAdapter layout={layout}>
      <LayoutNavigationProvider
        activeTabId={activeTabId}
        layoutSlug={layout?.slug}
      >
        <LayoutRenderer
          layout={layout}
          activeTab={activeTabObject}
          activeTabId={activeTabId}
          onTabChange={setActiveTabId}
          agent={agent as any}
          componentId={activeTabObject?.component}
          onLaunchPrompt={handleLaunchPrompt}
          onShowChat={() => setDockState(true)}
          refreshKey={refreshKey}
          onRefresh={handleRefresh}
          loading={isFetching > 0}
        />
      </LayoutNavigationProvider>
    </SDKAdapter>
  );
}
