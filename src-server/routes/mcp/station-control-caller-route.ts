/**
 * Station #90 lane D (station #122): the REST projection of a station-control
 * tool's verified caller, mounted under `/api/orchestration`.
 *
 * It has no production client. Its original consumer, a stdio
 * station-control child holding a per-session credential, no longer exists
 * (stdio children are caller-less); in-process tools resolve their caller
 * directly. The `/caller/delegation` leaf below is still used by
 * `station-control-delegation.ts`.
 *
 * Internal-only: any caller the runtime boundary did not accept as Station's
 * own internal principal gets a 404, whatever scope its credential carries,
 * so the leaf discloses nothing (not even that it exists) to a paired
 * device or operator credential. An internal request gets `{ caller }`,
 * which is `null` unless it presents a live credential; see
 * `resolveStationControlCallerForRequest` for the conditions.
 */
import { Hono } from 'hono';
import {
  resolveStationControlCallerForRequest,
  type StationControlCallerRecordResolver,
} from '../../runtime/mcp/station-control-caller.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function createStationControlCallerRoutes(options: {
  resolveRecord?: StationControlCallerRecordResolver;
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
  return app;
}
