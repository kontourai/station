import {
  isTelemetryCompanionOperationId,
  type TelemetryCompanionArchivePreparation,
  type TelemetryCompanionPrerequisites,
} from '@kontourai/station-contracts/telemetry-delivery';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { CompanionArchivePreparationBusyError } from '../../services/telemetry-companion-archive.js';

export function createTelemetryCompanionRoutes(deps: {
  requireOperator(request: Request): Promise<void>;
  prerequisites(
    includeArtifactEvidence: boolean,
  ): Promise<TelemetryCompanionPrerequisites>;
  prepareArchive?(
    request: Request,
    operationId: string,
  ): Promise<TelemetryCompanionArchivePreparation>;
  archivePreparation?(
    operationId: string,
  ): Promise<TelemetryCompanionArchivePreparation | null>;
}) {
  const app = new Hono();
  app.get('/prerequisites', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      await deps.requireOperator(c.req.raw);
    } catch {
      return c.json({ error: { code: 'operator_required' } }, 403);
    }
    let data: TelemetryCompanionPrerequisites;
    try {
      data = await deps.prerequisites(c.req.query('artifactEvidence') === '1');
    } catch {
      return c.json({ error: { code: 'companion_probe_unavailable' } }, 503);
    }
    try {
      await deps.requireOperator(c.req.raw);
    } catch {
      return c.json({ error: { code: 'operator_required' } }, 403);
    }
    return c.json({ data });
  });
  app.post('/archive-preparations', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      await deps.requireOperator(c.req.raw);
    } catch {
      return c.json({ error: { code: 'operator_required' } }, 403);
    }
    let operationId: string;
    try {
      const body = await readBoundedRequestBody(c.req.raw, 1024);
      if (body.status !== 'ok') throw new Error('Invalid body');
      operationId = z
        .object({
          operationId: z.string().refine(isTelemetryCompanionOperationId),
        })
        .strict()
        .parse(JSON.parse(body.body)).operationId;
    } catch {
      return c.json({ error: { code: 'invalid_preparation_request' } }, 400);
    }
    if (!deps.prepareArchive)
      return c.json(
        { error: { code: 'companion_preparation_unavailable' } },
        503,
      );
    try {
      const data = await deps.prepareArchive(c.req.raw, operationId);
      await deps.requireOperator(c.req.raw);
      return c.json({ data });
    } catch (error) {
      try {
        await deps.requireOperator(c.req.raw);
      } catch {
        return c.json({ error: { code: 'operator_required' } }, 403);
      }
      return c.json(
        {
          error: {
            code:
              error instanceof CompanionArchivePreparationBusyError
                ? 'companion_preparation_busy'
                : 'companion_preparation_unavailable',
          },
        },
        error instanceof CompanionArchivePreparationBusyError ? 409 : 503,
      );
    }
  });
  app.get('/archive-preparations/:operationId', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      await deps.requireOperator(c.req.raw);
    } catch {
      return c.json({ error: { code: 'operator_required' } }, 403);
    }
    const operationId = c.req.param('operationId');
    if (!isTelemetryCompanionOperationId(operationId))
      return c.json({ error: { code: 'invalid_preparation_request' } }, 400);
    if (!deps.archivePreparation)
      return c.json(
        { error: { code: 'companion_preparation_unavailable' } },
        503,
      );
    try {
      const data = await deps.archivePreparation(operationId);
      await deps.requireOperator(c.req.raw);
      return data
        ? c.json({ data })
        : c.json({ error: { code: 'companion_preparation_missing' } }, 404);
    } catch {
      try {
        await deps.requireOperator(c.req.raw);
      } catch {
        return c.json({ error: { code: 'operator_required' } }, 403);
      }
      return c.json(
        { error: { code: 'companion_preparation_unavailable' } },
        503,
      );
    }
  });
  return app;
}
