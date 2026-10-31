import type { KnowledgeLearningScope } from '@kontourai/flow-agents/knowledge-learning-contract';
import { LEARNING_REVIEW_PROJECT_HEADER } from '@kontourai/station-contracts/learning-review';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import type { LearningReviewService } from '../../services/learning-review/learning-review-service.js';
import { learningReviewSourceSelectionSchema as selection } from '../../services/learning-review/learning-review-source.js';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/);
const reference = z
  .object({
    authority: z.string().min(1).max(512),
    kind: z.string().min(1).max(512),
    id: z.string().min(1).max(512),
    revision: z.string().min(1).max(512),
  })
  .strict();
const base = {
  intentId: id,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
const intent = z.discriminatedUnion('action', [
  z
    .object({
      ...base,
      action: z.literal('evaluate'),
      status: z.enum(['supported', 'countered', 'mixed', 'inconclusive']),
      evidence: z.array(reference).min(1).max(32),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('approve'),
      rationale: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('reject'),
      rationale: z.string().min(1).max(4096),
    })
    .strict(),
  z.object({ ...base, action: z.literal('activate') }).strict(),
  z
    .object({
      ...base,
      action: z.literal('observe-effect'),
      assessment: z.enum(['supported', 'countered', 'unresolved']),
      evidence: reference.optional(),
      source: selection.optional(),
      expectedSourceRef: reference.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('retire'),
      reason: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('supersede'),
      replacementId: id,
      replacementRevision: z.string().min(1).max(512),
    })
    .strict(),
]);
const proposal = z
  .object({
    intentId: id,
    learningId: id,
    expectedSourceRef: reference.optional(),
    source: selection,
    kind: z.enum(['guideline', 'skill', 'claim', 'rule', 'evaluation']),
    title: z.string().min(1).max(240),
    body: z.string().min(1).max(16384),
    expectedEffect: z.string().min(1).max(2048),
  })
  .strict();

export interface ProjectLearningAdmission {
  scope: KnowledgeLearningScope;
  service: LearningReviewService;
  isCurrent(): boolean | Promise<boolean>;
}

export function createProjectLearningReviewRoutes(deps: {
  enabled(): boolean;
  authorize(
    request: Request,
    slug: string,
    action: 'read' | 'write',
  ): Promise<ProjectLearningAdmission | undefined>;
}) {
  const app = new Hono();
  async function run(
    c: Context,
    operation: 'list' | 'get' | 'prepare' | 'inspect' | 'propose' | 'apply',
  ) {
    if (!deps.enabled())
      return c.json(
        {
          success: false,
          code: 'feature_preview_disabled',
          previewId: 'learning-lifecycle-review',
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
          error: 'Enable Learning lifecycle review in Feature previews.',
        },
        404,
      );
    const access = await deps.authorize(
      c.req.raw,
      c.req.param('slug'),
      operation === 'list' || operation === 'get' || (operation === 'inspect' || operation === 'prepare')
        ? 'read'
        : 'write',
    );
    if (access?.scope.kind !== 'project')
      return c.json(
        {
          success: false,
          error: 'Learning review restricted',
          code: 'restricted',
        },
        403,
      );
    if (c.req.header(LEARNING_REVIEW_PROJECT_HEADER) !== access.scope.id)
      return c.json(
        {
          success: false,
          error: 'The selected Project changed',
          code: 'learning_review_project_changed',
        },
        409,
      );
    const current = async () =>
      !c.req.raw.signal.aborted && deps.enabled() && (await access.isCurrent());
    if (!(await current()))
      return c.json(
        {
          success: false,
          error: 'Learning review restricted',
          code: 'restricted',
        },
        403,
      );
    try {
      let data: unknown;
      const learningId = c.req.param('id');
      if (operation === 'list') data = await access.service.list(access.scope);
      else if (operation === 'get') {
        if (
          !id.safeParse(learningId).success ||
          (c.req.query('compareId') &&
            !id.safeParse(c.req.query('compareId')).success)
        )
          return c.json(
            { success: false, error: 'Invalid learning reference' },
            400,
          );
        data = await access.service.get(
          access.scope,
          learningId,
          c.req.query('compareId'),
        );
      } else {
        const body = await readBoundedRequestBody(c.req.raw, 65536);
        if (body.status !== 'ok')
          return c.json(
            {
              success: false,
              error: 'Learning request unavailable or too large',
            },
            body.status === 'too-large' ? 413 : 400,
          );
        const value: unknown = JSON.parse(body.body);
        if (operation === 'prepare') {
          const parsed = z.object({ source: selection }).strict().safeParse(value);
          if (!parsed.success) return c.json({ success: false, error: 'Invalid source selection' }, 400);
          data = await access.service.prepare(access.scope, parsed.data.source);
        } else if (operation === 'inspect') {
          const parsed = z.object({ reference }).strict().safeParse(value);
          if (!parsed.success || !id.safeParse(learningId).success)
            return c.json(
              { success: false, error: 'Invalid evidence reference' },
              400,
            );
          data = await access.service.inspect(
            access.scope,
            learningId,
            parsed.data.reference,
          );
        } else if (operation === 'propose') {
          const parsed = proposal.safeParse(value);
          if (!parsed.success)
            return c.json(
              { success: false, error: 'Invalid learning proposal' },
              400,
            );
          data = await access.service.propose(access.scope, parsed.data);
        } else {
          const parsed = intent.safeParse(value);
          if (!parsed.success || !id.safeParse(learningId).success)
            return c.json(
              { success: false, error: 'Invalid learning intent' },
              400,
            );
          if (parsed.data.action === 'observe-effect') {
            const effect = parsed.data;
            if (Boolean(effect.source) === Boolean(effect.evidence))
              return c.json(
                { success: false, error: 'Choose one exact effect source' },
                400,
              );
            data = await access.service.apply(
              access.scope,
              learningId,
              effect.source
                ? {
                    intentId: effect.intentId,
                    expectedRevision: effect.expectedRevision,
                    action: 'observe-effect',
                    assessment: effect.assessment,
                    source: effect.source,
                    expectedSourceRef: effect.expectedSourceRef,
                  }
                : {
                    intentId: effect.intentId,
                    expectedRevision: effect.expectedRevision,
                    action: 'observe-effect',
                    assessment: effect.assessment,
                    evidence: effect.evidence!,
                  },
            );
          } else
            data = await access.service.apply(
              access.scope,
              learningId,
              parsed.data,
            );
        }
      }
      return guardProjectResponse(c.json({ success: true, data }), current);
    } catch (error) {
      const supplied =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : '';
      const code = [
        'invalid',
        'restricted',
        'stale',
        'conflict',
        'not-found',
        'unavailable',
        'capacity',
      ].includes(supplied)
        ? supplied
        : 'unavailable';
      return c.json(
        {
          success: false,
          code,
          error:
            error instanceof SyntaxError
              ? 'Invalid learning request'
              : `Learning review ${code}`,
        },
        error instanceof SyntaxError || code === 'invalid'
          ? 400
          : code === 'restricted'
            ? 403
            : code === 'stale' || code === 'conflict'
              ? 409
              : 503,
      );
    }
  }
  app.get('/:slug/learning', (c) => run(c, 'list'));
  app.get('/:slug/learning/:id', (c) => run(c, 'get'));
  app.post('/:slug/learning/source', (c) => run(c, 'prepare'));
  app.post('/:slug/learning/:id/evidence', (c) => run(c, 'inspect'));
  app.post('/:slug/learning/proposals', (c) => run(c, 'propose'));
  app.post('/:slug/learning/:id/intents', (c) => run(c, 'apply'));
  return app;
}
