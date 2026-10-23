import { DelegationContractV2Error } from '@kontourai/flow-agents/delegation-authority-contract';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  awaitWithAbort,
  createGroupStreamLifetime,
  encodeGroupStreamCursor,
  readGroupStreamCursor,
  watchGroupPages,
} from '../../services/orchestration/delegation-group-transport.js';
import type { StationReportGroupRuntime } from '../../services/orchestration/station-report-group-runtime.js';
import { streamSSE } from '../sse-response.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const cursor = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/)
  .transform(Number)
  .refine(Number.isSafeInteger);
const cancel = z
  .object({
    operationKey: id,
    expectedRevision: z.number().int().nonnegative().safe(),
  })
  .strict();

export function createReportGroupRoutes(
  runtime: StationReportGroupRuntime | null,
) {
  const app = new Hono();
  async function body(c: Context) {
    if (
      c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      throw new SyntaxError();
    const read = await readBoundedRequestBody(c.req.raw, 256 * 1024);
    if (read.status !== 'ok') throw new SyntaxError();
    return JSON.parse(read.body);
  }
  async function respond(
    c: Context,
    work: (owner: StationReportGroupRuntime) => Promise<unknown>,
  ) {
    c.header('Cache-Control', 'no-store');
    if (!runtime)
      return c.json({ success: false, code: 'report_groups_unavailable' }, 503);
    try {
      const current = await runtime.authorizeResponse(c);
      const data = await work(runtime);
      current();
      if (Buffer.byteLength(JSON.stringify(data)) > 262_000)
        return c.json(
          { success: false, code: 'report_group_response_too_large' },
          503,
        );
      return c.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return c.json({ success: false, code: 'report_group_invalid' }, 400);
      if (error instanceof DelegationContractV2Error)
        return c.json({ success: false, code: 'report_group_conflict' }, 409);
      return c.json({ success: false, code: 'report_group_unavailable' }, 503);
    }
  }
  const noQuery = (c: Context) => z.object({}).strict().parse(c.req.query());
  app.post('/', (c) =>
    respond(c, async (owner) => {
      noQuery(c);
      return owner.create(c, await body(c));
    }),
  );
  app.get('/', (c) =>
    respond(c, (owner) => {
      const query = z
        .object({ afterGroupId: id.optional() })
        .strict()
        .parse(c.req.query());
      return owner.list(c, query.afterGroupId);
    }),
  );
  app.get('/:groupId', (c) =>
    respond(c, (owner) => {
      noQuery(c);
      return owner.get(c, id.parse(c.req.param('groupId')));
    }),
  );
  app.get('/:groupId/events', (c) =>
    respond(c, (owner) => {
      const query = z
        .object({ afterRevision: cursor.optional() })
        .strict()
        .parse(c.req.query());
      return owner.events(
        c,
        id.parse(c.req.param('groupId')),
        query.afterRevision ?? 0,
      );
    }),
  );
  app.get('/:groupId/members/:seatId/results/:invocationId', (c) =>
    respond(c, (owner) => {
      const query = z
        .object({ afterOffset: cursor.optional() })
        .strict()
        .parse(c.req.query());
      return owner.result(
        c,
        id.parse(c.req.param('groupId')),
        id.parse(c.req.param('seatId')),
        id.parse(c.req.param('invocationId')),
        query.afterOffset ?? 0,
      );
    }),
  );
  app.get('/:groupId/events/stream', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!runtime)
      return c.json({ success: false, code: 'report_groups_unavailable' }, 503);
    const lifetime = createGroupStreamLifetime(c.req.raw.signal, 60_000);
    try {
      const current = await runtime.authorizeResponse(c);
      const groupId = id.parse(c.req.param('groupId'));
      const query = z
        .object({ afterRevision: cursor.optional() })
        .strict()
        .parse(c.req.query());
      const domain = { kind: 'report' as const, groupId };
      let after = readGroupStreamCursor(
        domain,
        query.afterRevision,
        c.req.header('Last-Event-ID'),
      );
      await awaitWithAbort(runtime.events(c, groupId, after), lifetime.signal);
      current();
      return streamSSE(c, async (stream) => {
        const stop = () => {
          lifetime.stop();
          stream.abort();
        };
        stream.onAbort(lifetime.stop);
        lifetime.signal.addEventListener('abort', stop, { once: true });
        const pages = watchGroupPages({
          signal: lifetime.signal,
          lifetimeMs: 60_000,
          refreshMs: 1000,
          subscribe: () => () => {},
          relevant: () => false,
          read: async () => {
            const page = await runtime.events(c, groupId, after);
            after = page.nextRevision;
            return page;
          },
          fingerprint: (page) =>
            JSON.stringify([
              page.revision,
              page.nextRevision,
              page.events,
              page.unavailable,
            ]),
          hasMore: (page) => page.hasMore,
        });
        try {
          for await (const page of pages) {
            const data = JSON.stringify(page);
            if (Buffer.byteLength(data) > 262_000)
              throw new Error('report_page_too_large');
            current();
            await awaitWithAbort(
              stream.writeSSE({
                event: 'report-group-events',
                id: encodeGroupStreamCursor(domain, page.nextRevision),
                data,
              }),
              lifetime.signal,
            );
          }
        } catch {
          if (!lifetime.signal.aborted)
            await awaitWithAbort(
              stream.writeSSE({ event: 'unavailable', data: '{}' }),
              lifetime.signal,
            ).catch(() => {});
        } finally {
          await pages.return?.();
          lifetime.signal.removeEventListener('abort', stop);
          stop();
        }
      });
    } catch (error) {
      lifetime.stop();
      const invalid =
        error instanceof z.ZodError ||
        (error instanceof Error &&
          error.message === 'group_stream_cursor_invalid');
      return c.json(
        {
          success: false,
          code: invalid ? 'report_group_invalid' : 'report_group_unavailable',
        },
        invalid ? 400 : 503,
      );
    }
  });
  app.post('/:groupId/cancel', (c) =>
    respond(c, async (owner) => {
      noQuery(c);
      return owner.cancel(
        c,
        id.parse(c.req.param('groupId')),
        cancel.parse(await body(c)),
      );
    }),
  );
  return app;
}
