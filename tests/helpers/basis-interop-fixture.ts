import {
  STATION_TASK_BASIS_COLLECTION_VERSION,
  type StationTaskBasisCollection,
} from '@kontourai/station-contracts/task-basis';
import {
  composeBasisProjection,
  parseBasisProjection,
} from '@kontourai/surface/basis';

const observedAt = '2026-08-25T00:00:00.000Z';

/**
 * The production station-control transport updates its process-local API target.
 * Restore that fixture effect after shutdown; never use it to choose a listener.
 * The interop fixture's ephemeral bound socket is its only target authority.
 */
export function preserveBasisInteropEnvironment(): () => void {
  const apiBase = process.env.STATION_API_BASE;
  const port = process.env.STATION_PORT;
  return () => {
    if (apiBase === undefined) delete process.env.STATION_API_BASE;
    else process.env.STATION_API_BASE = apiBase;
    if (port === undefined) delete process.env.STATION_PORT;
    else process.env.STATION_PORT = port;
  };
}

/** Non-sensitive, positively parsed owner fixture for real host interoperability. */
export function basisInteropCollection(): StationTaskBasisCollection {
  const answers = Array.from({ length: 9 }, (_, index) => {
    const assessment =
      index === 1
        ? {
            owner: { authority: '@kontourai/surface' as const },
            state: 'not-captured' as const,
            observedAt,
          }
        : {
            owner: { authority: '@kontourai/surface' as const },
            state: 'available' as const,
            observedAt,
            value: {
              version: 'surface.answer-assessment/v2' as const,
              ref: {
                authority: '@kontourai/surface' as const,
                schemaVersion: 'surface.answer-assessment/v2' as const,
                kind: 'answer-assessment' as const,
                bundleId: 'fixture-bundle',
                claimId: 'fixture-claim',
              },
              found: true,
              bundle: {
                id: 'fixture-bundle',
                schemaVersion: 1,
                source: 'fixture-producer',
                generatedAt: observedAt,
              },
              claim: {
                id: 'fixture-claim',
                subject: {
                  subjectType: 'answer' as const,
                  subjectId: `fixture-message-${index}`,
                },
                status: 'verified' as const,
                freshness: { asOf: observedAt, expiresAt: null, stale: false },
              },
              policy: null,
              evidence: {
                entails: [
                  {
                    id: 'entails',
                    label: 'Entailing fixture',
                    sourceRef: 'source-entails',
                    locator: null,
                    observedAt,
                    supportStrength: 'entails' as const,
                    result: 'passed' as const,
                    blocksClaim: false,
                  },
                ],
                cited: [
                  {
                    id: 'cited',
                    label: 'Cited fixture',
                    sourceRef: 'source-cited',
                    locator: null,
                    observedAt,
                    supportStrength: 'cited' as const,
                    result: 'passed' as const,
                    blocksClaim: false,
                  },
                ],
                counterevidence: [
                  {
                    id: 'counter',
                    label: '<img src=x onerror=alert(1)>',
                    sourceRef: 'source-counter',
                    locator: null,
                    observedAt,
                    supportStrength: null,
                    result: 'failed' as const,
                    blocksClaim: true,
                  },
                ],
                undeclared: [],
              },
              derivation: { available: true, directInputs: [] },
              gaps: [
                {
                  code: 'fixture-gap',
                  message: 'A visible owner-declared fixture gap.',
                },
              ],
            },
          };
    const projection = composeBasisProjection({
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
            threadId: 'fixture-session',
            messageId: `fixture-message-${index}`,
          },
          fact: 'answer-observed',
          observedAt,
        },
      },
      assessment,
      contributions: [],
    });
    const parsed = parseBasisProjection(projection);
    const expectedStanding = index === 1 ? 'unresolved' : 'assessed-with-gaps';
    if (!parsed.ok || parsed.value.standing !== expectedStanding)
      throw new Error(
        'Interop fixture must be a valid assessed Surface projection',
      );
    return {
      answerReferenceId: `fixture-answer-${index}`,
      projection: parsed.value,
    };
  });
  return {
    version: STATION_TASK_BASIS_COLLECTION_VERSION,
    taskId: 'fixture-task',
    answers,
    unassociated: [
      {
        kind: 'task-output',
        taskId: 'fixture-task',
        outputId: 'fixture-output',
        kept: true,
      },
    ],
    keptToolResults: Array.from({ length: 17 }, (_, index) => ({
      referenceId: `fixture-kept-result-${index}`,
      ref: {
        authority: '@kontourai/thread' as const,
        schemaVersion: '1.2.0' as const,
        kind: 'result' as const,
        threadId: 'fixture-session',
        resultId: `fixture-result-${index}`,
      },
      kept: true as const,
      associatedAnswerReferenceIds: [],
    })),
    keptGateEvaluations: [
      {
        referenceId: 'fixture-kept-flow-evaluation',
        kept: true,
        evaluation: {
          ref: {
            runId: 'fixture-flow-run',
            gateId: 'verification',
            evaluationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
          evaluatedAt: observedAt,
          originalVerdict: 'pass',
          kind: 'recheck',
          trigger: 'freshness',
          previousRef: {
            runId: 'fixture-flow-run',
            gateId: 'verification',
            evaluationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
          currentStanding: 'superseded',
          currentRun: { status: 'active', currentStep: 'verification' },
          currentPersistedGateRef: {
            runId: 'fixture-flow-run-current',
            gateId: 'verification',
            evaluationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          },
          validityAsOf: observedAt,
          validityScope: 'retained-immutable-bundle',
          externalRevocation: 'not-observed',
          routeBack: {
            attempt: 2,
            maxAttempts: 3,
            reason: 'Fresh review required',
            selectedRoute: 'verification',
          },
          selectedEvidence: Array.from({ length: 21 }, (_, index) => ({
            evidenceId: `fixture-selected-evidence-${index}`,
            standing: 'superseded',
            freshness: 'stale',
            revocationCodes: ['superseded-by-recheck'],
            authority: 'active',
          })),
        },
      },
    ],
    gaps: [{ state: 'restricted', scope: 'process' }],
  };
}
