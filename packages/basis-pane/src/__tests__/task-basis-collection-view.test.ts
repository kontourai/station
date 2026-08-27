import type { StationTaskBasisCollection } from '@kontourai/station-contracts/task-basis';
import {
  buildStationTaskBasisMcpPage,
  STATION_TASK_BASIS_MCP_PAGE_VERSION,
} from '@kontourai/station-contracts/task-basis-mcp';
import {
  composeBasisProjection,
  parseBasisProjection,
} from '@kontourai/surface/basis';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import { describe, expect, test } from 'vitest';
import { buildStationTaskBasisCollectionView } from '../task-basis-collection-view';

function projection() {
  const observedAt = '2026-08-25T00:00:00.000Z';
  return composeBasisProjection({
    version: 'surface.basis-projection/v1',
    answer: {
      owner: { authority: '@kontourai/thread' },
      state: 'available',
      observedAt,
      value: {
        ref: {
          authority: '@kontourai/thread',
          schemaVersion: '1.2.0',
          kind: 'assistant-message',
          standing: 'observed',
          threadId: 'session',
          messageId: 'message',
        },
        fact: 'answer-observed',
        observedAt,
      },
    },
    assessment: {
      owner: { authority: '@kontourai/surface' },
      state: 'available',
      observedAt,
      value: {
        version: 'surface.answer-assessment/v2',
        ref: {
          authority: '@kontourai/surface',
          schemaVersion: 'surface.answer-assessment/v2',
          kind: 'answer-assessment',
          bundleId: 'bundle',
          claimId: 'claim',
        },
        found: true,
        bundle: {
          id: 'bundle',
          schemaVersion: 1,
          source: 'fixture',
          generatedAt: observedAt,
        },
        claim: {
          id: 'claim',
          subject: { subjectType: 'answer', subjectId: 'message' },
          status: 'verified',
          freshness: { asOf: observedAt, expiresAt: null, stale: false },
        },
        policy: null,
        evidence: {
          entails: [
            {
              id: 'entails',
              label: 'Entailing',
              sourceRef: 'source-entails',
              locator: null,
              observedAt,
              supportStrength: 'entails',
              result: 'passed',
              blocksClaim: false,
            },
          ],
          cited: [
            {
              id: 'cited',
              label: 'Cited',
              sourceRef: 'source-cited',
              locator: null,
              observedAt,
              supportStrength: 'cited',
              result: 'passed',
              blocksClaim: false,
            },
          ],
          undeclared: [],
          counterevidence: [
            {
              id: 'counter',
              label: 'Counter',
              sourceRef: 'source-counter',
              locator: null,
              observedAt,
              supportStrength: null,
              result: 'failed',
              blocksClaim: true,
            },
          ],
        },
        derivation: { available: true, directInputs: [] },
        gaps: [{ code: 'fixture-gap', message: 'Visible owner gap.' }],
      },
    },
    contributions: [],
  });
}

function collection(answerCount = 2) {
  return {
    version: 'station.task-basis-collection/v4',
    taskId: 'task-a',
    answers: Array.from({ length: answerCount }, (_, index) => ({
      answerReferenceId: `answer-${index + 1}`,
      projection: projection(),
    })),
    unassociated: [
      {
        kind: 'task-output',
        taskId: 'task-a',
        outputId: 'output-a',
        kept: true,
      },
    ],
    keptToolResults: [],
    keptGateEvaluations: [],
    gaps: [{ state: 'restricted' }, { state: 'unavailable' }],
  };
}

