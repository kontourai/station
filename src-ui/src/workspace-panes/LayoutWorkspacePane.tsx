import type {
  LayoutConfig,
  LayoutMetadata,
} from '@kontourai/station-contracts/layout';
import type { ProjectMetadata } from '@kontourai/station-contracts/project';
import {
  isCanonicalWorkspaceLayoutPaneInstance,
  parseWorkspaceLayoutPaneId,
} from '@kontourai/station-contracts/workspace-layout-pane';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  usePersonalLayoutQuery,
  usePersonalLayoutsQuery,
  useProjectLayoutQuery,
  useProjectLayoutsQuery,
  useProjectsQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { boardPath } from '../app-shell/board-route';
import { resolveProjectLayoutRendererKind } from '../app-shell/project-layout-kind';
import { Button } from '../components/Button';
import { SkeletonBlock } from '../components/Skeleton';
import { Empty } from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import { SDKAdapter } from '../core/SDKAdapter';
import { LayoutRenderer } from '../layouts';
import { layoutWorkspaceShape } from '../views/layout-workspace-shape';
import { WorkspacePaneBindingUnavailable } from './WorkspacePaneBindingUnavailable';

/**
 * One Board or project Layout as a dock pane (#2157).
 *
 * ## One renderer, three hosts
 *
 * This is `PersonalBoardView` and `LayoutView`'s renderer — the same
 * `LayoutRenderer` through the same `layoutWorkspaceShape` derivation — with
 * two differences a dock tab forces. The tab state is LOCAL (`activeTabId`),
 * not the route's, and there is NO `LayoutNavigationProvider`: that provider
 * writes `location.hash` and `sessionStorage` for the layout it wraps, and a
 * second one in a dock region would fight the main region's for the one
 * hash. A layout component that calls `useLayoutNavigation` therefore
 * throws here (`LazyBoundary` reports it); no built-in tab component does,
 * and a plugin tab that does is a known gap of this slice, not a supported
 * placement.
 *
 * ## The id is the identity, so the id resolves everything
 *
 * A Board is `board:<layoutId>` and a project Layout is
 * `layout:<projectId>/<layoutId>` — ids, not slugs, because a slug is
 * renamed and reused while an id is minted once. The SDK's reads are
 * slug-keyed, so the id resolves to a slug through the metadata LIST the
 * sidebar already holds (`usePersonalLayoutsQuery`, `useProjectsQuery` +
 * `useProjectLayoutsQuery`), and only then to the record. An id the list no
 * longer carries — a Board promoted into a project, a Layout deleted — is
 * "not found" in the tab, as `PersonalBoardView` reports it; the tab stays,
 * because closing a tab is the user's act.
 *
 * A project Layout binds ITS project through the id, never the dock's
 * (`SDKAdapter` gets `boundProjectSlug`, and so does `LayoutRenderer`, for
 * the one built-in tab that reads the UI's own navigation rather than the
 * SDK's — `flow-run-console`), so a region holds another project's Layout as
 * readily as its own. A Board has no project and the adapter is given none —
 * the same call `PersonalBoardView` makes.
 *
 * ## What a docked Layout deliberately does not carry
 *
 * Neither family gets `LayoutView`'s agent affordances: no `annotateAgentRef`
 * (`agentAvailableInProject`), no `onLaunchPrompt`, no `onShowChat`. For a
 * Board the reason is `PersonalBoardView`'s — there is no project to filter
 * against. For a project Layout there IS one, and the gap is deliberate for
 * this slice: launching a prompt binds a chat session to the route's
 * project through `LayoutView`'s own handlers and action bar, and a docked
 * tab beside Chat has no host chrome to launch from. A docked Layout reads
 * and navigates; it does not launch. The SDK header still renders the
 * layout's prompt buttons with a no-op launcher, so a docked Layout that
 * carries prompts shows inert controls today; wiring the launch to the
 * pane's bound project, or hiding the bar, is #2171.
 *
 * ## Which kinds render, and which are refused
 *
 * A Board always renders through `LayoutRenderer` (that is what a Board is).
 * A project Layout renders through it only when `ProjectLayoutRenderer`
 * would send it to `LayoutView` (`resolveProjectLayoutRendererKind` ===
 * `'layout-view'`); every other kind renders an "Open in Main" placeholder
 * whose action navigates to the layout (`setLayout`). Two of those are
 * refused by design and the rest by scope:
 *
 * - `coding` is a whole `WorkspacePaneHost` (`BuiltinCodingLayoutHost`)
 *   whose storage key, `?pane=` scope and DOM ids derive from
 *   `(projectId, layoutId)`; a docked copy would share the main region's
 *   persisted document and duplicate element ids.
 * - `chat` suspends the ambient regions it would be docked in (`App.tsx`),
 *   so a docked copy would have nowhere to live.
 * - `tasks`, `session-board` and `review` are route-shaped pages
 *   (`layoutTypeRegistry`) that take a project and layout SLUG and own
 *   their own chrome; docking them is a separate decision and this slice
 *   does not make it.
 */
