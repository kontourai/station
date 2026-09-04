import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import type { RuntimeSearch } from '../services/search/runtime-search.js';
import { unifiedSearchReads } from '../telemetry/metrics.js';
import { getBody, validate } from './schemas/schemas.js';

const id = z.string().min(1).max(256);
const requestSchema = z
  .object({
    version: z.literal(UNIFIED_SEARCH_V1),
    query: z.string().min(2).max(256),
    filters: z
      .object({
        kinds: z
          .array(
            z.enum([
              'project',
              'task',
              'session',
              'message',
              'file',
              'output',
              'run',
              'evidence',
              'receipt',
              'contribution',
            ]),
          )
          .max(10)
          .optional(),
        projectId: id.optional(),
        taskId: id.optional(),
      })
      .strict()
      .optional(),
    continuations: z
      .array(
        z
          .object({ providerId: id, token: z.string().min(1).max(4096) })
          .strict(),
      )
      .max(2)
      .optional(),
  })
  .strict();
const openSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), projectId: id, taskId: id }).strict(),
  z.object({ kind: z.literal('session'), sessionId: id }).strict(),
  z
    .object({
      kind: z.literal('session-message'),
      sessionId: id,
      matchedEventId: id,
    })
    .strict(),
]);

/** Read-only transport. Neither owner identity nor authority is accepted from JSON. */
export function createSearchRoutes(
  search: RuntimeSearch | undefined,
  options: {
    readAuthorityForRequest: (request: Request) => SessionReadAuthority;
    isRequestPrincipalCurrent: (request: Request) => boolean;
  },
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  const context = (request: Request) => ({
    authority: options.readAuthorityForRequest(request),
    current: () => options.isRequestPrincipalCurrent(request),
    signal: request.signal,
  });
  app.post(
    '/read-message',
    validate(
      z
        .object({
          sessionId: id,
          matchedEventId: id,
          continuation: z.string().min(1).max(256).optional(),
        })
        .strict(),
      { maxBodyBytes: 12 * 1024 },
    ),
    async (c) => {
      if (!search || !options.isRequestPrincipalCurrent(c.req.raw))
        return c.json({ success: false, error: 'Search unavailable' }, 503);
      const result = await search.readMessagePage(
        getBody(c),
        context(c.req.raw),
      );
      unifiedSearchReads.add(1, {
        operation: 'read-message',
        outcome: result.state,
      });
      if (!options.isRequestPrincipalCurrent(c.req.raw))
        return c.json({ success: false, error: 'Search unavailable' }, 503);
      return c.json({ success: true, data: result });
    },
  );
  app.post(
    '/',
    validate(requestSchema, { maxBodyBytes: 12 * 1024 }),
    async (c) => {
      if (!search || !options.isRequestPrincipalCurrent(c.req.raw))
        return c.json({ success: false, error: 'Search unavailable' }, 503);
      const result = await search.search(getBody(c), context(c.req.raw));
      unifiedSearchReads.add(1, { operation: 'search', outcome: result.state });
      if (!options.isRequestPrincipalCurrent(c.req.raw))
        return c.json({ success: false, error: 'Search unavailable' }, 503);
      if (result.state === 'invalid')
        return c.json({ success: false, error: 'Invalid search request' }, 400);
      return c.json({ success: true, data: result });
    },
  );
  app.post(
    '/resolve-open',
    validate(openSchema, { maxBodyBytes: 12 * 1024 }),
    async (c) => {
      if (!search || !options.isRequestPrincipalCurrent(c.req.raw))
        return c.json({ success: false, error: 'Search unavailable' }, 503);
      const result = await search.open(getBody(c), context(c.req.raw));
      unifiedSearchReads.add(1, {
        operation: 'resolve-open',
        outcome: result.state,
      });
      if (!options.isRequestPrincipalCurrent(c.req.raw))
        return c.json({ success: false, error: 'Search unavailable' }, 503);
      return c.json({ success: true, data: result });
    },
  );
  return app;
}
