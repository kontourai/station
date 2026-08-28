// @vitest-environment jsdom
import type { BasisPanelViewModel } from '@kontourai/surface/basis/view';
import { describe, expect, test } from 'vitest';
import { renderBasisPanel } from '../basis-panel-dom';

function view(): BasisPanelViewModel {
  return {
    version: 'surface.basis-panel-view/v1',
    state: 'ready',
    title: 'Basis',
    standing: {
      code: 'policy-met',
      label: 'Policy met',
      description: 'The claim meets its policy.',
      tone: 'positive',
      unresolvedReason: null,
    },
    gaps: [
      {
        code: 'owner-gap',
        message: '<img src=x onerror=alert(1)> remains inert.',
        metadata: {
          source: 'derivation.weak',
          weakEdges: [
            {
              claimId: '<img src=claim onerror=alert(1)>',
              inputClaimId: '<script>input</script>',
            },
          ],
        },
      },
    ],
    contextNotice: 'Context does not establish support.',
    footer: 'Inspect evidence before relying on an answer.',
    disclosures: {
      standing: 'always',
      gaps: 'always',
      assessment: 'expanded',
      context: 'collapsed',
      relationships: 'collapsed',
      technical: 'collapsed',
    },
    assessment: {
      state: 'available',
      found: true,
      claimStatus: 'verified',
      freshness: 'Current as of 2026-08-25T00:00:00.000Z',
      policy: {
        id: 'policy-a',
        outcome: 'satisfied',
        evaluatedAt: '2026-08-25T00:00:00.000Z',
        reasons: ['<b>policy reason</b>'],
      },
      evidence: [
        {
          id: 'entails',
          label: 'Entailing evidence',
          items: [],
        },
        { id: 'cited', label: 'Citations', items: [] },
        {
          id: 'undeclared',
          label: 'Support relationship not declared',
          items: [
            {
              id: 'undeclared',
              label: 'Untrusted <script>',
              source: 'source-a',
              locator: null,
              observedAt: '2026-08-25T00:00:00.000Z',
              supportStrength: null,
              result: 'not-evaluated',
              blocksClaim: false,
            },
          ],
        },
        { id: 'counterevidence', label: 'Counterevidence', items: [] },
      ],
      derivation: {
        available: true,
        directInputs: [
          {
            claimId: 'input-a',
            status: 'verified',
            source: 'derivedFrom',
            method: 'fixture',
            supportStrength: 'entails',
            rationale: 'because',
          },
        ],
      },
    },
    contextGroups: [
      {
        id: 'inputs',
        label: 'Inputs',
        items: [
          {
            ref: {
              authority: '@kontourai/station',
              schemaVersion: '1',
              kind: 'input',
              sessionId: 'context-session',
              eventId: 'context-event',
            },
            id: 'context-item',
            label: 'Station input',
            details: 'Hostile context remains descriptive only.',
            facts: [{ label: 'Input kind', value: 'prompt' }],
            gaps: [
              {
                code: 'weak-context',
                message: 'This context does not establish support.',
                metadata: {
                  source: 'derivation.weak',
                  weakEdges: [
                    {
                      claimId: 'context-claim',
                      inputClaimId: 'context-input',
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      { id: 'execution', label: 'Execution', items: [] },
      { id: 'process', label: 'Process', items: [] },
      { id: 'outcomes', label: 'Outcomes', items: [] },
      { id: 'sources', label: 'Sources', items: [] },
      { id: 'live', label: 'Live', items: [] },
    ],
    relationships: [
      {
        id: 'supports:a:b',
        label: 'Support',
        prose: 'The evidence supports the claim.',
        from: { label: 'From', value: 'source-a' },
        to: { label: 'To', value: 'claim-a' },
        gaps: [],
      },
    ],
    technical: {
      answerOwner: '@kontourai/thread',
      answerState: 'available',
      assessmentOwner: '@kontourai/surface',
      assessmentState: 'available',
      bundleId: 'bundle-a',
      claimId: 'claim-a',
    },
  };
}

describe('portable Basis panel DOM renderer', () => {
  test('renders the complete public view model as inert accessible DOM', () => {
    const root = document.createElement('section');
    renderBasisPanel(root, view());

    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      'Policy met',
    );
    expect(root.textContent).toContain('Support relationship not declared');
    expect(root.textContent).toContain('Current as of');
    expect(root.textContent).toContain('Derivation');
    expect(root.textContent).toContain('Technical identity');
    expect(root.textContent).toContain('Relationships');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root.textContent).toContain(
      '<img src=claim onerror=alert(1)> → <script>input</script>',
    );
    expect(root.textContent).toContain('context-claim → context-input');
    expect(root.textContent).toContain(
      'This context does not establish support.',
    );
    expect(root.querySelector('details[open] summary')?.textContent).toBe(
      'Assessment',
    );
  });
});