export function LayoutWorkspacePane({
  instance,
}: {
  instance: WorkspacePaneInstance;
}) {
  const key = parseWorkspaceLayoutPaneId(String(instance.instanceId));
  const canonical =
    key !== null && isCanonicalWorkspaceLayoutPaneInstance(instance);
  const board = key?.kind === 'board' ? key : null;
  const project = key?.kind === 'project' ? key : null;

  // Every hook unconditionally, gated by `enabled`: which family this is
  // decides which queries run, not which hooks are called.
  const boards = usePersonalLayoutsQuery({ enabled: board !== null });
  const projects = useProjectsQuery({ enabled: project !== null });
  const projectMeta = project
    ? only(
        projects.data as readonly ProjectMetadata[] | undefined,
        project.projectId,
      )
    : undefined;
  const projectSlug = projectMeta?.slug ?? '';
  const layouts = useProjectLayoutsQuery(projectSlug, {
    enabled: projectSlug !== '',
  });
  const boardMeta = board ? only(boards.data, board.layoutId) : undefined;
  const layoutMeta = project
    ? only(
        layouts.data as readonly LayoutMetadata[] | undefined,
        project.layoutId,
      )
    : undefined;
  const boardRecord = usePersonalLayoutQuery(boardMeta?.slug);
  const layoutRecord = useProjectLayoutQuery(
    projectSlug || undefined,
    layoutMeta?.slug,
    { enabled: projectSlug !== '' && layoutMeta !== undefined },
  );
  const [activeTabId, setActiveTabId] = useState<string | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);
  const { navigate, setLayout } = useNavigation();

  if (!canonical || !key)
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );

  const noun = key.kind === 'board' ? 'Board' : 'Layout';
  const listPending = board
    ? boards.isLoading
    : projects.isLoading || (projectMeta !== undefined && layouts.isLoading);
  const listError = board
    ? boards.isError
    : projects.isError || layouts.isError;
  const meta = board ? boardMeta : layoutMeta;
  const record = (board ? boardRecord : layoutRecord) as {
    data?: LayoutConfig;
    isLoading: boolean;
    isError: boolean;
    refetch: () => unknown;
  };

  if (listPending || (meta !== undefined && record.isLoading))
    return <SkeletonBlock count={3} label={`Loading ${noun}`} />;
  if (listError || record.isError)
    return (
      <Empty
        variant="compact"
        label={`Could not open this ${noun}`}
        description={`Station could not read this ${noun}.`}
        action={
          <Button
            size="sm"
            onClick={() => {
              if (listError) {
                if (board) boards.refetch();
                else {
                  projects.refetch();
                  layouts.refetch();
                }
              } else record.refetch();
            }}
          >
            Try again
          </Button>
        }
      />
    );
  if (meta === undefined)
    return (
      <Empty
        variant="compact"
        label={`${noun} not found`}
        description={
          board
            ? 'This Board no longer exists. A Board that was moved into a project is listed under that project.'
            : 'This Layout no longer exists, or its project does.'
        }
      />
    );
  if (!record.data) return null;

  const openInMain = () => {
    if (board) navigate(boardPath(meta.slug));
    else setLayout(projectSlug, meta.slug);
  };
  if (project) {
    const kind = resolveProjectLayoutRendererKind(record.data);
    if (kind !== 'layout-view')
      return (
        <Empty
          variant="compact"
          label="Open this Layout in Main"
          description={mainOnlyReason(kind)}
          action={
            <Button size="sm" onClick={openInMain}>
              Open in Main
            </Button>
          }
        />
      );
  }

  const layout = layoutWorkspaceShape(record.data, {
    annotateAgentRef: (item) => item,
    reviewPluginAction: (item) => item,
    hostOwnsGlobalActions: false,
  });
  if (!layout) return null;
  const activeTab =
    layout.tabs.find((tab: { id: string }) => tab.id === activeTabId) ??
    layout.tabs[0];
  return (
    <SDKAdapter
      layout={layout}
      {...(project ? { boundProjectSlug: projectSlug } : {})}
    >
      <LayoutRenderer
        layout={layout}
        {...(project ? { boundProjectSlug: projectSlug } : {})}
        activeTab={activeTab}
        activeTabId={activeTab?.id}
        onTabChange={setActiveTabId}
        componentId={activeTab?.component}
        refreshKey={refreshKey}
        onRefresh={() => setRefreshKey((value) => value + 1)}
        loading={record.isLoading}
      />
    </SDKAdapter>
  );
}

/** Why a project Layout of this kind renders in Main only; see the docblock. */
function mainOnlyReason(
  kind: ReturnType<typeof resolveProjectLayoutRendererKind>,
): string {
  switch (kind) {
    case 'coding':
      return 'A Coding layout is a pane host of its own; a docked copy would share the main region’s saved panes.';
    case 'chat':
      return 'A Chat layout takes the whole viewport, including the region this tab is in.';
    default:
      return 'This kind of layout renders only in the main region.';
  }
}

/**
 * The one entry with `id`, or undefined when there is none — or more than
 * one, which the resolver will not guess between.
 */
function only<T extends { id: string }>(
  entries: readonly T[] | undefined,
  id: string,
): T | undefined {
  const matches = (entries ?? []).filter((entry) => entry.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}
