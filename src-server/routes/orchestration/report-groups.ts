import { DelegationContractV2Error } from '@kontourai/flow-agents/delegation-authority-contract';
import { ContinuationPublicationUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import {
  REPORT_GROUP_CONTEXT_LIMITS,
  REPORT_GROUP_RENEWAL_LIMITS,
} from '@kontourai/station-contracts/report-group';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  outsideStationServerScope,
  runAsStationServer,
} from '../../security/station-server-scope.js';
import {
  awaitWithAbort,
  createGroupStreamLifetime,
  encodeGroupStreamCursor,
  readGroupStreamCursor,
  watchGroupPages,
} from '../../services/orchestration/delegation-group-transport.js';
import {
  ReportContinuationUnavailable,
  type StationReportGroupRuntime,
} from '../../services/orchestration/station-report-group-runtime.js';
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

const finalizeCancel = cancel.extend({ cancelOperationKey: id }).strict();
const sync = cancel
  .extend({
    seatId: id,
    flowHead: z.string().regex(/^[a-f0-9]{64}$/),
    text: z
      .string()
      .min(1)
      .max(65_536)
      .refine((value) => Buffer.byteLength(value) <= 65_536),
  })
  .strict();
const finalizeSync = cancel
  .extend({
    syncOperationKey: id,
    preparedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export function createReportGroupRoutes(
  runtime: StationReportGroupRuntime | null,
) {
  const app = new Hono();
  async function body(c: Context, maxBytes = 256 * 1024) {
    if (
      c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      throw new SyntaxError();
    const read = await readBoundedRequestBody(c.req.raw, maxBytes);
    if (read.status !== 'ok') throw new SyntaxError();
    return JSON.parse(read.body);
  }
  async function respond(
    c: Context,
    work: (
      owner: StationReportGroupRuntime,
      context: Parameters<StationReportGroupRuntime['bindRequest']>[0],
    ) => Promise<unknown>,
    finalizer = false,
  ) {
    c.header('Cache-Control', 'no-store');
    if (!runtime)
      return c.json({ success: false, code: 'report_groups_unavailable' }, 503);
    try {
      const run = async () => {
        const context = runtime.bindRequest(c);
        const current = await runtime.authorizeResponse(context);
        const data = await runAsStationServer(() => work(runtime, context));
        return runtime.withResponseCurrent(context, current, () => {
          if (Buffer.byteLength(JSON.stringify(data)) > 262_000)
            return c.json(
              { success: false, code: 'report_group_response_too_large' },
              503,
            );
          return c.json({ success: true, data });
        });
      };
      return finalizer ? await runtime.withFinalizerResponse(run) : await run();
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return c.json({ success: false, code: 'report_group_invalid' }, 400);
      if (error instanceof ContinuationPublicationUncertainError)
        return c.json(
          { success: false, code: error.code, publicationStatus: error.status },
          503,
        );
      if (error instanceof ReportContinuationUnavailable)
        return c.json({ success: false, code: error.code }, 503);
      if (error instanceof DelegationContractV2Error)
        return c.json({ success: false, code: 'report_group_conflict' }, 409);
      return c.json({ success: false, code: 'report_group_unavailable' }, 503);
    }
  }
  const noQuery = (c: Context) => z.object({}).strict().parse(c.req.query());
  app.post('/', (c) =>
    respond(c, async (owner, context) => {
      noQuery(c);
      return owner.create(context, await body(c));
    }),
  );
  app.get('/', (c) =>
    respond(c, (owner, context) => {
      const query = z
        .object({ afterGroupId: id.optional() })
        .strict()
        .parse(c.req.query());
      return owner.list(context, query.afterGroupId);
    }),
  );
  app.get('/:groupId', (c) =>
    respond(c, (owner, context) => {
      noQuery(c);
      return owner.get(context, id.parse(c.req.param('groupId')));
    }),
  );
  app.get('/:groupId/events', (c) =>
    respond(c, (owner, context) => {
      const query = z
        .object({ afterRevision: cursor.optional() })
        .strict()
        .parse(c.req.query());
      return owner.events(
        context,
        id.parse(c.req.param('groupId')),
        query.afterRevision ?? 0,
      );
    }),
  );
  app.get('/:groupId/members/:seatId/results/:invocationId', (c) =>
    respond(c, (owner, context) => {
      const query = z
        .object({ afterOffset: cursor.optional() })
        .strict()
        .parse(c.req.query());
      return owner.result(
        context,
        id.parse(c.req.param('groupId')),
        id.parse(c.req.param('seatId')),
        id.parse(c.req.param('invocationId')),
        query.afterOffset ?? 0,
      );
    }),
  );
  app.get('/:groupId/events/stream', (c) =>
    outsideStationServerScope(async () => {
      c.header('Cache-Control', 'no-store');
      if (!runtime)
        return c.json(
          { success: false, code: 'report_groups_unavailable' },
          503,
        );
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
        await awaitWithAbort(
          runtime.events(c, groupId, after),
          lifetime.signal,
        );
        current();
        return streamSSE(c, (stream) =>
          outsideStationServerScope(async () => {
            const stop = () =>
              outsideStationServerScope(() => {
                lifetime.stop();
                stream.abort();
              });
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
          }),
        );
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
    }),
  );
  app.post('/:groupId/members/:seatId/context-checkpoint', (c) =>
    respond(c, async (owner, context) => {
      noQuery(c);
      const input = z
        .object({ expectedRevision: z.number().int().nonnegative().safe() })
        .strict()
        .parse(await body(c));
      return owner.checkpoint(
        context,
        id.parse(c.req.param('groupId')),
        id.parse(c.req.param('seatId')),
        input.expectedRevision,
      );
    }),
  );
  app.post('/:groupId/sync/finalize', (c) =>
    respond(c, async (owner, context) => {
      noQuery(c);
      return owner.finalizeSync(
        context,
        id.parse(c.req.param('groupId')),
        finalizeSync.parse(await body(c)),
      );
    }),
  );
  app.post('/:groupId/input/narrow', (c) =>
    respond(c, async (owner, context) => {
      noQuery(c);
      return owner.narrowAfterInput(
        context,
        id.parse(c.req.param('groupId')),
        await body(c, REPORT_GROUP_RENEWAL_LIMITS.requestBytes),
      );
    }),
  );
  app.post('/:groupId/continuation/finalize', (c) =>
    respond(
      c,
      async (owner, context) => {
        noQuery(c);
        const input = cancel
          .extend({ continuationOperationKey: id })
          .strict()
          .parse(await body(c));
        return owner.finalizeContinuation(
          context,
          id.parse(c.req.param('groupId')),
          input,
        );
      },
      true,
    ),
  );
  app.post('/:groupId/report', (c) =>
    respond(c, async (owner, context) => {
      noQuery(c);
      const input = cancel
        .extend({
          seatId: id,
          flowHead: z.string().regex(/^[a-f0-9]{64}$/),
          syncOperationKey: id,
          previousInvocationId: id,
          retryRef: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(await body(c, REPORT_GROUP_RENEWAL_LIMITS.requestBytes));
      return owner.report(context, id.parse(c.req.param('groupId')), input);
    }),
  );
  app.post('/:groupId/input/sync', (c) =>
    respond(c, async (owner, context) => {
      noQuery(c);
      const input = cancel
        .extend({
          seatId: id,
          flowHead: z.string().regex(/^[a-f0-9]{64}$/),
          renewalOperationKey: id.max(
            REPORT_GROUP_RENEWAL_LIMITS.operationKeyCodeUnits,
          ),
        })
        .strict()
        .parse(await body(c, REPORT_GROUP_RENEWAL_LIMITS.requestBytes));
      return owner.syncAfterInput(
        context,
        id.parse(c.req.param('groupId')),
        input,
      );
    }),
  );
  app.post('/:groupId/sync', (c) =>
    respond(c, async (owner, context) => {
      noQuery(c);
      return owner.sync(
        context,
        id.parse(c.req.param('groupId')),
        sync.parse(await body(c, REPORT_GROUP_CONTEXT_LIMITS.requestBytes)),
      );
    }),
  );
  app.post('/:groupId/cancel/finalize', (c) =>
    respond(c, async (owner, context) => {
      noQuery(c);
      return owner.finalizeCancel(
        context,
        id.parse(c.req.param('groupId')),
        finalizeCancel.parse(await body(c)),
      );
    }),
  );
  app.post('/:groupId/accounting/recover', (c) =>
    respond(c, async (owner, context) => {
      noQuery(c);
      const input = z
        .object({ seatId: id, invocationId: id, operationKey: id })
        .strict()
        .parse(await body(c));
      return owner.recoverAccounting(
        context,
        id.parse(c.req.param('groupId')),
        input,
      );
    }),
  );
  app.post('/:groupId/cancel', (c) =>
    respond(c, async (owner, context) => {
      noQuery(c);
      return owner.cancel(
        context,
        id.parse(c.req.param('groupId')),
        cancel.parse(await body(c)),
      );
    }),
  );
  return app;
}
