import { Hono } from 'hono';
import { z } from 'zod/v3';
import {
  StarterRegistry,
  StarterWorkPrerequisiteError,
  StarterWorkTargetError,
  UnknownStarterWorkError,
} from '../services/starter-work/starter-registry.js';
import {
  StarterWorkConflictError,
  StarterWorkUnavailableError,
} from '../services/starter-work/starter-work-module.js';
import { getBody, validate } from './schemas/schemas.js';

const taskReferenceSchema = z
  .object({
    kind: z.literal('task'),
    id: z.string().min(1).max(4096),
    projectId: z.string().min(1).max(4096),
  })
  .strict();
const sessionReferenceSchema = z
  .object({
    kind: z.literal('session'),
    id: z.string().min(1).max(4096),
  })
  .strict();
const approvalReferenceSchema = z
  .object({ kind: z.literal('approval'), id: z.string().min(1).max(4096) })
  .strict();
const receiptReferenceSchema = z.discriminatedUnion('owner', [
  z
    .object({
      kind: z.literal('receipt'),
      owner: z.literal('scheduler-run'),
      id: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal('receipt'),
      owner: z.literal('independent-review'),
      id: z.string().min(1).max(4096),
      projectSlug: z.string().min(1).max(4096),
    })
    .strict(),
]);
const bindSchema = z
  .object({
    starterId: z.enum(['start-task', 'continue-session']),
    operationId: z.string().min(1).max(160),
    targetRef: z.union([taskReferenceSchema, sessionReferenceSchema]),
  })
  .strict();

