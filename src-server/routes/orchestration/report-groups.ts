import { DelegationContractV2Error } from '@kontourai/flow-agents/delegation-authority-contract';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import type { StationReportGroupRuntime } from '../../services/orchestration/station-report-group-runtime.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
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
