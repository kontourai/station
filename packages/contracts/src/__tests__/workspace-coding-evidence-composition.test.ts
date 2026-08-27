import { describe, expect, test } from 'vitest';
import {
  type CodingEvidenceCompositionControl,
  selectCodingEvidenceComposition,
} from '../workspace-coding-evidence-composition';
import {
  createWorkspacePlanPaneInstance,
  createWorkspaceReadinessPaneInstance,
  createWorkspaceTrustPaneInstance,
  WORKSPACE_PLAN_PANE_DESCRIPTOR,
  WORKSPACE_READINESS_PANE_DESCRIPTOR,
  WORKSPACE_TRUST_PANE_DESCRIPTOR,
} from '../workspace-evidence-panels';
import { toWorkspacePaneStateKey } from '../workspace-pane';

const fixtures = (projectId = 'p1') => {
  const plan = createWorkspacePlanPaneInstance(projectId);
  const readiness = createWorkspaceReadinessPaneInstance(projectId);
  const trust = createWorkspaceTrustPaneInstance(projectId);
  if (!plan || !readiness || !trust) throw new Error('fixture');
  return [
    {
      category: 'plan' as const,
      descriptor: WORKSPACE_PLAN_PANE_DESCRIPTOR,
      catalogInstance: plan,
      grant: 'granted' as const,
      availability: 'available' as const,
    },
    {
      category: 'readiness' as const,
      descriptor: WORKSPACE_READINESS_PANE_DESCRIPTOR,
      catalogInstance: readiness,
      grant: 'granted' as const,
      availability: 'available' as const,
    },
    {
      category: 'trust' as const,
      descriptor: WORKSPACE_TRUST_PANE_DESCRIPTOR,
      catalogInstance: trust,
      grant: 'granted' as const,
      availability: 'available' as const,
    },
  ];
};

const select = (control: CodingEvidenceCompositionControl) =>
  selectCodingEvidenceComposition({
    control,
    projectId: 'p1',
    layoutId: 'coding',
    panes: fixtures(),
  });

