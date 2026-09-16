import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_LAYOUT_PANE_DESCRIPTOR_ID =
  'pane:builtin:workspace-layout';
export const WORKSPACE_LAYOUT_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-layout';
export const WORKSPACE_LAYOUT_PANE_RENDERER_NAME = 'workspace-layout';
export const WORKSPACE_LAYOUT_PANE_SOURCE_ID = 'builtin:workspace-layout';

/**
 * The two id prefixes a Layout pane's instance id carries (#2157): a Board
 * (a principal-owned Layout, `board:<layoutId>`) and a project Layout
 * (`layout:<projectId>/<layoutId>`). The id IS the pane's identity in
 * `RegionState.panes`, so it must stay free of the one character that list
 * forbids (`,`, which `regionStatesEqual` joins on); both parts are UUIDs,
 * which admit none.
 */
export const WORKSPACE_LAYOUT_PANE_BOARD_ID_PREFIX = 'board:';
export const WORKSPACE_LAYOUT_PANE_PROJECT_ID_PREFIX = 'layout:';

function descriptor(value: unknown): WorkspacePaneDescriptor {
  const parsed = parseWorkspacePaneDescriptor(value);
  if (!parsed) throw new Error('Invalid built-in Layout Workspace Pane');
  return parsed;
}

/**
 * One Layout — a personal Board or a project Layout — declared as a
 * Workspace Pane (#2157).
 *
 * The same `LayoutConfig` the sidebar's pills navigate to, held by a dock
 * region as a tab beside Chat and rendered through the one `LayoutRenderer`
 * the main region uses. It is NOT the Session Board (`pane:builtin:board`,
 * one per project, `standalone`): that stays a route.
 *
 * `docked` only, and instance-keyed like a pull request: there is no blank
 * canonical occurrence (an occurrence names one Layout by id), so the
 * region's "+" catalog does not offer it — `RegionPaneCatalog` filters every
 * instance-keyed descriptor out. Its openers are `openLayoutInRegion` and,
 * from #2158, the sidebar's context menu and drag.
 *
 * One mode with NO context requirement: a Board has no project, and a
 * project Layout carries its project IN ITS ID rather than taking the dock's
 * — a region holds another project's Layout as readily as its own, and a
 * dock with no project still renders one. Declaring `project: true` would
 * refuse the Board outright.
 */
export const WORKSPACE_LAYOUT_PANE_DESCRIPTOR = descriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_LAYOUT_PANE_DESCRIPTOR_ID,
  name: 'Layout',
  description: 'Hold one Board or project Layout beside Chat.',
  rendererId: WORKSPACE_LAYOUT_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_LAYOUT_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['docked'],
    preferredRegion: 'docked',
  },
  modes: [{ id: 'default' }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});

/** The exact Layout one pane shows: a Board by id, or a project's Layout by both ids. */
export type WorkspaceLayoutPaneKey =
  | { kind: 'board'; layoutId: string }
  | { kind: 'project'; projectId: string; layoutId: string };

/**
 * The shape every id here must have: the server mints a Layout's `id` with
 * `randomUUID()` (`personal-layout-service.ts` `#newId`, the project layout
 * routes' `id: randomUUID()`), and a Project's the same way
 * (`project-service.ts` `createProject`). Lowercase, the form Node emits;
 * an uppercase spelling is not folded because the lists a pane resolves
 * against compare `entry.id === id` exactly, so a folded id would name a
 * record the resolver could never find.
 *
 * A pre-provisioned `project.json` may carry a hand-written id (the storage
 * schema asks only for a non-empty string); such a Project's Layouts cannot
 * be docked by this id grammar, and `workspaceLayoutPaneId` says so by
 * returning null rather than minting an id whose parse would be a guess.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The pane id for one Layout — `board:<layoutId>` or
 * `layout:<projectId>/<layoutId>` — or null when a part is not the shape the
 * server mints.
 */
export function workspaceLayoutPaneId(
  key: WorkspaceLayoutPaneKey,
): string | null {
  if (!UUID.test(key.layoutId)) return null;
  if (key.kind === 'board')
    return `${WORKSPACE_LAYOUT_PANE_BOARD_ID_PREFIX}${key.layoutId}`;
  if (!UUID.test(key.projectId)) return null;
  return `${WORKSPACE_LAYOUT_PANE_PROJECT_ID_PREFIX}${key.projectId}/${key.layoutId}`;
}

/** The Layout a pane id names, or null when the id is not one. */
export function parseWorkspaceLayoutPaneId(
  id: string,
): WorkspaceLayoutPaneKey | null {
  let key: WorkspaceLayoutPaneKey;
  if (id.startsWith(WORKSPACE_LAYOUT_PANE_BOARD_ID_PREFIX)) {
    key = {
      kind: 'board',
      layoutId: id.slice(WORKSPACE_LAYOUT_PANE_BOARD_ID_PREFIX.length),
    };
  } else if (id.startsWith(WORKSPACE_LAYOUT_PANE_PROJECT_ID_PREFIX)) {
    const rest = id.slice(WORKSPACE_LAYOUT_PANE_PROJECT_ID_PREFIX.length);
    const segments = rest.split('/');
    if (segments.length !== 2) return null;
    key = {
      kind: 'project',
      projectId: segments[0] as string,
      layoutId: segments[1] as string,
    };
  } else {
    return null;
  }
  // Round-trip rather than re-testing the parts: the id the parse accepts is
  // exactly the id the factory mints.
  return workspaceLayoutPaneId(key) === id ? key : null;
}

/**
 * One Layout pane occurrence. Its instance id IS its pane id, so the region
 * arrangement, the host document and the tab strip all name it the same way
 * and a second open of the same Layout is a reveal, not a duplicate. A
 * project Layout binds its project so the host's admission
 * (`RegionPaneHost`, which compares `boundContext.projectId` against the
 * derived occurrence) sees the same project on both sides; a Board binds
 * none.
 */
export function createWorkspaceLayoutPaneInstance(
  key: WorkspaceLayoutPaneKey,
): WorkspacePaneInstance | null {
  const identity = workspaceLayoutPaneId(key);
  if (!identity) return null;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_LAYOUT_PANE_DESCRIPTOR_ID,
    instanceId: identity,
    stateKey: identity,
    boundContext: {
      ...(key.kind === 'project' ? { projectId: key.projectId } : {}),
      sourceId: WORKSPACE_LAYOUT_PANE_SOURCE_ID,
    },
  });
}

export function isCanonicalWorkspaceLayoutPaneInstance(
  candidate: WorkspacePaneInstance,
): boolean {
  const identity = String(candidate.instanceId);
  const key = parseWorkspaceLayoutPaneId(identity);
  const context = candidate.boundContext;
  if (
    candidate.descriptorId !== WORKSPACE_LAYOUT_PANE_DESCRIPTOR_ID ||
    identity !== String(candidate.stateKey) ||
    key === null ||
    context?.sourceId !== WORKSPACE_LAYOUT_PANE_SOURCE_ID
  )
    return false;
  const expectedKeys = key.kind === 'project' ? 2 : 1;
  return (
    Object.keys(context).length === expectedKeys &&
    (key.kind === 'project'
      ? context.projectId === key.projectId
      : context.projectId === undefined)
  );
}
