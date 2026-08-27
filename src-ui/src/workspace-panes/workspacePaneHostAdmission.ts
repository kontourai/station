import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';

/** A mounting host admits only occurrences issued for its canonical Project. */
export function isWorkspacePaneInstanceOwnedByProject(
  instance: WorkspacePaneInstance,
  projectId: string | undefined,
): boolean {
  return Boolean(projectId && instance.boundContext?.projectId === projectId);
}
