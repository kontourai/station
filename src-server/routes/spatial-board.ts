import {
  MAX_SPATIAL_BOARD_COORDINATE,
  MAX_SPATIAL_BOARD_PINS,
  MAX_SPATIAL_BOARD_SIZE,
  MAX_SPATIAL_BOARD_ZOOM,
  MIN_SPATIAL_BOARD_ZOOM,
} from '@kontourai/station-contracts/spatial-board';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import { isSpatialBoardWorkReference } from '../services/spatial-board/spatial-board-reference.js';
import { SpatialBoardResolver } from '../services/spatial-board/spatial-board-resolver.js';
import {
  SpatialBoardCapacityError,
  SpatialBoardConflictError,
  SpatialBoardPinNotFoundError,
  type SpatialBoardStore,
  SpatialBoardUnavailableError,
} from '../services/spatial-board/spatial-board-store.js';
import { getBody, validate } from './schemas/schemas.js';

const revisionSchema = z.number().int().min(0).safe();
const boundedTextSchema = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) =>
        Buffer.byteLength(value) <= maxBytes &&
        ![...value].some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        }),
      'Text exceeds its byte bound or contains control characters.',
    );
const projectReferenceSchema = z
  .object({ kind: z.literal('project'), id: boundedTextSchema(4096) })
  .strict();
const taskReferenceSchema = z
  .object({
    kind: z.literal('task'),
    id: boundedTextSchema(4096),
    projectId: boundedTextSchema(4096),
  })
  .strict();
const sessionReferenceSchema = z
  .object({ kind: z.literal('session'), id: boundedTextSchema(4096) })
  .strict();
const approvalReferenceSchema = z
  .object({ kind: z.literal('approval'), id: boundedTextSchema(4096) })
  .strict();
const schedulerReceiptReferenceSchema = z
  .object({
    kind: z.literal('receipt'),
    owner: z.literal('scheduler-run'),
    id: boundedTextSchema(4096),
  })
  .strict();
const independentReviewReceiptReferenceSchema = z
  .object({
    kind: z.literal('receipt'),
    owner: z.literal('independent-review'),
    id: boundedTextSchema(4096),
    projectSlug: boundedTextSchema(4096),
  })
  .strict();
const flowRunReferenceSchema = z
  .object({
    kind: z.literal('run'),
    owner: z.literal('flow'),
    projectId: boundedTextSchema(4096),
    id: boundedTextSchema(4096),
    gateId: boundedTextSchema(4096).optional(),
  })
  .strict();
const runOutputArtifactReferenceSchema = z
  .object({
    kind: z.literal('artifact'),
    owner: z.literal('run-output'),
    runId: boundedTextSchema(4096),
    id: boundedTextSchema(4096),
  })
  .strict();
const agentReferenceSchema = z
  .object({ kind: z.literal('agent'), id: boundedTextSchema(4096) })
  .strict();
const referenceSchema = z
  .union([
    projectReferenceSchema,
    taskReferenceSchema,
    sessionReferenceSchema,
    approvalReferenceSchema,
    schedulerReceiptReferenceSchema,
    independentReviewReceiptReferenceSchema,
    flowRunReferenceSchema,
    runOutputArtifactReferenceSchema,
    agentReferenceSchema,
  ])
  .refine(isSpatialBoardWorkReference, 'Invalid Spatial Board WorkReference.');
const pinSchema = z
  .object({
    id: boundedTextSchema(160),
    reference: referenceSchema,
    x: z
      .number()
      .finite()
      .min(-MAX_SPATIAL_BOARD_COORDINATE)
      .max(MAX_SPATIAL_BOARD_COORDINATE),
    y: z
      .number()
      .finite()
      .min(-MAX_SPATIAL_BOARD_COORDINATE)
      .max(MAX_SPATIAL_BOARD_COORDINATE),
    width: z.number().finite().positive().max(MAX_SPATIAL_BOARD_SIZE),
    height: z.number().finite().positive().max(MAX_SPATIAL_BOARD_SIZE),
    order: z.number().int().min(0).max(MAX_SPATIAL_BOARD_PINS),
  })
  .strict();
const expectedRevisionSchema = z
  .object({ expectedRevision: revisionSchema })
  .strict();
const createSchema = expectedRevisionSchema.extend({ pin: pinSchema }).strict();
const replaceSchema = expectedRevisionSchema
  .extend({ pin: pinSchema })
  .strict();
const titleSchema = expectedRevisionSchema
  .extend({ title: boundedTextSchema(512) })
  .strict();
