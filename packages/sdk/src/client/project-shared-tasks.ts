import {
  PROJECT_SHARED_TASK_VERSION,
  type ProjectSharedTaskDocument,
  type ProjectSharedTaskHistory,
  type ProjectSharedTaskSummary,
} from '@kontourai/station-contracts/project-shared-task';
import { z } from 'zod/v3';
import { getJson } from './http';
import { unwrapProjectResponse } from './project-response';

const id = z.string().min(1).max(256);
const scope = z
  .object({
    stationId: id,
    localProjectId: id,
    localProjectSlug: id,
    portableProjectId: id,
  })
  .strict();
const summary = z
  .object({
    version: z.literal(PROJECT_SHARED_TASK_VERSION),
    project: scope,
    task: z
      .object({
        id,
        title: z.string().min(1).max(240),
        status: z.enum([
          'todo',
          'ready',
          'triage',
          'in_progress',
          'blocked',
          'review',
          'verification',
          'done',
          'canceled',
        ]),
        createdAt: z.string().datetime(),
      })
      .strict(),
    shareId: z.string().uuid(),
    sharedAt: z.string().datetime(),
  })
  .strict();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const history = z
  .object({
    kind: z.literal('available'),
    records: z
      .array(
        z
          .object({
            actor: z
              .object({
                kind: z.enum(['human', 'agent']),
                label: z.string().max(256),
              })
              .strict(),
            sequence: z.number().int().positive(),
            body: z
              .object({
                kind: z.literal('human-message'),
                text: z.string().max(16 * 1024),
              })
              .strict(),
            digests: z
              .object({ proposal: digest, checkpoint: digest })
              .strict(),
            integrity: z.literal('L0'),
          })
          .strict(),
      )
      .max(100),
    checkpoint: z
      .object({
        throughSeq: z.number().int().nonnegative(),
        checkpointDigest: digest,
        retainedAnchorSeq: z.number().int().nonnegative(),
        retainedAnchorDigest: digest,
      })
      .strict(),
    hasMore: z.boolean(),
    nextCursor: z.string().max(4096).optional(),
  })
  .strict();
const document = z
  .object({
    kind: z.literal('snapshot'),
    project: z.object({ id, slug: id }).strict(),
    task: z.object({ id, createdAt: z.string().datetime() }).strict(),
    revision: id,
    text: z.string().max(16 * 1024 * 1024),
  })
  .strict();
async function read<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await getJson(url);
  const value = await unwrapProjectResponse(
    response,
    'Shared Task unavailable',
  );
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('Shared Task response is incompatible');
  return parsed.data;
}
export const listProjectSharedTasks = (
  apiBase: string,
  slug: string,
): Promise<ProjectSharedTaskSummary[]> =>
  read(
    `${apiBase}/api/projects/${encodeURIComponent(slug)}/shared-work`,
    z.array(summary).max(512),
  );
export const readProjectSharedTaskHistory = (
  apiBase: string,
  slug: string,
  taskId: string,
): Promise<ProjectSharedTaskHistory> =>
  read(
    `${apiBase}/api/projects/${encodeURIComponent(slug)}/shared-work/${encodeURIComponent(taskId)}/history`,
    history,
  );
export const readProjectSharedTaskDocument = (
  apiBase: string,
  slug: string,
  taskId: string,
): Promise<ProjectSharedTaskDocument> =>
  read(
    `${apiBase}/api/projects/${encodeURIComponent(slug)}/shared-work/${encodeURIComponent(taskId)}/document`,
    document,
  );
