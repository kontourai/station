import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ReviewedTariffConfigurationService } from '../reviewed-tariff-config.js';
import { binding, catalog, route } from './reviewed-tariff-fixture.js';

const directory = trackTempDirs();
function fixture() {
  const root = directory('reviewed-tariffs-');
  chmodSync(root, 0o700);
  return { root, service: new ReviewedTariffConfigurationService(root) };
}
const request = {
  expectedRevision: 0,
  operationId: '0199a001-0000-7000-8000-000000000001',
  catalog,
  bindings: [binding],
};
const admission = { actorId: 'person:operator', assertCurrent() {} };

test('reading unconfigured tariffs is inert; explicit verified review persists private provenance and supplies the production capture', async () => {
  const { root, service } = fixture();
  expect(service.read()).toEqual({ state: 'not-configured' });
  expect(readdirSync(root)).toEqual([]);
  const saved = await service.review(request, admission);
  expect(saved.reviewedBy).toBe('person:operator');
  expect(saved.bindings[0]?.basis.reviewedAt).toBe(saved.reviewedAt);
  const current = service.read();
  expect(current.state).toBe('available');
  if (current.state !== 'available') throw new Error('Review did not persist');
  expect(
    await current.capture.capture({
      provider: 'acp',
      model: 'model',
      route,
      observedAt: '2026-08-10T00:00:00.000Z',
    }),
  ).toMatchObject({ inputPerMillion: 2, outputPerMillion: 4 });
  const bytes = readFileSync(join(root, 'reviewed-usage-tariffs.json'), 'utf8');
  expect(await service.review(request, admission)).toEqual(saved);
  expect(readFileSync(join(root, 'reviewed-usage-tariffs.json'), 'utf8')).toBe(
    bytes,
  );
});

test('body-supplied reviewers, conflicting revisions, revoked review and invalid owner mappings cannot publish tariffs', async () => {
  const { root, service } = fixture();
  await expect(
    service.review({ ...request, reviewedBy: 'person:forged' }, admission),
  ).rejects.toThrow();
  await expect(
    service.review(
      {
        ...request,
        bindings: [
          { ...binding, basis: { ...binding.basis, routeId: 'openrouter' } },
        ],
      },
      admission,
    ),
  ).rejects.toThrow();
  await expect(
    service.review(request, {
      actorId: 'person:operator',
      assertCurrent() {
        throw new Error('revoked');
      },
    }),
  ).rejects.toThrow('revoked');
  expect(service.read()).toEqual({ state: 'not-configured' });
  await service.review(request, admission);
  const bytes = readFileSync(join(root, 'reviewed-usage-tariffs.json'), 'utf8');
  await expect(
    service.review(
      { ...request, operationId: '0199a001-0000-7000-8000-000000000002' },
      admission,
    ),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(readFileSync(join(root, 'reviewed-usage-tariffs.json'), 'utf8')).toBe(
    bytes,
  );
});

test('corrupt retained configuration remains unavailable and cannot be silently replaced by defaults', async () => {
  const { root, service } = fixture();
  writeFileSync(join(root, 'reviewed-usage-tariffs.json'), '{broken', {
    mode: 0o600,
  });
  expect(service.read()).toEqual({ state: 'unavailable' });
  await expect(service.review(request, admission)).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(readFileSync(join(root, 'reviewed-usage-tariffs.json'), 'utf8')).toBe(
    '{broken',
  );
});
