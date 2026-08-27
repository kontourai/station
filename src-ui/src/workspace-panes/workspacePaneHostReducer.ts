import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  findWorkspacePaneHostTabGroup,
  MAX_WORKSPACE_PANE_HOST_PANES,
  MAX_WORKSPACE_PANE_HOST_TREE_DEPTH,
  parseWorkspacePaneHostDocument,
  restoreWorkspacePaneHostDocument,
  type WorkspacePaneHostAction,
  type WorkspacePaneHostDocumentV1,
  type WorkspacePaneHostNode,
  type WorkspacePaneHostSplit,
  type WorkspacePaneHostTabGroup,
} from '@kontourai/station-contracts/workspace-pane-host';
import {
  cloneWorkspacePaneHostNode,
  replaceWorkspacePaneHostNode,
  updateWorkspacePaneHostNode,
  withoutWorkspacePaneHostInstance,
  workspacePaneHostCloseSuccessor,
  workspacePaneHostGroupContaining,
} from './workspacePaneHostReducerTree';

export interface WorkspacePaneHostState {
  document: WorkspacePaneHostDocumentV1;
  /** UI-local failure metadata. It is deliberately absent from persisted host data. */
  rendererFailures: Readonly<Record<string, string>>;
}

function cloneDocument(
  document: WorkspacePaneHostDocumentV1,
): WorkspacePaneHostDocumentV1 {
  return {
    ...document,
    instances: [...document.instances],
    root: cloneWorkspacePaneHostNode(document.root),
  };
}

function insertAt<T>(items: readonly T[], item: T, index?: number): T[] {
  const at =
    index === undefined
      ? items.length
      : Math.max(0, Math.min(items.length, index));
  return [...items.slice(0, at), item, ...items.slice(at)];
}

function addExisting(
  document: WorkspacePaneHostDocumentV1,
  instance: WorkspacePaneInstance,
  targetGroupId?: string,
): WorkspacePaneHostDocumentV1 {
  if (
    document.instances.length >= MAX_WORKSPACE_PANE_HOST_PANES ||
    document.instances.some((item) => item.instanceId === instance.instanceId)
  )
    return document;
  const target = findWorkspacePaneHostTabGroup(
    document.root,
    targetGroupId ??
      (document.root.type === 'tabs'
        ? document.root.id
        : (workspacePaneHostGroupContaining(
            document.root,
            document.activeInstanceId,
          )?.id ?? '')),
  );
  if (!target) return document;
  return {
    ...document,
    instances: [...document.instances, instance],
    root: updateWorkspacePaneHostNode(document.root, target.id, (node) => ({
      ...(node as WorkspacePaneHostTabGroup),
      instanceIds: [
        ...(node as WorkspacePaneHostTabGroup).instanceIds,
        instance.instanceId,
      ],
      selectedInstanceId: instance.instanceId,
    })),
    activeInstanceId: instance.instanceId,
  };
}

function commit(
  state: WorkspacePaneHostState,
  document: WorkspacePaneHostDocumentV1,
  rendererFailures = state.rendererFailures,
): WorkspacePaneHostState {
  const parsed = parseWorkspacePaneHostDocument(document);
  return parsed ? { document: parsed, rendererFailures } : state;
}

function maxDepth(node: WorkspacePaneHostNode): number {
  return node.type === 'tabs'
    ? 0
    : 1 + Math.max(maxDepth(node.first), maxDepth(node.second));
}

function nodeIds(
  node: WorkspacePaneHostNode,
  into = new Set<string>(),
): Set<string> {
  into.add(node.id);
  if (node.type === 'split') {
    nodeIds(node.first, into);
    nodeIds(node.second, into);
  }
  return into;
}

function generatedNodeId(root: WorkspacePaneHostNode, prefix: string): string {
  const ids = nodeIds(root);
  for (let index = 1; index <= MAX_WORKSPACE_PANE_HOST_PANES * 2; index += 1) {
    const id = `${prefix}-${index}`;
    if (!ids.has(id)) return id;
  }
  return '';
}

