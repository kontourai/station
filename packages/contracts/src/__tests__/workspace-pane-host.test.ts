import { describe, expect, test, vi } from 'vitest';
import { parseWorkspacePaneInstance } from '../workspace-pane';
import {
  createWorkspacePaneHostBaselineDocument,
  MAX_WORKSPACE_PANE_HOST_PANES,
  MAX_WORKSPACE_PANE_HOST_RECOVERY_INPUT_ITEMS,
  MAX_WORKSPACE_PANE_HOST_TREE_DEPTH,
  parseWorkspacePaneHostDocument,
  restoreWorkspacePaneHostDocument,
  WORKSPACE_PANE_HOST_DOCUMENT_VERSION,
  workspacePaneHostSuppliableContexts,
} from '../workspace-pane-host';

function instance(id: string) {
  return parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: `descriptor-${id}`,
    instanceId: id,
    stateKey: `state-${id}`,
  })!;
}

function documentWith(...instances: ReturnType<typeof instance>[]) {
  return {
    version: WORKSPACE_PANE_HOST_DOCUMENT_VERSION,
    id: 'host',
    scope: {
      kind: 'task',
      projectId: 'project',
      taskId: 'task',
      layoutId: 'layout',
    },
    instances,
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: instances.map((item) => item.instanceId),
    },
    activeInstanceId: instances[0].instanceId,
  };
}

function fullyBoundInstance(id: string) {
  return parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: `descriptor-${id}`,
    instanceId: id,
    stateKey: `state-${id}`,
    boundContext: {
      projectId: `project-${id}`,
      taskId: `task-${id}`,
      sessionId: `session-${id}`,
      runId: `run-${id}`,
      workspaceId: `workspace-${id}`,
      sourceId: `source-${id}`,
    },
  })!;
}

interface RawTabsNode {
  type: 'tabs';
  id: string;
  instanceIds: string[];
}

interface RawSplitNode {
  type: 'split';
  id: string;
  orientation: 'horizontal' | 'vertical';
  ratio: number;
  collapsed?: 'first' | 'second';
  first: RawHostNode;
  second: RawHostNode;
}

type RawHostNode = RawTabsNode | RawSplitNode;

function deepestLegalTree(instanceIds: readonly string[]): RawHostNode {
  let group = 0;
  let split = 0;
  const tabs = (ids: readonly string[]): RawTabsNode => ({
    type: 'tabs',
    id: `group-${group++}`,
    instanceIds: [...ids],
  });
  const balanced = (ids: readonly string[]): RawHostNode => {
    if (ids.length === 1) return tabs(ids);
    const middle = Math.floor(ids.length / 2);
    return {
      type: 'split',
      id: `split-${split++}`,
      orientation: 'horizontal',
      ratio: 0.5,
      collapsed: 'first',
      first: balanced(ids.slice(0, middle)),
      second: balanced(ids.slice(middle)),
    };
  };
  return {
    type: 'split',
    id: `split-${split++}`,
    orientation: 'vertical',
    ratio: 0.5,
    collapsed: 'second',
    first: tabs(instanceIds.slice(0, 1)),
    second: balanced(instanceIds.slice(1)),
  };
}

function overDepthTree(instanceIds: readonly string[]): RawHostNode {
  let node: RawHostNode = {
    type: 'tabs',
    id: 'group-0',
    instanceIds: [instanceIds[0]],
  };
  for (
    let index = 1;
    index <= MAX_WORKSPACE_PANE_HOST_TREE_DEPTH + 1;
    index += 1
  ) {
    node = {
      type: 'split',
      id: `split-${index}`,
      orientation: 'horizontal',
      ratio: 0.5,
      first: node,
      second: {
        type: 'tabs',
        id: `group-${index}`,
        instanceIds: [instanceIds[index]],
      },
    };
  }
  return node;
}