const startTaskLaunchSchema = z
  .object({
    starterId: z.literal('start-task'),
    operationId: z.string().min(1).max(160),
    task: z
      .object({
        projectId: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        priority: z.string().optional(),
        skillName: z.string().optional(),
        agentId: z.string().optional(),
        createdBy: z.string().optional(),
        workspaceBinding: z.record(z.unknown()).optional(),
      })
      .strict(),
    dispatch: z
      .object({
        agentId: z.string().optional(),
        skillName: z.string().optional(),
        provider: z.string().optional(),
        runtimeConfig: z.record(z.unknown()).optional(),
        relatedFiles: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const continueSessionLaunchSchema = z
  .object({
    starterId: z.literal('continue-session'),
    operationId: z.string().min(1).max(160),
    sourceSessionId: z.string().min(1).max(4096),
  })
  .strict();
const inspectApprovalLaunchSchema = z
  .object({
    starterId: z.literal('inspect-approval'),
    operationId: z.string().min(1).max(160),
    targetRef: approvalReferenceSchema,
  })
  .strict();
const inspectReceiptLaunchSchema = z
  .object({
    starterId: z.literal('inspect-receipt'),
    operationId: z.string().min(1).max(160),
    targetRef: receiptReferenceSchema,
  })
  .strict();
const scheduledCheckLaunchSchema = z
  .object({
    starterId: z.literal('run-scheduled-check'),
    operationId: z.string().min(1).max(160),
  })
  .strict();
const launchSchema = z.discriminatedUnion('starterId', [
  startTaskLaunchSchema,
  continueSessionLaunchSchema,
  inspectApprovalLaunchSchema,
  inspectReceiptLaunchSchema,
  scheduledCheckLaunchSchema,
]);

type StarterWorkRouteError = {
  status: 404 | 409 | 503;
  code:
    | 'starter_work_not_found'
    | 'starter_work_prerequisite_required'
    | 'starter_work_target_invalid'
    | 'starter_work_conflict'
    | 'starter_work_unavailable';
  error: string;
};

/**
 * The launch boundary deliberately exposes a small, stable vocabulary. Service
 * error text can include local storage or readiness context, so never project it
 * to callers from here.
 */
const starterWorkRouteError = (error: unknown): StarterWorkRouteError => {
  if (error instanceof UnknownStarterWorkError)
    return {
      status: 404,
      code: 'starter_work_not_found',
      error: 'Starter Work not found.',
    };
  if (error instanceof StarterWorkPrerequisiteError)
    return {
      status: 409,
      code: 'starter_work_prerequisite_required',
      error: 'Starter Work setup is required.',
    };
  if (error instanceof StarterWorkTargetError)
    return {
      status: 409,
      code: 'starter_work_target_invalid',
      error: 'Starter Work target is invalid.',
    };
  if (error instanceof StarterWorkConflictError)
    return {
      status: 409,
      code: 'starter_work_conflict',
      error: 'Starter Work binding conflicts with an existing operation.',
    };
  return {
    status: 503,
    code: 'starter_work_unavailable',
    error: 'Starter Work is unavailable.',
  };
};

export function createStarterWorkRoutes(registry: StarterRegistry) {
  const app = new Hono();
  app.get('/', async (c) =>
    c.json({ success: true, data: await registry.list() }),
  );
  app.get('/:starterId', async (c) => {
    try {
      return c.json({
        success: true,
        data: await registry.status(c.req.param('starterId')),
      });
    } catch (error) {
      return c.json(
        { success: false, error: 'Starter Work not found' },
        error instanceof UnknownStarterWorkError ? 404 : 503,
      );
    }
  });
  app.get('/:starterId/candidate', async (c) => {
    try {
      return c.json({
        success: true,
        data: await registry.candidate(c.req.param('starterId')),
      });
    } catch (error) {
      const routeError = starterWorkRouteError(error);
      return c.json(
        {
          success: false,
          code: routeError.code,
          error: routeError.error,
        },
        routeError.status,
      );
    }
  });
  app.post('/bind', validate(bindSchema), async (c) => {
    try {
      return c.json({ success: true, data: await registry.bind(getBody(c)) });
    } catch (error) {
      const status =
        error instanceof StarterWorkConflictError
          ? 409
          : error instanceof UnknownStarterWorkError
            ? 404
            : error instanceof StarterWorkTargetError ||
                error instanceof StarterWorkPrerequisiteError
              ? 409
              : 503;
      const message =
        error instanceof StarterWorkUnavailableError ||
        error instanceof StarterWorkConflictError ||
        error instanceof StarterWorkTargetError ||
        error instanceof StarterWorkPrerequisiteError
          ? error.message
          : 'Starter Work binding is unavailable.';
      return c.json({ success: false, error: message }, status);
    }
  });
  app.post('/launch', validate(launchSchema), async (c) => {
    try {
      const body = getBody(c) as never;
      const starterId = (body as { starterId: string }).starterId;
      const result =
        starterId === 'continue-session'
          ? await registry.launchContinueSession(body)
          : starterId === 'start-task'
            ? await registry.launchStartTask(body)
            : starterId === 'run-scheduled-check'
              ? await registry.launchScheduledCheck(body)
              : await registry.launchInspection(body);
      return c.json(
        {
          success: true,
          data: result,
        },
        result.state === 'started' ||
          result.state === 'continued' ||
          result.state === 'opened'
          ? 201
          : 200,
      );
    } catch (error) {
      const routeError = starterWorkRouteError(error);
      return c.json(
        {
          success: false,
          code: routeError.code,
          error: routeError.error,
        },
        routeError.status,
      );
    }
  });
  app.get('/:starterId/observation', async (c) => {
    try {
      return c.json({
        success: true,
        data: await registry.observe(c.req.param('starterId')),
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error:
            error instanceof UnknownStarterWorkError
              ? 'Starter Work not found'
              : 'Starter Work is unavailable.',
        },
        error instanceof UnknownStarterWorkError ? 404 : 503,
      );
    }
  });
  app.delete('/:starterId/binding', async (c) => {
    try {
      return c.json({
        success: true,
        data: await registry.clear(c.req.param('starterId')),
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error:
            error instanceof UnknownStarterWorkError
              ? 'Starter Work not found'
              : 'Starter Work binding is unavailable.',
        },
        error instanceof UnknownStarterWorkError ? 404 : 503,
      );
    }
  });
  return app;
}
