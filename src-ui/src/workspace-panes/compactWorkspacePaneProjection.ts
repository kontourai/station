import type { WorkspacePaneInstanceId } from '@kontourai/station-contracts/workspace-pane';
import {
  flattenWorkspacePaneHost,
  type WorkspacePaneHostDocumentV1,
  type WorkspacePaneHostNode,
} from '@kontourai/station-contracts/workspace-pane-host';

export interface CompactWorkspacePaneTab {
  instanceId: WorkspacePaneInstanceId;
  selected: boolean;
  compatible: boolean;
  mount: boolean;
}

export interface CompactWorkspacePaneProjection {
  tabs: readonly CompactWorkspacePaneTab[];
  activeInstanceId: WorkspacePaneInstanceId;
  /** One element at most: compact mode never leaves hidden desktop renderer DOM mounted. */
  mountInstanceIds: readonly WorkspacePaneInstanceId[];
}

/**
 * Desktop visibility is group-local, unlike navigation focus. Collapsed split
 * branches disappear from the renderer set, while maximize deliberately wins
 * over every group selection.
 */
export function visibleWorkspacePaneHostInstanceIds(
  document: WorkspacePaneHostDocumentV1,
): readonly WorkspacePaneInstanceId[] {
  if (document.maximizedInstanceId) return [document.maximizedInstanceId];
  const selected = (node: WorkspacePaneHostNode): WorkspacePaneInstanceId[] => {
    if (node.type === 'tabs')
      return [node.selectedInstanceId ?? node.instanceIds[0]];
    if (node.collapsed === 'first') return selected(node.second);
    if (node.collapsed === 'second') return selected(node.first);
    return [...selected(node.first), ...selected(node.second)];
  };
  return selected(document.root);
}

export function projectCompactWorkspacePaneHost(
  document: WorkspacePaneHostDocumentV1,
  incompatibleInstanceIds: ReadonlySet<string> = new Set(),
): CompactWorkspacePaneProjection {
  const ids = flattenWorkspacePaneHost(document.root);
  const activeInstanceId = ids.includes(document.activeInstanceId)
    ? document.activeInstanceId
    : ids[0];
  const tabs = ids.map((instanceId) => {
    const compatible = !incompatibleInstanceIds.has(instanceId);
    return {
      instanceId,
      selected: instanceId === activeInstanceId,
      compatible,
      mount: instanceId === activeInstanceId && compatible,
    };
  });
  return {
    tabs,
    activeInstanceId,
    mountInstanceIds: tabs
      .filter((tab) => tab.mount)
      .map((tab) => tab.instanceId),
  };
}
