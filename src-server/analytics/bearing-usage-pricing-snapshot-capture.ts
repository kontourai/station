import { validateCatalogSnapshot } from '@kontourai/bearing';
import {
  isPublishedTariffBasis,
  type PricingSnapshot,
  type PublishedTariffBasis,
  type UsageReceipt,
} from '@kontourai/station-contracts/usage-rollup';
import type { UsagePricingSnapshotCapture } from './usage-pricing-snapshot-capture.js';

/** Trusted host review binds a Bearing observation to a serving route and token rules. No rates live here. */
export interface ReviewedTariffBinding {
  observationId: string;
  provider: string;
  model: string;
  basis: PublishedTariffBasis;
  measurements: {
    input?: string;
    output?: string;
    cacheRead?: string;
    cacheWrite?: string;
    reasoning?: string;
  };
}

export class BearingUsagePricingSnapshotCapture
  implements UsagePricingSnapshotCapture
{
  private readonly snapshots: readonly PricingSnapshot[];

  constructor(catalog: unknown, bindings: readonly ReviewedTariffBinding[]) {
    const validated = validateCatalogSnapshot(catalog);
    this.snapshots = bindings.map((binding) => {
      if (!isPublishedTariffBasis(binding.basis))
        throw new Error('Invalid reviewed tariff basis');
      const observation = validated.models
        .flatMap((model) => model.observations)
        .find((item) => item.id === binding.observationId);
      if (
        observation?.kind !== 'declaration' ||
        observation.execution?.runtime.id !== binding.basis.routeId ||
        observation.model.id !== binding.model ||
        observation.model.revision !== binding.basis.modelRevision ||
        !observation.evidence.some(
          (ref) =>
            ref.id === binding.basis.sourceArtifactId &&
            ref.uri === binding.basis.sourceUrl &&
            ref.digest,
        )
      )
        throw new Error('Tariff binding does not match exact Bearing evidence');
      if (
        observation.freshness.validUntil &&
        Date.parse(binding.basis.validUntil) >
          Date.parse(observation.freshness.validUntil)
      )
        throw new Error('Reviewed tariff exceeds owner freshness');
      if (
        validated.conflicts.some((conflict) =>
          conflict.observationIds.includes(observation.id),
        )
      )
        throw new Error('Conflicting tariff observation');
      const rate = (key: string | undefined) => {
        if (!key) return undefined;
        const rows = observation.measurements.filter(
          (measurement) => measurement.key === key,
        );
        const row = rows[0];
        if (
          rows.length !== 1 ||
          row?.kind !== 'fact' ||
          row.unit !== 'USD/token' ||
          typeof row.value !== 'number' ||
          !Number.isFinite(row.value) ||
          row.value < 0
        )
          throw new Error(
            'Tariff measurement is unavailable or has unsupported units',
          );
        return row.value * 1_000_000;
      };
      const reasoningPerMillion = rate(binding.measurements.reasoning);
      return {
        id: `bearing:${validated.digest}:${observation.id}:${binding.basis.tariffId}`,
        capturedAt: observation.freshness.observedAt,
        source: binding.basis.sourceUrl,
        currency: 'USD',
        provider: binding.provider,
        model: binding.model,
        inputPerMillion: rate(binding.measurements.input),
        outputPerMillion: rate(binding.measurements.output),
        cacheReadPerMillion: rate(binding.measurements.cacheRead),
        cacheWritePerMillion: rate(binding.measurements.cacheWrite),
        publishedTariff: { ...binding.basis, reasoningPerMillion },
      };
    });
  }

  async capture(input: {
    provider: string;
    model: string;
    observedAt: string;
    route?: UsageReceipt['route'];
  }): Promise<PricingSnapshot | undefined> {
    const matches = this.snapshots.filter(
      (snapshot) =>
        snapshot.provider === input.provider &&
        snapshot.model === input.model &&
        input.route !== undefined &&
        input.route.provenance.sourceRef.length > 0 &&
        input.route.id === snapshot.publishedTariff?.routeId &&
        input.route.modelRevision === snapshot.publishedTariff.modelRevision &&
        input.route.tariffId === snapshot.publishedTariff.tariffId,
    );
    // A model label alone cannot select a serving tariff.
    if (matches.length !== 1) return undefined;
    const snapshot = matches[0]!;
    return {
      ...snapshot,
      publishedTariff: snapshot.publishedTariff
        ? { ...snapshot.publishedTariff }
        : undefined,
    };
  }
}
