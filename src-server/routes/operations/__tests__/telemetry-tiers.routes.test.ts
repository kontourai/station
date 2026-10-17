import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { UsageTelemetryService } from '../../../services/usage-telemetry-service.js';
import { createUsageTelemetryDisclosureRoutes } from '../usage-telemetry-disclosure.js';

const makeTempDir = trackTempDirs();
test('status uses the live service configuration, respects DNT and never sends', async () => {
  const home = makeTempDir('station-tiers-route-');
  const fetch = vi.fn();
  const subject = new UsageTelemetryService({
    homeDir: home,
    appConfig: {
      defaultModel: '',
      invokeModel: '',
      structureModel: '',
      telemetryTier: { operator: 'full' },
    },
    version: '1.2.3',
    logger: { warn: vi.fn() },
    env: { DO_NOT_TRACK: '1' },
    fetch,
  });
  const response =
    await createUsageTelemetryDisclosureRoutes(subject).request('/status');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const body = await response.json();
  expect(body).toMatchObject({
    success: true,
    data: {
      liteInventory: {
        event: { domain: ['station_daily'] },
        public_plugins_enabled: { arrayMax: 20 },
      },
      liteInventoryRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      publishers: {
        kontour: { tier: 'off', reason: 'DNT' },
        operator: { tier: 'off', reason: 'DNT' },
      },
    },
  });
  expect(fetch).not.toHaveBeenCalled();
});
