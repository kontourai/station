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
 * Since #2049 the inventory also resolves INSTANCE-KEYED panes, which are not
 * map entries: `regionSurfacePane` answers for any id whose prefix
 * `INSTANCE_SURFACE_PREFIXES` describes (`pr:…`, `file-preview:…`) by minting
 * that one occurrence, and `regionSurfaceOfPane` folds such an occurrence back
 * to its own id. The map stays exactly the registry's dock-capable surfaces —
 * `region-surface-boundary.test.ts` pins that — because an instance pane has
 * no blank occurrence to register.
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
  isCanonicalWorkspaceAgentsPaneInstance,
  WORKSPACE_AGENTS_PANE_DESCRIPTOR,
  WORKSPACE_AGENTS_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-agents-pane';
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
  isCanonicalWorkspaceDevicePaneInstance,
  WORKSPACE_DEVICE_PANE_DESCRIPTOR,
  WORKSPACE_DEVICE_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-device-pane';
import {
  WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
  type WorkspaceFilePreviewPaneState,
} from '@kontourai/station-contracts/workspace-file-preview';
import {
  createWorkspaceLayoutPaneInstance,
  isCanonicalWorkspaceLayoutPaneInstance,
  parseWorkspaceLayoutPaneId,
  WORKSPACE_LAYOUT_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-layout-pane';
import {
  toWorkspacePaneInstanceId,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
  type WorkspacePaneSuppliableContexts,
  workspacePaneModesSatisfiableBy,
} from '@kontourai/station-contracts/workspace-pane';
import {
  createWorkspacePullRequestPaneInstance,
  isCanonicalWorkspacePullRequestPaneInstance,
  parseWorkspacePullRequestPaneId,
  WORKSPACE_PULL_REQUEST_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-pull-request-pane';
import {
  createFilePreviewPaneInstance,
  isCanonicalFilePreviewPaneInstance,
} from '../workspace-panes/filePreviewPaneInstance';
import {
  type FilePreviewPaneStateStorage,
  readFilePreviewPaneState,
} from '../workspace-panes/filePreviewPaneStateStorage';

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
  /**
   * The same project's slug, or null. Carried because a file preview's
   * persisted state names its project by SLUG (`WorkspaceFilePreviewPaneState`)
   * while an instance binds it by id: an entry that cannot compare both would
   * mint an occurrence of THIS dock's project for a file that belongs to
   * another, and the renderer would report a state mismatch for a tab the
   * host claimed to have derived (#2049).
   */
  projectSlug: string | null;
}

export interface RegionSurfacePane {
  surfaceId: string;
  /**
   * The tab's own title, where the pane derives one from its identity (a
   * pull request's number, a previewed file's name). Absent for a registered
   * surface, whose title is the registry's. `RegionPaneHost` prefers this and
   * falls back to `resolveRegionSurface(id).title` — which is also what the
   * folded Regions menu and the shell landmark, neither of which resolves an
   * instance, always show.
   */
  title?: string;
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
    [
      'workspace-agents',
      {
        surfaceId: 'workspace-agents',
        descriptorId: WORKSPACE_AGENTS_PANE_DESCRIPTOR.id,
        instanceId: WORKSPACE_AGENTS_PANE_INSTANCE.instanceId,
        instance: () => WORKSPACE_AGENTS_PANE_INSTANCE,
        isCanonical: isCanonicalWorkspaceAgentsPaneInstance,
      },
    ],
    [
      'device',
      {
        surfaceId: 'device',
        descriptorId: WORKSPACE_DEVICE_PANE_DESCRIPTOR.id,
        instanceId: WORKSPACE_DEVICE_PANE_INSTANCE.instanceId,
        // Ignores the context, like Chat, Activity and Agents, and for a
        // reason of its own: the device list is a fact about the STATION's host, not
        // about a checkout, so a Device pane renders in a dock with no
        // project rather than showing "choose a project" for a question no
        // project answers.
        instance: () => WORKSPACE_DEVICE_PANE_INSTANCE,
        isCanonical: isCanonicalWorkspaceDevicePaneInstance,
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

/** The exact shape `createFilePreviewPaneInstance` mints its identity in. */
const FILE_PREVIEW_PANE_ID = /^file-preview:[0-9a-f]{32}$/;

/**
 * The browser storage a file preview's state lives in, or null where there is
 * no browser (this module is read from node-environment unit tests). A pane
 * whose state cannot be read has no occurrence, which is the same answer an
 * absent state gives.
 */
function filePreviewStorage(): FilePreviewPaneStateStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

/** The last segment of a preview's path — the tab's name for the file. */
function filePreviewTitle(state: WorkspaceFilePreviewPaneState): string {
  const segments = state.path.split('/');
  return segments[segments.length - 1] || state.path;
}

/**
 * One pull request's pane, resolved from its id (#2049). The occurrence binds
 * the dock's project because the review route is project-scoped; with no
 * project the entry has no instance, exactly as a coding pane does.
 */
function pullRequestSurfacePane(
  surfaceId: string,
): RegionSurfacePane | undefined {
  const key = parseWorkspacePullRequestPaneId(surfaceId);
  if (!key) return undefined;
  return {
    surfaceId,
    descriptorId: WORKSPACE_PULL_REQUEST_PANE_DESCRIPTOR.id,
    instanceId: toWorkspacePaneInstanceId(surfaceId),
    title: `#${key.ref}`,
    instance: ({ projectId }) =>
      projectId === null
        ? null
        : createWorkspacePullRequestPaneInstance(key, projectId),
    isCanonical: (instance) =>
      String(instance.instanceId) === surfaceId &&
      isCanonicalWorkspacePullRequestPaneInstance(instance),
  };
}

/**
 * One file preview's pane, resolved from its id (#2049). Unlike every other
 * entry this one reads persisted STATE — the path is not in the id, only the
 * nonce is — so an occurrence exists only while that state does and names the
 * dock's own project. A preview of another project's file keeps its tab and
 * renders the host's "choose a project" placeholder rather than being rebound
 * to a checkout the path does not belong to.
 */
function filePreviewSurfacePane(
  surfaceId: string,
): RegionSurfacePane | undefined {
  const nonce = surfaceId.slice('file-preview:'.length);
  const storage = filePreviewStorage();
  const state = storage ? readFilePreviewPaneState(storage, surfaceId) : null;
  return {
    surfaceId,
    descriptorId: WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR.id,
    instanceId: toWorkspacePaneInstanceId(surfaceId),
    ...(state ? { title: filePreviewTitle(state) } : {}),
    instance: ({ projectId, projectSlug }) =>
      state && projectId !== null && state.projectSlug === projectSlug
        ? createFilePreviewPaneInstance(state, projectId, nonce)
        : null,
    isCanonical: (instance) =>
      String(instance.instanceId) === surfaceId &&
      isCanonicalFilePreviewPaneInstance(instance, state),
  };
}

/**
 * One Layout's pane — a Board or a project Layout — resolved from its id
 * alone (#2157). No dock-project dependency: a project Layout carries its
 * project IN the id, so another project's Layout still mounts in this dock
 * (its occurrence binds THAT project, which is what the host's admission
 * compares against), and a Board binds none. No `title` here: the Layout's
 * name is a server record the SDK lists, which this module (read from
 * node-environment unit tests, no React) cannot read — `RegionPaneHost`
 * resolves it (`LayoutPaneTitles`) and falls back to the prefix title
 * while the list loads.
 */
function layoutSurfacePane(surfaceId: string): RegionSurfacePane | undefined {
  const key = parseWorkspaceLayoutPaneId(surfaceId);
  if (!key) return undefined;
  return {
    surfaceId,
    descriptorId: WORKSPACE_LAYOUT_PANE_DESCRIPTOR.id,
    instanceId: toWorkspacePaneInstanceId(surfaceId),
    instance: () => createWorkspaceLayoutPaneInstance(key),
    isCanonical: (instance) =>
      String(instance.instanceId) === surfaceId &&
      isCanonicalWorkspaceLayoutPaneInstance(instance),
  };
}

/**
 * The pane a surface renders as in a region host, if it has one: a registered
 * surface's map entry, else the one occurrence an instance-keyed id names
 * (#2049). The prefixes here are the same ones `INSTANCE_SURFACE_PREFIXES`
 * declares in `region-model.ts` — that table is the entry chunk's id-keyed
 * half (placement, titles) and this is the host chunk's occurrence-minting
 * half; `region-instance-panes.test.ts` pins them to each other by prefix and
 * descriptor id so neither can grow a family the other does not know.
 *
 * An instance entry is minted per call rather than cached: a file preview's
 * title and occurrence are derived from persisted state, which the opener
 * writes and the reclaimer removes, so a cached entry would be a stale answer
 * about storage.
 */
export function regionSurfacePane(
  surfaceId: string,
): RegionSurfacePane | undefined {
  const registered = REGION_SURFACE_PANES.get(surfaceId);
  if (registered) return registered;
  if (surfaceId.startsWith('pr:')) return pullRequestSurfacePane(surfaceId);
  if (FILE_PREVIEW_PANE_ID.test(surfaceId))
    return filePreviewSurfacePane(surfaceId);
  if (surfaceId.startsWith('board:') || surfaceId.startsWith('layout:'))
    return layoutSurfacePane(surfaceId);
  return undefined;
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
  // An instance-keyed pane IS its own surface id (#2049), so the reverse fold
  // is the forward one applied to the id the instance already carries: it
  // resolves only when the entry that id mints calls this occurrence its own.
  const identity = String(instance.instanceId);
  return regionSurfacePane(identity)?.isCanonical(instance) === true
    ? identity
    : null;
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
