/**
 * Lane D of #90 (archive#122): the REST projection of a station-control
 * tool's verified caller, mounted under `/api/orchestration`.
 *
 * Its consumer is a stdio station-control child: that process holds its
 * per-session credential but not Station's token registry, so it asks here.
 * The answer is `{ caller: null }` for every request that is not Station's
 * own internal caller presenting a live credential; see
 * `resolveStationControlCallerForRequest` for the three conditions.
 */
import { Hono } from 'hono';
import {
  resolveStationControlCallerForRequest,
  type StationControlCallerRecordResolver,
  stationControlCallerProjection,
} from '../../runtime/mcp/station-control-caller.js';

export function createStationControlCallerRoutes(options: {
  resolveRecord?: StationControlCallerRecordResolver;
}): Hono {
  const app = new Hono();
  app.get('/station-control/caller', (c) => {
    const caller = resolveStationControlCallerForRequest(
      c.req.raw,
      options.resolveRecord,
    );
    return c.json(
      { caller: caller ? stationControlCallerProjection(caller) : null },
      200,
      { 'Cache-Control': 'no-store' },
    );
  });
  return app;
}
