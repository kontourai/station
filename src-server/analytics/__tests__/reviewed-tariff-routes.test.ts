import { chmodSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createReviewedTariffRoutes } from '../../routes/operations/reviewed-tariff-routes.js';
import { ReviewedTariffConfigurationService } from '../reviewed-tariff-config.js';
import { binding, catalog, route } from './reviewed-tariff-fixture.js';

const makeDirectory = trackTempDirs();

test('operator review route updates the same private pricing owner used by ingestion, with exact source metadata and no provider calls', async () => {
  const root = makeDirectory('tariff-route-');
  chmodSync(root, 0o700);
  const writer = new ReviewedTariffConfigurationService(root);
  const ingestion = new ReviewedTariffConfigurationService(root);
  let current = true;
  const app = createReviewedTariffRoutes({
    service: () => writer,
    enabled: () => true,
    authorize: async () => ({
      actorId: 'person:verified',
      assertCurrent() {
        if (!current) throw new Error('revoked');
      },
    }),
  });
  const captureInput = {
    provider: 'acp',
    model: 'model',
    route,
    observedAt: '2026-08-10T00:00:00.000Z',
  };
  expect(await ingestion.capture(captureInput)).toBeUndefined();
  const response = await app.request('http://station.test/reviewed-tariffs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: 0,
      operationId: '0199a001-0000-7000-8000-000000000001',
      catalog,
      bindings: [binding],
    }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).data.reviewedBy).toBe('person:verified');
  const first = await ingestion.capture(captureInput);
  expect(first).toMatchObject({
    inputPerMillion: 2,
    publishedTariff: { routeId: 'provider-direct' },
  });
  const read = vi.spyOn(ingestion, 'read');
  expect(await ingestion.capture(captureInput)).toEqual(first);
  expect(read).not.toHaveBeenCalled();
  current = false;
  expect(
    (await app.request('http://station.test/reviewed-tariffs')).status,
  ).toBe(403);
});
