import { describe, expect, test } from 'vitest';
import {
  type CodingDiffCompositionControl,
  selectCodingDiffComposition,
} from '../workspace-coding-diff-composition';
import {
  createWorkspaceCodingDiffPaneInstance,
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
} from '../workspace-coding-panels';
import { toWorkspacePaneStateKey } from '../workspace-pane';

const select = (
  control: CodingDiffCompositionControl,
  available = true,
  granted = available,
) => {
  const catalogInstance = createWorkspaceCodingDiffPaneInstance('p1');
  if (!catalogInstance) throw new Error('fixture instance');
  return selectCodingDiffComposition({
    control,
    projectId: 'p1',
    layoutId: 'coding',
    descriptor: WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
    catalogInstance,
    gitDiffAvailability: available ? 'available' : 'unavailable',
    gitDiffGrant: granted ? 'granted' : 'denied',
  });
};

describe('Coding Diff Workspace Composition migration', () => {
  test('keeps legacy only behind explicit rollback control', () => {
    expect(select('legacy')).toMatchObject({
      document: null,
      receipt: {
        control: 'legacy',
        outcome: 'legacy-selected',
        restorationIdentityMatched: true,
        fallbackUsed: false,
      },
    });
  });

  test.each(['compare', 'composition'] as const)(
    '%s instantiates the authoritative Diff occurrence with stable restore identity',
    (control) => {
      const result = select(control);
      expect(result.document).toMatchObject({
        id: 'coding-diff.host',
        instances: [
          {
            descriptorId: 'pane:builtin:coding:diff',
            instanceId: 'workspace-coding-diff',
            stateKey: 'workspace-coding-diff',
            boundContext: {
              projectId: 'p1',
              workspaceId: 'p1',
              sourceId: 'builtin:workspace-coding-diff',
            },
          },
        ],
      });
      expect(result.receipt).toEqual({
        control,
        outcome: 'composition-selected',
        restorationIdentityMatched: true,
        fallbackUsed: false,
      });
    },
  );

  test('fails visibly without the distinct Git Diff grant and never falls back', () => {
    expect(select('composition', true, false)).toEqual({
      document: null,
      instance: null,
      receipt: {
        control: 'composition',
        outcome: 'unavailable',
        restorationIdentityMatched: false,
        fallbackUsed: false,
        reason: 'capability-unavailable',
      },
    });
  });

  test('compare mismatch fails visibly instead of selecting legacy', () => {
    const catalogInstance = createWorkspaceCodingDiffPaneInstance('p1');
    if (!catalogInstance) throw new Error('fixture instance');
    const result = selectCodingDiffComposition({
      control: 'compare',
      projectId: 'p1',
      layoutId: 'coding',
      descriptor: WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
      catalogInstance,
      comparisonBaseline: {
        ...catalogInstance,
        stateKey: toWorkspacePaneStateKey('different-state'),
      },
      gitDiffAvailability: 'available',
      gitDiffGrant: 'granted',
    });
    expect(result).toEqual({
      document: null,
      instance: null,
      receipt: {
        control: 'compare',
        outcome: 'unavailable',
        restorationIdentityMatched: false,
        fallbackUsed: false,
        reason: 'comparison-mismatch',
      },
    });
  });
});