/**
 * Value equality over a restored host document. Both sides come out of
 * `parseWorkspacePaneHostDocument`, so this compares the JSON-safe data graph
 * the parser produces — no cycles, no class instances, no undefined-vs-missing
 * ambiguity to resolve. It is deliberately conservative: reporting "different"
 * for two equal documents costs exactly what the old behavior always cost.
 */
function sameWorkspacePaneHostDocument(
  left: WorkspacePaneHostDocumentV1,
  right: WorkspacePaneHostDocumentV1,
): boolean {
  return sameJsonValue(left, right);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]))
    );
  }
  if (
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    left === null ||
    right === null
  )
    return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      sameJsonValue(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  );
}

/** Pure state kernel; all actions consume an existing, server/catalog-issued instance. */
export function reduceWorkspacePaneHost(
  state: WorkspacePaneHostState,
  action: WorkspacePaneHostAction,
): WorkspacePaneHostState {
  if (action.type === 'restore') {
    const restored = restoreWorkspacePaneHostDocument(action.document);
    if (!restored.document) return state;
    // station#3795: restoring a document that is value-identical to the one
    // already held is a no-op, and must be observable as one. `restore` used
    // to hand back a freshly parsed object every time, which is a new
    // `state.document` identity — so every `[state.document]` effect ran
    // again, including the one that WRITES the document back to localStorage.
    // The lease path restores on every grant, so this fired for a document
    // nobody had changed.
    if (sameWorkspacePaneHostDocument(state.document, restored.document))
      return Object.keys(state.rendererFailures).length === 0
        ? state
        : { document: state.document, rendererFailures: {} };
    return { document: restored.document, rendererFailures: {} };
  }
  if (action.type === 'renderer-failed') {
    if (
      !state.document.instances.some(
        (item) => item.instanceId === action.instanceId,
      )
    )
      return state;
    return {
      ...state,
      rendererFailures: {
        ...state.rendererFailures,
        [action.instanceId]: action.code,
      },
    };
  }
  if (action.type === 'renderer-retry') {
    if (!(action.instanceId in state.rendererFailures)) return state;
    const { [action.instanceId]: _retrying, ...rendererFailures } =
      state.rendererFailures;
    return { ...state, rendererFailures };
  }
  const document = cloneDocument(state.document);
  if (action.type === 'add-existing-instance') {
    return commit(
      state,
      addExisting(document, action.instance, action.targetGroupId),
    );
  }
  if (action.type === 'select') {
    const group = workspacePaneHostGroupContaining(
      document.root,
      action.instanceId,
    );
    if (!group) return state;
    return commit(state, {
      ...document,
      activeInstanceId: action.instanceId,
      root: updateWorkspacePaneHostNode(document.root, group.id, (node) => ({
        ...(node as WorkspacePaneHostTabGroup),
        selectedInstanceId: action.instanceId,
      })),
    });
  }
  if (action.type === 'maximize') {
    if (
      action.instanceId !== undefined &&
      !document.instances.some((item) => item.instanceId === action.instanceId)
    )
      return state;
    const { maximizedInstanceId: _previous, ...withoutMaximized } = document;
    return commit(state, {
      ...withoutMaximized,
      ...(action.instanceId ? { maximizedInstanceId: action.instanceId } : {}),
    });
  }
  if (action.type === 'resize') {
    if (!Number.isFinite(action.ratio)) return state;
    return commit(state, {
      ...document,
      root: updateWorkspacePaneHostNode(
        document.root,
        action.splitId,
        (node) =>
          node.type === 'split'
            ? { ...node, ratio: Math.min(0.8, Math.max(0.2, action.ratio)) }
            : node,
      ),
    });
  }
  if (action.type === 'collapse') {
    return commit(state, {
      ...document,
      root: updateWorkspacePaneHostNode(
        document.root,
        action.splitId,
        (node) =>
          node.type !== 'split'
            ? node
            : action.collapsed
              ? { ...node, collapsed: action.collapsed }
              : (() => {
                  const { collapsed: _collapsed, ...uncollapsed } = node;
                  return uncollapsed;
                })(),
      ),
    });
  }
  if (action.type === 'close') {
    if (
      !document.instances.some(
        (item) => item.instanceId === action.instanceId,
      ) ||
      document.instances.length === 1
    )
      return state;
    const root = withoutWorkspacePaneHostInstance(
      document.root,
      action.instanceId,
    );
    if (!root) return state;
    const next = {
      ...document,
      root,
      instances: document.instances.filter(
        (item) => item.instanceId !== action.instanceId,
      ),
    };
    next.activeInstanceId =
      workspacePaneHostCloseSuccessor(document, action.instanceId) ??
      document.activeInstanceId;
    if (next.maximizedInstanceId === action.instanceId)
      delete next.maximizedInstanceId;
    const { [action.instanceId]: _removed, ...rendererFailures } =
      state.rendererFailures;
    return commit(state, next, rendererFailures);
  }
  if (action.type === 'reorder') {
    const group = workspacePaneHostGroupContaining(
      document.root,
      action.instanceId,
    );
    if (!group) return state;
    const items = group.instanceIds.filter((id) => id !== action.instanceId);
    const instanceIds = insertAt(items, action.instanceId, action.toIndex);
    return commit(state, {
      ...document,
      root: updateWorkspacePaneHostNode(document.root, group.id, (node) => ({
        ...(node as WorkspacePaneHostTabGroup),
        instanceIds,
        selectedInstanceId:
          (node as WorkspacePaneHostTabGroup).selectedInstanceId ??
          instanceIds[0],
      })),
    });
  }
  if (action.type === 'move') {
    const source = workspacePaneHostGroupContaining(
      document.root,
      action.instanceId,
    );
    const target = findWorkspacePaneHostTabGroup(
      document.root,
      action.targetGroupId,
    );
    if (!source || !target) return state;
    if (source.id === target.id)
      return reduceWorkspacePaneHost(state, {
        type: 'reorder',
        instanceId: action.instanceId,
        toIndex: action.index ?? source.instanceIds.length - 1,
      });
    const without = withoutWorkspacePaneHostInstance(
      document.root,
      action.instanceId,
    );
    if (!without) return state;
    const liveTarget = findWorkspacePaneHostTabGroup(
      without,
      action.targetGroupId,
    );
    if (!liveTarget) return state;
    return commit(state, {
      ...document,
      root: updateWorkspacePaneHostNode(without, liveTarget.id, (node) => ({
        ...(node as WorkspacePaneHostTabGroup),
        instanceIds: insertAt(
          (node as WorkspacePaneHostTabGroup).instanceIds,
          action.instanceId,
          action.index,
        ),
        selectedInstanceId:
          document.activeInstanceId === action.instanceId
            ? action.instanceId
            : ((node as WorkspacePaneHostTabGroup).selectedInstanceId ??
              (node as WorkspacePaneHostTabGroup).instanceIds[0]),
      })),
    });
  }
  if (action.type === 'split') {
    if (
      document.instances.length >= MAX_WORKSPACE_PANE_HOST_PANES ||
      document.instances.some(
        (item) => item.instanceId === action.instance.instanceId,
      )
    )
      return state;
    const target = findWorkspacePaneHostTabGroup(
      document.root,
      action.targetGroupId,
    );
    if (
      !target ||
      maxDepth(document.root) >= MAX_WORKSPACE_PANE_HOST_TREE_DEPTH
    )
      return state;
    const id = generatedNodeId(document.root, 'split');
    const groupId = generatedNodeId(document.root, 'tabs');
    if (!id || !groupId) return state;
    const newGroup: WorkspacePaneHostTabGroup = {
      type: 'tabs',
      id: groupId,
      instanceIds: [action.instance.instanceId],
      selectedInstanceId: action.instance.instanceId,
    };
    const split: WorkspacePaneHostSplit = {
      type: 'split',
      id,
      orientation: action.orientation,
      ratio: 0.5,
      first: action.placement === 'before' ? newGroup : target,
      second: action.placement === 'before' ? target : newGroup,
    };
    return commit(state, {
      ...document,
      instances: [...document.instances, action.instance],
      root: replaceWorkspacePaneHostNode(document.root, target.id, split),
      activeInstanceId: action.instance.instanceId,
    });
  }
  return state;
}
