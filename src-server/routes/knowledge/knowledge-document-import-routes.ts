import type {
  KnowledgeDocumentImportReceipt,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { errorMessage } from '../schemas/schemas.js';
import {
  KnowledgeDocumentImportError,
  type KnowledgeDocumentImportService,
  type KnowledgeImportAuthority,
} from '../../services/knowledge/knowledge-document-import-service.js';

interface Dependencies {
  service: KnowledgeDocumentImportService;
  authority: (request: Request) => KnowledgeImportAuthority;
  mayReadRoot: (request: Request, root: KnowledgeStoreRoot) => Promise<boolean>;
  guardReadResponse: (
    request: Request,
    roots: readonly KnowledgeStoreRoot[],
    response: Response,
  ) => Promise<Response>;
}

const resumeSchema = z
  .object({
    expectedRoot: z.unknown(),
    retryUncertain: z.boolean(),
  })
  .strict();

export function createKnowledgeDocumentImportRoutes(deps: Dependencies) {
  const app = new Hono();
  const input = async (c: Context) => {
    const read = await readBoundedRequestBody(c.req.raw, 2 * 1024 * 1024);
    if (read.status !== 'ok')
      throw new KnowledgeDocumentImportError(
        'Invalid or oversized import body.',
        400,
      );
    return JSON.parse(read.body);
  };
  const failure = (c: Context, error: unknown) => {
    if (error instanceof KnowledgeDocumentImportError)
      return c.json({ success: false, error: errorMessage(error) }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json(
        { success: false, error: 'Invalid document import request.' },
        400,
      );
    return c.json(
      {
        success: false,
        error: 'Import unavailable. Check the saved import before continuing.',
      },
      503,
    );
  };
  const ids = (c: Context) => ({
    rootId: z.string().min(1).parse(c.req.param('rootId')),
    requestId: z.string().uuid().parse(c.req.param('requestId')),
  });
  const receiptResponse = async (
    c: Context,
    receipt: KnowledgeDocumentImportReceipt,
    authority: KnowledgeImportAuthority,
  ) => {
    const saved = await deps.service.get(
      receipt.rootId,
      receipt.requestId,
      authority.assertCurrent,
    );
    authority.assertCurrent();
    if (!saved)
      throw new KnowledgeDocumentImportError(
        'Saved import is unavailable.',
        503,
      );
    return deps.guardReadResponse(
      c.req.raw,
      [saved.root],
      c.json({ success: true, data: saved.receipt }),
    );
  };
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.post('/document-imports', async (c) => {
    try {
      const authority = deps.authority(c.req.raw);
      authority.assertCurrent();
      const receipt = await deps.service.import(await input(c), authority);
      return await receiptResponse(c, receipt, authority);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post('/roots/:rootId/document-imports/:requestId/resume', async (c) => {
    try {
      const authority = deps.authority(c.req.raw);
      authority.assertCurrent();
      const { rootId, requestId } = ids(c);
      const body = resumeSchema.parse(await input(c));
      const expected = z
        .object({ id: z.string() })
        .passthrough()
        .parse(body.expectedRoot);
      if (expected.id !== rootId)
        throw new KnowledgeDocumentImportError(
          'Import source does not match the request.',
          400,
        );
      const receipt = await deps.service.resume(
        expected,
        requestId,
        body.retryUncertain,
        authority,
      );
      return await receiptResponse(c, receipt, authority);
    } catch (error) {
      return failure(c, error);
    }
  });
  // Observation persists publication witnesses, so this remains operator-only.
  app.get('/roots/:rootId/document-imports/:requestId', async (c) => {
    try {
      const authority = deps.authority(c.req.raw);
      authority.assertCurrent();
      const { rootId, requestId } = ids(c);
      const result = await deps.service.get(
        rootId,
        requestId,
        authority.assertCurrent,
      );
      authority.assertCurrent();
      if (!result)
        return c.json({ success: false, error: 'Import not found.' }, 404);
      return deps.guardReadResponse(
        c.req.raw,
        [result.root],
        c.json({ success: true, data: result.receipt }),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get(
    '/roots/:rootId/document-imports/:requestId/originals/:index',
    async (c) => {
      try {
        const { rootId, requestId } = ids(c);
        const index = z.coerce
          .number()
          .int()
          .min(0)
          .max(7)
          .parse(c.req.param('index'));
        const result = await deps.service.original(rootId, requestId, index);
        if (!result || !(await deps.mayReadRoot(c.req.raw, result.root)))
          return c.json({ success: false, error: 'Original not found.' }, 404);
        const response = new Response(result.bytes, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
        return deps.guardReadResponse(c.req.raw, [result.root], response);
      } catch (error) {
        return failure(c, error);
      }
    },
  );
  return app;
}
