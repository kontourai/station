import type { TaskOutputCreateInput } from '@kontourai/station-contracts';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import { resolveClientOriginForRequest } from '../../security/runtime-request-security.js';
import type { SessionOutputsModule } from '../../services/orchestration/session-outputs-module.js';
import type { TaskGraphService } from '../../services/projects/task-graph-service.js';
import {
  TaskOutputConflictError,
  TaskOutputDeletedOperationError,
  TaskOutputModule,
  TaskOutputNotFoundError,
  TaskOutputUnavailableError,
} from '../../services/projects/task-output-module.js';
import { isBoundedSafePng } from '../../services/projects/workspace-file-preview-service.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const createSchema = z
  .object({
    operationId: z.string().min(1).max(160),
    relativePath: z.string().min(1).max(4096),
    title: z.string().min(1).max(240),
    declaredMediaType: z.string().max(160).optional(),
  })
  .strict();
const keepDeclaredSchema = z
  .object({ operationId: z.string().min(1).max(160) })
  .strict();

/** Task Output transport; all workspace and storage authority remains private. */
export function createTaskOutputRoutes(
  outputs: TaskOutputModule,
  options?: {
    taskGraph: Pick<TaskGraphService, 'readTask' | 'keepDeclaredPullRequest'>;
    sessionOutputs: SessionOutputsModule;
    readAuthorityForRequest: (
      request: Request,
    ) => SessionReadAuthority | undefined;
    canReadSession: (
      sessionId: string,
      authority: SessionReadAuthority,
    ) => boolean;
    isRequestPrincipalCurrent: (request: Request) => boolean;
    resolveProjectWorkspace: (projectId: string) => string | undefined;
  },
) {
  const app = new Hono();
  const unavailable = () => ({
    success: false,
    error: 'Task output unavailable',
  });
  const notFound = () => ({ success: false, error: 'Task output not found' });
  const respondError = (c: any, error: unknown) => {
    if (
      error instanceof TaskOutputConflictError ||
      error instanceof TaskOutputDeletedOperationError
    ) {
      return c.json(
        { success: false, error: 'Task output operation conflicts' },
        409,
      );
    }
    if (error instanceof TaskOutputNotFoundError)
      return c.json(notFound(), 404);
    return c.json(
      unavailable(),
      error instanceof TaskOutputUnavailableError ? 503 : 503,
    );
  };

  app.post(
    '/:taskId/declared-outputs/:sessionId/:eventId/keep',
    validate(keepDeclaredSchema),
    async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const unavailable = (status: 404 | 503 = 404) =>
        c.json({ success: false, error: 'Declared output not found' }, status);
      if (options?.isRequestPrincipalCurrent(c.req.raw) !== true)
        return unavailable();
      const taskId = param(c, 'taskId');
      const sessionId = param(c, 'sessionId');
      const authority = options.readAuthorityForRequest(c.req.raw);
      const task = options.taskGraph.readTask(taskId);
      // `workspaceBinding.workingDirectory` is only ever populated by
      // TaskGraphService.deriveWorkspaceBinding, which stores
      // `realpathSync(resolve(expandTilde(...)))` at Task-creation time
      // (task-graph-service.ts) — never the project's raw stored value. That
      // invariant has held since the field's introduction (archive#521: no other
      // writer sets it), so a captured binding can never carry an
      // unexpanded `~`; nothing downstream needs to expand it again.
      const workspace = task?.workspaceBinding?.workingDirectory;
      const projectWorkspace =
        task && options.resolveProjectWorkspace(task.projectId);
      if (
        !task ||
        !workspace ||
        !projectWorkspace ||
        !authority ||
        !options.canReadSession(sessionId, authority)
      )
        return unavailable();
      const originalProjectId = task.projectId;
      const originalWorkspace = workspace;
      const current = () =>
        options.isRequestPrincipalCurrent(c.req.raw) === true &&
        options.canReadSession(sessionId, authority) === true;
      const canKeepForTask = () => {
        if (!current()) return false;
        const actual = options.taskGraph.readTask(taskId);
        return (
          actual?.projectId === originalProjectId &&
          // Same-provenance witness compare, not a path read: both sides are
          // `workspaceBinding.workingDirectory` (see the note above `const
          // workspace = ...`) — one captured at request start, one re-read
          // here at witness time — to detect the Task moving to a different
          // workspace mid-request. Never used to touch the filesystem.
          actual.workspaceBinding?.workingDirectory === originalWorkspace &&
          options.resolveProjectWorkspace(actual.projectId) === projectWorkspace
        );
      };
      const outcome = await options.sessionOutputs.keep({
        taskId,
        sessionId,
        eventId: param(c, 'eventId'),
        operationId: (getBody(c) as { operationId: string }).operationId,
        taskWorkspace: originalWorkspace,
        authority,
        current,
        canKeepForTask,
        outputs,
        keepPullRequest: (candidate) =>
          options.taskGraph.keepDeclaredPullRequest(
            {
              taskId,
              operationId: (getBody(c) as { operationId: string }).operationId,
              ...candidate,
            },
            {
              expectedProjectId: originalProjectId,
              isAuthorized: (actualTask) =>
                current() &&
                actualTask.projectId === originalProjectId &&
                // Same witness compare as `canKeepForTask` above.
                actualTask.workspaceBinding?.workingDirectory ===
                  originalWorkspace &&
                options.resolveProjectWorkspace(actualTask.projectId) ===
                  projectWorkspace,
            },
          ),
      });
      if (outcome.status === 'unavailable') return unavailable(503);
      // The classification below is sensitive too: a revocation that landed
      // while the module was unwinding must receive the ordinary opaque 404.
      if (!current() || !canKeepForTask()) return unavailable();
      if (outcome.status === 'conflict')
        return c.json(
          { success: false, error: 'Declared output operation conflicts' },
          409,
        );
      if (outcome.status === 'deleted')
        return c.json(
          { success: false, error: 'Declared output was deleted' },
          410,
        );
      if (outcome.status !== 'kept') return unavailable();
      return c.json({ success: true, data: outcome }, 201);
    },
  );

  app.get('/:taskId/outputs', async (c) => {
    try {
      return c.json({
        success: true,
        data: await outputs.list(param(c, 'taskId')),
      });
    } catch (error) {
      return respondError(c, error);
    }
  });
  app.post('/:taskId/outputs', validate(createSchema), async (c) => {
    try {
      return c.json(
        {
          success: true,
          data: await outputs.create(
            param(c, 'taskId'),
            getBody(c) as TaskOutputCreateInput,
            resolveClientOriginForRequest(c.req.raw),
          ),
        },
        201,
      );
    } catch (error) {
      return respondError(c, error);
    }
  });
  app.get('/:taskId/outputs/:outputId', async (c) => {
    try {
      return c.json({
        success: true,
        data: await outputs.read(param(c, 'taskId'), param(c, 'outputId')),
      });
    } catch (error) {
      return respondError(c, error);
    }
  });
  app.get('/:taskId/outputs/:outputId/content', async (c) => {
    try {
      const { output, bytes } = await outputs.readContent(
        param(c, 'taskId'),
        param(c, 'outputId'),
      );
      // The stored/caller type never makes executable content inline. PNG is
      // an opt-in preview only after the same strict byte validator that owns
      // workspace previews accepts these exact snapshot bytes.
      const requestedType = output.materialization.mediaType;
      const textPreview =
        requestedType === 'text/plain' || requestedType === 'application/json';
      const safePng =
        requestedType === 'image/png' && isBoundedSafePng(Buffer.from(bytes));
      const type =
        textPreview || safePng ? requestedType : 'application/octet-stream';
      const safeName =
        output.materialization.fileName
          .replace(/[\r\n"]/g, '')
          .replace(/[^A-Za-z0-9._-]/g, '_') || 'task-output';
      return new Response(bytes, {
        headers: {
          'Content-Type': type,
          'Content-Length': String(bytes.length),
          'X-Content-Type-Options': 'nosniff',
          ETag: `"${output.materialization.digest}"`,
          'Cache-Control': 'private, no-store',
          'Content-Disposition': `${textPreview || safePng ? 'inline' : 'attachment'}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
          ...(safePng ? { 'X-Station-Safe-Preview': 'image/png' } : {}),
        },
      });
    } catch (error) {
      return respondError(c, error);
    }
  });
  app.delete('/:taskId/outputs/:outputId', async (c) => {
    try {
      await outputs.delete(param(c, 'taskId'), param(c, 'outputId'));
      return c.json({ success: true, data: { deleted: true } });
    } catch (error) {
      return respondError(c, error);
    }
  });
  return app;
}
