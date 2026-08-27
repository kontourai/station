import type { WorkspacePaneInstanceId } from '@kontourai/station-contracts/workspace-pane';
import {
  flattenWorkspacePaneHost,
  type WorkspacePaneHostDocumentV1,
  type WorkspacePaneHostNode,
  type WorkspacePaneHostTabGroup,
} from '@kontourai/station-contracts/workspace-pane-host';

/** Pure tree operations shared by reducer transitions and host controller work. */
export function workspacePaneHostGroupContaining(
  node: WorkspacePaneHostNode,
  instanceId: string,
): WorkspacePaneHostTabGroup | undefined {
  if (node.type === 'tabs')
    return node.instanceIds.includes(instanceId as WorkspacePaneInstanceId)
      ? node
      : undefined;
  return (
    workspacePaneHostGroupContaining(node.first, instanceId) ??
    workspacePaneHostGroupContaining(node.second, instanceId)
  );
}

export function cloneWorkspacePaneHostNode(
  node: WorkspacePaneHostNode,
): WorkspacePaneHostNode {
  return node.type === 'tabs'
    ? {
        ...node,
        instanceIds: [...node.instanceIds],
        selectedInstanceId: node.selectedInstanceId ?? node.instanceIds[0],
      }
    : {
        ...node,
        first: cloneWorkspacePaneHostNode(node.first),
        second: cloneWorkspacePaneHostNode(node.second),
      };
}

export function replaceWorkspacePaneHostNode(
  node: WorkspacePaneHostNode,
  id: string,
  replacement: WorkspacePaneHostNode,
): WorkspacePaneHostNode {
  if (node.id === id) return replacement;
  if (node.type === 'tabs') return node;
  return {
    ...node,
    first: replaceWorkspacePaneHostNode(node.first, id, replacement),
    second: replaceWorkspacePaneHostNode(node.second, id, replacement),
  };
}

export function updateWorkspacePaneHostNode(
  node: WorkspacePaneHostNode,
  id: string,
  update: (node: WorkspacePaneHostNode) => WorkspacePaneHostNode,
): WorkspacePaneHostNode {
  if (node.id === id) return update(node);
  if (node.type === 'tabs') return node;
  return {
    ...node,
    first: updateWorkspacePaneHostNode(node.first, id, update),
    second: updateWorkspacePaneHostNode(node.second, id, update),
  };
}

export function withoutWorkspacePaneHostInstance(
  node: WorkspacePaneHostNode,
  instanceId: WorkspacePaneInstanceId,
): WorkspacePaneHostNode | null {
  if (node.type === 'tabs') {
    const removedIndex = node.instanceIds.indexOf(instanceId);
    const instanceIds = node.instanceIds.filter((id) => id !== instanceId);
    if (!instanceIds.length) return null;
    return {
      ...node,
      instanceIds,
      selectedInstanceId:
        node.selectedInstanceId === instanceId
          ? instanceIds[
              Math.min(Math.max(removedIndex, 0), instanceIds.length - 1)
            ]
          : (node.selectedInstanceId ?? instanceIds[0]),
    };
  }
  const first = withoutWorkspacePaneHostInstance(node.first, instanceId);
  const second = withoutWorkspacePaneHostInstance(node.second, instanceId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function workspacePaneHostCloseSuccessor(
  document: WorkspacePaneHostDocumentV1,
  instanceId: WorkspacePaneInstanceId,
): WorkspacePaneInstanceId | null {
  if (document.activeInstanceId !== instanceId)
    return document.activeInstanceId;
  const group = workspacePaneHostGroupContaining(document.root, instanceId);
  if (group && group.instanceIds.length > 1) {
    const index = group.instanceIds.indexOf(instanceId);
    const remaining = group.instanceIds.filter((id) => id !== instanceId);
    return (
      remaining[Math.min(Math.max(index, 0), remaining.length - 1)] ?? null
    );
  }
  return (
    flattenWorkspacePaneHost(document.root).find((id) => id !== instanceId) ??
    null
  );
}