const cameraSchema = expectedRevisionSchema
  .extend({
    camera: z
      .object({
        x: z
          .number()
          .finite()
          .min(-MAX_SPATIAL_BOARD_COORDINATE)
          .max(MAX_SPATIAL_BOARD_COORDINATE),
        y: z
          .number()
          .finite()
          .min(-MAX_SPATIAL_BOARD_COORDINATE)
          .max(MAX_SPATIAL_BOARD_COORDINATE),
        zoom: z
          .number()
          .finite()
          .min(MIN_SPATIAL_BOARD_ZOOM)
          .max(MAX_SPATIAL_BOARD_ZOOM),
      })
      .strict(),
  })
  .strict();
const cleanupSchema = expectedRevisionSchema
  .extend({
    missingReferences: z.array(referenceSchema).max(MAX_SPATIAL_BOARD_PINS),
  })
  .strict();

type RouteError = {
  status: 404 | 409 | 413 | 503;
  code:
    | 'spatial_board_pin_not_found'
    | 'spatial_board_conflict'
    | 'spatial_board_capacity'
    | 'spatial_board_unavailable';
  error: string;
};

function routeError(error: unknown): RouteError {
  if (error instanceof SpatialBoardPinNotFoundError)
    return {
      status: 404,
      code: 'spatial_board_pin_not_found',
      error: 'Spatial board pin not found.',
    };
  if (error instanceof SpatialBoardConflictError)
    return {
      status: 409,
      code: 'spatial_board_conflict',
      error: 'Spatial board revision or identity conflicts with current state.',
    };
  if (error instanceof SpatialBoardCapacityError)
    return {
      status: 413,
      code: 'spatial_board_capacity',
      error: 'Spatial board capacity was reached.',
    };
  return {
    status: 503,
    code: 'spatial_board_unavailable',
    error:
      error instanceof SpatialBoardUnavailableError
        ? 'Spatial board is unavailable.'
        : 'Spatial board is unavailable.',
  };
}

export function createSpatialBoardRoutes(
  store: SpatialBoardStore,
  resolver: SpatialBoardResolver,
) {
  const app = new Hono();
  const respond = async (operation: () => Promise<unknown>) => {
    try {
      return { ok: true as const, data: await operation() };
    } catch (error) {
      return { ok: false as const, failure: routeError(error) };
    }
  };
  const json = (c: Context, result: Awaited<ReturnType<typeof respond>>) =>
    result.ok
      ? c.json({ success: true, data: result.data })
      : c.json(
          {
            success: false,
            code: result.failure.code,
            error: result.failure.error,
          },
          result.failure.status,
        );

  app.get('/', async (c) => json(c, await respond(() => store.read())));
  app.get('/resolved', async (c) =>
    json(
      c,
      await respond(async () => {
        const board = await store.read();
        return resolver.resolve(board);
      }),
    ),
  );
  app.post('/pins', validate(createSchema), async (c) => {
    const body = getBody(c) as z.infer<typeof createSchema>;
    return json(
      c,
      await respond(() => store.create(body.expectedRevision, body.pin)),
    );
  });
  app.put('/pins/:pinId', validate(replaceSchema), async (c) => {
    const body = getBody(c) as z.infer<typeof replaceSchema>;
    if (body.pin.id !== c.req.param('pinId'))
      return c.json(
        {
          success: false,
          code: 'spatial_board_conflict',
          error: 'Spatial board pin identity does not match the route.',
        },
        409,
      );
    return json(
      c,
      await respond(() => store.replace(body.expectedRevision, body.pin)),
    );
  });
  app.delete('/pins/:pinId', validate(expectedRevisionSchema), async (c) => {
    const body = getBody(c) as z.infer<typeof expectedRevisionSchema>;
    const pinId = c.req.param('pinId') ?? '';
    return json(
      c,
      await respond(() => store.remove(body.expectedRevision, pinId)),
    );
  });
  app.patch('/title', validate(titleSchema), async (c) => {
    const body = getBody(c) as z.infer<typeof titleSchema>;
    return json(
      c,
      await respond(() => store.setTitle(body.expectedRevision, body.title)),
    );
  });
  app.patch('/camera', validate(cameraSchema), async (c) => {
    const body = getBody(c) as z.infer<typeof cameraSchema>;
    return json(
      c,
      await respond(() => store.setCamera(body.expectedRevision, body.camera)),
    );
  });
  app.post('/cleanup', validate(cleanupSchema), async (c) => {
    const body = getBody(c) as z.infer<typeof cleanupSchema>;
    return json(
      c,
      await respond(() =>
        store.cleanupMissing(body.expectedRevision, body.missingReferences),
      ),
    );
  });
  app.post('/undo', validate(expectedRevisionSchema), async (c) => {
    const body = getBody(c) as z.infer<typeof expectedRevisionSchema>;
    return json(c, await respond(() => store.undo(body.expectedRevision)));
  });
  return app;
}
