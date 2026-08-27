import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  type ExistingAgentSetupImportModule,
  SetupImportError,
} from '../services/setup/existing-agent-setup-import.js';
import {
  getBody,
  param,
  setupImportApplySchema,
  setupImportPreviewSchema,
  setupImportTargetReviewSchema,
  validate,
} from './schemas/schemas.js';

/** Public boundary for the narrowly scoped existing-agent setup import. */
export function createSetupImportRoutes(
  module: ExistingAgentSetupImportModule,
  options: {
    operatorIdentityForRequest: (context: Context) => string | undefined;
    /** Defense in depth for compositions that cannot omit the mount. */
    isHostedExecution?: () => boolean;
  },
) {
  const app = new Hono();
  // Codex homes and Station's local Skills are personal-machine state. A
  // pairing scope alone is deliberately insufficient: ordinary paired
  // devices can operate an agent but cannot read or mutate this host config.
  const requireOperator = (c: Context) => options.operatorIdentityForRequest(c);
  const failure = (error: unknown, fallback: string) => {
    const code = error instanceof SetupImportError ? error.code : undefined;
    if (code === 'STORE_UNAVAILABLE' || code === 'SOURCE_UNAVAILABLE')
      return { status: 503, error: 'Setup import is temporarily unavailable.' };
    if (code === 'RECEIPT_NOT_FOUND')
      return { status: 404, error: 'Setup import receipt not found.' };
    if (code === 'INVALID_SOURCE' || code === 'INVALID_APPLY')
      return { status: 400, error: fallback };
    return { status: 409, error: fallback };
  };
  app.use('*', async (c, next) => {
    if (options.isHostedExecution?.()) {
      return c.json(
        { success: false, error: 'Setup import is unavailable.' },
        404,
      );
    }
    if (!requireOperator(c)) {
      return c.json(
        { success: false, error: 'Operator authority required.' },
        403,
      );
    }
    await next();
  });
  app.get('/sources', async (c) =>
    c.json({ success: true, data: await module.sources() }),
  );
  app.post('/previews', validate(setupImportPreviewSchema), async (c) => {
    try {
      return c.json(
        { success: true, data: await module.preview(getBody(c).sourceId) },
        201,
      );
    } catch (error) {
      const mapped = failure(
        error,
        'Setup import preview could not be created.',
      );
      return c.json(
        { success: false, error: mapped.error },
        mapped.status as 400,
      );
    }
  });
  app.post(
    '/previews/:id/targets',
    validate(setupImportTargetReviewSchema),
    async (c) => {
      try {
        return c.json({
          success: true,
          data: await module.reviewTargets({
            previewId: param(c, 'id'),
            items: getBody(c).items,
          }),
        });
      } catch (error) {
        const mapped = failure(
          error,
          'Setup import targets could not be reviewed.',
        );
        return c.json(
          { success: false, error: mapped.error },
          mapped.status as 409,
        );
      }
    },
  );
  app.post(
    '/previews/:id/apply',
    validate(setupImportApplySchema),
    async (c) => {
      try {
        return c.json({
          success: true,
          data: await module.apply({
            previewId: param(c, 'id'),
            witnessId: getBody(c).witnessId,
          }),
        });
      } catch (error) {
        const mapped = failure(error, 'Setup import could not be applied.');
        return c.json(
          { success: false, error: mapped.error },
          mapped.status as 409,
        );
      }
    },
  );
  app.get('/receipts/:id', async (c) => {
    try {
      return c.json({
        success: true,
        data: await module.receipt(param(c, 'id')),
      });
    } catch (error) {
      const mapped = failure(error, 'Setup import receipt could not be read.');
      return c.json(
        { success: false, error: mapped.error },
        mapped.status as 404,
      );
    }
  });
  app.post('/receipts/:id/rollback', async (c) => {
    try {
      return c.json({
        success: true,
        data: await module.rollback(param(c, 'id')),
      });
    } catch (error) {
      const mapped = failure(
        error,
        'Setup import rollback could not complete.',
      );
      return c.json(
        { success: false, error: mapped.error },
        mapped.status as 409,
      );
    }
  });
  return app;
}
