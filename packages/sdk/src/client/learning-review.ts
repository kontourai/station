import type {
  LearningReviewDetail,
  LearningReviewEvidenceView,
  LearningReviewIndex,
  LearningReviewIntentInput,
  LearningReviewMutationResult,
  LearningReviewPreparedSource,
  LearningReviewProposalInput,
  LearningReviewRevisionRef,
  LearningReviewSourceSelection,
} from '@kontourai/station-contracts/learning-review';
import { LEARNING_REVIEW_PROJECT_HEADER } from '@kontourai/station-contracts/learning-review';
import { z } from 'zod';
import {
  type ApiRequestScope,
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
  StationHttpError,
} from './http';

type Options = ClientRequestOptions & {
  requestScope: ApiRequestScope;
  projectId: string;
};

export function isLearningAccessRefusal(error: unknown): boolean {
  return (
    error instanceof StationHttpError &&
    ([401, 403, 404].includes(error.status) ||
      error.code === 'learning_review_project_changed')
  );
}
const ref = z.object({
  authority: z.string(),
  kind: z.string(),
  id: z.string(),
  revision: z.string().optional(),
});
const revisionRef = ref.extend({ revision: z.string() });
const scope = z.object({
  kind: z.enum(['global', 'project', 'agent', 'session']),
  id: z.string(),
});
const gap = z
  .object({
    state: z.enum([
      'not-captured',
      'restricted',
      'unavailable',
      'unsupported-version',
      'corrupt',
    ]),
  })
  .strict();
const stage = <T extends z.ZodType>(value: T) =>
  z.union([z.object({ state: z.literal('available'), value }), gap]);
const projection = z.object({
  schemaVersion: z.literal('station.learning-review/v1'),
  projectionId: z.string(),
  owner: ref,
  scope,
  source: stage(
    z.array(
      z.object({
        sourceRef: ref,
        kind: z.enum(['feedback', 'receipt', 'observation']),
        capturedAt: z.string(),
        relation: z.enum(['contributed', 'countered', 'context']),
      }),
    ),
  ),
  candidate: stage(
    z.object({
      candidateRef: ref,
      kind: z.enum(['skill', 'claim', 'guideline', 'rule', 'evaluation']),
      title: z.string(),
      expectedEffect: z.string(),
      scope,
      proposedRevisionRef: revisionRef.optional(),
      currentRevisionRef: revisionRef.optional(),
      supportingRefs: z.array(ref),
      counterRefs: z.array(ref),
      conflictRefs: z.array(ref),
      deploymentTargets: z.array(ref),
      freshness: z.object({
        state: z.enum(['current', 'stale', 'unknown']),
        ownerUpdatedAt: z.string().optional(),
        observedAt: z.string(),
      }),
    }),
  ),
  evaluation: stage(
    z.object({
      evaluationRef: ref,
      status: z.enum([
        'pending',
        'supported',
        'countered',
        'mixed',
        'inconclusive',
      ]),
      evidenceRefs: z.array(ref),
      evaluatedAt: z.string().optional(),
    }),
  ),
  decision: stage(
    z.union([
      z.object({
        status: z.enum(['proposed', 'deferred']),
        decisionRef: ref.optional(),
      }),
      z.object({
        status: z.enum(['approved', 'rejected']),
        decisionRef: ref,
        receiptRef: ref,
        decidedAt: z.string(),
      }),
    ]),
  ),
  activation: stage(
    z.union([
      z.object({
        status: z.literal('inactive'),
        deploymentTargets: z.array(ref),
        contributionDisclosures: z.tuple([]),
      }),
      z.object({
        status: z.enum(['active', 'superseded', 'retired']),
        activeRevisionRef: revisionRef,
        activatedAt: z.string(),
        deploymentTargets: z.array(ref),
        contributionDisclosures: z.array(
          z.object({
            turnRef: ref,
            activeRevisionRef: revisionRef,
            coordinate: z
              .object({
                conversationId: z.string(),
                sessionId: z.string(),
                turnId: z.string(),
              })
              .optional(),
          }),
        ),
      }),
    ]),
  ),
  effect: stage(
    z.object({
      observations: z.array(
        z.object({
          observationRef: ref,
          assessment: z.enum(['supported', 'countered', 'unresolved']),
          observedAt: z.string(),
        }),
      ),
    }),
  ),
  retirement: stage(
    z.union([
      z.object({ status: z.literal('not-retired') }),
      z.object({
        status: z.literal('retired'),
        retirementRef: ref,
        receiptRef: ref,
        retiredAt: z.string(),
        reason: z.string(),
      }),
    ]),
  ),
});
const receipt = z.object({
  ref: revisionRef,
  action: z.string(),
  actorId: z.string(),
  at: z.string(),
});
const detail: z.ZodType<LearningReviewDetail> = z.union([
  z.object({
    state: z.literal('available'),
    id: z.string(),
    revision: z.number().int().positive(),
    active: z.boolean(),
    body: z.string(),
    projection,
    receipts: z.array(receipt).max(512),
    contributionCoverage: z
      .enum(['up-to-100-recent-task-turns', 'unavailable'])
      .optional(),
    supersededBy: revisionRef.optional(),
    comparison: z
      .union([
        z.object({
          state: z.literal('available'),
          ref: revisionRef,
          title: z.string(),
          body: z.string(),
          active: z.boolean(),
        }),
        gap,
      ])
      .optional(),
  }),
  gap,
]);
const index: z.ZodType<LearningReviewIndex> = z.union([
  z.object({
    state: z.literal('available'),
    items: z.array(detail).max(64),
    coverage: z.enum(['complete', 'partial']),
  }),
  z
    .object({
      state: z.enum([
        'restricted',
        'unavailable',
        'unsupported-version',
        'corrupt',
      ]),
    })
    .strict(),
]);
const mutation: z.ZodType<LearningReviewMutationResult> = z.object({
  receipt,
  detail,
});
const path = (apiBase: string, slug: string) =>
  `${apiBase}/api/projects/${encodeURIComponent(slug)}/learning`;
