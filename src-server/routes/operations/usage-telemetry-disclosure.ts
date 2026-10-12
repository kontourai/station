import { PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL } from '@kontourai/station-contracts/product-telemetry';
import { type Context, Hono } from 'hono';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  runtimeRequestPrincipalMayAccessHttpRoute,
} from '../../security/runtime-request-security.js';
import type { UsageTelemetryService } from '../../services/usage-telemetry-service.js';

/**
 * The two writes a disclosure surface offers, evaluated against THIS caller.
 *
 * Acknowledging needs `access:manage` (pairing-route-scopes.ts), which no
 * QR/manual-code pairing preset carries, so a paired phone can read the
 * inventory but never consent to egress on the operator's behalf. Without
 * these booleans the UI offered that phone a modal whose every action could
 * only fail. They are computed with the same gate ingress applies, for the
 * exact routes the UI would call, so the offer cannot drift from the refusal.
 */
const ACKNOWLEDGE_ROUTE = {
  method: 'POST',
  path: '/api/usage-telemetry/disclosure/acknowledgements',
} as const;
const CHANGE_SETTING_ROUTE = { method: 'PUT', path: '/config/app' } as const;

/** The inventory is served from the emitter's source so disclosure copy cannot drift. */
/**
 * Accepts a getter because routes are registered inside `initializeRuntime`
 * (runtime-initialize.ts) BEFORE `StationRuntime` constructs its
 * `UsageTelemetryService` (station-runtime.ts, after initialize returns). A
 * service captured by value at mount time is therefore always undefined; the
 * handler must resolve it per request and answer 503 until it exists.
 */
export function createUsageTelemetryDisclosureRoutes(
  serviceOrGetter:
    | UsageTelemetryService
    | (() => UsageTelemetryService | undefined),
  security: CurrentRuntimeRequestPrincipalSecurity,
) {
  const resolve = () =>
    typeof serviceOrGetter === 'function' ? serviceOrGetter() : serviceOrGetter;
  const callerDisclosure = async (
    service: UsageTelemetryService,
    c: Context,
  ) => ({
    ...(await service.disclosure()),
    canAcknowledge: runtimeRequestPrincipalMayAccessHttpRoute(
      c.req.raw,
      security,
      ACKNOWLEDGE_ROUTE,
    ),
    canChangeSetting: runtimeRequestPrincipalMayAccessHttpRoute(
      c.req.raw,
      security,
      CHANGE_SETTING_ROUTE,
    ),
  });
  const app = new Hono();
  app.get('/disclosure', async (c) => {
    const service = resolve();
    if (!service)
      return c.json(
        { success: false, error: { code: 'telemetry_not_ready' } },
        503,
      );
    return c.json({ success: true, data: await callerDisclosure(service, c) });
  });
  app.post('/disclosure/acknowledgements', async (c) => {
    const service = resolve();
    if (!service)
      return c.json(
        { success: false, error: { code: 'telemetry_not_ready' } },
        503,
      );
    const body: unknown = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !('acknowledgementProtocol' in body) ||
      body.acknowledgementProtocol !==
        PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL
    )
      return c.json(
        {
          success: false,
          error: {
            code: 'telemetry_acknowledgement_protocol_unsupported',
            message:
              'Update this app to acknowledge the current usage telemetry inventory.',
            requiredProtocol: PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL,
          },
        },
        426,
      );
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !('inventoryRevision' in body) ||
      typeof body.inventoryRevision !== 'string'
    )
      return c.json(
        {
          success: false,
          error: 'The displayed inventory revision is required.',
        },
        400,
      );
    const disclosure = await service.disclosure();
    if (body.inventoryRevision !== disclosure.inventoryRevision)
      return c.json(
        {
          success: false,
          error:
            'Usage telemetry disclosure changed; review the current inventory.',
        },
        409,
      );
    await service.acknowledgeDisclosure(body.inventoryRevision);
    // The client caches this answer in place of the GET's, so it carries the
    // same per-caller capabilities.
    return c.json({ success: true, data: await callerDisclosure(service, c) });
  });
  return app;
}
