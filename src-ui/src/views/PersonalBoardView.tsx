import {
  FullScreenLoader,
  LayoutNavigationProvider,
  StationHttpError,
  usePersonalLayoutQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { Button } from '../components/Button';
import { ErrorState } from '../components/state';
import { SDKAdapter } from '../core/SDKAdapter';
import { LayoutRenderer } from '../layouts';
import { layoutWorkspaceShape } from './layout-workspace-shape';
import { PersonalBoardWorkspace } from './personal-board/PersonalBoardWorkspace';

/** Dashboard authoring and legacy Layout tabs share one principal-owned Board.
 * Legacy panes keep their navigation and refresh controls; neither host launches
 * Project-bound prompts from a Board without a Project capability context.
 */
export function PersonalBoardView({ boardSlug }: { boardSlug: string }) {
  const {
    data: board,
    isLoading,
    error,
    refetch,
  } = usePersonalLayoutQuery(boardSlug);
  const [refreshKey, setRefreshKey] = useState(0);
  const [authoring, setAuthoring] = useState(false);
  const [activeTabId, setActiveTabId] = useState<string | undefined>();

  const layout = layoutWorkspaceShape(board, {
    annotateAgentRef: (item) => item,
    reviewPluginAction: (item) => item,
    hostOwnsGlobalActions: false,
  });

  if (isLoading && !layout) return <FullScreenLoader />;

  if (!layout) {
    // A 404 here means this person has no Board by that slug — including the
    // case where they just promoted it into a project, which is the ordinary
    // way a Board's URL stops resolving. It is reported as a missing Board
    // rather than as a failure, because nothing went wrong.
    const missing =
      error instanceof StationHttpError ? error.status === 404 : false;
    return (
      <ErrorState
        title={missing ? 'Board not found' : 'Could not open this Board'}
        description={
          missing
            ? 'This Board no longer exists. A Board that was moved into a project is listed under that project.'
            : ((error as Error | undefined)?.message ??
              'Station could not read this Board.')
        }
        action={
          missing ? undefined : (
            <button type="button" onClick={() => refetch()}>
              Try again
            </button>
          )
        }
      />
    );
  }

  const activeTab =
    layout.tabs.find((tab: { id: string }) => tab.id === activeTabId) ??
    layout.tabs[0];

  if (
    authoring ||
    board?.config.dashboard ||
    board?.config.dashboardProposal ||
    layout.tabs.length === 0
  )
    return (
      <PersonalBoardWorkspace key={boardSlug} slug={boardSlug}>
        {layout.tabs.length > 0 && (
          <SDKAdapter layout={layout}>
            <LayoutNavigationProvider
              activeTabId={activeTab?.id}
              layoutSlug={layout.slug}
            >
              <LayoutRenderer
                layout={{ ...layout, dashboard: undefined }}
                canLaunchPrompts={false}
                activeTab={activeTab}
                componentId={activeTab?.component}
                refreshKey={refreshKey}
                onRefresh={() => setRefreshKey((key) => key + 1)}
                loading={isLoading}
                activeTabId={activeTab?.id}
                onTabChange={setActiveTabId}
              />
            </LayoutNavigationProvider>
          </SDKAdapter>
        )}
      </PersonalBoardWorkspace>
    );

  return (
    <SDKAdapter layout={layout}>
      <Button onClick={() => setAuthoring(true)}>Build dashboard</Button>
      <LayoutNavigationProvider
        activeTabId={activeTab?.id}
        layoutSlug={layout.slug}
      >
        <LayoutRenderer
          layout={layout}
          canLaunchPrompts={false}
          activeTab={activeTab}
          activeTabId={activeTab?.id}
          onTabChange={setActiveTabId}
          componentId={activeTab?.component}
          refreshKey={refreshKey}
          onRefresh={() => setRefreshKey((key) => key + 1)}
          loading={isLoading}
        />
      </LayoutNavigationProvider>
    </SDKAdapter>
  );
}
