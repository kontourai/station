import { parseWorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  flattenWorkspacePaneHost,
  MAX_WORKSPACE_PANE_HOST_PANES,
  parseWorkspacePaneHostDocument,
  type WorkspacePaneHostDocumentV1,
} from '@kontourai/station-contracts/workspace-pane-host';
import { describe, expect, test } from 'vitest';
import {
  reduceWorkspacePaneHost,
  type WorkspacePaneHostState,
} from '../workspacePaneHostReducer';

function instance(id: string) {
  return parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: `descriptor-${id}`,
    instanceId: id,
    stateKey: `state-${id}`,
  })!;
}
function state(): WorkspacePaneHostState {
  const one = instance('one');
  const two = instance('two');
  const document: WorkspacePaneHostDocumentV1 = {
    version: '1.1',
    id: 'host',
    scope: {
      kind: 'task',
      projectId: 'project',
      taskId: 'task',
      layoutId: 'layout',
    },
    instances: [one, two],
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: [one.instanceId, two.instanceId],
    },
    activeInstanceId: one.instanceId,
  };
  return { document, rendererFailures: {} };
}

describe('Workspace Pane host reducer', () => {
  test('keeps exact existing identities through add, reorder, split, move, resize, collapse, select, maximize, and close', () => {
    const three = instance('three');
    let current = reduceWorkspacePaneHost(state(), {
      type: 'add-existing-instance',
      instance: three,
    });
    current = reduceWorkspacePaneHost(current, {
      type: 'reorder',
      instanceId: three.instanceId,
      toIndex: 0,
    });
    current = reduceWorkspacePaneHost(current, {
      type: 'split',
      instance: instance('four'),
      targetGroupId: 'root',
      orientation: 'vertical',
      placement: 'after',
    });
    const splitId =
      current.document.root.type === 'split' ? current.document.root.id : '';
    const targetId =
      current.document.root.type === 'split' &&
      current.document.root.second.type === 'tabs'
        ? current.document.root.second.id
        : '';
    current = reduceWorkspacePaneHost(current, {
      type: 'move',
      instanceId: three.instanceId,
      targetGroupId: targetId,
    });
    current = reduceWorkspacePaneHost(current, {
      type: 'resize',
      splitId,
      ratio: 2,
    });
    current = reduceWorkspacePaneHost(current, {
      type: 'collapse',
      splitId,
      collapsed: 'second',
    });
    current = reduceWorkspacePaneHost(current, {
      type: 'select',
      instanceId: three.instanceId,
    });
    current = reduceWorkspacePaneHost(current, {
      type: 'maximize',
      instanceId: three.instanceId,
    });
    current = reduceWorkspacePaneHost(current, {
      type: 'close',
      instanceId: instance('one').instanceId,
    });
    current = reduceWorkspacePaneHost(current, {
      type: 'restore',
      document: current.document,
    });
    expect(flattenWorkspacePaneHost(current.document.root)).toEqual(
      expect.arrayContaining([
        instance('two').instanceId,
        three.instanceId,
        instance('four').instanceId,
      ]),
    );
    expect(new Set(flattenWorkspacePaneHost(current.document.root)).size).toBe(
      current.document.instances.length,
    );
    expect(current.document.activeInstanceId).toBe(three.instanceId);
    expect(current.document.maximizedInstanceId).toBe(three.instanceId);
    expect(
      current.document.root.type === 'split' && current.document.root.ratio,
    ).toBe(0.8);
  });

  test('records a renderer failure locally without disposing or changing siblings', () => {
    const before = state();
    const after = reduceWorkspacePaneHost(before, {
      type: 'renderer-failed',
      instanceId: instance('one').instanceId,
      code: 'crashed',
    });
    expect(after.document).toBe(before.document);
    expect(after.rendererFailures).toEqual({ one: 'crashed' });
  });

  test('keeps per-group selection independent from focused navigation identity', () => {
    const split = reduceWorkspacePaneHost(state(), {
      type: 'split',
      instance: instance('three'),
      targetGroupId: 'root',
      orientation: 'horizontal',
      placement: 'after',
    });
    const root = split.document.root;
    if (
      root.type !== 'split' ||
      root.first.type !== 'tabs' ||
      root.second.type !== 'tabs'
    )
      throw new Error('expected split');
    let current = reduceWorkspacePaneHost(split, {
      type: 'select',
      instanceId: instance('two').instanceId,
    });
    expect(current.document.activeInstanceId).toBe('two');
    expect((current.document.root as any).first.selectedInstanceId).toBe('two');
    expect((current.document.root as any).second.selectedInstanceId).toBe(
      'three',
    );
    current = reduceWorkspacePaneHost(current, {
      type: 'close',
      instanceId: instance('two').instanceId,
    });
    expect((current.document.root as any).first.selectedInstanceId).toBe('one');
  });

  test('rejects a 25th pane, NaN resize, excessive split depth, and clears collapse', () => {
    let current = state();
    for (let index = 3; index <= MAX_WORKSPACE_PANE_HOST_PANES; index += 1) {
      current = reduceWorkspacePaneHost(current, {
        type: 'add-existing-instance',
        instance: instance(`pane-${index}`),
      });
    }
    const full = current;
    expect(full.document.instances).toHaveLength(MAX_WORKSPACE_PANE_HOST_PANES);
    expect(flattenWorkspacePaneHost(full.document.root)).toHaveLength(
      MAX_WORKSPACE_PANE_HOST_PANES,
    );
    current = reduceWorkspacePaneHost(current, {
      type: 'add-existing-instance',
      instance: instance('pane-25'),
    });
    expect(current).toEqual(full);
    current = reduceWorkspacePaneHost(current, {
      type: 'resize',
      splitId: 'missing',
      ratio: Number.NaN,
    });
    expect(current).toEqual(full);

    const deepestTabs = (
      node: WorkspacePaneHostState['document']['root'],
    ): string => (node.type === 'tabs' ? node.id : deepestTabs(node.first));
    let splitState = state();
    for (let index = 0; index < 6; index += 1) {
      splitState = reduceWorkspacePaneHost(splitState, {
        type: 'split',
        instance: instance(`depth-${index}`),
        targetGroupId: deepestTabs(splitState.document.root),
        orientation: 'horizontal',
        placement: 'after',
      });
    }
    const atDepthLimit = splitState;
    splitState = reduceWorkspacePaneHost(splitState, {
      type: 'split',
      instance: instance('too-deep'),
      targetGroupId: deepestTabs(splitState.document.root),
      orientation: 'horizontal',
      placement: 'after',
    });
    expect(splitState).toEqual(atDepthLimit);

    const split = reduceWorkspacePaneHost(state(), {
      type: 'split',
      instance: instance('collapse'),
      targetGroupId: 'root',
      orientation: 'vertical',
      placement: 'after',
    });
    const splitId =
      split.document.root.type === 'split' ? split.document.root.id : '';
    const collapsed = reduceWorkspacePaneHost(split, {
      type: 'collapse',
      splitId,
      collapsed: 'first',
    });
    const uncollapsed = reduceWorkspacePaneHost(collapsed, {
      type: 'collapse',
      splitId,
      collapsed: undefined,
    });
    expect(
      uncollapsed.document.root.type === 'split' &&
        uncollapsed.document.root.collapsed,
    ).toBeUndefined();
    expect(parseWorkspacePaneHostDocument(uncollapsed.document)).not.toBeNull();

    const collisionTarget =
      split.document.root.type === 'split' &&
      split.document.root.first.type === 'tabs'
        ? split.document.root.first.id
        : '';
    const collision = reduceWorkspacePaneHost(split, {
      type: 'split',
      instance: instance('collision'),
      targetGroupId: collisionTarget,
      orientation: 'vertical',
      placement: 'after',
    });
    const collectNodeIds = (
      node: WorkspacePaneHostState['document']['root'],
    ): string[] =>
      node.type === 'tabs'
        ? [node.id]
        : [
            node.id,
            ...collectNodeIds(node.first),
            ...collectNodeIds(node.second),
          ];
    const ids = collectNodeIds(collision.document.root);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * station#3795: `restore` re-parses, so restoring the document already held
 * used to mint a new identity — invalidating every `[state.document]` effect
 * in the host, one of which writes the document to localStorage. The lease
 * path restores on every grant, so that write fired for a document nobody had
 * changed. An idempotent restore is identity-preserving.
 */
test('a value-identical restore keeps the document identity it already had', () => {
  // Restore once so the held document is the parser's own normalized shape —
  // which is what the lease path holds, and what it restores again on every
  // grant. A hand-built fixture is not that shape (the parser fills in
  // `selectedInstanceId`), and this must not report identity for a document
  // that genuinely differs from the one held.
  const initial = reduceWorkspacePaneHost(state(), {
    type: 'restore',
    document: state().document,
  });
  const restored = reduceWorkspacePaneHost(initial, {
    type: 'restore',
    document: JSON.parse(
      JSON.stringify(initial.document),
    ) as WorkspacePaneHostDocumentV1,
  });

  expect(restored).toBe(initial);
  expect(restored.document).toBe(initial.document);
});

test('a restore that genuinely differs still replaces the document', () => {
  const initial = reduceWorkspacePaneHost(state(), {
    type: 'restore',
    document: state().document,
  });
  const moved: WorkspacePaneHostDocumentV1 = {
    ...initial.document,
    activeInstanceId: instance('two').instanceId,
  };

  const restored = reduceWorkspacePaneHost(initial, {
    type: 'restore',
    document: moved,
  });

  expect(restored.document).not.toBe(initial.document);
  expect(restored.document.activeInstanceId).toBe(instance('two').instanceId);
});
