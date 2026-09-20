import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import type {
  ProjectSharedTaskDocument,
  ProjectSharedTaskHistory,
} from '@kontourai/station-contracts/project-shared-task';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import type { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';
import type {
  ProjectSharedTaskAuthority,
  ProjectSharedTaskService,
} from '../../services/projects/project-shared-task-service.js';
import { type ProjectSharedTaskAdmission } from '../../services/projects/project-shared-task-store.js';
import { getBody, param, validate } from '../schemas/schemas.js';

export function createProjectSharedTaskRoutes(deps: {
  service: ProjectSharedTaskService;
  room: Pick<ProjectTaskRoomRuntime, 'history' | 'document'>;
  scope(request: Request, slug: string): Promise<ProjectMembershipScope>;
  authority(request: Request): Promise<ProjectSharedTaskAuthority>;
}) {
  const app = new Hono();
  const missing = () =>
    Response.json(
      { success: false, error: 'Shared Task not found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
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
      } catch {
        return false;
      }
    });
  app.put('/:slug/shared-work/:taskId', async (c) => {
    try {
      const authority = await deps.authority(c.req.raw);
      const scope = await deps.scope(c.req.raw, c.req.param('slug'));
      return c.json(
        {
          success: true,
          data: await deps.service.share(
            scope,
            c.req.param('taskId'),
            authority,
          ),
        },
        201,
      );
    } catch {
      return missing();
    }
  });
  app.delete(
    '/:slug/shared-work/:taskId',
    validate(z.object({ shareId: z.string().uuid() }).strict()),
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
          ),
        });
      } catch {
        return missing();
      }
    },
  );
  app.get('/:slug/shared-work', async (c) => {
    try {
      const scope = await deps.scope(c.req.raw, c.req.param('slug'));
      const authority = await deps.authority(c.req.raw);
      const data = await deps.service.list(scope, authority);
      return guardProjectResponse(
        Response.json(
          { success: true, data },
          { headers: { 'Cache-Control': 'no-store' } },
        ),
        async () => {
          try {
            await authority.requireProjectRead(scope);
            return true;
          } catch {
            return false;
          }
        },
      );
    } catch {
      return missing();
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
      const value = await deps.room.history({
        taskId: admission.taskId,
        request: c.req.raw,
        project: true,
      });
      await deps.service.revalidate(admission, authority);
      const history = humanHistory(value);
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
    } catch {
      return missing();
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
      const value = await deps.room.document({
        taskId: admission.taskId,
        request: c.req.raw,
      });
      await deps.service.revalidate(admission, authority);
      if (
        value.kind !== 'snapshot' ||
        typeof value.revision !== 'string' ||
        typeof value.text !== 'string'
      )
        return missing();
      const data: ProjectSharedTaskDocument = {
        kind: 'snapshot',
        project: {
          id: admission.scope.localProjectId,
          slug: admission.scope.localProjectSlug,
        },
        task: { id: admission.taskId, createdAt: admission.taskCreatedAt },
        revision: value.revision,
        text: value.text,
      };
      return guarded(
        Response.json(
          { success: true, data },
          { headers: { 'Cache-Control': 'no-store' } },
        ),
        admission,
        authority,
      );
    } catch {
      return missing();
    }
  });
  return app;
}
function humanHistory(value: any): ProjectSharedTaskHistory | undefined {
  if (value?.kind !== 'available' || !Array.isArray(value.records))
    return undefined;
  return {
    kind: 'available',
    records: value.records.filter(
      (record: any) => record?.body?.kind === 'human-message',
    ),
    checkpoint: value.checkpoint,
    hasMore: value.hasMore,
    ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}),
  };
}
