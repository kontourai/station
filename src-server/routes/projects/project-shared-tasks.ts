import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import type {
  ProjectSharedTaskDocument,
  ProjectSharedTaskHistory,
  ProjectSharedTaskPublicationExpectation,
} from '@kontourai/station-contracts/project-shared-task';
import { parseProjectTaskRoomBrowserHistory } from '@kontourai/station-contracts/project-task-room-browser';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import type { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import { ProjectMembershipRefusal } from '../../services/projects/project-membership-store.js';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';
import type {
  ProjectSharedTaskAuthority,
  ProjectSharedTaskService,
} from '../../services/projects/project-shared-task-service.js';
import {
  type ProjectSharedTaskAdmission,
  ProjectSharedTaskRefusal,
} from '../../services/projects/project-shared-task-store.js';
import { getBody, param, validate } from '../schemas/schemas.js';

export function createProjectSharedTaskRoutes(deps: {
  service: ProjectSharedTaskService;
  room: Pick<ProjectTaskRoomRuntime, 'sharedHistory' | 'sharedDocument'>;
  scope(request: Request, slug: string): Promise<ProjectMembershipScope>;
  authority(request: Request): Promise<ProjectSharedTaskAuthority>;
}) {
  const app = new Hono();
  const missing = () =>
    Response.json(
      { success: false, error: 'Shared Task not found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  const failure = (error: unknown) =>
    error instanceof ProjectMembershipRefusal ||
    (error instanceof ProjectSharedTaskRefusal && error.code !== 'unavailable')
      ? missing()
      : Response.json(
          { success: false, error: 'Shared Task unavailable' },
          { status: 503, headers: { 'Cache-Control': 'no-store' } },
        );
  const guarded = async (
    response: Response,
    admission: ProjectSharedTaskAdmission,
    authority: ProjectSharedTaskAuthority,
  ) =>
    guardProjectResponse(response, async () => {
      try {
        await deps.service.revalidate(admission, authority);
        return true;
      } catch (error) {
        if (
          error instanceof ProjectMembershipRefusal ||
          error instanceof ProjectSharedTaskRefusal
        )
          return false;
        throw error;
      }
    });
  const expectationSchema = z
    .object({
      project: z
        .object({
          stationId: z.string().min(1).max(256),
          localProjectId: z.string().min(1).max(256),
          localProjectSlug: z.string().min(1).max(256),
          portableProjectId: z.string().min(1).max(256),
        })
        .strict(),
      task: z
        .object({
          id: z.string().min(1).max(256),
          createdAt: z.string().datetime(),
        })
        .strict(),
    })
    .strict();
  app.put('/:slug/shared-work/:taskId', async (c) => {
    try {
      const raw = await c.req.raw.clone().text();
      const expected = raw
        ? expectationSchema.parse(JSON.parse(raw))
        : undefined;
      const authority = await deps.authority(c.req.raw);
      const scope = await deps.scope(c.req.raw, c.req.param('slug'));
      const admission = await deps.service.share(
        scope,
        c.req.param('taskId'),
        authority,
        expected as ProjectSharedTaskPublicationExpectation | undefined,
      );
      return c.json(
        {
          success: true,
          data: expected
            ? await deps.service.publication(
                scope,
                c.req.param('taskId'),
                authority,
              )
            : admission,
        },
        201,
      );
    } catch (error) {
      return failure(error);
    }
  });
  app.delete(
    '/:slug/shared-work/:taskId',
    validate(
      z
        .object({
          shareId: z.string().uuid(),
          expected: expectationSchema.optional(),
        })
        .strict(),
    ),
    async (c) => {
      try {
        const authority = await deps.authority(c.req.raw);
        const scope = await deps.scope(c.req.raw, param(c, 'slug'));
        return c.json({
          success: true,
          data: await deps.service.unshare(
            scope,
            param(c, 'taskId'),
            (getBody(c) as { shareId: string }).shareId,
            authority,
            (
              getBody(c) as {
                expected?: ProjectSharedTaskPublicationExpectation;
              }
            ).expected,
          ),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
  app.get('/:slug/shared-work', async (c) => {
    try {
      const scope = await deps.scope(c.req.raw, c.req.param('slug'));
      const authority = await deps.authority(c.req.raw);
      const data = await deps.service.list(scope, authority);
      if (
        Buffer.byteLength(JSON.stringify({ success: true, data })) >
        1024 * 1024
      )
        return failure(new ProjectSharedTaskRefusal('unavailable'));
      return guardProjectResponse(
        Response.json(
          { success: true, data },
          { headers: { 'Cache-Control': 'no-store' } },
        ),
        async () => {
          try {
            await authority.requireProjectRead(scope);
            for (const summary of data)
              await deps.service.revalidateSummary(summary, authority);
            return true;
          } catch (error) {
            if (
              error instanceof ProjectMembershipRefusal ||
              error instanceof ProjectSharedTaskRefusal
            )
              return false;
            throw error;
          }
        },
      );
    } catch (error) {
      return failure(error);
    }
  });
  app.get('/:slug/shared-work/:taskId/publication', async (c) => {
    try {
      const authority = await deps.authority(c.req.raw);
      const scope = await deps.scope(c.req.raw, c.req.param('slug'));
      const taskId = c.req.param('taskId');
      const data = await deps.service.publication(scope, taskId, authority);
      return guardProjectResponse(
        Response.json(
          { success: true, data },
          { headers: { 'Cache-Control': 'no-store' } },
        ),
        async () => {
          try {
            const current = await deps.service.publication(
              scope,
              taskId,
              authority,
            );
            return JSON.stringify(current) === JSON.stringify(data);
          } catch (error) {
            if (
              error instanceof ProjectMembershipRefusal ||
              error instanceof ProjectSharedTaskRefusal
            )
              return false;
            throw error;
          }
        },
      );
    } catch (error) {
      return failure(error);
    }
  });
  app.get('/:slug/shared-work/:taskId/history', async (c) => {
    try {
      const authority = await deps.authority(c.req.raw);
      const admission = await deps.service.admitRead(
        await deps.scope(c.req.raw, c.req.param('slug')),
        c.req.param('taskId'),
        authority,
      );
      const value = await deps.room.sharedHistory({
        taskId: admission.taskId,
        request: c.req.raw,
        current: async () => {
          try {
            await deps.service.revalidate(admission, authority);
            return true;
          } catch (error) {
            if (
              error instanceof ProjectMembershipRefusal ||
              error instanceof ProjectSharedTaskRefusal
            )
              return false;
            throw error;
          }
        },
      });
      await deps.service.revalidate(admission, authority);
      const history = humanHistory(value);
      if (
        history &&
        Buffer.byteLength(JSON.stringify({ success: true, data: history })) >
          1024 * 1024
      )
        return guarded(
          Response.json(
            { success: true, data: { kind: 'too-large' } },
            { headers: { 'Cache-Control': 'no-store' } },
          ),
          admission,
          authority,
        );
      return history
        ? guarded(
            Response.json(
              { success: true, data: history },
              { headers: { 'Cache-Control': 'no-store' } },
            ),
            admission,
            authority,
          )
        : missing();
    } catch (error) {
      return failure(error);
    }
  });
  app.get('/:slug/shared-work/:taskId/document', async (c) => {
    try {
      const authority = await deps.authority(c.req.raw);
      const admission = await deps.service.admitRead(
        await deps.scope(c.req.raw, c.req.param('slug')),
        c.req.param('taskId'),
        authority,
      );
      const value = await deps.room.sharedDocument({
        taskId: admission.taskId,
        request: c.req.raw,
        current: async () => {
          try {
            await deps.service.revalidate(admission, authority);
            return true;
          } catch (error) {
            if (
              error instanceof ProjectMembershipRefusal ||
              error instanceof ProjectSharedTaskRefusal
            )
              return false;
            throw error;
          }
        },
      });
      await deps.service.revalidate(admission, authority);
      if (
        value.kind !== 'snapshot' ||
        typeof value.revision !== 'string' ||
        typeof value.text !== 'string'
      )
        return missing();
      const success = {
        success: true,
        data: {
          kind: 'snapshot',
          project: {
            id: admission.scope.localProjectId,
            slug: admission.scope.localProjectSlug,
          },
          task: { id: admission.taskId, createdAt: admission.taskCreatedAt },
          revision: value.revision,
          text: value.text,
        },
      } as const;
      if (Buffer.byteLength(JSON.stringify(success)) > 1024 * 1024)
        return guarded(
          Response.json(
            { success: true, data: { kind: 'too-large' } },
            { headers: { 'Cache-Control': 'no-store' } },
          ),
          admission,
          authority,
        );
      const data: ProjectSharedTaskDocument = success.data;
      return guarded(
        Response.json(
          { success: true, data },
          { headers: { 'Cache-Control': 'no-store' } },
        ),
        admission,
        authority,
      );
    } catch (error) {
      return failure(error);
    }
  });
  return app;
}
function humanHistory(value: unknown): ProjectSharedTaskHistory | undefined {
  const parsed = parseProjectTaskRoomBrowserHistory(value);
  if (parsed?.kind !== 'available') return undefined;
  if (parsed.hasMore) return { kind: 'unavailable' };
  return {
    kind: 'available',
    records: parsed.records.flatMap((record) =>
      record?.body?.kind === 'human-message'
        ? [
            {
              actor: { kind: record.actor.kind, label: record.actor.label },
              sequence: record.sequence,
              body: { kind: 'human-message' as const, text: record.body.text },
              digests: {
                proposal: record.digests.proposal,
                checkpoint: record.digests.checkpoint,
              },
              integrity: 'L0' as const,
            },
          ]
        : [],
    ),
    checkpoint: {
      throughSeq: parsed.checkpoint.throughSeq,
      checkpointDigest: parsed.checkpoint.checkpointDigest,
      retainedAnchorSeq: parsed.checkpoint.retainedAnchorSeq,
      retainedAnchorDigest: parsed.checkpoint.retainedAnchorDigest,
    },
    hasMore: false,
  };
}
