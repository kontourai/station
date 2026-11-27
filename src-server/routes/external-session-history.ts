import { EXTERNAL_SESSION_HISTORY_PREVIEW } from '@kontourai/station-contracts/orchestration';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { isBoundRuntimeOwner } from '../security/runtime-request-security.js';
import {
  FeaturePreviewDisabledError,
  requireFeaturePreview,
} from '../services/feature-previews/feature-preview-refusal.js';
import type { FeaturePreviewSelector } from '../services/feature-previews/feature-preview-registry.js';
import {
  type AttachedSessionFollowService,
  ExternalSessionHistoryUnavailable,
} from '../services/orchestration/attached-session-follow-service.js';

const listQuery = z.object({
  offset: z.coerce.number().int().min(0).max(4096).default(0),
  provider: z.enum(['claude', 'codex', 'opencode', 'grok', 'acp']).optional(),
  search: z.string().max(120).default(''),
});
const archiveId = z.string().regex(/^[0-9a-f]{64}$/);
const archiveCursor = z.string().uuid().optional();
const importOperationId = z.string().regex(/^[0-9a-f]{32}$/);

export interface ExternalSessionHistoryRouteDeps {
  follow: Pick<
    AttachedSessionFollowService,
    'listArchive' | 'readArchive' | 'importArchive' | 'cancelArchiveImport'
  >;
  preview: FeaturePreviewSelector;
}

export function createExternalSessionHistoryRoutes(
  options: ExternalSessionHistoryRouteDeps & {
    isOwnerCurrent: (request: Request) => boolean;
  },
) {
  const app = new Hono();
  function assertCurrent(c: Context) {
    if (!isBoundRuntimeOwner(c.req.raw) || !options.isOwnerCurrent(c.req.raw)) {
      throw new ExternalArchiveAccessError();
    }
    requireFeaturePreview(
      options.preview,
      EXTERNAL_SESSION_HISTORY_PREVIEW,
      'Third-party history',
    );
    c.req.raw.signal.throwIfAborted();
  }

  function admit(c: Context): () => void {
    c.header('Cache-Control', 'no-store');
    assertCurrent(c);
    return () => assertCurrent(c);
  }

  app.onError((error, c) => {
    if (error instanceof FeaturePreviewDisabledError)
      return c.json(error.refusal, 404);
    if (error instanceof ExternalArchiveAccessError)
      return c.json(
        { success: false, error: 'Station owner access required.' },
        403,
      );
    if (error instanceof z.ZodError)
      return c.json({ success: false, error: 'Invalid history request.' }, 400);
    if (c.req.raw.signal.aborted)
      return c.json(
        { success: false, error: 'History request canceled.' },
        409,
      );
    if (error instanceof ExternalSessionHistoryUnavailable)
      return c.json(
        { success: false, error: error.publicMessage, code: error.code },
        error.status,
      );
    return c.json(
      { success: false, error: 'Third-party history is unavailable.' },
      503,
    );
  });

  app.get('/', async (c) => {
    const assertAdmission = admit(c);
    const input = listQuery.parse(c.req.query());
    const data = await options.follow.listArchive(input, assertAdmission);
    return c.json({ success: true, data });
  });
  app.get('/:id/transcript', async (c) => {
    const assertAdmission = admit(c);
    const data = await options.follow.readArchive(
      archiveId.parse(c.req.param('id')),
      archiveCursor.parse(c.req.query('cursor')),
      c.req.query('from') === 'start',
      assertAdmission,
    );
    return c.json({ success: true, data });
  });
  app.post('/:id/import', async (c) => {
    const assertAdmission = admit(c);
    const data = await options.follow.importArchive(
      archiveId.parse(c.req.param('id')),
      importOperationId.parse(c.req.query('operationId')),
      assertAdmission,
      c.req.raw.signal,
    );
    return c.json({ success: true, data });
  });
  app.delete('/:id/import/:operationId', async (c) => {
    const assertAdmission = admit(c);
    await options.follow.cancelArchiveImport(
      archiveId.parse(c.req.param('id')),
      importOperationId.parse(c.req.param('operationId')),
    );
    assertAdmission();
    return c.body(null, 204);
  });
  return app;
}

class ExternalArchiveAccessError extends Error {}
