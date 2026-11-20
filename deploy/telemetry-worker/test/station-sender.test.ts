import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL } from '@kontourai/station-contracts/product-telemetry';
import { LITE_TELEMETRY_INVENTORY_REVISION } from '@kontourai/station-shared/product-telemetry';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs.js';
import { createUsageTelemetryDisclosureRoutes } from '../../../src-server/routes/operations/usage-telemetry-disclosure.js';
import { UsageTelemetryService } from '../../../src-server/services/usage-telemetry-service.js';
import { call, fakeReceiver, provision, testEnv } from './helpers.ts';

const build = vi.hoisted(() => ({
  endpoint: 'https://telemetry.kontourai.io/v1/lite/station',
}));
vi.mock('../../../src-server/domain/telemetry-build-constants.js', () => ({
  STATION_AUTHOR_TELEMETRY_ENDPOINT: build.endpoint,
}));
const makeTempDir = trackTempDirs();

test('a Stable Station sends only a noticed daily report to the Lite-only Kontour Worker', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-12T10:00:00Z');
  const worker = fakeReceiver();
  let live: UsageTelemetryService | undefined;
  try {
    const env = testEnv(worker);
    await provision(env);
    const sends: { url: string; body: unknown; status: number }[] = [];
    const home = makeTempDir('station-lite-worker-');
    live = new UsageTelemetryService({
      homeDir: home,
      appConfig: {
        defaultModel: 'fixture',
        invokeModel: 'fixture',
        structureModel: 'fixture',
        telemetryTier: { kontour: 'full', operator: 'off' },
      },
      version: '1.2.3',
      env: { STATION_CHANNEL: 'stable', STATION_STDOUT_HANDSHAKE: '1' },
      logger: { warn: vi.fn() },
      fetch: async (input, init) => {
        const url = String(input);
        const response = await call(env, new URL(url).pathname, init);
        sends.push({
          url,
          body: JSON.parse(String(init?.body)),
          status: response.status,
        });
        return response;
      },
    });
    await live.stationStarted();
    const shown = await live.disclosure('kontour');
    await writeFile(
      join(home, 'config', 'usage-telemetry-disclosure-kontour.json'),
      JSON.stringify({
        acknowledgedAt: new Date().toISOString(),
        destination: build.endpoint,
        inventoryRevision: shown.inventoryRevision,
        publisher: 'kontour',
      }),
    );
    await live.track('plugin_installed', { plugin: 'custom' });
    await live.flush();
    expect(sends).toEqual([]);

    const routes = createUsageTelemetryDisclosureRoutes(live);
    const refused = await routes.request('/disclosure/acknowledgements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        acknowledgementProtocol: PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL,
        inventoryRevision: shown.inventoryRevision,
        publisher: 'kontour',
        destination: build.endpoint,
      }),
    });
    expect(refused.status).toBe(409);
    expect(await live.canSaveAuthorFull()).toBe(false);
    await live.recordLiteNotice('kontour', LITE_TELEMETRY_INVENTORY_REVISION);
    vi.setSystemTime('2026-10-13T10:00:00Z');
    await live.flushDaily();
    expect(sends).toEqual([
      {
        url: build.endpoint,
        body: expect.objectContaining({
          event: 'station_daily',
          channel: 'stable',
          version: '1.2.3',
        }),
        status: 202,
      },
    ]);
    expect(sends[0].body).not.toHaveProperty('distinct_id');
    expect(await live.outbox('kontour')).toEqual([
      expect.objectContaining({ outcome: 'sent', tier: 'lite' }),
    ]);
    const read = await call(env, '/v1/operator/lite/insights', {
      operator: true,
    });
    expect(read.status).toBe(200);
    const insights = (await read.json()) as { totals: number[] };
    expect(insights.totals.at(-1)).toBe(1);
  } finally {
    try {
      await live?.shutdown();
    } finally {
      worker.storage.db.close();
      vi.useRealTimers();
    }
  }
});
