import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { composeAuthorizedSessionAnswerBasis } from '../../projects/task-basis-module.js';
import { createExactAnswerBasisModule } from '../exact-answer-basis-module.js';
import {
  reviewedSourceSessionInventoryGroup,
  reviewedSourceSessionInventoryRow,
} from '../reviewed-source-session-inventory-adapter.js';

const authority = sessionReadAuthorityFromRequest(
  'owner',
  undefined,
  undefined,
);
const answer = {
  status: 'found' as const,
  sessionId: 'session-a',
  turnId: 'turn-a',
  observedAt: '2026-08-27T00:00:00.000Z',
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
      messageId: 'message-a',
    },
  },
  inputs: [],
  results: [],
};
const assessment = {
  assessment: {
    owner: { authority: '@kontourai/surface' as const },
    state: 'not-captured' as const,
    observedAt: answer.observedAt,
  },
};

describe('ExactAnswerBasisModule', () => {
  test('reads every exact owner once and refuses a revoked publication', async () => {
    let current = true;
    const readAssessment = vi.fn(async () => assessment);
    const readNarrative = vi.fn(async () => ({
      owner: { authority: '@kontourai/thread' as const },
      state: 'observed-empty' as const,
      observedAt: answer.observedAt,
      value: [],
    }));
    const readReviewedSource = vi.fn(async () => undefined);
    const module = createExactAnswerBasisModule({
      hosted: () => false,
      canReadSession: () => true,
      readAnswer: (async () => answer) as never,
      readAssessment,
      readNarrative: readNarrative as never,
      readReviewedSource,
    });
    await expect(
      module.read({
        sessionId: 'session-a',
        turnId: 'turn-a',
        authority,
        current: () => current,
      }),
    ).resolves.toMatchObject({ status: 'found' });
    expect(readAssessment).toHaveBeenCalledTimes(1);
    expect(readNarrative).toHaveBeenCalledTimes(1);
    expect(readReviewedSource).toHaveBeenCalledTimes(1);
    readAssessment.mockImplementationOnce(async () => {
      current = false;
      return assessment;
    });
    current = true;
    await expect(
      module.read({
        sessionId: 'session-a',
        turnId: 'turn-a',
        authority,
        current: () => current,
      }),
    ).resolves.toEqual({ status: 'not-found' });
  });

  test('maps one exact reviewed contribution without inferring support', () => {
    const row = reviewedSourceSessionInventoryRow({
      sessionId: 'session-a',
      turnId: 'turn-a',
      answerReferenceId: 'message-a',
      basis: composeAuthorizedSessionAnswerBasis(answer as never),
      contribution: {
        owner: { authority: '@kontourai/fieldwork' },
        state: 'available',
        observedAt: answer.observedAt,
        value: [
          {
            ref: {
              authority: '@kontourai/fieldwork',
              schemaVersion: 'fieldwork.kontourai.io/v1',
              kind: 'reviewed-web-source',
              exactRef: `fieldwork-reviewed-source:v1:${'a'.repeat(64)}`,
              evidenceId: 'evidence-a',
            },
            answer: answer.binding.answer,
            role: 'source',
            context: {
              kind: 'reviewed-source',
              sourceClaimId: 's',
              sourceEvidenceId: 'evidence-a',
              answerClaimId: 'a',
              answerCitationEvidenceId: 'c',
              assessmentRevision: 3,
              review: 'accepted',
              reviewedAt: null,
              currentness: 'current',
              checkedAt: answer.observedAt,
              expectedCapture: null,
              observedCapture: null,
            },
          },
        ],
      } as never,
    });
    expect(row).toMatchObject({
      relations: ['contributed-to'],
      reviewedSource: {
        exactRef: `fieldwork-reviewed-source:v1:${'a'.repeat(64)}`,
        currentness: 'current',
      },
    });
    expect(row?.relations).not.toContain('supports');
  });

  test('keeps an authorized hosted answer and Basis while publishing only an unavailable Fieldwork descriptor', async () => {
    const personalAssessment = vi.fn(async () => assessment);
    const personalNarrative = vi.fn(async () => undefined);
    const personalReviewed = vi.fn(async () => undefined);
    const module = createExactAnswerBasisModule({
      hosted: () => true,
      canReadSession: () => true,
      readAnswer: async () => answer as never,
      readAssessment: personalAssessment,
      readNarrative: personalNarrative as never,
      readReviewedSource: personalReviewed,
    });
    const result = await module.read({
      sessionId: 'session-a',
      turnId: 'turn-a',
      authority: { ...authority, mode: 'hosted' },
      current: () => true,
    });
    expect(result).toMatchObject({
      status: 'found',
      projection: { answer: { state: 'available' } },
      reviewedSource: {
        owner: { authority: '@kontourai/fieldwork' },
        state: 'unavailable',
      },
    });
    expect(personalAssessment).not.toHaveBeenCalled();
    expect(personalNarrative).not.toHaveBeenCalled();
    expect(personalReviewed).not.toHaveBeenCalled();
  });

  test('publishes only closed Fieldwork source gaps and never turns a support edge into support', () => {
    const basis = composeAuthorizedSessionAnswerBasis(answer as never);
    const contribution = {
      owner: { authority: '@kontourai/fieldwork' },
      state: 'available',
      observedAt: answer.observedAt,
      value: [
        {
          ref: {
            authority: '@kontourai/fieldwork',
            schemaVersion: 'fieldwork.kontourai.io/v1',
            kind: 'reviewed-web-source',
            exactRef: `fieldwork-reviewed-source:v1:${'b'.repeat(64)}`,
            evidenceId: 'evidence-a',
          },
          answer: answer.binding.answer,
          role: 'source',
          context: {
            kind: 'reviewed-source',
            sourceClaimId: 'source-claim',
            sourceEvidenceId: 'evidence-a',
            answerClaimId: 'answer-claim',
            answerCitationEvidenceId: 'citation-a',
            assessmentRevision: 1,
            review: 'not-accepted',
            reviewedAt: null,
            currentness: 'drifted',
            checkedAt: answer.observedAt,
            expectedCapture: null,
            observedCapture: null,
          },
          gaps: [
            {
              code: 'reviewed-source-drifted',
              message:
                'Reviewed source context is incomplete or requires attention.',
            },
          ],
        },
      ],
    } as never;
    const row = reviewedSourceSessionInventoryRow({
      sessionId: 'session-a',
      turnId: 'turn-a',
      answerReferenceId: 'message-a',
      contribution,
      basis: {
        ...basis,
        relationships: [
          {
            kind: 'supports',
            from: 'evidence:evidence-a',
            to: 'answer-claim',
            source: 'surface-assessment',
            gaps: [],
          },
        ],
      },
    });
    expect(row).toMatchObject({
      relations: ['contributed-to'],
      contributionGaps: ['reviewed-source-drifted'],
    });
    expect(row?.relations).not.toContain('supports');
    expect(
      reviewedSourceSessionInventoryGroup({
        sessionId: 'session-a',
        turnId: 'turn-a',
        answerReferenceId: 'message-a',
        contribution: {
          owner: { authority: '@kontourai/fieldwork' },
          state: 'unavailable',
          observedAt: answer.observedAt,
        } as never,
        basis,
      }),
    ).toMatchObject({
      state: 'unavailable',
      items: [],
      gaps: [{ kind: 'unavailable' }],
    });
  });
});