async function unwrap<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (response.status === 404 || response.status === 501)
    throw new StationHttpError(
      response.status,
      'Learning review is unsupported on this host. Enable its Feature Preview or update this Station.',
      { code: 'learning_review_unsupported' },
    );
  const body = await readJsonBody(response);
  if (!response.ok) {
    const error = z
      .object({ error: z.string(), code: z.string().optional() })
      .safeParse(body);
    throw new StationHttpError(
      response.status,
      error.success ? error.data.error : 'Learning review unavailable',
      { code: error.success ? error.data.code : 'unavailable' },
    );
  }
  return z.object({ success: z.literal(true), data: schema }).parse(body).data;
}
const bounded = (options: Options): Options => ({
  ...options,
  headers: {
    ...options.headers,
    [LEARNING_REVIEW_PROJECT_HEADER]: options.projectId,
  },
  maxResponseBytes: 2 * 1024 * 1024,
});
export function fetchProjectLearning(
  apiBase: string,
  slug: string,
  options: Options,
): Promise<LearningReviewIndex> {
  return getJson(path(apiBase, slug), bounded(options)).then((response) =>
    unwrap(response, index),
  );
}
export function fetchProjectLearningDetail(
  apiBase: string,
  slug: string,
  id: string,
  compareId: string | undefined,
  options: Options,
): Promise<LearningReviewDetail> {
  return getJson(
    `${path(apiBase, slug)}/${encodeURIComponent(id)}${compareId ? `?compareId=${encodeURIComponent(compareId)}` : ''}`,
    bounded(options),
  ).then((response) => unwrap(response, detail));
}
export function proposeProjectLearning(
  apiBase: string,
  slug: string,
  input: LearningReviewProposalInput,
  options: Options,
): Promise<LearningReviewMutationResult> {
  return mutateJson(
    `${path(apiBase, slug)}/proposals`,
    'POST',
    bounded(options),
    input,
  ).then((response) => unwrap(response, mutation));
}
export function applyProjectLearningIntent(
  apiBase: string,
  slug: string,
  id: string,
  input: LearningReviewIntentInput,
  options: Options,
): Promise<LearningReviewMutationResult> {
  return mutateJson(
    `${path(apiBase, slug)}/${encodeURIComponent(id)}/intents`,
    'POST',
    bounded(options),
    input,
  ).then((response) => unwrap(response, mutation));
}

export async function fetchProjectLearningEvidence(
  apiBase: string,
  slug: string,
  id: string,
  reference: LearningReviewRevisionRef,
  options: Options,
): Promise<LearningReviewEvidenceView> {
  const response = await mutateJson(
    `${path(apiBase, slug)}/${encodeURIComponent(id)}/evidence`,
    'POST',
    bounded(options),
    { reference },
  );
  const view = await unwrap(
    response,
    z.union([
      z.object({
        state: z.literal('available'),
        ref: revisionRef,
        title: z.string().max(240),
        text: z.string().max(16384),
        capturedAt: z.string().optional(),
        truncated: z.boolean().optional(),
      }),
      gap,
    ]),
  );
  if (
    view.state === 'available' &&
    (view.ref.authority !== reference.authority ||
      view.ref.kind !== reference.kind ||
      view.ref.id !== reference.id ||
      view.ref.revision !== reference.revision)
  )
    throw new StationHttpError(
      409,
      'The evidence revision changed. Refresh owner state.',
    );
  return view;
}

export async function prepareProjectLearningSource(
  apiBase: string,
  slug: string,
  source: LearningReviewSourceSelection,
  options: Options,
): Promise<LearningReviewPreparedSource> {
  const response = await mutateJson(
    `${path(apiBase, slug)}/source`,
    'POST',
    bounded(options),
    { source },
  );
  const prepared = await unwrap(
    response,
    z.union([
      z.object({
        state: z.literal('available'),
        projectId: z.string(),
        ref: revisionRef,
        title: z.string().max(240),
        body: z.string().max(16384),
        truncated: z.boolean().optional(),
      }),
      z
        .object({
          state: z.enum([
            'restricted',
            'unavailable',
            'unsupported-version',
            'corrupt',
          ]),
        })
        .strict(),
    ]),
  );
  if (
    prepared.state === 'available' &&
    prepared.projectId !== options.projectId
  )
    throw new StationHttpError(409, 'The selected Project changed.');
  return prepared;
}
