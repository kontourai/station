import type { WorkspacePaneInstanceId } from '@kontourai/station-contracts/workspace-pane';
import type {
  WorkspacePaneHostDocumentV1,
  WorkspacePaneHostScope,
} from '@kontourai/station-contracts/workspace-pane-host';
import { MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import { navigationStore } from '../contexts/navigation-store';

export const WORKSPACE_PANE_ACTIVE_INSTANCE_QUERY_PARAM = 'pane';

/** Delegates user selection to the existing navigation store's push-history owner. */
export function writeWorkspacePaneHostSelection(
  document: WorkspacePaneHostDocumentV1,
  instanceId: WorkspacePaneInstanceId | null,
): void {
  if (
    instanceId !== null &&
    !document.instances.some((instance) => instance.instanceId === instanceId)
  )
    return;
  navigationStore.setActiveWorkspacePane(
    instanceId,
    workspacePaneHostScopeKey(document.scope),
  );
}

/**
 * The host's own reconciliation of a selection the URL already names (a close
 * choosing its successor, a catalog revoking the named pane): the current
 * entry is corrected in place rather than pushed, so Back does not land on an
 * entry naming a pane that is gone (`navigationSelection="explicit"`).
 */
export function replaceWorkspacePaneHostSelection(
  document: WorkspacePaneHostDocumentV1,
  instanceId: WorkspacePaneInstanceId | null,
): void {
  if (
    instanceId !== null &&
    !document.instances.some((instance) => instance.instanceId === instanceId)
  )
    return;
  navigationStore.updateParams({
    pane: instanceId,
    paneScope:
      instanceId === null ? null : workspacePaneHostScopeKey(document.scope),
  });
}

/** Snapshot/subscription consumers read the same navigation authority as deep links and popstate. */
export function readWorkspacePaneHostSelection(
  document: WorkspacePaneHostDocumentV1,
): string | null {
  const snapshot = navigationStore.getSnapshot();
  const instanceId = snapshot.activeWorkspacePane;
  return snapshot.activeWorkspacePaneScope ===
    workspacePaneHostScopeKey(document.scope) &&
    instanceId &&
    document.instances.some((instance) => instance.instanceId === instanceId)
    ? instanceId
    : null;
}

/**
 * Whether the URL currently names a pane FOR THIS HOST'S SCOPE — any pane,
 * including one the host just closed. The `'explicit'` selection mode keeps
 * such a name current and never mints one (`workspacePaneHostController`).
 */
export function workspacePaneHostSelectionIsNamed(
  document: WorkspacePaneHostDocumentV1,
): boolean {
  const snapshot = navigationStore.getSnapshot();
  return (
    snapshot.activeWorkspacePane !== null &&
    snapshot.activeWorkspacePaneScope ===
      workspacePaneHostScopeKey(document.scope)
  );
}

export function workspacePaneHostScopeKey(
  scope: WorkspacePaneHostScope,
): string {
  switch (scope.kind) {
    case 'ambient':
      return JSON.stringify(['ambient']);
    case 'task':
      return JSON.stringify([
        'task',
        scope.projectId,
        scope.taskId,
        scope.layoutId,
      ]);
    case 'project':
      return JSON.stringify(['project', scope.projectId, scope.layoutId]);
    default: {
      const unreachable: never = scope;
      return unreachable;
    }
  }
}

export function isWorkspacePaneHostSelection(value: string | null): boolean {
  return (
    value !== null &&
    value.length > 0 &&
    value === value.trim() &&
    value.length <= MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH
  );
}
