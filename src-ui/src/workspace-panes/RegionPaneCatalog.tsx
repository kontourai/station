import {
  resolveWorkspacePaneAvailability,
  type WorkspacePaneAvailabilityInput,
} from '@kontourai/station-contracts/workspace-pane-availability';
import { useCallback, useMemo, useState } from 'react';
import { useRegionModel } from '../contexts/RegionModelContext';
import {
  describeOpenInRegionRefusal,
  useOpenInRegion,
} from '../contexts/useOpenInRegion';
import { type DockRegionId, regionLabel } from '../regions/region-model';
import {
  DOCK_HOST_SUPPLIABLE_CONTEXTS,
  dockCanSupply,
  regionSurfaceOfDescriptor,
} from '../regions/region-surface-panes';
import { ProjectWorkspacePaneModal } from './ProjectWorkspacePaneCatalog';
import {
  type ResolvedWorkspacePaneCatalogEntry,
  useResolvedWorkspacePaneCatalog,
} from './resolvedWorkspacePaneCatalog';
import type { WorkspacePaneAvailabilityCatalogEntry } from './workspacePaneAvailabilityPresentation';

/**
 * The dock's context, in the availability resolver's vocabulary: derived
 * from `DOCK_HOST_SUPPLIABLE_CONTEXTS`, so the catalog's "why not" and the
 * inventory's admission read one set. The resolver checks `project`, `task`
 * and `workspace` (and a git-repository requirement, which is the server's
 * fact and left alone); `source` it does not check, and the dock supplies it.
 */
const DOCK_CONTEXT_PRESENCE: NonNullable<
  WorkspacePaneAvailabilityInput['context']
> = {
  project: DOCK_HOST_SUPPLIABLE_CONTEXTS.has('project') ? 'present' : 'missing',
  task: DOCK_HOST_SUPPLIABLE_CONTEXTS.has('task') ? 'present' : 'missing',
  workspace: DOCK_HOST_SUPPLIABLE_CONTEXTS.has('workspace')
    ? 'present'
    : 'missing',
};

/**
 * What a dock region's catalog lists (#2047): every known pane declaring
 * `docked` — the capability's first placement reader that decides FIT, not
 * location; the user picks the region by pressing its "+" — with the
 * availability the DOCK gives it. An entry the server already calls
 * unavailable keeps that reason (rollout and distribution precede context in
 * the resolver's own order); an available one the dock cannot supply context
 * for (`dockCanSupply`: a pane that needs a Task, which no dock has) is
 * re-resolved under the dock's context and lists disabled with the
 * resolver's reason — `missing-task`, "Choose a Task before opening this
 * pane." — rather than being silently absent. A pane that declares no
 * `docked` is not a dock pane and is not listed.
 */
export function dockCatalogEntries(
  entries: readonly ResolvedWorkspacePaneCatalogEntry[],
): ResolvedWorkspacePaneCatalogEntry[] {
  return entries
    .filter((entry) =>
      entry.descriptor.placement.supportedRegions.includes('docked'),
    )
    .map((entry) =>
      entry.availability.state === 'available' &&
      !dockCanSupply(entry.descriptor)
        ? {
            ...entry,
            availability: resolveWorkspacePaneAvailability(
              {
                rollout: 'available',
                distribution: 'enabled',
                renderer: entry.clientRendererPresence,
                context: DOCK_CONTEXT_PRESENCE,
              },
              entry.descriptor.modes[0].contextRequirement,
            ),
          }
        : entry,
    );
}

/**
 * A dock region's "+" catalog (#2047 D4): `ProjectWorkspacePaneModal` over
 * the dock project's resolved catalog, narrowed to dock panes
 * (`dockCatalogEntries`). Open is `openInRegion(instance, { region })` —
 * the model places the surface and the region host derives its document
 * from the arrangement — never a host's own open action, which would refuse
 * a pane the region does not yet hold. A pane the region already holds
 * reads "Open in this workspace", the card's own already-open state.
 * Lives behind `RegionPaneHost`'s lazy boundary; the dialog's chrome is the
 * eagerly loaded `station-dialog__*`, so it renders correctly from here.
 */
export function RegionPaneCatalog({
  regionId,
  projectSlug,
  onClose,
}: {
  regionId: DockRegionId;
  projectSlug: string;
  onClose: () => void;
}) {
  const catalog = useResolvedWorkspacePaneCatalog(projectSlug);
  const model = useRegionModel();
  const openInRegion = useOpenInRegion();
  const [notice, setNotice] = useState<string | null>(null);
  const entries = useMemo(
    () => dockCatalogEntries(catalog.entries),
    [catalog.entries],
  );
  const held = model.regions[regionId].panes;
  const isOpen = useCallback(
    (entry: WorkspacePaneAvailabilityCatalogEntry) => {
      const surfaceId = regionSurfaceOfDescriptor(entry.descriptor.id);
      return surfaceId !== null && held.includes(surfaceId);
    },
    [held],
  );
  const select = useCallback(
    (selected: WorkspacePaneAvailabilityCatalogEntry) => {
      // Open renders only for an available entry carrying an instance; the
      // full occurrence is the resolved entry's, found by its ids.
      const entry = entries.find(
        (candidate) =>
          candidate.descriptor.id === selected.descriptor.id &&
          candidate.instance?.instanceId === selected.instance?.instanceId,
      );
      if (!entry?.instance) return;
      const outcome = openInRegion(entry.instance, { region: regionId });
      if (outcome.ok) {
        setNotice(null);
        onClose();
        return;
      }
      setNotice(describeOpenInRegionRefusal(outcome.reason));
    },
    [entries, onClose, openInRegion, regionId],
  );
  const label = regionLabel(regionId);
  return (
    <ProjectWorkspacePaneModal
      show
      title={`Add pane to ${label}`}
      subtitle={`Panes a dock region can hold. Available panes open as a tab in ${label}; the others carry their state as a badge with the next step.`}
      notice={notice}
      onClose={() => {
        setNotice(null);
        onClose();
      }}
      entries={entries}
      loading={catalog.isLoading}
      error={catalog.isError}
      onRetry={() => void catalog.refetch()}
      onSelect={select}
      onAction={(_entry, action) => {
        if (action.code === 'retry-availability-check') {
          void catalog.refetch();
          return 'Checking the current pane availability.';
        }
        return 'The dock can explain the requirement but cannot complete that step from its pane catalog.';
      }}
      canExecuteAction={(_entry, action) =>
        action.code === 'retry-availability-check'
      }
      isOpen={isOpen}
    />
  );
}
