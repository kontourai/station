import { DelegationContractV2Error } from '@kontourai/flow-agents/delegation-authority-contract';
import { DelegationAdmissionError } from '@kontourai/flow-agents/delegation-authority-service';
import { DELEGATION_GROUP_LIMITS } from '@kontourai/station-contracts/delegation-group';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { DelegationGroupBindingError } from '../../services/orchestration/delegation-group-binding-store.js';
import {
  type DelegationGroupRuntime,
  DelegationGroupRuntimeRefusal,
} from '../../services/orchestration/delegation-group-runtime.js';
import {
  awaitWithAbort,
  createGroupStreamLifetime,
  encodeGroupStreamCursor,
  readGroupStreamCursor,
} from '../../services/orchestration/delegation-group-transport.js';
import { streamSSE } from '../sse-response.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const createInput = z.object({ preparationId: id, operationId: id }).strict();
const commandInput = z
  .object({
    operationId: id,
    expectedRevision: z.number().int().nonnegative().max(512),
  })
  .strict();
const groupPath = z.object({ groupId: id }).strict();
const memberPath = z.object({ groupId: id, seatId: id }).strict();
const eventQuery = z
  .object({
    afterRevision: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .refine((n) => n <= 512)
      .optional(),
  })
  .strict();
const memberQuery = z
  .object({
    afterSequence: z
      .string()
      .regex(/^\d{1,15}$/)
      .transform(Number)
      .refine(Number.isSafeInteger)
      .optional(),
  })
  .strict();
const listQuery = z.object({ afterGroupId: id.optional() }).strict();
const noQuery = z.object({}).strict();

function failure(error: unknown): {
  code: string;
  status: 400 | 403 | 404 | 409 | 422 | 503;
} {
  if (error instanceof Error && error.message === 'group_stream_cursor_invalid')
    return { code: 'group_stream_cursor_invalid', status: 400 };
  if (
    error instanceof Error &&
    error.message === 'group_metadata_fence_unavailable'
  )
    return { code: 'group_metadata_fence_unavailable', status: 503 };
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return { code: 'group_invalid', status: 400 };
  if (error instanceof DelegationGroupRuntimeRefusal) {
    const status =
      error.code === 'group_authority_required'
        ? 403
        : error.code === 'group_not_found'
          ? 404
          : error.code === 'group_stale'
            ? 409
            : error.code === 'group_invalid'
              ? 400
              : 503;
    return { code: error.code, status };
  }
  if (error instanceof DelegationGroupBindingError)
    return { code: 'group_binding_unavailable', status: 409 };
  if (
    error instanceof DelegationAdmissionError ||
    error instanceof DelegationContractV2Error
  ) {
    const conflict = [
      'group_revision_conflict',
      'controller_fence_conflict',
      'operation_intent_conflict',
      'group_already_exists',
    ].includes(error.code);
    return {
      code: conflict ? 'group_conflict' : 'group_admission_refused',
      status: conflict ? 409 : 422,
    };
  }
  if (
    error instanceof Error &&
    error.name === 'BoundedApiExecutionUnavailableError'
  )
    return { code: 'physical_adapter_unqualified', status: 422 };
  return { code: 'group_unavailable', status: 503 };
}

