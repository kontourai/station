import { describe, expect, test } from 'vitest';
import {
  createWorkspacePlanPaneInstance,
  createWorkspaceReadinessPaneInstance,
  createWorkspaceTrustPaneInstance,
  isCanonicalWorkspacePlanPaneInstance,
  isCanonicalWorkspaceReadinessPaneInstance,
  isCanonicalWorkspaceTrustPaneInstance,
  WORKSPACE_PLAN_PANE_DESCRIPTOR,
  WORKSPACE_READINESS_PANE_DESCRIPTOR,
  WORKSPACE_TRUST_PANE_DESCRIPTOR,
} from '../workspace-evidence-panels';

describe('Workspace evidence panels', () => {
  test.each([
    [
      'Plan',
      WORKSPACE_PLAN_PANE_DESCRIPTOR,
      createWorkspacePlanPaneInstance,
      isCanonicalWorkspacePlanPaneInstance,
    ],
    [
      'Readiness',
      WORKSPACE_READINESS_PANE_DESCRIPTOR,
      createWorkspaceReadinessPaneInstance,
      isCanonicalWorkspaceReadinessPaneInstance,
    ],
    [
      'Trust',
      WORKSPACE_TRUST_PANE_DESCRIPTOR,
      createWorkspaceTrustPaneInstance,
      isCanonicalWorkspaceTrustPaneInstance,
    ],
  ] as const)(
    '%s issues only one exact Project projection',
    (_name, descriptor, createInstance, isCanonical) => {
      const instance = createInstance('project-a');

      expect(instance).toEqual({
        version: '1.0',
        descriptorId: descriptor.id,
        instanceId: expect.any(String),
        stateKey: expect.any(String),
        boundContext: {
          projectId: 'project-a',
          workspaceId: 'project-a',
          sourceId: expect.stringMatching(/^builtin:workspace-/),
        },
      });
      expect(isCanonical(instance!)).toBe(true);
      expect(
        isCanonical({
          ...instance!,
          boundContext: { ...instance!.boundContext, workspaceId: 'other' },
        }),
      ).toBe(false);
      expect(instance!.boundContext?.taskId).toBeUndefined();
      expect(instance!.boundContext?.runId).toBeUndefined();
    },
  );

  test('does not issue a projection without an exact Project identity', () => {
    expect(createWorkspacePlanPaneInstance(' project-a')).toBeNull();
    expect(createWorkspaceReadinessPaneInstance('')).toBeNull();
    expect(createWorkspaceTrustPaneInstance('project-a ')).toBeNull();
  });
});
