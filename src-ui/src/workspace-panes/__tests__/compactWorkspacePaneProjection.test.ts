import { parseWorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneHostDocumentV1 } from '@kontourai/station-contracts/workspace-pane-host';
import { expect, test } from 'vitest';
import {
  projectCompactWorkspacePaneHost,
  visibleWorkspacePaneHostInstanceIds,
} from '../compactWorkspacePaneProjection';

test('compact projection preserves order and mounts only the active compatible pane', () => {
  const one = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: 'one',
    instanceId: 'one',
    stateKey: 'one',
  })!;
  const two = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: 'two',
    instanceId: 'two',
    stateKey: 'two',
  })!;
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
    activeInstanceId: two.instanceId,
  };
  expect(projectCompactWorkspacePaneHost(document)).toMatchObject({
    activeInstanceId: two.instanceId,
    mountInstanceIds: [two.instanceId],
    tabs: [
      { instanceId: one.instanceId, selected: false, mount: false },
      { instanceId: two.instanceId, selected: true, mount: true },
    ],
  });
  expect(
    projectCompactWorkspacePaneHost(document, new Set([two.instanceId]))
      .mountInstanceIds,
  ).toEqual([]);
});

test('desktop visibility keeps one selected pane per uncollapsed group', () => {
  const one = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: 'one',
    instanceId: 'one',
    stateKey: 'one',
  })!;
  const two = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: 'two',
    instanceId: 'two',
    stateKey: 'two',
  })!;
  const three = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: 'three',
    instanceId: 'three',
    stateKey: 'three',
  })!;
  const document = {
    version: '1.1' as const,
    id: 'host',
    scope: {
      kind: 'project' as const,
      projectId: 'project',
      layoutId: 'layout',
    },
    instances: [one, two, three],
    activeInstanceId: one.instanceId,
    root: {
      type: 'split' as const,
      id: 'split',
      orientation: 'horizontal' as const,
      ratio: 0.5,
      first: {
        type: 'tabs' as const,
        id: 'first',
        instanceIds: [one.instanceId, two.instanceId],
        selectedInstanceId: two.instanceId,
      },
      second: {
        type: 'tabs' as const,
        id: 'second',
        instanceIds: [three.instanceId],
        selectedInstanceId: three.instanceId,
      },
    },
  };
  expect(visibleWorkspacePaneHostInstanceIds(document)).toEqual([
    two.instanceId,
    three.instanceId,
  ]);
  expect(
    visibleWorkspacePaneHostInstanceIds({
      ...document,
      root: { ...document.root, collapsed: 'second' },
    }),
  ).toEqual([two.instanceId]);
  expect(
    visibleWorkspacePaneHostInstanceIds({
      ...document,
      maximizedInstanceId: one.instanceId,
    }),
  ).toEqual([one.instanceId]);
});
