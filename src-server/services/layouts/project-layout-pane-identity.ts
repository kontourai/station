import { createHash } from 'node:crypto';
import {
  toWorkspacePaneInstanceId,
  toWorkspacePaneStateKey,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import {
  COMPACT_PROJECT_LAYOUT_PANE_ID_PREFIX,
  MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH,
} from '@kontourai/station-contracts/workspace-pane-layout-adapter';

/** The Project catalog owns these ids. Keep every identity that already fit. */
export function compactProjectLayoutPaneIdentity(
  instance: WorkspacePaneInstance,
): WorkspacePaneInstance {
  const { instanceId, stateKey, descriptorId } = instance;
  const compactInstance =
    instanceId.length > MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH;
  const compactState =
    stateKey.length > MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH;
  if (!compactInstance && !compactState) return instance;

  const { projectId, sourceId } = instance.boundContext ?? {};
  if (!projectId || !sourceId)
    throw new Error('Project layout Pane has no project or source binding');
  const digest = createHash('sha256')
    .update(JSON.stringify([projectId, sourceId, descriptorId]))
    .digest('hex');
  return {
    ...instance,
    instanceId: compactInstance
      ? toWorkspacePaneInstanceId(
          COMPACT_PROJECT_LAYOUT_PANE_ID_PREFIX + digest,
        )
      : instanceId,
    stateKey: compactState
      ? toWorkspacePaneStateKey(`state:project-layout-v1:${digest}`)
      : stateKey,
  };
}
