import { Hono } from 'hono';
import type { ActionOperationActor } from '../../services/operations/action-operation-service.js';
import {
  ActionOperationCursorError,
  type ActionOperationService,
} from '../../services/operations/action-operation-service.js';
import { param } from '../schemas/schemas.js';

const MAX_QUERY_LENGTH = 64;

export interface ActionOperationRouteDeps {
  readonly operations: Pick<
    ActionOperationService,
    'get' | 'list' | 'watch' | 'cancel'
  >;
  /** Runtime derives this from authenticated account/device/session authority. */
  readonly actorForRequest: (request: Request) => ActionOperationActor;
}

function boundedInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^\d{1,2}$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}
function boundedCursor(value: string | undefined): string | undefined {
  return value && value.length <= MAX_QUERY_LENGTH ? value : undefined;
}

/** The public operation surface is read/cancel only; domain owners create/update. */
export function createActionOperationRoutes(deps: ActionOperationRouteDeps) {
  const app = new Hono();
  app.get('/', async (c) => {
    const limit = boundedInt(c.req.query('limit'));
    if (c.req.query('limit') && !limit)
      return c.json({ success: false, error: 'Invalid operation page' }, 400);
    const suppliedCursor = c.req.query('cursor');
    const cursor = boundedCursor(suppliedCursor);
    if (suppliedCursor && !cursor)
      return c.json({ success: false, error: 'Invalid operation page' }, 400);
    try {
      return c.json({
        success: true,
        data: await deps.operations.list(deps.actorForRequest(c.req.raw), {
          ...(cursor ? { cursor } : {}),
          ...(limit ? { limit } : {}),
        }),
      });
    } catch (error) {
      if (error instanceof ActionOperationCursorError) {
        return c.json({ success: false, error: 'Invalid operation page' }, 400);
      }
      throw error;
    }
  });
  app.get('/watch', async (c) => {
    const suppliedCursor = c.req.query('cursor');
    const cursor = boundedCursor(suppliedCursor);
    if (suppliedCursor && !cursor)
      return c.json({ success: false, error: 'Invalid operation cursor' }, 400);
    try {
      return c.json({
        success: true,
        data: await deps.operations.watch(
          deps.actorForRequest(c.req.raw),
          cursor,
        ),
      });
    } catch (error) {
      if (error instanceof ActionOperationCursorError) {
        return c.json(
          { success: false, error: 'Invalid operation cursor' },
          400,
        );
      }
      throw error;
    }
  });
  app.get('/:id', async (c) => {
    const operation = await deps.operations.get(
      deps.actorForRequest(c.req.raw),
      param(c, 'id'),
    );
    return operation
      ? c.json({ success: true, data: operation })
      : c.json({ success: false, error: 'Operation not found' }, 404);
  });
  app.post('/:id/cancel', async (c) => {
    const result = await deps.operations.cancel(
      deps.actorForRequest(c.req.raw),
      param(c, 'id'),
    );
    if (result.kind === 'not-found')
      return c.json({ success: false, error: 'Operation not found' }, 404);
    if (
      result.kind === 'unsupported' ||
      result.kind === 'refused' ||
      result.kind === 'indeterminate'
    ) {
      return c.json(
        {
          success: false,
          error:
            result.kind === 'indeterminate'
              ? 'Cancellation requires reconciliation'
              : result.kind === 'refused'
                ? 'Cancellation was refused by the operation owner'
                : 'Cancellation is unavailable',
          data: result.operation,
        },
        409,
      );
    }
    return c.json({
      success: true,
      data: result.operation,
      idempotent: result.kind === 'already-terminal',
    });
  });
  return app;
}
