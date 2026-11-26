/**
 * #2377 slice D: station-control for a run of Station's own engine that an
 * authenticated HTTP request starts with no session — the invoke endpoints
 * (`POST /agents/:slug/invoke`, `/agents/:slug/invoke/stream`, `/invoke`),
 * the SDK's raw tool call (`POST /agents/:slug/tools/:toolName`) and a
 * direct chat stream (`POST /api/agents/:slug/chat` from a client, e.g. the
 * SDK's `streamConversationTurn`).
 *
 * The run acts for the principal Station resolved for the request (the
 * operator's credential, a paired device's person, an account), through its
 * own per-run in-process server and `bound` token
 * (`openNativeStationControlRequestRun`). A request with no resolvable
 * principal gets no run, so its tool calls are refused
 * (`station_control_caller_required`). An internal request never gets one:
 * a bare internal token is refused by the authority guard, and Station's own
 * relay of a session turn carries that session's turn correlation, which is
 * the caller its tool calls use.
 *
 * The run ends when the response does: after the body is fully read or
 * cancelled, so a streamed invoke keeps its caller for its whole stream.
 */
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { Context, MiddlewareHandler } from 'hono';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { openNativeStationControlRequestRun } from '../mcp/station-control-native-tools.js';

/** The engine routes that run Station's own agent for an HTTP request. */
export const REQUEST_STATION_CONTROL_PATHS = [
  '/agents/:slug/invoke',
  '/agents/:slug/invoke/stream',
  '/invoke',
  '/agents/:slug/tools/:toolName',
  '/api/agents/:slug/chat',
] as const;

export function createRequestStationControlMiddleware(deps: {
  /** The request's resolved principal id; throws or answers nothing when none. */
  resolvePrincipalId(c: Context): string | undefined;
  tenantFor(request: Request): TenantExecutionContext | undefined;
}): MiddlewareHandler {
  return async (c, next) => {
    if (
      c.req.method !== 'POST' ||
      getRuntimeAuthenticatedRequestPrincipal(c.req.raw)?.kind === 'internal'
    )
      return next();
    let principalId: string | undefined;
    try {
      principalId = deps.resolvePrincipalId(c);
    } catch {
      principalId = undefined;
    }
    if (!principalId) return next();
    const tenant = deps.tenantFor(c.req.raw);
    const run = openNativeStationControlRequestRun({
      principalId,
      ...(tenant ? { tenantExecutionContext: tenant } : {}),
    });
    try {
      await run.run(() => next());
    } catch (error) {
      await run.close();
      throw error;
    }
    const body = c.res.body;
    if (!body) {
      await run.close();
      return;
    }
    // Retire the run when the response body ends or is abandoned.
    const reader = body.getReader();
    const response = c.res;
    c.res = new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              controller.close();
              await run.close();
            } else controller.enqueue(chunk.value);
          } catch (error) {
            controller.error(error);
            await run.close();
          }
        },
        async cancel(reason) {
          await run.close();
          await reader.cancel(reason);
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  };
}
