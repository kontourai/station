import { describe, expect, test } from 'vitest';
import {
  createWorkspaceCodingDiffPaneInstance,
  createWorkspaceCodingFileBrowserPaneInstance,
  createWorkspaceCodingTerminalPaneInstance,
  isCanonicalWorkspaceCodingDiffPaneInstance,
  isCanonicalWorkspaceCodingFileBrowserPaneInstance,
  isCanonicalWorkspaceCodingTerminalPaneInstance,
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '../workspace-coding-panels';

describe('Workspace coding panels', () => {
  test('issues one exact Project-bound Files occurrence', () => {
    const instance = createWorkspaceCodingFileBrowserPaneInstance('project-a');

    expect(instance).toEqual({
      version: '1.0',
      descriptorId: WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR.id,
      instanceId: 'workspace-coding-file-browser',
      stateKey: 'workspace-coding-file-browser',
      boundContext: {
        projectId: 'project-a',
        workspaceId: 'project-a',
        sourceId: 'builtin:workspace-coding-file-browser',
      },
    });
    expect(isCanonicalWorkspaceCodingFileBrowserPaneInstance(instance!)).toBe(
      true,
    );
    expect(
      isCanonicalWorkspaceCodingFileBrowserPaneInstance({
        ...instance!,
        boundContext: { ...instance!.boundContext, workspaceId: 'other' },
      }),
    ).toBe(false);
  });

  test('issues one exact Project-bound Diff occurrence', () => {
    const instance = createWorkspaceCodingDiffPaneInstance('project-a');

    expect(instance).toEqual({
      version: '1.0',
      descriptorId: WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR.id,
      instanceId: 'workspace-coding-diff',
      stateKey: 'workspace-coding-diff',
      boundContext: {
        projectId: 'project-a',
        workspaceId: 'project-a',
        sourceId: 'builtin:workspace-coding-diff',
      },
    });
    expect(isCanonicalWorkspaceCodingDiffPaneInstance(instance!)).toBe(true);
    expect(
      isCanonicalWorkspaceCodingDiffPaneInstance({
        ...instance!,
        boundContext: {
          ...instance!.boundContext,
          workspaceId: 'extra-context',
        },
      }),
    ).toBe(false);
  });

  test('issues one exact Project-bound Terminal placement without a session identity', () => {
    const instance = createWorkspaceCodingTerminalPaneInstance('project-a');

    expect(instance).toEqual({
      version: '1.0',
      descriptorId: WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR.id,
      instanceId: 'workspace-coding-terminal',
      stateKey: 'workspace-coding-terminal',
      boundContext: {
        projectId: 'project-a',
        sourceId: 'builtin:workspace-coding-terminal',
      },
    });
    expect(isCanonicalWorkspaceCodingTerminalPaneInstance(instance!)).toBe(
      true,
    );
    expect(
      isCanonicalWorkspaceCodingTerminalPaneInstance({
        ...instance!,
        boundContext: { ...instance!.boundContext, sourceId: 'other' },
      }),
    ).toBe(false);
    expect(instance!.boundContext?.sessionId).toBeUndefined();
  });

  test('does not issue an occurrence without a normalized Project identity', () => {
    expect(
      createWorkspaceCodingFileBrowserPaneInstance(' project-a'),
    ).toBeNull();
    expect(createWorkspaceCodingDiffPaneInstance('')).toBeNull();
    expect(createWorkspaceCodingTerminalPaneInstance('project-a ')).toBeNull();
  });
});
