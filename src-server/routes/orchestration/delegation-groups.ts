import { DELEGATION_GROUP_LIMITS } from '@kontourai/station-contracts/delegation-group';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import {
  outsideStationServerScope,
  runAsStationServer,
} from '../../security/station-server-scope.js';
import { PortableGroupBudgetInsufficient } from '../../services/orchestration/portable-group-preparation.js';
import type { DelegationGroupRuntime } from '../../services/orchestration/portable-group-runtime.js';
import { parseStationReportGroupInput } from '../../services/orchestration/station-report-group-input.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const cursor = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/)
  .transform(Number)
  .refine(Number.isSafeInteger);
const command = z
  .object({
    operationId: id,
    expectedRevision: z.number().int().nonnegative().max(512),
  })
  .strict();

/** Mount behind authenticated Station ingress only when its host owners exist. */
// UNWIRED(#91): capability remains false until the complete portable surface is qualified.
export function createDelegationGroupRoutes(
  runtime: DelegationGroupRuntime | null,
) {
  const app = new Hono();
  const respond = async (
    context: Context,
    body: (owner: DelegationGroupRuntime) => Promise<unknown>,
  ) => {
    context.header('Cache-Control', 'no-store');
    if (!runtime)
      return context.json({ success: false, code: 'group_unavailable' }, 503);
    try {
      const current = await runtime.authorizeResponse(context);
      const authority = stationControlRequestAuthority(context.req.raw);
      const work = () => body(runtime);
      const data =
        authority?.kind === 'caller' || authority?.kind === 'caller-less'
          ? await outsideStationServerScope(work)
          : await runAsStationServer(work);
      current();
      if (
        Buffer.byteLength(JSON.stringify(data)) >
        DELEGATION_GROUP_LIMITS.responseBytes
      )
        return context.json(
          { success: false, code: 'group_response_too_large' },
          503,
        );
      return context.json({ success: true, data });
    } catch (error) {
      if (error instanceof PortableGroupBudgetInsufficient)
        return context.json(
          { success: false, code: error.code, failurePhase: error.phase },
          409,
        );
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return context.json({ success: false, code: 'group_invalid' }, 400);
      return context.json({ success: false, code: 'group_unavailable' }, 503);
    }
  };
  const readBody = async (context: Context) => {
    if (
      context.req
        .header('Content-Type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase() !== 'application/json'
    )
      throw new SyntaxError();
    const result = await readBoundedRequestBody(
      context.req.raw,
      DELEGATION_GROUP_LIMITS.requestBytes,
    );
    if (result.status !== 'ok') throw new SyntaxError();
    return JSON.parse(result.body);
  };
  const noQuery = (context: Context) =>
    z.object({}).strict().parse(context.req.query());
  app.post('/', (context) =>
    respond(context, async (owner) => {
      noQuery(context);
      return owner.create(
        context,
        parseStationReportGroupInput(await readBody(context)),
      );
    }),
  );
  app.get('/', (context) =>
    respond(context, (owner) => {
      const query = z
        .object({ afterGroupId: id.optional() })
        .strict()
        .parse(context.req.query());
      return owner.list(context, query.afterGroupId);
    }),
  );
  app.get('/:groupId', (context) =>
    respond(context, (owner) => {
      noQuery(context);
      return owner.get(context, id.parse(context.req.param('groupId')));
    }),
  );
  app.get('/:groupId/events', (context) =>
    respond(context, (owner) => {
      const query = z
        .object({ afterRevision: cursor.optional() })
        .strict()
        .parse(context.req.query());
      return owner.events(
        context,
        id.parse(context.req.param('groupId')),
        query.afterRevision ?? 0,
      );
    }),
  );
  app.get('/:groupId/members/:seatId/events', (context) =>
    respond(context, (owner) => {
      const query = z
        .object({ afterSequence: cursor.optional() })
        .strict()
        .parse(context.req.query());
      return owner.memberEvents(
        context,
        id.parse(context.req.param('groupId')),
        id.parse(context.req.param('seatId')),
        query.afterSequence ?? 0,
      );
    }),
  );
  app.get('/:groupId/members/:seatId/output', (context) =>
    respond(context, (owner) => {
      const query = z
        .object({ afterCodeUnit: cursor.optional() })
        .strict()
        .parse(context.req.query());
      return owner.memberOutput(
        context,
        id.parse(context.req.param('groupId')),
        id.parse(context.req.param('seatId')),
        query.afterCodeUnit ?? 0,
      );
    }),
  );
  app.post('/:groupId/run', (context) =>
    respond(context, async (owner) => {
      noQuery(context);
      const input = command.parse(await readBody(context));
      return owner.run(
        context,
        id.parse(context.req.param('groupId')),
        input.operationId,
        input.expectedRevision,
      );
    }),
  );
  app.post('/:groupId/cancel', (context) =>
    respond(context, async (owner) => {
      noQuery(context);
      const input = command.parse(await readBody(context));
      return owner.cancel(
        context,
        id.parse(context.req.param('groupId')),
        input.operationId,
        input.expectedRevision,
      );
    }),
  );
  return app;
}
