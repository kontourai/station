import {
  FullScreenLoader,
  LayoutNavigationProvider,
  StationHttpError,
  usePersonalLayoutQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { ErrorState } from '../components/state';
import { SDKAdapter } from '../core/SDKAdapter';
import { LayoutRenderer } from '../layouts';
import { layoutWorkspaceShape } from './layout-workspace-shape';

/**
 * A Board, rendered (#2062).
 *
 * ## One renderer, two hosts
 *
 * This does NOT reimplement layout rendering. It resolves a Board through
 * `usePersonalLayoutQuery` and hands it to the same `LayoutRenderer`
 * (`src-ui/src/layouts/index.tsx`) that `LayoutView` uses, through the same
 * `layoutWorkspaceShape` derivation. `LayoutRenderer` takes no project and
 * reads none — that is what makes one renderer serve both scopes rather than
 * a second one appearing for the scope without a project.
 *
 * The sharing is by CONSTRUCTION — one import, one derivation — and that is
 * the extent of what is proven. `PersonalBoardView.test.tsx` pins the shape
 * this view hands over, but it stubs the renderer, and so does
 * `LayoutView.test.tsx`; no test renders a Board through the real one
 * (#2062 review L5, #2082). Read the claim as "there is only one renderer
 * here", not as "the renderer is verified against a Board".
 *
 * ## What a Board deliberately does not carry, and why
 *
 * `LayoutView` is a PROJECT host, and several of its affordances are defined
 * in terms of the project: an agent reference is annotated available or not
 * by `agentAvailableInProject`, launching a prompt binds a chat session to a
 * project, and the workspace-pane host actions are read per project. A Board
 * has no project, so none of those questions has an answer here — and
 * answering them with the project machinery's "unknown" is worse than not
 * offering them, because `layoutViewUtils`'s filter fails CLOSED and would
 * render every agent action visibly disabled with no explanation a Board
 * reader could act on.
 *
 * So this host renders the Board's panes and no agent-launch surface:
 * `annotateAgentRef` is identity (nothing to filter against),
 * `hostOwnsGlobalActions` is false (there is no project action bar above
 * this), no `onLaunchPrompt` is supplied, and the renderer is TOLD so through
 * `canLaunchPrompts={false}` (#2171) — omitting the handler alone never was
 * a contract: the SDK header rendered the prompts anyway, wired to a no-op,
 * which is the defect #2171 closed. Agent launches from a Board need the
 * per-principal capability projection decision D2 describes, which is not
 * this slice. The gap is stated rather than approximated.
 */
export function PersonalBoardView({ boardSlug }: { boardSlug: string }) {
  const {
    data: board,
    isLoading,
    error,
    refetch,
  } = usePersonalLayoutQuery(boardSlug);
  const [refreshKey, setRefreshKey] = useState(0);
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

  return (
    <SDKAdapter layout={layout}>
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
