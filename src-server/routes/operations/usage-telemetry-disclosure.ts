import { PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL } from '@kontourai/station-contracts/product-telemetry';
import { Hono } from 'hono';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import type { UsageTelemetryService } from '../../services/usage-telemetry-service.js';
import {
  checkOtelTelemetryConnection,
  getOtelTelemetryDeliveryStatus,
} from '../../telemetry-delivery-state.js';

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
) {
  const resolve = () =>
    typeof serviceOrGetter === 'function' ? serviceOrGetter() : serviceOrGetter;
  const app = new Hono();
  app.get('/status', async (c) => {
    const service = resolve();
    if (!service)
      return c.json(
        { success: false, error: { code: 'telemetry_not_ready' } },
        503,
      );
    c.header('Cache-Control', 'private, no-store');
    return c.json({ success: true, data: await service.telemetryStatus() });
  });
  app.get('/delivery-status', async (c) => {
    const service = resolve();
    if (!service)
      return c.json(
        { success: false, error: { code: 'telemetry_not_ready' } },
        503,
      );
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      success: true,
      data: {
        protocol: 'station-telemetry-delivery/v1',
        product: await service.deliveryStatus(),
        otel: getOtelTelemetryDeliveryStatus(),
      },
    });
  });
  app.post('/connection-checks/:transport', async (c) => {
    const transport = c.req.param('transport');
    if (transport !== 'product' && transport !== 'otel')
      return c.json(
        { success: false, error: { code: 'telemetry_transport_invalid' } },
        400,
      );
    const service = resolve();
    if (!service)
      return c.json(
        { success: false, error: { code: 'telemetry_not_ready' } },
        503,
      );
    c.header('Cache-Control', 'private, no-store');
    const result =
      transport === 'product'
        ? await service.checkConnection()
        : await checkOtelTelemetryConnection();
    return c.json({ success: true, data: result });
  });
  app.get('/disclosure', async (c) => {
    const service = resolve();
    if (!service)
      return c.json(
        { success: false, error: { code: 'telemetry_not_ready' } },
        503,
      );
    return c.json({ success: true, data: await service.disclosure() });
  });
  app.post('/disclosure/acknowledgements', async (c) => {
    if (requestMayBeAnAgent(c.req.raw))
      return c.json(
        {
          success: false,
          error:
            'Agents cannot acknowledge telemetry consent. The operator can review it in Settings.',
        },
        403,
      );
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
    if (disclosure.publishers.operator.reason === 'DNT')
      return c.json(
        {
          success: false,
          error:
            'Full telemetry must be confirmed after DO_NOT_TRACK is removed.',
        },
        409,
      );
    await service.acknowledgeDisclosure(body.inventoryRevision);
    return c.json({ success: true, data: await service.disclosure() });
  });
  return app;
}