/** Mount at /api/orchestration/groups, behind the existing auth/scope middleware. */
// UNWIRED(#91): mount together with explicit pairing leaves and actual host owners.
export function createDelegationGroupRoutes(
  runtime: DelegationGroupRuntime,
  resolvePrincipal: (context: Context) => PrincipalRef,
): Hono {
  const app = new Hono();
  const respond = async (
    c: Context,
    work: (principal: PrincipalRef) => Promise<unknown>,
  ) => {
    c.header('Cache-Control', 'no-store');
    try {
      const principal = resolvePrincipal(c);
      runtime.assertAuthority(c.req.raw, principal);
      const data = await work(principal);
      const body = { success: true, data };
      if (
        Buffer.byteLength(JSON.stringify(body)) >
        DELEGATION_GROUP_LIMITS.responseBytes
      )
        return c.json(
          { success: false, code: 'group_response_too_large' },
          503,
        );
      return c.json(body);
    } catch (error) {
      const result = failure(error);
      return c.json({ success: false, code: result.code }, result.status);
    }
  };
  const body = async (c: Context): Promise<unknown> => {
    if (
      !c.req
        .header('Content-Type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase()
        .endsWith('/json')
    )
      throw new DelegationGroupRuntimeRefusal('group_invalid');
    const result = await readBoundedRequestBody(
      c.req.raw,
      DELEGATION_GROUP_LIMITS.requestBytes,
    );
    if (result.status !== 'ok')
      throw new DelegationGroupRuntimeRefusal('group_invalid');
    return JSON.parse(result.body);
  };
  app.post('/', (c) =>
    respond(c, async (principal) => {
      noQuery.parse(c.req.query());
      return runtime.create(
        c.req.raw,
        principal,
        createInput.parse(await body(c)),
      );
    }),
  );
  app.get('/', (c) =>
    respond(c, async (principal) => {
      const query = listQuery.parse(c.req.query());
      return runtime.list(c.req.raw, principal, query.afterGroupId);
    }),
  );
  app.get('/:groupId', (c) =>
    respond(c, async (principal) => {
      noQuery.parse(c.req.query());
      const { groupId } = groupPath.parse(c.req.param());
      return runtime.get(c.req.raw, principal, groupId);
    }),
  );
  app.get('/:groupId/events', (c) =>
    respond(c, async (principal) => {
      const { groupId } = groupPath.parse(c.req.param());
      const query = eventQuery.parse(c.req.query());
      return runtime.events(
        c.req.raw,
        principal,
        groupId,
        query.afterRevision ?? 0,
      );
    }),
  );
  app.post('/:groupId/cancel', (c) =>
    respond(c, async (principal) => {
      noQuery.parse(c.req.query());
      const { groupId } = groupPath.parse(c.req.param());
      return runtime.cancel(
        c.req.raw,
        principal,
        groupId,
        commandInput.parse(await body(c)),
      );
    }),
  );
  app.post('/:groupId/run', (c) =>
    respond(c, async (principal) => {
      noQuery.parse(c.req.query());
      const { groupId } = groupPath.parse(c.req.param());
      return runtime.launch(
        c.req.raw,
        principal,
        groupId,
        commandInput.parse(await body(c)),
      );
    }),
  );
  app.get('/:groupId/members/:seatId/events', (c) =>
    respond(c, async (principal) => {
      const { groupId, seatId } = memberPath.parse(c.req.param());
      const query = memberQuery.parse(c.req.query());
      return runtime.memberEvents(
        c.req.raw,
        principal,
        groupId,
        seatId,
        query.afterSequence ?? 0,
      );
    }),
  );
  app.get('/:groupId/members/:seatId/output', (c) =>
    respond(c, async (principal) => {
      noQuery.parse(c.req.query());
      const { groupId, seatId } = memberPath.parse(c.req.param());
      return runtime.rawOutput(c.req.raw, principal, groupId, seatId);
    }),
  );
  app.get('/:groupId/events/stream', async (c) => {
    c.header('Cache-Control', 'no-store');
    const lifetime = createGroupStreamLifetime(c.req.raw.signal, 60_000);
    try {
      const principal = resolvePrincipal(c);
      runtime.assertAuthority(c.req.raw, principal);
      const { groupId } = groupPath.parse(c.req.param());
      const query = eventQuery.parse(c.req.query());
      const domain = { kind: 'group' as const, groupId };
      const after = readGroupStreamCursor(
        domain,
        query.afterRevision,
        c.req.header('Last-Event-ID'),
      );
      await awaitWithAbort(
        runtime.events(c.req.raw, principal, groupId, after),
        lifetime.signal,
      );
      return streamSSE(c, async (stream) => {
        const abort = () => {
          lifetime.stop();
          stream.abort();
        };
        stream.onAbort(lifetime.stop);
        lifetime.signal.addEventListener('abort', abort, { once: true });
        if (lifetime.signal.aborted) stream.abort();
        try {
          const pages = await awaitWithAbort(
            runtime.watchGroupEvents(
              c.req.raw,
              principal,
              groupId,
              after,
              lifetime.signal,
            ),
            lifetime.signal,
          );
          for await (const page of pages) {
            const data = JSON.stringify(page);
            if (Buffer.byteLength(data) > DELEGATION_GROUP_LIMITS.responseBytes)
              throw new Error('page limit');
            await awaitWithAbort(
              stream.writeSSE({
                id: encodeGroupStreamCursor(domain, page.nextRevision),
                event: 'group-events',
                data,
              }),
              AbortSignal.any([lifetime.signal, pages.signal]),
            );
          }
        } finally {
          lifetime.signal.removeEventListener('abort', abort);
          abort();
        }
      });
    } catch (error) {
      lifetime.stop();
      const result = failure(error);
      return c.json({ success: false, code: result.code }, result.status);
    }
  });
  app.get('/:groupId/members/:seatId/events/stream', async (c) => {
    c.header('Cache-Control', 'no-store');
    const lifetime = createGroupStreamLifetime(c.req.raw.signal, 60_000);
    try {
      const principal = resolvePrincipal(c);
      runtime.assertAuthority(c.req.raw, principal);
      const { groupId, seatId } = memberPath.parse(c.req.param());
      const query = memberQuery.parse(c.req.query());
      const domain = { kind: 'member' as const, groupId, seatId };
      const after = readGroupStreamCursor(
        domain,
        query.afterSequence,
        c.req.header('Last-Event-ID'),
      );
      await awaitWithAbort(
        runtime.memberEvents(c.req.raw, principal, groupId, seatId, after),
        lifetime.signal,
      );
      return streamSSE(c, async (stream) => {
        const abort = () => {
          lifetime.stop();
          stream.abort();
        };
        stream.onAbort(lifetime.stop);
        lifetime.signal.addEventListener('abort', abort, { once: true });
        if (lifetime.signal.aborted) stream.abort();
        try {
          const pages = await awaitWithAbort(
            runtime.watchMemberEvents(
              c.req.raw,
              principal,
              groupId,
              seatId,
              after,
              lifetime.signal,
            ),
            lifetime.signal,
          );
          for await (const page of pages) {
            const data = JSON.stringify(page);
            if (Buffer.byteLength(data) > DELEGATION_GROUP_LIMITS.responseBytes)
              throw new Error('page limit');
            await awaitWithAbort(
              stream.writeSSE({
                id: encodeGroupStreamCursor(domain, page.nextSequence),
                event: 'member-events',
                data,
              }),
              AbortSignal.any([lifetime.signal, pages.signal]),
            );
          }
        } finally {
          lifetime.signal.removeEventListener('abort', abort);
          abort();
        }
      });
    } catch (error) {
      lifetime.stop();
      const result = failure(error);
      return c.json({ success: false, code: result.code }, result.status);
    }
  });

  return app;
}
