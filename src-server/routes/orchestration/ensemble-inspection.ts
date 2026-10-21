import { ENSEMBLE_INSPECTION_LIMITS } from '@kontourai/station-contracts/ensemble';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  EnsembleInspectionRefusal,
  type EnsembleInspectionService,
} from '../../services/orchestration/ensemble-inspection.js';

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const schema = z
  .object({
    path: z.string().min(1).max(4096),
    expectedPresetHash: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
    bindings: z
      .record(
        id,
        z
          .object({
            agent: id,
            projectSlug: z
              .string()
              .min(1)
              .max(128)
              .regex(/^[a-zA-Z0-9_-]+$/),
          })
          .strict(),
      )
      .refine((value) => Object.keys(value).length <= 16),
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value.bindings).length === 0 ||
      value.expectedPresetHash !== undefined,
  );

export function createEnsembleInspectionRoutes(
  service: EnsembleInspectionService,
  resolvePrincipal: (c: Context) => PrincipalRef,
): Hono {
  const app = new Hono();
  app.post('/inspect', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const principal = resolvePrincipal(c);
      service.assertAuthority(c.req.raw, principal);
      const body = await readBoundedRequestBody(
        c.req.raw,
        ENSEMBLE_INSPECTION_LIMITS.requestBytes,
      );
      if (body.status !== 'ok')
        return c.json(
          { success: false, code: 'ensemble_inspection_invalid' },
          body.status === 'too-large' ? 413 : 400,
        );
      let value: unknown;
      try {
        value = JSON.parse(body.body);
      } catch {
        return c.json(
          { success: false, code: 'ensemble_inspection_invalid' },
          400,
        );
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success)
        return c.json(
          { success: false, code: 'ensemble_inspection_invalid' },
          400,
        );
      const data = await service.inspect(parsed.data, c.req.raw, principal);
      if (
        Buffer.byteLength(JSON.stringify({ success: true, data })) >
        ENSEMBLE_INSPECTION_LIMITS.responseBytes
      )
        throw new EnsembleInspectionRefusal('ensemble_inspection_unavailable');
      return c.json({ success: true, data });
    } catch (error) {
      const code =
        error instanceof EnsembleInspectionRefusal
          ? error.code
          : 'ensemble_inspection_unavailable';
      return c.json(
        {
          success: false,
          code,
          error:
            'Ensemble inspection could not establish a current authorized configuration. Refresh the source and receiver bindings.',
        },
        code === 'ensemble_inspection_authority_required'
          ? 403
          : code === 'ensemble_inspection_stale'
            ? 409
            : 422,
      );
    }
  });
  return app;
}
