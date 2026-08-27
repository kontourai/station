/** Bounded personal-mode Activity projection; the runtime owns room visibility. */
import {
  LIVE_ACTIVITY_MAX_CONNECTED_CLIENTS,
  LIVE_ACTIVITY_SCHEMA_VERSION,
  type LiveActivityProjection,
} from '@kontourai/station-contracts/live-activity';
import { Hono } from 'hono';
import type { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import type { ClientConnectionPresence } from '../../services/ssh/client-connection-presence.js';

export interface LiveActivityRouteDeps {
  readonly roomRuntime?: ProjectTaskRoomRuntime;
  readonly connectedClientPresence: ClientConnectionPresence;
  readonly activePairedDeviceIds: () => readonly string[];
  readonly hosted?: () => boolean;
}

export function createLiveActivityRoutes(deps: LiveActivityRouteDeps) {
  const app = new Hono();
  app.get('/', async (c) => {
    if (deps.hosted?.() || !deps.roomRuntime)
      return c.json({ error: 'unavailable' }, 404);
    const activity = await deps.roomRuntime.liveActivity({
      request: c.req.raw,
    });
    if (activity.kind !== 'available')
      return c.json({ error: 'unavailable' }, 404);
    const connectedClients = Math.min(
      LIVE_ACTIVITY_MAX_CONNECTED_CLIENTS,
      [
        ...deps.connectedClientPresence
          .snapshot(deps.activePairedDeviceIds())
          .values(),
      ].reduce((total, device) => total + device.sessionCount, 0),
    );
    const projection: LiveActivityProjection = {
      ...activity.projection,
      schemaVersion: LIVE_ACTIVITY_SCHEMA_VERSION,
      connectedClients,
    };
    return c.json({ success: true, data: projection });
  });
  return app;
}
