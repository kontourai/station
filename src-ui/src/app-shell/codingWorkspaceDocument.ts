import {
  restoreWorkspacePaneHostDocument,
  type WorkspacePaneHostDocumentV1,
  workspacePaneHostScopeMatches,
} from '@kontourai/station-contracts/workspace-pane-host';
import { reduceWorkspacePaneHost } from '../workspace-panes/workspacePaneHostReducer';
import type { WorkspacePaneHostRestoredInstanceAdmission } from '../workspace-panes/workspacePaneHostStorage';

/** Apply changed built-in membership without replacing the reader's other panes. */
export function reconcileCodingWorkspaceDocument(
  previousBaseline: WorkspacePaneHostDocumentV1,
  nextBaseline: WorkspacePaneHostDocumentV1,
  current: WorkspacePaneHostDocumentV1,
  admitInstance: WorkspacePaneHostRestoredInstanceAdmission,
): WorkspacePaneHostDocumentV1 {
  if (
    current.id !== nextBaseline.id ||
    previousBaseline.id !== nextBaseline.id ||
    !workspacePaneHostScopeMatches(
      previousBaseline.scope,
      nextBaseline.scope,
    ) ||
    !workspacePaneHostScopeMatches(current.scope, nextBaseline.scope)
  )
    return nextBaseline;
  const previousIds = new Set(
    previousBaseline.instances.map((instance) => instance.instanceId),
  );
  const known = [
    ...current.instances
      .filter((instance) => !previousIds.has(instance.instanceId))
      .flatMap((instance) => {
        const admitted = admitInstance(instance);
        return admitted ? [admitted] : [];
      }),
    ...nextBaseline.instances,
  ];
  const restored = restoreWorkspacePaneHostDocument(current, known).document;
  if (!restored) return nextBaseline;
  let state = { document: restored, rendererFailures: {} };
  for (const instance of nextBaseline.instances) {
    if (
      !state.document.instances.some(
        (existing) => existing.instanceId === instance.instanceId,
      )
    )
      state = reduceWorkspacePaneHost(state, {
        type: 'add-existing-instance',
        instance,
      });
  }
  return reduceWorkspacePaneHost(state, {
    type: 'select',
    instanceId: restored.activeInstanceId,
  }).document;
}
