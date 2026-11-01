import { expect, test } from 'vitest';
import { BearingUsagePricingSnapshotCapture } from '../bearing-usage-pricing-snapshot-capture.js';
import { binding, catalog, route } from './reviewed-tariff-fixture.js';

test('captures exact reviewed public Bearing facts without a Station price table; missing and ambiguous routes stay unpriced', async () => {
  const capture = new BearingUsagePricingSnapshotCapture(catalog, [binding]);
  expect(
    await capture.capture({
      provider: 'acp',
      model: 'model',
      route,
      observedAt: '2026-08-10T00:00:00.000Z',
    }),
  ).toMatchObject({
    inputPerMillion: 2,
    outputPerMillion: 4,
    publishedTariff: {
      routeId: 'provider-direct',
      sourceArtifactId: 'source-1',
    },
  });
  expect(
    await capture.capture({
      provider: 'bedrock',
      model: 'model',
      route,
      observedAt: '2026-08-10T00:00:00.000Z',
    }),
  ).toBeUndefined();
  const ambiguous = new BearingUsagePricingSnapshotCapture(catalog, [
    binding,
    { ...binding, basis: { ...binding.basis } },
  ]);
  expect(
    await ambiguous.capture({
      provider: 'acp',
      model: 'model',
      route,
      observedAt: '2026-08-10T00:00:00.000Z',
    }),
  ).toBeUndefined();
});

test('rejects a model revision, source artifact or measurement not vouched by the validated owner observation', () => {
  for (const changed of [
    { ...binding, basis: { ...binding.basis, modelRevision: 'r2' } },
    { ...binding, basis: { ...binding.basis, sourceArtifactId: 'other' } },
    { ...binding, measurements: { input: 'invented-rate' } },
    { ...binding, basis: { ...binding.basis, routeId: 'openrouter' } },
  ])
    expect(
      () => new BearingUsagePricingSnapshotCapture(catalog, [changed]),
    ).toThrow();
});

test('immutable tariff snapshot identity includes reviewed route, category and measurement mapping', async () => {
  const input = {
    provider: 'acp',
    model: 'model',
    route,
    observedAt: '2026-08-10T00:00:00.000Z',
  };
  const original = await new BearingUsagePricingSnapshotCapture(catalog, [
    binding,
  ]).capture(input);
  const changedCategory = await new BearingUsagePricingSnapshotCapture(
    catalog,
    [{ ...binding, basis: { ...binding.basis, cacheInput: 'included' } }],
  ).capture(input);
  const changedMapping = await new BearingUsagePricingSnapshotCapture(catalog, [
    {
      ...binding,
      measurements: { input: 'provider.output', output: 'provider.input' },
    },
  ]).capture(input);
  expect(changedCategory?.id).not.toBe(original?.id);
  expect(changedMapping?.id).not.toBe(original?.id);
  expect(
    (
      await new BearingUsagePricingSnapshotCapture(catalog, [
        structuredClone(binding),
      ]).capture(input)
    )?.id,
  ).toBe(original?.id);
});
