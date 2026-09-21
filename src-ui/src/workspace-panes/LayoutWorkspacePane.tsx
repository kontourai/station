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
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { boardPath } from '../app-shell/board-route';
import { resolveProjectLayoutRendererKind } from '../app-shell/project-layout-kind';
import { Button } from '../components/Button';
import { SkeletonBlock } from '../components/Skeleton';
import { Empty } from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import { useScopedProjectsQuery } from '../contexts/ProjectsContext';
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
 * ## What a docked Layout deliberately does not carry, and now says so
 *
 * Neither family gets `LayoutView`'s agent affordances: no `annotateAgentRef`
 * (`agentAvailableInProject`), no `onLaunchPrompt`, no `onShowChat`. For a
 * Board the reason is `PersonalBoardView`'s — there is no project to filter
 * against. For a project Layout the launch is withheld as a SCOPE choice
 * (#2171), and the record (`docs/design/placement.md`, §#2157) says which
 * half of it is forced and which is not: a PLUGIN layout's admitted launch
 * is `focusWorkspacePaneHostAction`, whose inputs are the route host's
 * `hostActions` query and `hostAuthority` (the live contribution to admit
 * against), which this pane does not hold — the control it focuses is
 * `WorkspacePaneHostActions`' (mounted by `WorkspacePaneHostActionsFrame`
 * for the CURRENT project view, so it is on the page only while Main shows
 * that project) — so it cannot be wired here; a NON-plugin project layout
 * could have been wired to its bound
 * project through `resolveLayoutLaunchAgent`, and that stays open. What was
 * not available to copy is `LayoutView`'s own tail — it ends
 * `setDockState(true); setActiveChat(null)`, which reveals Chat and selects
 * nothing — but the lifecycle hook's `createChatSession → setActiveChat(id)
 * → setDockState(true)` does select the new session, so a wired launcher had
 * a working pattern; #2171's review made that distinction, and #2194
 * tracks `LayoutView`'s tail.
 *
 * So a docked Layout reads and navigates; it does not launch — and the
 * header is told, through `canLaunchPrompts={false}`, rather than handed a
 * no-op. Before #2171 the SDK header rendered the layout's prompt buttons
 * anyway, so a docked Layout carrying prompts showed controls that did
 * nothing. An `external` or `internal` action of a NON-plugin layout still
 * renders: it opens a link or navigates without a launcher, and its author
 * is the layout's own owner.
 *
 * ## A project plugin record's stored actions are dropped, not rendered
 *
 * `LayoutView` never renders a plugin layout's STORED actions as themselves:
 * its shape strips the stored globals (`hostOwnsGlobalActions: true`) and
 * rewrites every tab action to a `prompt` (`reviewPluginAction`) so that it
 * passes through `handleLaunchPrompt`'s `packageId` admission, which honours
 * only what the LIVE contribution still carries; and the host action bar
 * renders no `external`/`internal` kind at all. A stored URL or route from a
 * withdrawn, replaced or never-admitted plugin is therefore never a live link
 * in the route host. This pane has no admission path, so for a PROJECT
 * record that declares `config.plugin` it strips the stored globals the same
 * way and empties each tab's `actions` and `skills` — a link it cannot admit
 * is not rendered rather than rendered as a link (#2171 review H1). A
 * project layout with no plugin keeps its own actions: nothing admits them
 * in the route host either, because their author is the layout's owner.
 *
 * A Board is NOT stripped, plugin word or not. A Board's `config.plugin` is
 * the caller's own input into their own record (`personal-layouts.ts`), not
 * a contribution a project host admits, and `PersonalBoardView` renders it
 * with `hostOwnsGlobalActions: false` and no strip. The dock mirrors the
 * route host of each family; a Board that showed its links at `/boards/…`
 * and none in a dock would be the two-hosts-one-record divergence this
 * pane exists not to introduce (#2171 delta review M2).
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
  const projects = useScopedProjectsQuery({ enabled: project !== null });
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

  // A PROJECT record declaring a plugin: see "A project plugin record's
  // stored actions are dropped" in the docblock. The same fact `LayoutView`
  // reads (`typeof config.plugin === 'string'`), read the same way — and
  // only for the family whose route host reads it; a Board's plugin word is
  // its owner's own record and `PersonalBoardView` strips nothing.
  const pluginProjectRecord =
    project !== null && typeof record.data.config?.plugin === 'string';
  const shape = layoutWorkspaceShape(record.data, {
    annotateAgentRef: (item) => item,
    reviewPluginAction: (item) => item,
    hostOwnsGlobalActions: pluginProjectRecord,
  });
  const layout =
    shape && pluginProjectRecord
      ? {
          ...shape,
          tabs: shape.tabs.map((tab: { id: string }) => ({
            ...tab,
            actions: [],
            skills: [],
          })),
        }
      : shape;
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
        canLaunchPrompts={false}
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
