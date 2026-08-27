import { encodeTaskTurnReference } from '@kontourai/station-contracts';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import {
  composeAuthorizedSessionAnswerBasis,
  createTaskBasisQueryModule,
} from '../task-basis-module.js';

const observedAt = '2026-08-25T00:00:00.000Z';
const answer = {
  status: 'found' as const,
  sessionId: 'session-a',
  turnId: 'turn-a',
  observedAt,
  binding: {
    version: 'station-answer-binding/v1' as const,
    sessionId: 'session-a',
    turnId: 'turn-a',
    answer: {
      authority: '@kontourai/thread' as const,
      schemaVersion: '1.2.0' as const,
      kind: 'assistant-message' as const,
      standing: 'observed' as const,
      threadId: 'session-a',
      messageId: 'start-a:assistant',
    },
  },
  projectSlug: 'project-a',
  inputs: [
    {
      eventId: 'input-a',
      kind: 'initial' as const,
      prompt: 'ask',
      attachments: [],
    },
  ],
  results: [],
};

const noKeptToolResults = {
  read: async () => ({ status: 'found' as const, references: [] }),
};
const keptGateEvaluation = {
  referenceId: 'flow-keep-a',
  evaluation: {
    ref: {
      runId: 'run-a',
      gateId: 'gate-a',
      evaluationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    evaluatedAt: '2026-08-26T00:00:00.000Z',
    originalVerdict: 'block' as const,
    kind: 'initial' as const,
    trigger: 'ordinary' as const,
    currentStanding: 'current' as const,
    currentRun: { status: 'active' as const, currentStep: null },
    selectedEvidence: [],
    validityAsOf: '2026-08-26T00:00:00.000Z',
    validityScope: 'retained-immutable-bundle' as const,
    externalRevocation: 'not-observed' as const,
  },
};

describe('Station Surface Basis adapter', () => {
  test('round-trips a direct observed answer through Surface and stays execution-only without assessment', () => {
    const projection = composeAuthorizedSessionAnswerBasis(answer);
    expect(projection.standing).toBe('execution-only');
    expect(projection.unresolvedReason).toBeNull();
    expect(projection.answer).toMatchObject({
      state: 'available',
      value: { ref: answer.binding.answer },
    });
    expect(projection.regions.inputs[0]).toMatchObject({
      ref: { eventId: 'input-a' },
    });
    expect(projection.relationships).toEqual([]);
  });

  test('selected Task answer is an exact Surface projection and Whole Task has no aggregate standing', async () => {
    const links = [
      {
        id: 'keep-a',
        targetId: encodeTaskTurnReference('session-a', 'turn-a'),
      },
    ];
    const module = createTaskBasisQueryModule({
      taskGraph: {
        readTaskTurnReferenceScope: () => ({ projectId: 'project-a' }),
        readTaskTurnReferenceLinks: () => links,
      },
      sessionQueries: { readAnswerBasis: async () => answer },
      outputs: { list: async () => [{ id: 'output-a' }] },
      toolResultReferences: noKeptToolResults,
      gateEvaluationReferences: {
        read: async () => ({
          status: 'found' as const,
          references: [keptGateEvaluation],
        }),
      },
    });
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );
    const selected = await module.read({
      taskId: 'task-a',
      answerReferenceId: 'keep-a',
      authority,
    });
    expect(selected).toMatchObject({
      status: 'found',
      data: {
        version: 'surface.basis-projection/v1',
        standing: 'execution-only',
      },
    });
    const whole = await module.read({
      taskId: 'task-a',
      authority,
      request: new Request('http://station.test'),
    });
    expect(whole).toEqual({
      status: 'found',
      data: {
        version: 'station.task-basis-collection/v4',
        taskId: 'task-a',
        answers: [
          {
            answerReferenceId: 'keep-a',
            projection: composeAuthorizedSessionAnswerBasis(answer),
          },
        ],
        unassociated: [
          {
            kind: 'task-output',
            taskId: 'task-a',
            outputId: 'output-a',
            kept: true,
          },
        ],
        keptToolResults: [],
        keptGateEvaluations: [
          {
            referenceId: 'flow-keep-a',
            kept: true,
            evaluation: keptGateEvaluation.evaluation,
          },
        ],
        gaps: [],
      },
    });
  });

  test('uses a kept answer pin instead of following the direct narrative head', async () => {
    const readNarrative = vi.fn(async () => ({
      owner: { authority: '@kontourai/flow-agents' as const },
      state: 'not-captured' as const,
      observedAt,
    }));
    const module = createTaskBasisQueryModule({
      taskGraph: {
        readTaskTurnReferenceScope: () => ({ projectId: 'project-a' }),
        readTaskTurnReferenceLinks: () => [
          {
            id: 'keep-a',
            targetId: encodeTaskTurnReference('session-a', 'turn-a'),
          },
        ],
        readTaskAnswerNarrativePin: () => 3,
      },
      sessionQueries: { readAnswerBasis: async () => answer },
      outputs: { list: async () => [] },
      toolResultReferences: noKeptToolResults,
      readNarrative,
    });
    await module.read({
      taskId: 'task-a',
      answerReferenceId: 'keep-a',
      authority: sessionReadAuthorityFromRequest('owner', undefined, undefined),
    });
    expect(readNarrative).toHaveBeenCalledWith(
      expect.objectContaining({ associationRevision: 3 }),
    );
  });

  test('a denied selected owner is indistinguishable and unrelated outputs never enter it', async () => {
    const module = createTaskBasisQueryModule({
      taskGraph: {
        readTaskTurnReferenceScope: () => ({ projectId: 'project-a' }),
        readTaskTurnReferenceLinks: () => [
          {
            id: 'keep-a',
            targetId: encodeTaskTurnReference('session-a', 'turn-a'),
          },
        ],
      },
      sessionQueries: {
        readAnswerBasis: async () => ({ status: 'not-found' as const }),
      },
      outputs: { list: async () => [{ id: 'output-a' }] },
      toolResultReferences: noKeptToolResults,
    });
    await expect(
      module.read({
        taskId: 'task-a',
        answerReferenceId: 'keep-a',
        authority: sessionReadAuthorityFromRequest(
          'owner',
          undefined,
          undefined,
        ),
      }),
    ).resolves.toEqual({ status: 'not-found' });
  });

  test('keeps authorized projections while exposing only bounded identity-free owner gaps', async () => {
    const module = createTaskBasisQueryModule({
      taskGraph: {
        readTaskTurnReferenceScope: () => ({ projectId: 'project-a' }),
        readTaskTurnReferenceLinks: () => [
          {
            id: 'keep-a',
            targetId: encodeTaskTurnReference('session-a', 'turn-a'),
          },
          { id: 'malformed', targetId: 'not-a-turn-reference' },
          {
            id: 'restricted',
            targetId: encodeTaskTurnReference('session-b', 'turn-b'),
          },
        ],
      },
      sessionQueries: {
        readAnswerBasis: async (query) =>
          query.threadId === 'session-a'
            ? answer
            : { status: 'not-found' as const },
      },
      outputs: { list: async () => Promise.reject(new Error('owner down')) },
      toolResultReferences: noKeptToolResults,
    });
    const outcome = await module.read({
      taskId: 'task-a',
      authority: sessionReadAuthorityFromRequest('owner', undefined, undefined),
    });
    expect(outcome).toMatchObject({
      status: 'found',
      data: {
        answers: [
          expect.objectContaining({
            answerReferenceId: 'keep-a',
            projection: expect.objectContaining({ standing: 'execution-only' }),
          }),
        ],
        gaps: [
          { state: 'corrupt' },
          { state: 'restricted' },
          { state: 'unavailable' },
        ],
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('session-b');
    expect(JSON.stringify(outcome)).not.toContain('turn-b');
  });

  test('returns retryable unavailable for an exact selected resolver outage', async () => {
    const module = createTaskBasisQueryModule({
      taskGraph: {
        readTaskTurnReferenceScope: () => ({ projectId: 'project-a' }),
        readTaskTurnReferenceLinks: () => [
          {
            id: 'keep-a',
            targetId: encodeTaskTurnReference('session-a', 'turn-a'),
          },
        ],
      },
      sessionQueries: {
        readAnswerBasis: async () => ({ status: 'unavailable' }),
      },
      outputs: { list: async () => [] },
      toolResultReferences: noKeptToolResults,
    });
    await expect(
      module.read({
        taskId: 'task-a',
        answerReferenceId: 'keep-a',
        authority: sessionReadAuthorityFromRequest(
          'owner',
          undefined,
          undefined,
        ),
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  test('keeps a successful sibling while collapsing descriptor corruption to one collection gap', async () => {
    const module = createTaskBasisQueryModule({
      taskGraph: {
        readTaskTurnReferenceScope: () => ({ projectId: 'project-a' }),
        readTaskTurnReferenceLinks: () => [
          {
            id: 'good',
            targetId: encodeTaskTurnReference('session-a', 'turn-a'),
          },
          {
            id: 'corrupt',
            targetId: encodeTaskTurnReference('session-b', 'turn-b'),
          },
        ],
      },
      sessionQueries: {
        readAnswerBasis: async (query) =>
          query.threadId === 'session-a' ? answer : { status: 'corrupt' },
      },
      outputs: { list: async () => [] },
      toolResultReferences: noKeptToolResults,
    });
    const outcome = await module.read({
      taskId: 'task-a',
      authority: sessionReadAuthorityFromRequest('owner', undefined, undefined),
    });
    expect(outcome).toMatchObject({
      status: 'found',
      data: {
        answers: [
          expect.objectContaining({
            answerReferenceId: 'good',
            projection: expect.objectContaining({ standing: 'execution-only' }),
          }),
        ],
        gaps: [{ state: 'corrupt' }],
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('session-b');
    expect(JSON.stringify(outcome)).not.toContain('turn-b');
  });

  test('derives kept-result associations only from exact available Surface execution refs', async () => {
    const answerWithResult = {
      ...answer,
      results: [
        {
          eventId: 'event-a',
          result: {
            resultId: 'event-a',
            name: 'shell',
            terminalStatus: 'success' as const,
            content: [],
            truncated: false,
            omittedParts: 0,
            omittedTextBytes: 0,
            omittedMetadataBytes: 0,
          },
        },
      ],
    };
    const module = createTaskBasisQueryModule({
      taskGraph: {
        readTaskTurnReferenceScope: () => ({ projectId: 'project-a' }),
        readTaskTurnReferenceLinks: () => [
          {
            id: 'answer-a',
            targetId: encodeTaskTurnReference('session-a', 'turn-a'),
          },
        ],
      },
      sessionQueries: { readAnswerBasis: async () => answerWithResult },
      outputs: { list: async () => [] },
      toolResultReferences: {
        read: async () => ({
          status: 'found' as const,
          references: [
            {
              referenceId: 'keep-a',
              ref: {
                authority: '@kontourai/thread' as const,
                schemaVersion: '1.2.0' as const,
                kind: 'result' as const,
                threadId: 'session-a',
                resultId: 'event-a',
              },
              result: answerWithResult.results[0]!.result,
            },
            {
              referenceId: 'keep-b',
              ref: {
                authority: '@kontourai/thread' as const,
                schemaVersion: '1.2.0' as const,
                kind: 'result' as const,
                threadId: 'session-a',
                resultId: 'event-not-in-answer',
              },
              result: answerWithResult.results[0]!.result,
            },
          ],
          gaps: [{ state: 'unavailable' as const }],
        }),
      },
    });
    const outcome = await module.read({
      taskId: 'task-a',
      authority: sessionReadAuthorityFromRequest('owner', undefined, undefined),
    });
    expect(outcome).toMatchObject({
      status: 'found',
      data: {
        keptToolResults: [
          {
            referenceId: 'keep-a',
            associatedAnswerReferenceIds: ['answer-a'],
          },
          {
            referenceId: 'keep-b',
            associatedAnswerReferenceIds: [],
          },
        ],
        gaps: [{ state: 'unavailable' }],
      },
    });
  });

  test('omits unsafe owner display context without aborting the Surface projection', () => {
    const projection = composeAuthorizedSessionAnswerBasis({
      ...answer,
      inputs: [
        {
          ...answer.inputs[0]!,
          prompt: 'line\n\u202Eunsafe',
        },
      ],
    });
    expect(projection.standing).toBe('execution-only');
    expect(projection.regions.inputs[0]).toMatchObject({
      context: { kind: 'station-input', inputKind: 'initial' },
      gaps: [{ code: 'owner-context-not-captured' }],
    });
    expect(JSON.stringify(projection)).not.toContain('unsafe');
  });

  test('does not combine an R1 Task assessment with an association-only R2 source', async () => {
    let associationHead = 'R1';
    const readAssessment = vi.fn(async () => ({
      assessment: {
        owner: { authority: '@kontourai/surface' as const },
        state: 'not-captured' as const,
        observedAt,
      },
      reviewedSource: {
        revision: 1,
        artifactSha: 'a'.repeat(64),
        association: { exactRef: 'R1' },
        assessment: {} as never,
        evidence: {} as never,
        current: () => associationHead === 'R1',
      },
    }));
    const readReviewedSource = vi.fn(async (input: any) => {
      // Deterministic owner-await hook: R2 changes only association state.
      associationHead = 'R2';
      return input.assessment.reviewedSource.current() ? {} : undefined;
    });
    const module = createTaskBasisQueryModule({
      taskGraph: {
        readTaskTurnReferenceScope: () => ({ projectId: 'project-a' }),
        readTaskTurnReferenceLinks: () => [
          {
            id: 'keep-a',
            targetId: encodeTaskTurnReference('session-a', 'turn-a'),
          },
        ],
      },
      sessionQueries: { readAnswerBasis: async () => answer },
      outputs: { list: async () => [] },
      toolResultReferences: noKeptToolResults,
      readAssessment: readAssessment as never,
      readReviewedSource: readReviewedSource as never,
    });
    const outcome = await module.read({
      taskId: 'task-a',
      answerReferenceId: 'keep-a',
      authority: sessionReadAuthorityFromRequest('owner', undefined, undefined),
    });
    expect(outcome).toMatchObject({ status: 'found' });
    expect(JSON.stringify(outcome)).not.toContain('fieldwork');
    expect(readAssessment).toHaveBeenCalledTimes(1);
    expect(readReviewedSource).toHaveBeenCalledTimes(1);
  });
});
