import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { uiCommandOps } from '../../telemetry/metrics.js';

const INVALID_PATH = /javascript:|data:|vbscript:/i;

export interface UICommandRouteDeps {
  /**
   * archive#3567 fix round FIX 1: `UI_NAVIGATE` reaches a client only through
   * `/events`' `canRelayUiNavigateEvent`, which delivers in personal mode and
   * denies in hosted multi-tenant mode (the payload carries no destination
   * identity to route it to one tenant). This route must not report success
   * for a broadcast that will be silently dropped — it asks the same
   * personal-vs-hosted question and refuses up front when the answer is
   * "hosted", rather than emitting an event nobody will ever receive.
   *
   * archive#3567 second fix round FIX 1: REQUIRED, not optional. An
   * optional, defaulted safety decision is exactly the bug class this PR
   * exists to close — an unwired predicate previously read as "personal"
   * (`deps.isHostedDeployment?.() === true` is `false` when the field is
   * `undefined`) and emitted. There is exactly one production call site
   * (`runtime-routes.ts`); every caller must now supply this explicitly, and
   * a second composition that forgets it fails to compile instead of
   * silently emitting in a hosted deployment.
   *
   * This route and `/events`' `canRelayUiNavigateEvent` derive "is this
   * deployment hosted" from two independent sources — this one from the
   * `hostedTenantRegistry` closed over at route composition, `/events` from
   * `authority.mode` on the per-request `SessionReadAuthority`. They agree
   * today only because both ultimately close over the same
   * `hostedTenantRegistry` in `runtime-routes.ts`; there is no shared
   * enforcement that keeps them in lockstep if that ever changes.
   */
  isHostedDeployment: () => boolean;
}

export function createUICommandRoutes(
  eventBus: EventBus,
  deps: UICommandRouteDeps,
) {
  const app = new Hono();

  app.post('/', async (c) => {
    const { command, payload } = await c.req.json<{
      command: string;
      payload: Record<string, unknown>;
    }>();
    uiCommandOps.add(1, { op: 'execute' });

    if (command === 'navigate') {
      const path = payload?.path;
      if (
        typeof path !== 'string' ||
        !path.startsWith('/') ||
        path.startsWith('//') ||
        path.startsWith('http:') ||
        path.startsWith('https:') ||
        INVALID_PATH.test(path)
      ) {
        return c.json(
          { success: false, error: 'Invalid navigation path' },
          400,
        );
      }
      if (deps.isHostedDeployment()) {
        // archive#3567 second fix round FIX 3: 403, not 409 — what forbids
        // this is the deployment's own configuration, not a resource state
        // the client could resolve and retry (409's contract). No retry can
        // ever succeed here. Same shape and status as
        // `plugin-public-routes.ts`'s "this configuration does not permit
        // this operation" refusal.
        return c.json(
          {
            success: false,
            error:
              "Navigation commands are not delivered in hosted multi-tenant mode: /events has no destination identity to route ui:navigate to one tenant's connections, so it is denied rather than broadcast to every tenant.",
          },
          403,
        );
      }
      eventBus.emit(SERVER_EVENTS.UI_NAVIGATE, { path });
      return c.json({ success: true });
    }

    return c.json(
      { success: false, error: `Unknown command: ${command}` },
      400,
    );
  });

  return app;
}