function keptGateEvaluation(overrides: Record<string, unknown> = {}) {
  return {
    referenceId: 'flow-evaluation-link',
    kept: true,
    evaluation: {
      ref: {
        runId: 'flow-run',
        gateId: 'review',
        evaluationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      evaluatedAt: '2026-08-26T00:00:00.000Z',
      originalVerdict: 'pass',
      kind: 'recheck',
      trigger: 'freshness',
      previousRef: {
        runId: 'flow-run',
        gateId: 'review',
        evaluationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
      currentStanding: 'superseded',
      currentRun: { status: 'active', currentStep: 'review' },
      currentPersistedGateRef: {
        runId: 'flow-run-current',
        gateId: 'review',
        evaluationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
      validityAsOf: '2026-08-26T00:30:00.000Z',
      validityScope: 'retained-immutable-bundle',
      externalRevocation: 'not-observed',
      exceptionId: 'approved-exception',
      routeBack: {
        attempt: 2,
        maxAttempts: 3,
        reason: 'Need a fresh review',
        selectedRoute: 'review',
      },
      selectedEvidence: [
        {
          evidenceId: 'selected-evidence',
          standing: 'superseded',
          freshness: 'stale',
          revocationCodes: ['superseded-by-recheck'],
          authority: 'active',
        },
      ],
      ...overrides,
    },
  };
}

describe('buildStationTaskBasisCollectionView', () => {
  test('keeps exact server order and delegates all answer semantics to Surface', () => {
    const input = collection();
    expect(parseBasisProjection(input.answers[0]?.projection)).toMatchObject({
      ok: true,
    });
    const view = buildStationTaskBasisCollectionView({
      kind: 'authorized-collection',
      collection: input,
    });
    expect(view.status).toBe('available');
    if (view.status !== 'available') return;
    expect(view.answers.map((answer) => answer.answerReferenceId)).toEqual([
      'answer-1',
      'answer-2',
    ]);
    expect(view.answers[0]?.panel).toEqual(
      buildBasisPanelViewModel(input.answers[0]?.projection),
    );
    expect(
      view.answers[0]?.panel.assessment?.evidence.map((group) => group.id),
    ).toEqual(['entails', 'cited', 'undeclared', 'counterevidence']);
    expect(view).not.toHaveProperty('standing');
    expect(view.availabilityGaps).toEqual([
      { state: 'restricted' },
      { state: 'unavailable' },
    ]);
    expect(view.unassociated).toEqual(input.unassociated);
  });

  test('adapts a bounded page without changing Surface semantics and preserves continuation', () => {
    const page = buildStationTaskBasisMcpPage(collection(10));
    expect(page?.status).toBe('available');
    if (page?.status !== 'available') return;
    const view = buildStationTaskBasisCollectionView({
      kind: 'bounded-page',
      page,
    });
    expect(view).toMatchObject({
      status: 'available',
      continuation: page.continuation,
    });
    if (view.status !== 'available') return;
    expect(view.answers).toHaveLength(8);
    expect(view.answers[7]?.answerReferenceId).toBe('answer-8');
    expect(view.answers[0]?.panel).toEqual(
      buildBasisPanelViewModel(page.answers[0]?.projection),
    );
  });

  test('keeps Flow Process receipts separate from answers and preserves their exact owner facts', () => {
    const input = collection() as StationTaskBasisCollection;
    input.keptGateEvaluations = [keptGateEvaluation()] as never;
    input.gaps = [
      { state: 'restricted', scope: 'process' },
      { state: 'unavailable' },
    ];
    const view = buildStationTaskBasisCollectionView({
      kind: 'authorized-collection',
      collection: input,
    });
    expect(view.status).toBe('available');
    if (view.status !== 'available') return;
    expect(view).not.toHaveProperty('standing');
    expect(view.chrome.availability).toEqual([
      {
        state: 'restricted',
        scope: 'process',
        message: 'Some kept Process context is restricted.',
      },
      {
        state: 'unavailable',
        message: 'Some kept answer context is unavailable.',
      },
    ]);
    expect(view.availabilityGaps).toEqual(input.gaps);
    expect(view.keptGateEvaluations).toEqual([
      expect.objectContaining({
        referenceId: 'flow-evaluation-link',
        gateId: 'review',
        originalVerdict: 'pass',
        currentStanding: 'superseded',
        validityScope: 'retained-immutable-bundle',
        externalRevocation: 'not-observed',
        previousRef: input.keptGateEvaluations[0]?.evaluation.previousRef,
        currentPersistedGateRef:
          input.keptGateEvaluations[0]?.evaluation.currentPersistedGateRef,
        selectedEvidence:
          input.keptGateEvaluations[0]?.evaluation.selectedEvidence,
      }),
    ]);
    expect(view.answers[0]?.panel.standing.label).toBe('Assessed with gaps');
  });

  test.each([
    [['answer-on-earlier-page'], 'Associated with an answer on another page.'],
    [[], 'Not associated with an available answer.'],
  ])(
    'distinguishes off-page associations from absent available associations: %j',
    (associatedAnswerReferenceIds, associationMessage) => {
      const view = buildStationTaskBasisCollectionView({
        kind: 'bounded-page',
        page: {
          version: STATION_TASK_BASIS_MCP_PAGE_VERSION,
          status: 'available',
          taskId: 'task-a',
          offsets: {
            answerOffset: 1,
            unassociatedOffset: 0,
            keptToolResultOffset: 0,
            keptGateEvaluationOffset: 0,
          },
          answers: [],
          unassociated: [],
          keptToolResults: [
            {
              referenceId: 'kept-result-a',
              ref: {
                authority: '@kontourai/thread',
                schemaVersion: '1.2.0',
                kind: 'result',
                threadId: 'session-a',
                resultId: 'result-a',
              },
              kept: true,
              associatedAnswerReferenceIds,
            },
          ],
          keptGateEvaluations: [],
          gaps: [],
        },
      });
      expect(view).toMatchObject({
        status: 'available',
        answers: [],
        keptToolResults: [
          expect.objectContaining({ referenceId: 'kept-result-a' }),
        ],
        chrome: {
          keptToolResultsHeading: 'Kept tool results',
          keptToolResultItems: [
            expect.objectContaining({
              associationMessage,
            }),
          ],
        },
      });
    },
  );

  test('fails closed for malformed, accessor-backed, and proxy-hostile sources', () => {
    const accessor = Object.defineProperty(
      { kind: 'authorized-collection' },
      'collection',
      {
        enumerable: true,
        get: () => {
          throw new Error('must not read');
        },
      },
    );
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('nope');
        },
      },
    );
    for (const value of [null, {}, accessor, hostile]) {
      expect(buildStationTaskBasisCollectionView(value)).toEqual({
        version: 'station.task-basis-collection-view/v1',
        status: 'unavailable',
        reason: 'invalid-envelope',
      });
    }
  });
});
