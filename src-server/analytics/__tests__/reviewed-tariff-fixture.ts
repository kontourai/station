import { compileCatalog, type ObservationInput } from '@kontourai/bearing';
import type { ReviewedTariffBinding } from '../bearing-usage-pricing-snapshot-capture.js';

const observation: ObservationInput = {
  schemaVersion: 'bearing.observation/v2',
  kind: 'declaration',
  model: { id: 'model', revision: 'r1', quantization: null },
  execution: {
    kind: 'partial',
    runtime: { id: 'provider-direct', version: null },
    adapter: null,
    effectiveContextTokens: null,
    toolSurface: null,
    hardware: null,
    workflow: null,
  },
  task: null,
  measurements: [
    { key: 'provider.input', kind: 'fact', value: 0.000002, unit: 'USD/token' },
    {
      key: 'provider.output',
      kind: 'fact',
      value: 0.000004,
      unit: 'USD/token',
    },
  ],
  outcome: null,
  usage: null,
  sourceClass: 'first-party',
  evidence: [
    {
      id: 'source-1',
      kind: 'published-tariff',
      uri: 'https://provider.example/pricing',
      digest: { algorithm: 'sha256', value: 'a'.repeat(64) },
      observedAt: '2026-08-01T00:00:00.000Z',
    },
  ],
  freshness: {
    observedAt: '2026-08-01T00:00:00.000Z',
    validUntil: '2026-08-30T00:00:00.000Z',
  },
  uncertainty: {
    level: 'low',
    basis: ['reviewed exact provider tariff'],
    gaps: [],
  },
};
export const route = {
  id: 'provider-direct',
  modelRevision: 'r1',
  tariffId: 'tariff-1',
  provenance: { authority: 'host-observed' as const, sourceRef: 'dispatch:1' },
};
export const catalog = compileCatalog([observation], {
  asOf: '2026-08-01T00:00:00.000Z',
});
export const binding: ReviewedTariffBinding = {
  observationId: catalog.models[0]!.observations[0]!.id,
  provider: 'acp',
  model: 'model',
  basis: {
    routeId: 'provider-direct',
    modelRevision: 'r1',
    tariffId: 'tariff-1',
    sourceUrl: 'https://provider.example/pricing',
    sourceArtifactId: 'source-1',
    reviewedAt: '2026-08-01T00:00:00.000Z',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    validUntil: '2026-08-30T00:00:00.000Z',
    cacheInput: 'disjoint',
    reasoning: 'unknown',
  },
  measurements: { input: 'provider.input', output: 'provider.output' },
};
