/**
 * The pane each dock-capable surface is rendered as inside a region's pane
 * host (#2045, slice 1 of the tabbed dock; #2047 adds the coding panes).
 *
 * A region holds a `WorkspacePaneHost` document (`RegionPaneHost`), and the
 * surfaces placed there are its panes. This inventory is the join between the
 * two vocabularies: a surface id from `REGION_SURFACE_REGISTRY` on one side,
 * the canonical `WorkspacePaneInstance` the host opens for it on the other.
 * Home is absent by design: its only placement is `main`, which is the route
 * outlet, not a pane host (`MainRegionSurface`).
 *
 * Since #2047 an entry's `instance` is a FACTORY over the dock's context, not
 * a constant: a coding pane is the active PROJECT's (its instance binds
 * `projectId`, no layout), and with no project it has no instance at all —
 * the tab and the record keep the surface, the host renders a "choose a
 * project" pane in its place (`RegionPaneHost`). Chat and Activity ignore the
 * context; their one ambient occurrence is the same everywhere. One instance
 * per kind per region set (singleton, #2047 D3): instance-keyed panes (a
 * second terminal, a preview of one file) are batch B's, with instance ids in
 * `RegionState.panes`.
 *
 * Readers, named here so the inventory is never a label nothing derives:
 * `RegionShells` mounts a host only for a selected pane with an entry;
 * `RegionPaneHost` builds the region's document from its panes' entries (in
 * tab order, #2046 2a) and admits a persisted or opened pane only when
 * `regionSurfaceOfPane` names a surface the region holds and its project is
 * the dock's; the dock catalog (`RegionPaneCatalog`) maps a catalog
 * descriptor back to its surface through `regionSurfaceOfDescriptor` and
 * offers only what `dockCanSupply` admits. `region-surface-panes.test.ts`
 * pins the keys to the registry's dock-capable surfaces in both directions
 * and every entry's descriptor to `dockCanSupply`.
 *
 * Kept apart from `region-model.ts` on purpose: the model is pure over ids and
 * imports no pane contract, and stays in the entry chunk; this module is the
 * `RegionPaneHost` chunk's, and stays contract-only — no renderer, and never
 * `builtinWorkspacePaneRegistry.tsx` (a cross-chunk cycle fails the build).
 */

