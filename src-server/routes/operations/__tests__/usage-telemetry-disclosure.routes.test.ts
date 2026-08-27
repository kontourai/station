import { describe, expect, test, vi } from 'vitest';
import { createUsageTelemetryDisclosureRoutes } from '../usage-telemetry-disclosure.js';

const disclosure = {
  acknowledged: false,
  inventoryRevision: 'inventory-revision',
  events: { station_started: { description: 'Starts', properties: {} } },
};

describe('usage telemetry disclosure routes', () => {
  test('ROUTE CONTRACT DEFECT: GET returns the documented disclosure envelope', async () => {
    const service = {
      disclosure: vi.fn().mockResolvedValue(disclosure),
      acknowledgeDisclosure: vi.fn(),
    };
    const response = await createUsageTelemetryDisclosureRoutes(
      service as never,
    ).request('/disclosure');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: disclosure,
    });
  });

  test('ROUTE IDEMPOTENCE DEFECT: repeated acknowledgement preserves one receipt revision and response shape', async () => {
    const acknowledged = { ...disclosure, acknowledged: true };
    const service = {
      disclosure: vi.fn().mockResolvedValue(acknowledged),
      acknowledgeDisclosure: vi.fn().mockResolvedValue(undefined),
    };
    const app = createUsageTelemetryDisclosureRoutes(service as never);
    const first = await app.request('/disclosure/acknowledgements', {
      method: 'POST',
    });
    const second = await app.request('/disclosure/acknowledgements', {
      method: 'POST',
    });
    expect(service.acknowledgeDisclosure).toHaveBeenCalledTimes(2);
    await expect(first.json()).resolves.toEqual({
      success: true,
      data: acknowledged,
    });
    await expect(second.json()).resolves.toEqual({
      success: true,
      data: acknowledged,
    });
  });
});