describe('Coding evidence Workspace Composition migration', () => {
  test('legacy remains explicit and reversible', () => {
    expect(select('legacy')).toMatchObject({
      document: null,
      instances: expect.arrayContaining([
        expect.objectContaining({ instanceId: 'workspace-plan' }),
        expect.objectContaining({ instanceId: 'workspace-readiness' }),
        expect.objectContaining({ instanceId: 'workspace-trust' }),
      ]),
      receipts: [
        expect.objectContaining({
          outcome: 'legacy-selected',
          fallbackUsed: false,
        }),
      ],
      unavailablePanes: [],
    });
  });

  test.each(['compare', 'composition'] as const)(
    '%s restores all three authoritative evidence occurrences',
    (control) => {
      const result = select(control);
      expect(result.document).toMatchObject({
        id: 'coding-evidence.host',
        instances: expect.arrayContaining(
          ['plan', 'readiness', 'trust'].map((category) =>
            expect.objectContaining({
              instanceId: `workspace-${category}`,
              stateKey: `workspace-${category}`,
              boundContext: expect.objectContaining({
                projectId: 'p1',
                workspaceId: 'p1',
              }),
            }),
          ),
        ),
      });
      expect(result.receipts).toEqual([
        {
          category: 'evidence',
          control,
          outcome: 'composition-selected',
          restorationIdentityMatched: true,
          fallbackUsed: false,
        },
      ]);
      expect(result.unavailablePanes).toEqual([]);
    },
  );

  test.each(['plan', 'readiness', 'trust'] as const)(
    'omits only %s when it has no distinct grant and retains healthy siblings',
    (category) => {
      const panes = fixtures().map((pane) =>
        pane.category === category
          ? { ...pane, grant: 'denied' as const }
          : pane,
      );
      expect(
        selectCodingEvidenceComposition({
          control: 'composition',
          projectId: 'p1',
          layoutId: 'coding',
          panes,
        }),
      ).toMatchObject({
        document: expect.objectContaining({
          instances: expect.not.arrayContaining([
            expect.objectContaining({ instanceId: `workspace-${category}` }),
          ]),
        }),
        instances: expect.arrayContaining(
          ['plan', 'readiness', 'trust']
            .filter((candidate) => candidate !== category)
            .map((candidate) =>
              expect.objectContaining({ instanceId: `workspace-${candidate}` }),
            ),
        ),
        receipts: expect.arrayContaining([
          expect.objectContaining({
            category,
            outcome: 'unavailable',
            fallbackUsed: false,
            reason: 'grant-denied',
          }),
        ]),
        unavailablePanes: [{ category, reason: 'grant-denied' }],
      });
    },
  );

  // The two inputs behind an omission are separate facts, and the previous
  // shape reported every omission as 'capability-unavailable' — including the
  // case above, where the capability is perfectly reachable (#3158).
  test.each([
    {
      name: 'a reachable capability the pane is not granted',
      pane: { grant: 'denied' as const, availability: 'available' as const },
      reason: 'grant-denied',
    },
    {
      name: 'a capability Station cannot reach',
      pane: {
        grant: 'granted' as const,
        availability: 'unavailable' as const,
      },
      reason: 'capability-unavailable',
    },
    {
      name: 'both at once',
      pane: {
        grant: 'denied' as const,
        availability: 'unavailable' as const,
      },
      reason: 'capability-unavailable-and-grant-denied',
    },
  ])('reports $name as its own reason', ({ pane, reason }) => {
    const panes = fixtures().map((candidate) =>
      candidate.category === 'readiness'
        ? { ...candidate, ...pane }
        : candidate,
    );
    const result = selectCodingEvidenceComposition({
      control: 'composition',
      projectId: 'p1',
      layoutId: 'coding',
      panes,
    });
    expect(result.unavailablePanes).toEqual([
      { category: 'readiness', reason },
    ]);
    expect(
      result.receipts.filter((receipt) => receipt.category === 'readiness'),
    ).toEqual([
      {
        category: 'readiness',
        control: 'composition',
        outcome: 'unavailable',
        restorationIdentityMatched: false,
        fallbackUsed: false,
        reason,
      },
    ]);
    // The healthy siblings still mount — the reason describes one pane.
    expect(result.document?.instances.map((i) => i.instanceId)).toEqual(
      expect.arrayContaining(['workspace-plan', 'workspace-trust']),
    );
  });

  test('compare mismatch fails visibly without legacy evidence fallback', () => {
    const panes = fixtures();
    const comparisonBaselines = panes.map((pane) => pane.catalogInstance);
    comparisonBaselines[1] = {
      ...comparisonBaselines[1],
      stateKey: toWorkspacePaneStateKey('readiness-drift'),
    };
    expect(
      selectCodingEvidenceComposition({
        control: 'compare',
        projectId: 'p1',
        layoutId: 'coding',
        panes,
        comparisonBaselines,
      }),
    ).toEqual({
      document: null,
      instances: [],
      receipts: [
        {
          category: 'evidence',
          control: 'compare',
          outcome: 'unavailable',
          restorationIdentityMatched: false,
          fallbackUsed: false,
          reason: 'comparison-mismatch',
        },
      ],
      unavailablePanes: [],
    });
  });

  test('fails the whole composition when no evidence pane is safe', () => {
    expect(
      selectCodingEvidenceComposition({
        control: 'composition',
        projectId: 'p1',
        layoutId: 'coding',
        panes: fixtures().map((pane) => ({
          ...pane,
          availability: 'unavailable' as const,
        })),
      }),
    ).toMatchObject({
      document: null,
      instances: [],
      receipts: [
        expect.objectContaining({
          category: 'evidence',
          outcome: 'unavailable',
          fallbackUsed: false,
          reason: 'capability-unavailable',
        }),
      ],
    });
  });
});
