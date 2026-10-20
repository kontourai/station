import { z } from 'zod/v3';

/**
 * #3386: where a conversation no project claims continues. Only a name is
 * accepted, never a path: the folder is always the conversation's own,
 * re-verified by the adoption owner.
 */
export const adoptSessionTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('project'),
      projectSlug: z.string().min(1).max(512),
    })
    .strict(),
  z.object({ kind: z.literal('own-folder') }).strict(),
]);
