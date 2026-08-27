import { describe, expect, test } from 'vitest';
import {
  type CodingFileCompositionControl,
  selectCodingFileComposition,
} from '../workspace-coding-file-composition';
import {
  createWorkspaceCodingFileBrowserPaneInstance,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
} from '../workspace-coding-panels';

const select = (
  control: CodingFileCompositionControl,
  available = true,
  granted = available,
) => {
  const catalogInstance = createWorkspaceCodingFileBrowserPaneInstance('p1');
  if (!catalogInstance) throw new Error('fixture instance');
  return selectCodingFileComposition({
    control,
    projectId: 'p1',
    layoutId: 'coding',
    descriptor: WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
    catalogInstance,
    fileReadAvailability: available ? 'available' : 'unavailable',
    fileReadGrant: granted ? 'granted' : 'denied',
  });
};

describe('Coding file Workspace Composition migration', () => {
  test('keeps legacy only behind explicit rollback control', () => {
    const result = select('legacy');
    expect(result.document).toBeNull();
    expect(result.receipt).toEqual({
      control: 'legacy',
      outcome: 'legacy-selected',
      restorationIdentityMatched: true,
      fallbackUsed: false,
    });
  });

  test.each(['compare', 'composition'] as const)(
    '%s instantiates the real file occurrence through the generic Host Document',
    (control) => {
      const result = select(control);
      expect(result.document).toMatchObject({
        version: '1.1',
        id: 'coding-file-browser.host',
        instances: [
          {
            descriptorId: 'pane:builtin:coding:file-browser',
            instanceId: 'workspace-coding-file-browser',
            stateKey: 'workspace-coding-file-browser',
            boundContext: {
              projectId: 'p1',
              workspaceId: 'p1',
              sourceId: 'builtin:workspace-coding-file-browser',
            },
          },
        ],
      });
      expect(result.receipt).toMatchObject({
        control,
        outcome: 'composition-selected',
        restorationIdentityMatched: true,
        fallbackUsed: false,
      });
    },
  );

  test('fails visibly without grant and never returns the legacy occurrence', () => {
    const result = select('composition', true, false);
    expect(result.instance).toBeNull();
    expect(result.document).toBeNull();
    expect(result.receipt).toEqual({
      control: 'composition',
      outcome: 'unavailable',
      restorationIdentityMatched: false,
      fallbackUsed: false,
      reason: 'capability-unavailable',
    });
  });
});
