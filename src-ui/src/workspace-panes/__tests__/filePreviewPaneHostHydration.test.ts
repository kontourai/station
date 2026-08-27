import { parseWorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { expect, test } from 'vitest';
import {
  admitRestoredFilePreviewPaneInstance,
  createFilePreviewPaneInstance,
} from '../filePreviewPaneInstance';
import { writeFilePreviewPaneState } from '../filePreviewPaneStateStorage';
import {
  hydrateWorkspacePaneHost,
  workspacePaneHostStorageKey,
} from '../workspacePaneHostStorage';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
  };
}

test('host hydration retains admitted File Preview siblings', () => {
  const target = storage();
  const projectId = 'project-uuid';
  const scope = {
    kind: 'project' as const,
    projectId,
    layoutId: 'coding',
  };
  const coding = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: 'builtin:coding',
    instanceId: 'coding',
    stateKey: 'coding',
    boundContext: { projectId, sourceId: 'builtin:coding' },
  })!;
  const preview = createFilePreviewPaneInstance(
    {
      version: '1.0',
      projectSlug: 'demo',
      path: 'src/main.ts',
      wrap: true,
    },
    projectId,
    'a'.repeat(32),
  )!;
  expect(
    writeFilePreviewPaneState(target, preview.stateKey, {
      version: '1.0',
      projectSlug: 'demo',
      path: 'src/main.ts',
      wrap: true,
    }),
  ).toBe(true);
  target.setItem(
    workspacePaneHostStorageKey(scope, 'coding-host'),
    JSON.stringify({
      version: '1.1',
      id: 'coding-host',
      scope,
      instances: [coding, preview],
      root: {
        type: 'tabs',
        id: 'root',
        instanceIds: [coding.instanceId, preview.instanceId],
        selectedInstanceId: preview.instanceId,
      },
      activeInstanceId: preview.instanceId,
    }),
  );

  const hydrated = hydrateWorkspacePaneHost(
    target,
    scope,
    'coding-host',
    [coding],
    (candidate) =>
      admitRestoredFilePreviewPaneInstance(
        projectId,
        'demo',
        candidate,
        target,
      ),
  );
  expect(hydrated.document?.instances).toHaveLength(2);
  expect(hydrated.document?.activeInstanceId).toBe(preview.instanceId);
});

test('host hydration discards a pre-bump document instead of salvaging known panes', () => {
  const target = storage();
  const scope = {
    kind: 'project' as const,
    projectId: 'project-uuid',
    layoutId: 'coding',
  };
  const known = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: 'builtin:coding',
    instanceId: 'coding',
    stateKey: 'coding',
    boundContext: { projectId: scope.projectId, sourceId: 'builtin:coding' },
  })!;
  const unknown = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: 'builtin:unknown',
    instanceId: 'unknown',
    stateKey: 'unknown',
    boundContext: { projectId: scope.projectId, sourceId: 'builtin:unknown' },
  })!;
  target.setItem(
    workspacePaneHostStorageKey(scope, 'coding-host'),
    JSON.stringify({
      version: '1.0',
      id: 'coding-host',
      scope,
      instances: [known, unknown],
      root: {
        type: 'tabs',
        id: 'root',
        instanceIds: [known.instanceId, unknown.instanceId],
        selectedInstanceId: known.instanceId,
      },
      activeInstanceId: known.instanceId,
    }),
  );

  const hydrated = hydrateWorkspacePaneHost(target, scope, 'coding-host', [
    known,
  ]);

  // A null document makes the host use its code-owned working defaults; the
  // catalog-known pane above must not be salvaged from the rejected schema.
  expect(hydrated.document).toBeNull();
  expect(hydrated.failures).toEqual([{ code: 'invalid-document' }]);
});

test('a corrupt preview state removes only that dynamic sibling during hydration', () => {
  const target = storage();
  const scope = {
    kind: 'project' as const,
    projectId: 'demo',
    layoutId: 'coding',
  };
  const coding = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: 'builtin:coding',
    instanceId: 'coding',
    stateKey: 'coding',
    boundContext: { projectId: 'demo', sourceId: 'builtin:coding' },
  })!;
  const preview = createFilePreviewPaneInstance(
    {
      version: '1.0',
      projectSlug: 'demo',
      path: 'src/main.ts',
      wrap: true,
    },
    'demo',
    'b'.repeat(32),
  )!;
  target.setItem(
    workspacePaneHostStorageKey(scope, 'coding-host'),
    JSON.stringify({
      version: '1.1',
      id: 'coding-host',
      scope,
      instances: [coding, preview],
      root: {
        type: 'tabs',
        id: 'root',
        instanceIds: [coding.instanceId, preview.instanceId],
        selectedInstanceId: preview.instanceId,
      },
      activeInstanceId: preview.instanceId,
    }),
  );

  const hydrated = hydrateWorkspacePaneHost(
    target,
    scope,
    'coding-host',
    [coding],
    (candidate) =>
      admitRestoredFilePreviewPaneInstance('demo', 'demo', candidate, target),
  );
  expect(hydrated.document?.instances).toEqual([coding]);
  expect(
    hydrated.failures.some((failure) => failure.code === 'unknown-instance'),
  ).toBe(true);
});
