/**
 * Station #90 lane D (station #122): the REST projection of a station-control
 * tool's verified caller, mounted under `/api/orchestration`.
 *
 * Its consumer is a stdio station-control child: that process holds its
 * per-session credential but not Station's token registry, so it asks here.
 *
 * Internal-only: any caller the runtime boundary did not accept as Station's
 * own internal principal gets a 404, whatever scope its credential carries,
 * so the leaf discloses nothing (not even that it exists) to a paired
 * device or operator credential. An internal request gets `{ caller }`,
 * which is `null` unless it presents a live credential; see
 * `resolveStationControlCallerForRequest` for the conditions.
 */
import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import { Hono } from 'hono';
import {
  resolveStationControlCallerForRequest,
  type StationControlCallerRecordResolver,
} from '../../runtime/mcp/station-control-caller.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function createStationControlCallerRoutes(options: {
  resolveRecord?: StationControlCallerRecordResolver;
  /**
   * #2601: the child context this Station derives for the request's verified
   * caller, or `null` without one (`createCallerDelegationDeriver`).
   */
  deriveCallerDelegation?: (
    request: Request,
  ) => Promise<AgentDelegationContext | null>;
}): Hono {
  const app = new Hono();
  app.get('/station-control/caller', (c) => {
    if (getRuntimeAuthenticatedRequestPrincipal(c.req.raw)?.kind !== 'internal')
      return c.json({ error: { code: 'not_found' } }, 404, NO_STORE);
    const caller = resolveStationControlCallerForRequest(
      c.req.raw,
      options.resolveRecord,
    );
    return c.json({ caller }, 200, NO_STORE);
  });
  // #2601: what a station-control tool forwards to a saved Environment,
  // settled here because that forward bypasses this Station's dispatch
  // routes. A refusal (depth limit, underivable lineage) is a 403 whose
  // message the tool reports as-is.
  app.get('/station-control/caller/delegation', async (c) => {
    if (
      getRuntimeAuthenticatedRequestPrincipal(c.req.raw)?.kind !== 'internal' ||
      !options.deriveCallerDelegation
    )
      return c.json({ error: { code: 'not_found' } }, 404, NO_STORE);
    try {
      const delegation = await options.deriveCallerDelegation(c.req.raw);
      return c.json({ delegation }, 200, NO_STORE);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (
        code === 'delegation_depth_exceeded' ||
        code === 'delegation_lineage_unavailable'
      )
        return c.json({ error: (error as Error).message, code }, 403, NO_STORE);
      throw error;
    }
  });
  return app;
}
