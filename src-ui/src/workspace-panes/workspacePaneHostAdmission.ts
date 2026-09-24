import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';

/** A mounting host admits only occurrences issued for its canonical Project. */
export function isWorkspacePaneInstanceOwnedByProject(
  instance: WorkspacePaneInstance,
  projectId: string | undefined,
): boolean {
  return Boolean(projectId && instance.boundContext?.projectId === projectId);
}

/**
 * Whether a Project host can place this pane (#2465). Project hosts — the
 * Project page's pane route and a Project layout — place panes in their own
 * regions (`primary`, `secondary`, `standalone`) and admit only occurrences
 * bound to their Project. A descriptor that declares nothing but `docked`
 * (the host-global Device pane; Activity, Agents and Layout likewise) lives
 * in the dock. The pane picker offers only placeable panes, and a layout
 * that already holds a dock-only pane says where it lives instead of calling
 * it another Project's: one derivation for both.
 */
export function isProjectPlaceableWorkspacePane(
  descriptor: Pick<WorkspacePaneDescriptor, 'placement'>,
): boolean {
  return descriptor.placement.supportedRegions.some(
    (region) => region !== 'docked',
  );
}
