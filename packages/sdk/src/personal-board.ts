import { z } from 'zod/v3';

export const personalBoardSlugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => !value.includes('..'), 'Use a safe path segment');
const projectSlug = personalBoardSlugSchema.optional();
const limit = z.number().int().min(1).max(30);
const sectionBase = {
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().trim().min(1).max(120),
  width: z.enum(['half', 'full']),
};
const href = z
  .string()
  .max(2048)
  .refine((value) => {
    if (
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !Array.from(value).some(
        (character) => character === '\\' || character.charCodeAt(0) <= 32,
      )
    )
      return true;
    try {
      return ['https:', 'http:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Use an internal Station path or an http/https URL');

export const personalBoardDefinitionSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000),
    sections: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .object({
              ...sectionBase,
              kind: z.literal('tasks'),
              projectSlug,
              includeCompleted: z.boolean().optional(),
              limit,
            })
            .strict(),
          z
            .object({
              ...sectionBase,
              kind: z.literal('attention'),
              projectSlug,
              limit,
            })
            .strict(),
          z
            .object({
              ...sectionBase,
              kind: z.literal('recent-work'),
              projectSlug,
              limit,
            })
            .strict(),
          z
            .object({ ...sectionBase, kind: z.literal('projects'), limit })
            .strict(),
          z
            .object({
              ...sectionBase,
              kind: z.literal('note'),
              body: z.string().max(12000),
            })
            .strict(),
          z
            .object({
              ...sectionBase,
              kind: z.literal('links'),
              links: z
                .array(
                  z
                    .object({ label: z.string().trim().min(1).max(120), href })
                    .strict(),
                )
                .max(30),
            })
            .strict(),
        ]),
      )
      .max(24),
  })
  .strict()
  .superRefine((board, ctx) => {
    if (
      new Set(board.sections.map((section) => section.id)).size !==
      board.sections.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sections'],
        message: 'Section IDs must be unique',
      });
    }
  });

export const personalBoardProposalSchema = z
  .object({
    revision: z.string().length(64).nullable(),
    definition: personalBoardDefinitionSchema,
  })
  .strict();
export const personalBoardSaveSchema = personalBoardProposalSchema.extend({
  revision: z.string().length(64),
});
export const personalBoardDismissSchema = z
  .object({ revision: z.string().length(64) })
  .strict();