describe('Workspace Pane host document', () => {
  test('derives only identities actually bound by each host scope', () => {
    expect(workspacePaneHostSuppliableContexts({ kind: 'ambient' })).toEqual(
      new Set(),
    );
    expect(
      workspacePaneHostSuppliableContexts({
        kind: 'project',
        projectId: 'project',
        layoutId: 'layout',
      }),
    ).toEqual(new Set(['project']));
    expect(
      workspacePaneHostSuppliableContexts({
        kind: 'task',
        projectId: 'project',
        taskId: 'task',
        layoutId: 'layout',
      }),
    ).toEqual(new Set(['project', 'task']));
  });

  test('parses exact existing instance identities and bounded geometry', () => {
    const first = instance('one');
    const second = instance('two');
    const parsed = parseWorkspacePaneHostDocument(documentWith(first, second));
    expect(parsed).toMatchObject({
      version: WORKSPACE_PANE_HOST_DOCUMENT_VERSION,
      activeInstanceId: first.instanceId,
      instances: [first, second],
      root: { selectedInstanceId: first.instanceId },
    });
    expect(
      parseWorkspacePaneHostDocument({
        ...documentWith(first),
        version: '1.0',
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneHostDocument({
        ...documentWith(first),
        version: '2.0',
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneHostDocument({
        ...documentWith(first),
        instances: Array.from(
          { length: MAX_WORKSPACE_PANE_HOST_PANES + 1 },
          () => first,
        ),
      }),
    ).toBeNull();
  });

  test('normalizes old group documents and locally recovers an invalid group selection', () => {
    const first = instance('one');
    const second = instance('two');
    expect(
      parseWorkspacePaneHostDocument(documentWith(first, second))?.root,
    ).toMatchObject({
      selectedInstanceId: first.instanceId,
    });
    const restored = restoreWorkspacePaneHostDocument({
      ...documentWith(first, second),
      root: {
        type: 'tabs',
        id: 'root',
        instanceIds: [first.instanceId, second.instanceId],
        selectedInstanceId: 'missing',
      },
    });
    expect(restored.document?.root).toMatchObject({
      selectedInstanceId: first.instanceId,
    });
    expect(restored.failures).toContainEqual({
      code: 'invalid-selection',
      nodeId: 'root',
    });
  });

  test('rejects duplicate/orphan placements and unsafe ratios', () => {
    const first = instance('one');
    const second = instance('two');
    expect(
      parseWorkspacePaneHostDocument({
        ...documentWith(first, second),
        root: {
          type: 'tabs',
          id: 'root',
          instanceIds: [first.instanceId, first.instanceId],
        },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneHostDocument({
        ...documentWith(first, second),
        root: { type: 'tabs', id: 'root', instanceIds: [first.instanceId] },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneHostDocument({
        ...documentWith(first, second),
        root: {
          type: 'split',
          id: 'root',
          orientation: 'vertical',
          ratio: 0.1,
          first: { type: 'tabs', id: 'a', instanceIds: [first.instanceId] },
          second: { type: 'tabs', id: 'b', instanceIds: [second.instanceId] },
        },
      }),
    ).toBeNull();
  });

  test('rejects accessor-bearing data without evaluating the accessor', () => {
    const first = instance('one');
    const candidate = documentWith(first);
    const getter = vi.fn(() => '1.0');
    Object.defineProperty(candidate, 'version', {
      enumerable: true,
      get: getter,
    });
    expect(parseWorkspacePaneHostDocument(candidate)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  test('quarantines a malformed child and keeps its valid sibling', () => {
    const first = instance('one');
    const second = instance('two');
    const restored = restoreWorkspacePaneHostDocument(
      {
        ...documentWith(first, second),
        root: {
          type: 'split',
          id: 'root',
          orientation: 'horizontal',
          ratio: 0.5,
          first: { type: 'tabs', id: 'valid', instanceIds: [first.instanceId] },
          second: { type: 'tabs', id: 'bad', instanceIds: ['missing'] },
        },
        activeInstanceId: 'missing',
      },
      [first, second],
    );
    expect(restored.document).not.toBeNull();
    expect(restored.document!.root).toEqual({
      type: 'tabs',
      id: 'valid',
      instanceIds: [first.instanceId],
      selectedInstanceId: first.instanceId,
    });
    expect(restored.document!.instances).toEqual([first]);
    expect(restored.failures.map((failure) => failure.code)).toContain(
      'empty-group',
    );
    expect(restored.document!.activeInstanceId).toBe(first.instanceId);
  });

  test('uses catalog-issued records instead of trusting a changed persisted identity', () => {
    const first = instance('one');
    const restored = restoreWorkspacePaneHostDocument(
      {
        ...documentWith(first),
        instances: [
          {
            version: '1.0',
            descriptorId: 'descriptor-one',
            instanceId: 'one',
            stateKey: 'different-state',
          },
        ],
      },
      [first],
    );
    expect(restored.document).not.toBeNull();
    expect(restored.document!.instances).toEqual([first]);
    expect(restored.failures.map((failure) => failure.code)).toContain(
      'unknown-instance',
    );
  });

  test('treats an explicit empty catalog as authoritative', () => {
    const first = instance('one');
    expect(
      restoreWorkspacePaneHostDocument(documentWith(first), []),
    ).toMatchObject({
      document: null,
      failures: [{ code: 'invalid-instance' }],
    });
    expect(
      restoreWorkspacePaneHostDocument(documentWith(first)).document,
    ).not.toBeNull();
  });

  test('supports Project/Layout scope and substitutes the complete catalog instance', () => {
    const first = instance('one');
    const catalog = {
      ...first,
      boundContext: { projectId: 'catalog-project' },
    };
    const restored = restoreWorkspacePaneHostDocument(
      {
        ...documentWith(first),
        scope: { kind: 'project', projectId: 'project', layoutId: 'layout' },
        instances: [
          { ...first, boundContext: { projectId: 'persisted-project' } },
        ],
      },
      [catalog],
    );
    expect(restored.document?.scope).toEqual({
      kind: 'project',
      projectId: 'project',
      layoutId: 'layout',
    });
    expect(restored.document?.instances).toEqual([catalog]);
  });

  test('is non-throwing and returns no document when recovery has no valid instance', () => {
    expect(
      restoreWorkspacePaneHostDocument({
        version: '1.0',
        id: 'host',
        scope: { kind: 'project', projectId: 'project', layoutId: 'layout' },
        instances: [],
        root: null,
        activeInstanceId: 'missing',
      }),
    ).toMatchObject({ document: null });
  });

  test('bounds host identity segments used by scope and documents', () => {
    const first = instance('one');
    expect(
      parseWorkspacePaneHostDocument({
        ...documentWith(first),
        id: 'x'.repeat(129),
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneHostDocument({
        ...documentWith(first),
        scope: {
          kind: 'project',
          projectId: 'x'.repeat(129),
          layoutId: 'layout',
        },
      }),
    ).toBeNull();
  });

  test('accepts the full 24-pane host capacity and rejects 25 panes or over-depth trees', () => {
    const full = Array.from(
      { length: MAX_WORKSPACE_PANE_HOST_PANES },
      (_, index) => fullyBoundInstance(`pane-${index}`),
    );
    expect(
      parseWorkspacePaneHostDocument(documentWith(...full)),
    ).not.toBeNull();
    expect(
      parseWorkspacePaneHostDocument({
        ...documentWith(...full),
        root: deepestLegalTree(full.map((item) => item.instanceId)),
        maximizedInstanceId: full.at(-1)!.instanceId,
      }),
    ).not.toBeNull();
    expect(
      parseWorkspacePaneHostDocument(
        documentWith(
          ...Array.from(
            { length: MAX_WORKSPACE_PANE_HOST_PANES + 1 },
            (_, index) => instance(`too-many-${index}`),
          ),
        ),
      ),
    ).toBeNull();
    expect(
      parseWorkspacePaneHostDocument({
        ...documentWith(
          ...Array.from(
            { length: MAX_WORKSPACE_PANE_HOST_TREE_DEPTH + 2 },
            (_, index) => instance(`deep-${index}`),
          ),
        ),
        root: overDepthTree(
          Array.from(
            { length: MAX_WORKSPACE_PANE_HOST_TREE_DEPTH + 2 },
            (_, index) => `deep-${index}`,
          ),
        ),
      }),
    ).toBeNull();
  });

  test('rejects hostile aggregate and wide recovery input beyond the derived bound', () => {
    const candidate = {
      ...documentWith(instance('one')),
      instances: Array.from(
        { length: MAX_WORKSPACE_PANE_HOST_RECOVERY_INPUT_ITEMS + 1 },
        () => ({ version: '1.0' }),
      ),
    };
    expect(restoreWorkspacePaneHostDocument(candidate)).toMatchObject({
      document: null,
    });
    const aggregate = documentWith(instance('aggregate')) as Record<
      string,
      unknown
    >;
    for (let index = 0; index < 7; index += 1) {
      aggregate[`extra-${index}`] = Object.fromEntries(
        Array.from(
          { length: MAX_WORKSPACE_PANE_HOST_RECOVERY_INPUT_ITEMS / 6 },
          (_, property) => [`property-${property}`, property],
        ),
      );
    }
    expect(parseWorkspacePaneHostDocument(aggregate)).toBeNull();
  });

  test('accepts exactly the derived graph-work bound and rejects one more item', () => {
    const exact = Object.assign(
      documentWith(instance('one')),
      Object.fromEntries(
        Array.from(
          { length: MAX_WORKSPACE_PANE_HOST_RECOVERY_INPUT_ITEMS - 25 },
          (_, index) => [`unused-${index}`, index],
        ),
      ),
    );
    const over = { ...exact, 'unused-over': true };
    expect(parseWorkspacePaneHostDocument(exact)).not.toBeNull();
    expect(parseWorkspacePaneHostDocument(over)).toBeNull();
  });

  test('rejects 15k properties before inspecting their descriptor values', () => {
    const candidate = documentWith(instance('one'));
    const getter = vi.fn(() => 'unreachable');
    for (let index = 0; index < 15_000; index += 1) {
      Object.defineProperty(candidate, `unused-${index}`, {
        enumerable: true,
        get: getter,
      });
    }
    expect(parseWorkspacePaneHostDocument(candidate)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  test('fails closed for a provided all-invalid catalog and reconstructs a later valid record', () => {
    const valid = instance('valid');
    const invalid = {
      ...instance('invalid'),
      boundContext: { projectId: 'x'.repeat(129) },
    };
    expect(
      restoreWorkspacePaneHostDocument(documentWith(valid), [invalid]),
    ).toMatchObject({ document: null });
    expect(
      createWorkspacePaneHostBaselineDocument(
        'host',
        { kind: 'project', projectId: 'project', layoutId: 'layout' },
        [invalid, valid],
      ),
    ).toMatchObject({ activeInstanceId: valid.instanceId });

    const second = instance('second');
    expect(
      createWorkspacePaneHostBaselineDocument(
        'host',
        { kind: 'project', projectId: 'project', layoutId: 'layout' },
        [valid, second],
      ),
    ).toMatchObject({
      instances: [valid, second],
      root: {
        type: 'tabs',
        instanceIds: [valid.instanceId, second.instanceId],
      },
    });
  });
});
