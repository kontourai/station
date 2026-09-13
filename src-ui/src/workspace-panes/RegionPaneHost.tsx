import {
  parseWorkspacePaneInstance,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import {
  createWorkspacePaneHostBaselineDocument,
  restoreWorkspacePaneHostDocument,
  type WorkspacePaneHostDocumentV1,
} from '@kontourai/station-contracts/workspace-pane-host';
import { type ReactNode, useMemo, useState } from 'react';
import { DockShell } from '../components/chat-dock/DockShell';
import { useRegionModelOptional } from '../contexts/RegionModelContext';
import type { DockShellChrome } from '../hooks/useDockShellChrome';
import { reportRegionClearance } from '../regions/region-clearance';
import type { DockRegionId } from '../regions/region-model';
import {
  regionSurfaceOfPane,
  regionSurfacePane,
} from '../regions/region-surface-panes';
import type { DockMode } from '../types';
import { WorkspacePaneHost } from './WorkspacePaneHost';
import {
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
 * - the model-less mount (`ChatDock` with no region, the pre-region path
 *   App-level tests still take) is Chat alone in its own host, which is
 *   exactly the document this id names, so it keeps using it;
 * - a region host whose own document has never been written ADOPTS it
 *   (`adoptLegacyChatDockDocument`) when Chat occupies the region.
 */
export const AMBIENT_CHAT_DOCK_DOCUMENT_ID = 'chat-dock';

/**
 * The document a dock region owns: `ambient:<region>` (#2045). Per REGION,
 * not per occupant — a surface moving from `bottom` to `right` leaves one
 * document and joins another, which is the shape slice 2's tabs need (a
 * region's document holds every pane placed there). The model-less mount has
 * no region and keeps the legacy Chat document.
 */
export function regionPaneHostDocumentId(
  regionId: DockRegionId | undefined,
): string {
  return regionId ?? AMBIENT_CHAT_DOCK_DOCUMENT_ID;
}

const REGION_PANE_HOST_SCOPE = { kind: 'ambient' } as const;

/**
 * The baseline document for a region holding `surfaceIds`: one tab group of
 * the surfaces' canonical panes. This slice places one surface per region,
 * so the list is one long; the shape already admits more.
 *
 * Throws rather than returning null, the same way the descriptors themselves
 * refuse to parse: every input is a code-owned constant, so a failure here is
 * a build that shipped an invalid built-in, not a runtime condition. Returning
 * null would make the region silently absent — and an absent affordance is
 * indistinguishable from one Station never had.
 */
export function createRegionPaneHostDocument(
  documentId: string,
  surfaceIds: readonly string[],
): WorkspacePaneHostDocumentV1 {
  const instances = surfaceIds.map((surfaceId) => {
    const pane = regionSurfacePane(surfaceId);
    if (!pane)
      throw new Error(`Region surface "${surfaceId}" has no built-in pane`);
    return pane.instance;
  });
  const document = createWorkspacePaneHostBaselineDocument(
    documentId,
    REGION_PANE_HOST_SCOPE,
    instances,
  );
  if (!document)
    throw new Error(`Invalid built-in region host document "${documentId}"`);
  return document;
}

/** The legacy Chat dock document: the model-less mount's, and adoption's source. */
export function createAmbientChatDockPaneDocument(): WorkspacePaneHostDocumentV1 {
  return createRegionPaneHostDocument(AMBIENT_CHAT_DOCK_DOCUMENT_ID, ['chat']);
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
    const chat = regionSurfacePane('chat');
    if (!chat) return false;
    const restored = restoreWorkspacePaneHostDocument(JSON.parse(legacy), [
      chat.instance,
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
 * of a surface in `occupants` passes, so a region document a previous build
 * persisted with another surface's pane — or a stale one after a swap moved
 * that surface elsewhere — restores as the current occupant's baseline rather
 * than rendering a pane the region does not hold. Returns a parsed instance
 * rather than the untrusted persisted object: a cast would let an unparsed
 * candidate alias straight into the host document.
 */
function admitRegionPane(
  candidate: unknown,
  occupants: readonly string[],
): WorkspacePaneInstance | null {
  const instance = parseWorkspacePaneInstance(candidate);
  return instance && isRegionPane(instance, occupants) ? instance : null;
}

function isRegionPane(
  instance: WorkspacePaneInstance,
  occupants: readonly string[],
): boolean {
  const surfaceId = regionSurfaceOfPane(instance);
  return surfaceId !== null && occupants.includes(surfaceId);
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
 * One dock region's pane host (#2045): `DockShell` (the one dock chrome shell
 * — root box, resize handle, geometry/snap/drag state,
 * `dock.toggle`/`dock.maximize`) around a chromeless `WorkspacePaneHost`
 * holding the region's document, whose panes are the surfaces placed there.
 * Chat and Activity both render through it; the `presentation` stays
 * `chromeless` until slice 2 gives a region tabs. The shell's geometry report
 * goes to the clearance reducer, one entry per rendered region (#928; the
 * reducer is the one writer of the CSS variables, archive#3902/archive#3929).
 *
 * The occupant is read from the region model — this is shell machinery, like
 * `DockShell`, not a surface renderer (`region-surface-boundary.test.ts`
 * pins those). Without a region (the model-less `ChatDock` mount) the host is
 * Chat's alone, on the legacy document.
 *
 * The inner host is keyed by its document (`WorkspacePaneHost`) AND by the
 * occupant: a swap changes what the region's document may hold, and the
 * controller initialises from its document once, so the host remounts and
 * re-hydrates rather than rendering yesterday's catalog.
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
  const occupant =
    regionId && model ? model.regions[regionId].occupant : 'chat';
  const documentId = regionPaneHostDocumentId(regionId);
  // Before the inner host's first read of the region key (its controller
  // hydrates in its own state initialiser), so the adopted document is what
  // it finds. Once per mount: a region host mounts when its region becomes
  // occupied, and adoption only acts on a region key that is absent.
  useState(() => {
    if (regionId && occupant === 'chat')
      adoptLegacyChatDockDocument(window.localStorage, regionId);
  });
  const occupants = useMemo(
    () => (occupant && regionSurfacePane(occupant) ? [occupant] : []),
    [occupant],
  );
  const document = useMemo(
    () =>
      occupants.length
        ? createRegionPaneHostDocument(documentId, occupants)
        : null,
    [documentId, occupants],
  );
  return (
    <DockShell
      regionId={regionId}
      onRenderedRegionGeometryChange={reportRegionClearance}
    >
      {(shellChrome) =>
        document ? (
          <WorkspacePaneHost
            key={occupants.join('+')}
            document={document}
            presentation="chromeless"
            admitRestoredInstance={(candidate) =>
              admitRegionPane(candidate, occupants)
            }
            admitOpenInstance={(instance) => isRegionPane(instance, occupants)}
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
                  return null;
              }
            }}
          />
        ) : null
      }
    </DockShell>
  );
}
