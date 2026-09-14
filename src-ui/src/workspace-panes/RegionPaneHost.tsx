import {
  parseWorkspacePaneInstance,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import {
  createWorkspacePaneHostBaselineDocument,
  restoreWorkspacePaneHostDocument,
  type WorkspacePaneHostDocumentV1,
} from '@kontourai/station-contracts/workspace-pane-host';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { DockShell } from '../components/chat-dock/DockShell';
import { LazyBoundary } from '../components/LazyBoundary';
import { SkeletonBlock } from '../components/Skeleton';
import { Empty } from '../components/state';
import { useDeviceSettings } from '../contexts/DeviceSettingsContext';
import { useProject } from '../contexts/ProjectsContext';
import { useRegionModelOptional } from '../contexts/RegionModelContext';
import { useActiveProject } from '../hooks/useActiveProject';
import type { DockShellChrome } from '../hooks/useDockShellChrome';
import { reportRegionClearance } from '../regions/region-clearance';
import type { DockRegionId } from '../regions/region-model';
import {
  type RegionPaneContext,
  regionSurfaceOfPane,
  regionSurfacePane,
} from '../regions/region-surface-panes';
import type { DockMode } from '../types';
import { RegionChromeBar, type RegionChromeTab } from './RegionChromeBar';
import { RegionChromeSlotsContext } from './RegionChromeSlots';
import { WorkspacePaneHost } from './WorkspacePaneHost';
import type { WorkspacePaneHostOpenAction } from './WorkspacePaneHostOpenContext';
import {
  hydrateWorkspacePaneHost,
  persistWorkspacePaneHost,
  type WorkspacePaneHostStorage,
  workspacePaneHostStorageKey,
} from './workspacePaneHostStorage';

/**
 * The document id half of the pre-#2045 Chat dock document,
 * `station:workspace-pane-host:v2:ambient:chat-dock`
 * (`workspacePaneHostStorageKey`). It is a user's dock state on disk, so the
 * key is pinned by `RegionPaneHost.test.tsx` and named in
 * `docs/design/placement.md`. Two readers keep it:
 *
 * - a host given NO region (`RegionShells`' model-less branch renders
 *   `<ChatDock />` without one, the pre-region path App-level tests still
 *   take) is Chat alone in its own host, which is exactly the document this
 *   id names, so it keeps using it. A `ChatDock` handed a `regionId` — the
 *   plumbing `ChatDockRegionForwarding.test.tsx` pins; no production caller
 *   does it — is that region's host, on that region's document, with the
 *   admission `RegionShells` would apply (its props differ: no Activity
 *   renderer, so only Chat can render on that path);
 * - a region host whose own document has never been written ADOPTS it
 *   (`adoptLegacyChatDockDocument`) when Chat occupies the region — per
 *   region, on that region's first Chat mount; the legacy key never retires.
 */
export const AMBIENT_CHAT_DOCK_DOCUMENT_ID = 'chat-dock';

/**
 * The document a dock region owns: `ambient:<region>` (#2045). Per REGION,
 * not per occupant — a surface moving from `bottom` to `right` leaves one
 * document and joins another, which is the shape slice 2's tabs need (a
 * region's document holds every pane placed there). A host given no region
 * keeps the legacy Chat document.
 */
export function regionPaneHostDocumentId(
  regionId: DockRegionId | undefined,
): string {
  return regionId ?? AMBIENT_CHAT_DOCK_DOCUMENT_ID;
}

const REGION_PANE_HOST_SCOPE = { kind: 'ambient' } as const;

/** The context of a host that has no dock project to bind (the legacy mount). */
const PROJECTLESS_CONTEXT: RegionPaneContext = { projectId: null };

/**
 * The document for a region holding `surfaceIds`, in tab order: one tab
 * group of the surfaces' canonical panes under `context`, with
 * `selectedSurfaceId`'s pane active (the first when none is named). Derived
 * from the arrangement (`RegionState.panes` and `occupant`, #2046 2a), so
 * the arrangement is the authority for what a region holds and which pane
 * shows; the host's persisted copy carries nothing this does not.
 *
 * A surface whose pane the context cannot supply (#2047: a coding pane while
 * the dock has no project) is left OUT of the document — its tab and its
 * place in the record stay, the host renders a placeholder for it — and a
 * region none of whose panes can be supplied derives no document (null).
 * That is the one runtime condition here. A surface with no pane entry at
 * all still throws, the same way the descriptors themselves refuse to parse:
 * that input is a code-owned constant, so it is a build that shipped an
 * invalid built-in, and returning null for it would make the region silently
 * absent — an absent affordance is indistinguishable from one Station never
 * had.
 */
export function createRegionPaneHostDocument(
  documentId: string,
  surfaceIds: readonly string[],
  selectedSurfaceId?: string,
  context: RegionPaneContext = PROJECTLESS_CONTEXT,
): WorkspacePaneHostDocumentV1 | null {
  const instances = surfaceIds.flatMap((surfaceId) => {
    const pane = regionSurfacePane(surfaceId);
    if (!pane)
      throw new Error(`Region surface "${surfaceId}" has no built-in pane`);
    const instance = pane.instance(context);
    return instance ? [instance] : [];
  });
  if (instances.length === 0) return null;
  const document = createWorkspacePaneHostBaselineDocument(
    documentId,
    REGION_PANE_HOST_SCOPE,
    instances,
  );
  if (!document)
    throw new Error(`Invalid built-in region host document "${documentId}"`);
  const selected =
    selectedSurfaceId === undefined
      ? undefined
      : regionSurfacePane(selectedSurfaceId)?.instanceId;
  if (
    selected === undefined ||
    selected === document.activeInstanceId ||
    document.root.type !== 'tabs' ||
    !instances.some((instance) => instance.instanceId === selected)
  )
    return document;
  return {
    ...document,
    activeInstanceId: selected,
    root: { ...document.root, selectedInstanceId: selected },
  };
}

/**
 * Bring a region's persisted document into line with the arrangement's pane
 * set before the host hydrates it (#2046 2a). Hydration restores whatever
 * the region key holds against the catalog, and a persisted document can
 * only LOSE panes there (admission drops what the region no longer holds);
 * it never gains one. So a region key written while the region held Chat
 * alone would keep showing Chat alone after Activity joined between
 * launches — the arrangement record says two panes, the document one. When
 * the persisted pane list (the instance ids, in order) differs from
 * `document`'s, the derived document is persisted in its place; a matching
 * list is left as it is, active pane included (the mounted host follows the
 * arrangement's selection on its own, see `RegionPaneHost`). Like adoption,
 * this is a mount that writes the region key, and only when the two
 * disagree; an unreadable key is left for the host, which starts from the
 * derived document. Returns whether it wrote.
 */
export function reconcileRegionPaneHostDocument(
  storage: WorkspacePaneHostStorage,
  document: WorkspacePaneHostDocumentV1,
): boolean {
  try {
    if (
      storage.getItem(
        workspacePaneHostStorageKey(document.scope, document.id),
      ) === null
    )
      return false;
    const persisted = hydrateWorkspacePaneHost(
      storage,
      document.scope,
      document.id,
      document.instances,
    ).document;
    if (!persisted) return false;
    const persistedIds = persisted.instances.map((i) => i.instanceId);
    const derivedIds = document.instances.map((i) => i.instanceId);
    if (
      persistedIds.length === derivedIds.length &&
      persistedIds.every((id, index) => id === derivedIds[index])
    )
      return false;
    return persistWorkspacePaneHost(storage, document);
  } catch {
    return false;
  }
}

/** The legacy Chat dock document: the model-less mount's, and adoption's source. */
export function createAmbientChatDockPaneDocument(): WorkspacePaneHostDocumentV1 {
  const document = createRegionPaneHostDocument(AMBIENT_CHAT_DOCK_DOCUMENT_ID, [
    'chat',
  ]);
  // Chat's occurrence needs no context, so this is a code-owned constant.
  if (!document) throw new Error('Invalid built-in ambient Chat dock document');
  return document;
}

/**
 * First-run adoption of the pre-#2045 Chat document into a region's own
 * (#2045, design constraint 1). When `ambient:<region>` has never been
 * written and `ambient:chat-dock` exists, the legacy document is restored
 * against the Chat catalog, re-identified as the region's, and persisted
 * under the region's key. Returns whether a document was adopted.
 *
 * What this carries today: the canonical Chat occurrence and nothing else —
 * every build that ever wrote the legacy document wrote it with Chat as its
 * only pane, so its content equals the region's baseline. The adoption is
 * therefore the MECHANISM by which the pinned key keeps restoring a user's
 * dock, not a data migration with anything to lose; it is documented as such
 * in `docs/design/placement.md`. The legacy key is left in place: an older
 * build in the same-device stale-tab window still reads it, and it costs one
 * key. Adoption is idempotent, so a later re-run (the region key reclaimed)
 * reproduces the same result.
 *
 * Only a region Chat occupies adopts: the document names Chat, and restoring
 * it into a region whose catalog is Activity's would drop every instance.
 */
export function adoptLegacyChatDockDocument(
  storage: WorkspacePaneHostStorage,
  regionId: DockRegionId,
): boolean {
  try {
    const regionKey = workspacePaneHostStorageKey(
      REGION_PANE_HOST_SCOPE,
      regionId,
    );
    if (storage.getItem(regionKey) !== null) return false;
    const legacy = storage.getItem(
      workspacePaneHostStorageKey(
        REGION_PANE_HOST_SCOPE,
        AMBIENT_CHAT_DOCK_DOCUMENT_ID,
      ),
    );
    if (legacy === null) return false;
    const chat = regionSurfacePane('chat')?.instance(PROJECTLESS_CONTEXT);
    if (!chat) return false;
    const restored = restoreWorkspacePaneHostDocument(JSON.parse(legacy), [
      chat,
    ]).document;
    if (!restored || restored.id !== AMBIENT_CHAT_DOCK_DOCUMENT_ID)
      return false;
    return persistWorkspacePaneHost(storage, { ...restored, id: regionId });
  } catch {
    // Unreadable storage or a corrupt legacy document: the region starts
    // from its baseline, which is what the legacy document held anyway.
    return false;
  }
}

/**
 * Admission for a persisted pane (the reload path): only the canonical pane
 * of a surface in `occupants`, bound as the dock binds it, passes — so a
 * region document a previous build persisted with another surface's pane, or
 * a stale one after a swap moved that surface elsewhere, restores as the
 * current occupant's baseline rather than rendering a pane the region does
 * not hold. Returns a parsed instance rather than the untrusted persisted
 * object: a cast would let an unparsed candidate alias straight into the
 * host document. (A persisted coding pane bound to ANOTHER project under the
 * dock's current one never reaches this: it shares the derived instance's id
 * and the catalog match re-binds it to the dock's project first.)
 */
function admitRegionPane(
  candidate: unknown,
  occupants: readonly string[],
  context: RegionPaneContext,
): WorkspacePaneInstance | null {
  const instance = parseWorkspacePaneInstance(candidate);
  return instance && isRegionPane(instance, occupants, context)
    ? instance
    : null;
}

/**
 * Whether `instance` is a pane this region holds, as this dock binds it
 * (#2047): the surface must be in `occupants` and the instance must bind the
 * project the dock's context binds — an unbound pane (Chat, Activity) binds
 * none on both sides; a coding pane opened for another project, or opened
 * while the dock has no project, is refused.
 */
function isRegionPane(
  instance: WorkspacePaneInstance,
  occupants: readonly string[],
  context: RegionPaneContext,
): boolean {
  const surfaceId = regionSurfaceOfPane(instance);
  if (surfaceId === null || !occupants.includes(surfaceId)) return false;
  const canonical = regionSurfacePane(surfaceId)?.instance(context);
  return (
    canonical !== undefined &&
    canonical !== null &&
    canonical.boundContext?.projectId === instance.boundContext?.projectId
  );
}

export type RenderChatPane = (
  instance: WorkspacePaneInstance,
  onRequestAuth: (() => Promise<boolean> | undefined) | undefined,
  shellChrome: DockShellChrome,
) => ReactNode;

export type RenderActivityPane = (
  instance: WorkspacePaneInstance,
  shellChrome: DockShellChrome,
) => ReactNode;

/**
 * A docked built-in pane other than Chat's and Activity's (#2047: the
 * coding panes) renders through the built-in registry, behind its own lazy
 * boundary so the coding render graph (`CodingTerminalPane`, `FileTreePanel`,
 * the diff stack) stays out of this pre-warmed chunk. A new promise per
 * call, like `RegionShells`' loaders: React's `lazy` livelocks on a memoized
 * settled promise (kontourai/station#1301).
 */
const loadRegionBuiltinPane = () =>
  import('./RegionBuiltinPane').then((module) => ({
    default: module.RegionBuiltinPane,
  }));

/**
 * The project a dock region binds its panes to (#2047 D3/D5): the dock's own
 * remembered binding (`chatDockProjectSlug`, the setting `useDockShellChrome`
 * exposes as `activeProjectSlug` and Chat's project switcher writes), else
 * the route's active project, the same fallback `ChatDock` takes for a user
 * who has never bound one. Resolved to the project's id — what the coding
 * instances bind — through the project read, so an unknown or deleted slug
 * is no project rather than a dangling id.
 */
function useDockProjectId(): string | null {
  const { chatDockProjectSlug } = useDeviceSettings();
  const { projectSlug: activeProjectSlug } = useActiveProject();
  const slug = chatDockProjectSlug ?? activeProjectSlug ?? '';
  const { project } = useProject(slug);
  return project?.id ?? null;
}

/**
 * What a region shows for a selected pane its dock cannot supply (#2047 D6:
 * a coding pane while the dock has no project). The tab and the record keep
 * the surface; only the rendering waits. Same scroll container as every
 * non-Chat dock pane (`ActivityDockPane`).
 */
function RegionPaneNeedsProject({ title }: { title: string }) {
  return (
    <div className="dock-slot__body">
      <Empty
        variant="compact"
        label="Choose a project for this dock"
        description={`${title} shows the dock’s active project. Pick one from Chat’s project switcher and it will render here.`}
      />
    </div>
  );
}

/**
 * One dock region's pane host (#2045): `DockShell` (the one dock chrome shell
 * — root box, resize handle, geometry/snap/drag state,
 * `dock.toggle`/`dock.maximize`) around the region's chrome bar
 * (`RegionChromeBar`, #2046 2b: placement grab, tab strip, maximize,
 * visibility, and the slots the selected pane's own toolbar renders into)
 * and a `dock`-presentation `WorkspacePaneHost` holding the region's
 * document, whose panes are the surfaces placed there. Chat and Activity
 * both render through it. The strip is one tab per pane in `RegionState.panes`
 * order; a tab click is the model's `selectPane`, a close its `removePane`,
 * a reorder a `panes` write — the tab strip is a READER of the arrangement,
 * and the host shows the SELECTED pane (a pane behind a tab is not mounted).
 * The shell's geometry report goes to the clearance reducer, one entry per
 * rendered region (#928; the reducer is the one writer of the CSS
 * variables, archive#3902/archive#3929); the bar is inside the shell's
 * reported box, so the strip costs the workspace no clearance of its own.
 *
 * The pane set and the selected pane are read from the region model
 * (`RegionState.panes`, `occupant`) — this is shell machinery, like
 * `DockShell`, not a surface renderer (`region-surface-boundary.test.ts`
 * pins those). The document is DERIVED from them
 * (`createRegionPaneHostDocument`); admission of a persisted or opened pane
 * is over the pane set. Without a region (the model-less `ChatDock` mount)
 * the host is Chat's alone, on the legacy document.
 *
 * The inner host is keyed by its document (`WorkspacePaneHost`) and by
 * nothing else (#2046 2a, decision 4): a changed pane set is a new
 * authority fingerprint, and the controller's layout effect restores the
 * derived document, revoking the panes no longer held
 * (`workspacePaneHostController.ts`, `authorityFingerprint`).
 * `RegionPaneHost.regions.test.tsx` proves that path alone lands on the
 * region's current panes under a stale persisted document (the test the
 * #2045 docblock named as the condition for dropping its occupant key). The
 * one thing the fingerprint cannot do is ADD a pane at mount, which
 * `reconcileRegionPaneHostDocument` does before the first hydration.
 *
 * Selection: the arrangement's `occupant` is the pane the host shows. The
 * controller owns the live selection, so when the live active pane differs
 * from the arrangement's the host selects the arrangement's through the
 * controller's own `focusExisting` — and only then. The host is mounted
 * with `navigationSelection={false}`: a region's selection is the model's,
 * persisted in the arrangement record, not a `?pane=` history entry — so
 * neither a placement nor a tab click pushes history (2a review: the
 * follow used to push one entry per select and a popstate re-pushed), and
 * `?pane=` never pulls a dock host away from the model. The tab strip
 * writes the ARRANGEMENT (`selectPane`), never the controller, so selection
 * runs one way through this seam: model → host.
 *
 * The renderers are supplied by the caller, not imported: Chat's lives in
 * `ChatDock.tsx` and Activity's behind `RegionShells`' lazy boundary, and
 * this module must import neither surface's render graph. `renderActivityPane`
 * is optional only for the model-less mount, whose host holds Chat alone; a
 * region host that is handed an Activity pane without its renderer throws,
 * which the lazy boundary reports, rather than rendering nothing.
 */
export function RegionPaneHost({
  regionId,
  onRequestAuth,
  renderChatPane,
  renderActivityPane,
}: {
  regionId?: DockMode;
  onRequestAuth?: () => Promise<boolean> | undefined;
  renderChatPane: RenderChatPane;
  renderActivityPane?: RenderActivityPane;
}) {
  const model = useRegionModelOptional();
  const region = regionId && model ? model.regions[regionId] : undefined;
  const regionPanes = region?.panes;
  // The panes with a built-in pane entry, in the region's tab order; an id
  // without one (a fixture the model admits to a dock region) has nothing
  // to render and is left out. `region.panes` keeps its identity while the
  // set is unchanged (`updateRegion`), so this is stable across selection
  // and visibility writes.
  const panes = useMemo(
    () =>
      regionPanes
        ? regionPanes.filter((surfaceId) => regionSurfacePane(surfaceId))
        : ['chat'],
    [regionPanes],
  );
  const selected =
    region && region.occupant && panes.includes(region.occupant)
      ? region.occupant
      : panes[0];
  const documentId = regionPaneHostDocumentId(regionId);
  // The dock's project, for the panes that bind one (#2047). A change here
  // is a new authority fingerprint for the inner host (the instances'
  // `boundContext` is part of it), so a project switch re-binds a mounted
  // coding pane through the same restore path a pane-set change takes —
  // the instance ids do not change, so `reconcileRegionPaneHostDocument`
  // (ids only) is not what carries it.
  const projectId = useDockProjectId();
  const context = useMemo<RegionPaneContext>(
    () => ({ projectId }),
    [projectId],
  );
  const document = useMemo(
    () =>
      panes.length
        ? createRegionPaneHostDocument(documentId, panes, selected, context)
        : null,
    [context, documentId, panes, selected],
  );
  // Whether the SELECTED pane has an instance under this context. A pane the
  // dock cannot supply keeps its tab and renders the placeholder in place of
  // the host: mounting the host with another pane active would show a pane
  // the strip does not say is selected.
  const selectedSupplied =
    selected !== undefined &&
    regionSurfacePane(selected)?.instance(context) != null;
  // Before the inner host's first read of the region key (its controller
  // hydrates in its own state initialiser), so the adopted or reconciled
  // document is what it finds. Once per mount: a region host mounts when its
  // region becomes occupied, adoption only acts on a region key that is
  // absent, and a pane set that changes while mounted reaches the host
  // through the fingerprint path instead.
  useState(() => {
    if (!regionId || !document) return;
    if (panes.includes('chat'))
      adoptLegacyChatDockDocument(window.localStorage, regionId);
    reconcileRegionPaneHostDocument(window.localStorage, document);
  });
  const [openAction, setOpenAction] =
    useState<WorkspacePaneHostOpenAction | null>(null);
  const [liveActiveInstanceId, setLiveActiveInstanceId] = useState<
    string | null
  >(null);
  const selectedInstanceId = selected
    ? regionSurfacePane(selected)?.instanceId
    : undefined;
  useEffect(() => {
    if (!openAction || !selectedInstanceId || liveActiveInstanceId === null)
      return;
    if (liveActiveInstanceId === selectedInstanceId) return;
    openAction.focusExisting?.(selectedInstanceId);
  }, [liveActiveInstanceId, openAction, selectedInstanceId]);

  // The region bar's tabs, from the same `panes` the document derives from.
  const tabs = useMemo<RegionChromeTab[]>(
    () =>
      panes.flatMap((surfaceId) => {
        const pane = regionSurfacePane(surfaceId);
        return pane
          ? [
              {
                surfaceId,
                instanceId: pane.instanceId,
                title: model?.surfaces.get(surfaceId)?.title ?? surfaceId,
              },
            ]
          : [];
      }),
    [model, panes],
  );
  // The id the strip's tabs and the host's panel share: the REGION's, so the
  // pair is stable whatever tab-group id a persisted (adopted) document
  // carries.
  const groupId = `region:${documentId}`;
  const selectTab = useCallback(
    (surfaceId: string) => {
      if (regionId && model) model.selectPane(regionId, surfaceId);
    },
    [model, regionId],
  );
  const closeTab = useCallback(
    (surfaceId: string) => {
      if (regionId && model) model.removePane(regionId, surfaceId);
    },
    [model, regionId],
  );
  const reorderTab = useCallback(
    (surfaceId: string, toIndex: number) => {
      if (!regionId || !model) return;
      const current = model.regions[regionId].panes;
      const from = current.indexOf(surfaceId);
      if (from === -1 || toIndex < 0 || toIndex >= current.length) return;
      const order = current.filter((pane) => pane !== surfaceId);
      order.splice(toIndex, 0, surfaceId);
      model.setRegion(regionId, { panes: order });
    },
    [model, regionId],
  );
  // The bar's slots, published to the panes below so the selected pane's
  // toolbar can render into them (`RegionChromeSlots`). State, not refs: the
  // pane must re-render once the slot exists.
  const [leadingSlot, setLeadingSlot] = useState<HTMLElement | null>(null);
  const [trailingSlot, setTrailingSlot] = useState<HTMLElement | null>(null);
  const slots = useMemo(
    () => ({ leading: leadingSlot, trailing: trailingSlot }),
    [leadingSlot, trailingSlot],
  );
  return (
    <DockShell
      regionId={regionId}
      onRenderedRegionGeometryChange={reportRegionClearance}
    >
      {(shellChrome) => (
        <RegionChromeSlotsContext.Provider value={slots}>
          <RegionChromeBar
            chrome={shellChrome}
            groupId={groupId}
            tabs={tabs}
            selectedSurfaceId={selected}
            onSelectTab={selectTab}
            onCloseTab={
              regionId && model && tabs.length > 1 ? closeTab : undefined
            }
            onReorderTab={reorderTab}
            leadingSlotRef={setLeadingSlot}
            trailingSlotRef={setTrailingSlot}
          />
          {document && selectedSupplied ? (
            <WorkspacePaneHost
              document={document}
              presentation="dock"
              dockGroupId={groupId}
              // The region model is the selection authority (the record
              // persists it), so the host never writes `?pane=` — following
              // the model is not a navigation — and never reads it.
              navigationSelection={false}
              admitRestoredInstance={(candidate) =>
                admitRegionPane(candidate, panes, context)
              }
              admitOpenInstance={(instance) =>
                isRegionPane(instance, panes, context)
              }
              onOpenActionChange={setOpenAction}
              onDocumentChange={(live) =>
                setLiveActiveInstanceId(live.activeInstanceId)
              }
              renderPane={(instance) => {
                switch (regionSurfaceOfPane(instance)) {
                  case 'chat':
                    return renderChatPane(instance, onRequestAuth, shellChrome);
                  case 'activity':
                    if (!renderActivityPane)
                      throw new Error(
                        'Region host holds Activity but was given no Activity renderer',
                      );
                    return renderActivityPane(instance, shellChrome);
                  default:
                    return (
                      <LazyBoundary
                        load={loadRegionBuiltinPane}
                        componentProps={{ instance }}
                        pending={
                          <SkeletonBlock count={3} label="Loading pane" />
                        }
                      />
                    );
                }
              }}
            />
          ) : selected !== undefined ? (
            <RegionPaneNeedsProject
              title={model?.surfaces.get(selected)?.title ?? selected}
            />
          ) : null}
        </RegionChromeSlotsContext.Provider>
      )}
    </DockShell>
  );
}