import {
  isCanonicalWorkspaceActivityPaneInstance,
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import {
  createWorkspaceChatPaneInstance,
  isCanonicalWorkspaceChatPaneInstance,
  WORKSPACE_CHAT_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-chat-pane';
import {
  createWorkspaceCodingDiffPaneInstance,
  createWorkspaceCodingFileBrowserPaneInstance,
  createWorkspaceCodingTerminalPaneInstance,
  isCanonicalWorkspaceCodingDiffPaneInstance,
  isCanonicalWorkspaceCodingFileBrowserPaneInstance,
  isCanonicalWorkspaceCodingTerminalPaneInstance,
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_DIFF_PANE_INSTANCE_ID,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_INSTANCE_ID,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_INSTANCE_ID,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  toWorkspacePaneInstanceId,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
  type WorkspacePaneSuppliableContexts,
  workspacePaneModesSatisfiableBy,
} from '@kontourai/station-contracts/workspace-pane';

/**
 * What a dock region can bind for a pane (#2047). The active project is the
 * dock's own binding (`chatDockProjectSlug`, else the active project), and
 * the coding instances bind `sourceId` and `workspaceId = projectId` from
 * it. Nothing else: no `task`, no `session` (no docked pane reads one —
 * declare it when one does, not before), no `run`. This one set is BOTH the
 * catalog's filter (`dockCanSupply`) and what the inventory's own pin
 * asserts of every entry, so the two cannot disagree.
 *
 * What a user sees of the `task` exclusion today: NOTHING (review M2). The
 * catalog lists the panes declaring `docked` and re-resolves an available
 * one the dock cannot supply into a disabled row with the resolver's reason
 * (`missing-task`) — but that path needs a descriptor that declares BOTH
 * `docked` and a Task requirement, and no shipped pane does: the task-room
 * panes declare `primary`/`secondary`, so the catalog's `docked` filter
 * drops them before any reason is computed. They are neither listed nor
 * explained. The mechanism exists and is proven by a fixture descriptor
 * (`RegionPaneCatalog.test.tsx`); the first shipped `docked` pane needing a
 * Task is what will make it visible.
 */
export const DOCK_HOST_SUPPLIABLE_CONTEXTS: WorkspacePaneSuppliableContexts =
  new Set(['project', 'source', 'workspace'] as const);

/**
 * Whether some mode of `descriptor` runs on what a dock supplies — the
 * contract's own satisfiability fold over `DOCK_HOST_SUPPLIABLE_CONTEXTS`,
 * not a region word.
 */
export function dockCanSupply(descriptor: WorkspacePaneDescriptor): boolean {
  return (
    workspacePaneModesSatisfiableBy(descriptor, DOCK_HOST_SUPPLIABLE_CONTEXTS)
      .length > 0
  );
}

/** What a region host knows when it builds its panes: the dock's project. */
export interface RegionPaneContext {
  /** The active project's id, or null when the dock has none. */
  projectId: string | null;
}

export interface RegionSurfacePane {
  surfaceId: string;
  /** The descriptor the pane is an occurrence of (`pane:builtin:<surface>`). */
  descriptorId: string;
  /**
   * The instance id every occurrence this entry mints carries — constant per
   * kind, whatever project it binds — so the region's tab strip can name the
   * pane's panel without an instance in hand.
   */
  instanceId: WorkspacePaneInstance['instanceId'];
  /**
   * The one occurrence the host opens for this surface under `context`, or
   * null when the context cannot supply it (a coding pane with no project).
   */
  instance(context: RegionPaneContext): WorkspacePaneInstance | null;
  /**
   * Whether a candidate IS this surface's canonical occurrence — the
   * descriptor's own identity check, so a same-shaped impostor (a Home
   * occurrence under a different instance id, a project-bound Chat) is
   * refused by the contract that defines the pane, not by a copy here. A
   * coding pane's check is project-agnostic: which project it binds is the
   * host's admission (`RegionPaneHost`, against the dock's context).
   */
  isCanonical(instance: WorkspacePaneInstance): boolean;
}

/**
 * The shell has one projectless Chat occurrence; the contract builds it.
 * Throws rather than returning null for the same reason the descriptor itself
 * refuses to parse: the input is a code-owned constant, so a failure is a
 * build that shipped an invalid built-in, not a runtime condition.
 */
function ambientChatPaneInstance(): WorkspacePaneInstance {
  const chat = createWorkspaceChatPaneInstance();
  if (!chat) throw new Error('Invalid built-in ambient Chat pane occurrence');
  return chat;
}

const AMBIENT_CHAT_PANE_INSTANCE = ambientChatPaneInstance();

/** A coding pane's entry: the fixed per-project instance the contract mints. */
function codingPane(
  surfaceId: string,
  descriptor: WorkspacePaneDescriptor,
  instanceId: string,
  create: (projectId: string) => WorkspacePaneInstance | null,
  isCanonical: (instance: WorkspacePaneInstance) => boolean,
): [string, RegionSurfacePane] {
  return [
    surfaceId,
    {
      surfaceId,
      descriptorId: descriptor.id,
      // A code-owned constant: an invalid one throws at load, like the
      // descriptors themselves.
      instanceId: toWorkspacePaneInstanceId(instanceId),
      instance: ({ projectId }) =>
        projectId === null ? null : create(projectId),
      isCanonical,
    },
  ];
}

export const REGION_SURFACE_PANES: ReadonlyMap<string, RegionSurfacePane> =
  new Map<string, RegionSurfacePane>([
    [
      'chat',
      {
        surfaceId: 'chat',
        descriptorId: WORKSPACE_CHAT_PANE_DESCRIPTOR.id,
        instanceId: AMBIENT_CHAT_PANE_INSTANCE.instanceId,
        instance: () => AMBIENT_CHAT_PANE_INSTANCE,
        // The predicate the chat-dock host used before it became the region
        // host, unchanged: a persisted project-bound Chat under the same
        // instance id is normalised to the projectless catalog record by
        // `restoreWorkspacePaneHostDocument`'s catalog match, so admission
        // needs no project rule of its own.
        isCanonical: (instance) =>
          instance.descriptorId === WORKSPACE_CHAT_PANE_DESCRIPTOR.id &&
          isCanonicalWorkspaceChatPaneInstance(instance),
      },
    ],
    [
      'activity',
      {
        surfaceId: 'activity',
        descriptorId: WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.id,
        instanceId: WORKSPACE_ACTIVITY_PANE_INSTANCE.instanceId,
        instance: () => WORKSPACE_ACTIVITY_PANE_INSTANCE,
        isCanonical: isCanonicalWorkspaceActivityPaneInstance,
      },
    ],
    codingPane(
      'coding:terminal',
      WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
      WORKSPACE_CODING_TERMINAL_PANE_INSTANCE_ID,
      createWorkspaceCodingTerminalPaneInstance,
      isCanonicalWorkspaceCodingTerminalPaneInstance,
    ),
    codingPane(
      'coding:diff',
      WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
      WORKSPACE_CODING_DIFF_PANE_INSTANCE_ID,
      createWorkspaceCodingDiffPaneInstance,
      isCanonicalWorkspaceCodingDiffPaneInstance,
    ),
    codingPane(
      'coding:file-browser',
      WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
      WORKSPACE_CODING_FILE_BROWSER_PANE_INSTANCE_ID,
      createWorkspaceCodingFileBrowserPaneInstance,
      isCanonicalWorkspaceCodingFileBrowserPaneInstance,
    ),
  ]);

/** The pane a surface renders as in a region host, if it has one. */
export function regionSurfacePane(
  surfaceId: string,
): RegionSurfacePane | undefined {
  return REGION_SURFACE_PANES.get(surfaceId);
}

/**
 * The surface whose canonical pane `instance` is, or null for a pane no
 * region surface owns. The host's admission and its renderer dispatch both
 * fold through this one derivation.
 */
export function regionSurfaceOfPane(
  instance: WorkspacePaneInstance,
): string | null {
  for (const pane of REGION_SURFACE_PANES.values()) {
    if (pane.isCanonical(instance)) return pane.surfaceId;
  }
  return null;
}

/**
 * The surface a catalog descriptor is placed as, or null for a descriptor no
 * region surface renders (#2047): the dock catalog's Open goes through the
 * model (`placeSurface`), so a card must resolve to a surface id before it
 * can offer anything.
 */
export function regionSurfaceOfDescriptor(descriptorId: string): string | null {
  for (const pane of REGION_SURFACE_PANES.values()) {
    if (pane.descriptorId === descriptorId) return pane.surfaceId;
  }
  return null;
}
