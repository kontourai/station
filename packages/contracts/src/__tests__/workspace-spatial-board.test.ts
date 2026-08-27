import { describe, expect, test } from 'vitest';
import { isWorkspaceHomeRoleEligibleDescriptor } from '../workspace-home-role.js';
import {
  createWorkspaceSpatialBoardPaneInstance,
  isCanonicalWorkspaceSpatialBoardDescriptor,
  isCanonicalWorkspaceSpatialBoardPaneInstance,
  WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR,
} from '../workspace-spatial-board.js';

describe('spatial board Workspace Pane contract', () => {
  test('declares one Project-hosted first-party Pane without Home selection', () => {
    expect(WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR).toMatchObject({
      renderer: {
        kind: 'builtin-component',
        name: 'workspace-spatial-board',
      },
      modes: [{ id: 'default', contextRequirement: { project: true } }],
      provenance: { origin: 'builtin' },
      lifecycle: { stage: 'preview' },
    });
    expect(
      WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR.placement.supportedRegions,
    ).toContain('standalone');
    expect(
      isWorkspaceHomeRoleEligibleDescriptor(
        WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR,
      ),
    ).toBe(false);
  });

  test('issues and verifies exact Project-hosted occurrences', () => {
    const instance = createWorkspaceSpatialBoardPaneInstance('project-a');
    expect(instance).not.toBeNull();
    if (!instance) throw new Error('expected spatial board instance');
    expect(isCanonicalWorkspaceSpatialBoardPaneInstance(instance)).toBe(true);
    expect(
      isCanonicalWorkspaceSpatialBoardPaneInstance({
        ...instance,
        stateKey: 'forged' as typeof instance.stateKey,
      }),
    ).toBe(false);
    expect(
      isCanonicalWorkspaceSpatialBoardDescriptor(
        WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR,
      ),
    ).toBe(true);
  });
});
