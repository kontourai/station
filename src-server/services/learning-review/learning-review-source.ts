import { z } from 'zod/v3';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/);

export const learningReviewSourceSelectionSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('task-standing'),
        taskId: id,
        taskCreatedAt: z.string().datetime(),
        recordKind: z.enum(['decision', 'dead-end']),
        key: z.string().min(1).max(128),
        version: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('rated-feedback'),
        conversationId: z.string().min(1).max(512),
        turnId: z.string().min(1).max(512),
        ratingId: z.string().min(1).max(512),
      })
      .strict(),
  ],
);
