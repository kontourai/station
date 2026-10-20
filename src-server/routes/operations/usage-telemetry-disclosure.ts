import {
  PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL,
  type TelemetryFeedback,
} from '@kontourai/station-contracts/product-telemetry';
import { parseTelemetryFeedback } from '@kontourai/station-shared/product-telemetry';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
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
  for (const path of ['/feedback', '/lite-notices']) {
    app.on('POST', path, async (c, next) => {
      if (requestMayBeAnAgent(c.req.raw))
        return c.json(
          { success: false, error: { code: 'telemetry_user_action_required' } },
          403,
        );
      await next();
    });
  }
  app.on('POST', '/feedback', bodyLimit({ maxSize: 1024 }));
  app.on('POST', '/lite-notices', bodyLimit({ maxSize: 1024 }));
  app.get('/outbox', async (c) => {
    const publisher = c.req.query('publisher');
    if (
      publisher !== undefined &&
      publisher !== 'kontour' &&
      publisher !== 'operator'
    )
      return c.json(
        { success: false, error: { code: 'telemetry_publisher_invalid' } },
        400,
      );
    const rawLimit = c.req.query('limit');
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      return c.json(
        { success: false, error: { code: 'telemetry_outbox_limit_invalid' } },
        400,
      );
    const service = resolve();
    if (!service)
      return c.json(
        { success: false, error: { code: 'telemetry_not_ready' } },
        503,
      );
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      success: true,
      data: (await service.outbox(publisher)).slice(-limit),
    });
  });
  app.post('/feedback', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    let feedback: TelemetryFeedback;
    try {
      feedback = parseTelemetryFeedback(body);
      if (feedback.publisher !== 'kontour' && feedback.publisher !== 'operator')
        throw new Error('Unsupported feedback publisher');
    } catch {
      return c.json(
        { success: false, error: { code: 'telemetry_feedback_invalid' } },
        400,
      );
    }
    const service = resolve();
    if (!service)
      return c.json(
        { success: false, error: { code: 'telemetry_not_ready' } },
        503,
      );
    if (!(await service.submitFeedback(feedback)))
      return c.json(
        { success: false, error: { code: 'telemetry_feedback_not_available' } },
        409,
      );
    c.header('Cache-Control', 'private, no-store');
    return c.json({ success: true });
  });
  app.post('/lite-notices', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'inventoryRevision,publisher' ||
      !('publisher' in body) ||
      (body.publisher !== 'kontour' && body.publisher !== 'operator') ||
      !('inventoryRevision' in body) ||
      typeof body.inventoryRevision !== 'string'
    )
      return c.json(
        { success: false, error: { code: 'telemetry_notice_invalid' } },
        400,
      );
    const service = resolve();
    if (!service)
      return c.json(
        { success: false, error: { code: 'telemetry_not_ready' } },
        503,
      );
    const status = await service.telemetryStatus();
    if (body.inventoryRevision !== status.liteInventoryRevision)
      return c.json(
        { success: false, error: { code: 'telemetry_notice_changed' } },
        409,
      );
    if (status.publishers[body.publisher].reason === 'DNT')
      return c.json(
        { success: false, error: { code: 'telemetry_notice_DNT' } },
        409,
      );
    await service.recordLiteNotice(body.publisher, body.inventoryRevision);
    return c.json({ success: true });
  });
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
    const publisher = c.req.query('publisher');
    if (
      publisher !== undefined &&
      publisher !== 'operator' &&
      publisher !== 'kontour'
    )
      return c.json(
        { success: false, error: { code: 'telemetry_publisher_invalid' } },
        400,
      );
    const service = resolve();
    if (!service)
      return c.json(
        { success: false, error: { code: 'telemetry_not_ready' } },
        503,
      );
    if (
      publisher === 'kontour' &&
      !(await service.telemetryStatus()).authorEndpoint
    )
      return c.json(
        { success: false, error: { code: 'telemetry_unconfigured' } },
        409,
      );
    return c.json({ success: true, data: await service.disclosure(publisher) });
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
    const publisher = 'publisher' in body ? body.publisher : 'operator';
    if (publisher !== 'operator' && publisher !== 'kontour')
      return c.json(
        { success: false, error: { code: 'telemetry_publisher_invalid' } },
        400,
      );
    if (
      publisher === 'kontour' &&
      !(await service.telemetryStatus()).authorEndpoint
    )
      return c.json(
        { success: false, error: { code: 'telemetry_unconfigured' } },
        409,
      );
    const disclosure = await service.disclosure(publisher);
    if (
      publisher === 'kontour' &&
      (!('destination' in body) || body.destination !== disclosure.destination)
    )
      return c.json(
        { success: false, error: { code: 'telemetry_destination_changed' } },
        409,
      );
    if (body.inventoryRevision !== disclosure.inventoryRevision)
      return c.json(
        {
          success: false,
          error:
            'Usage telemetry disclosure changed; review the current inventory.',
        },
        409,
      );
    if (disclosure.publishers[publisher].reason === 'DNT')
      return c.json(
        {
          success: false,
          error:
            'Full telemetry must be confirmed after DO_NOT_TRACK is removed.',
        },
        409,
      );
    if (publisher === 'kontour')
      await service.acknowledgeDisclosure(
        body.inventoryRevision,
        publisher,
        disclosure.destination,
      );
    else await service.acknowledgeDisclosure(body.inventoryRevision);
    return c.json({ success: true, data: await service.disclosure(publisher) });
  });
  return app;
}
