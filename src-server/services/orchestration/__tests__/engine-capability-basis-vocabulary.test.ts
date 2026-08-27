/**
 * station#1549: pins `BuiltinStationControlDelivery['basis']` to the Surface
 * spec's own evidence vocabulary.
 *
 * WHY THIS TEST LIVES HERE AND NOT IN `packages/contracts`
 * `packages/contracts` has no dependency on `@kontourai/surface` and must not
 * gain one for a string literal — it is the leaf every other package imports.
 * The station tree DOES depend on surface (see
 * `services/evidence/trust-bundle-service.ts`), so the pin lives here: the
 * closest place that can see both vocabularies at once.
 *
 * WHAT IT PROTECTS
 * `'runtime_observation'` is not a word this repo invented. It is
 * `@kontourai/surface`'s `EvidenceType` member, and the whole
 * policy-in-the-cell / evidence-on-the-connection / status-as-a-derivation
 * shape is the spec's `sf-runtime-observation-required` conformance case
 * applied to engine capability. Re-spelling it locally
 * (`'runtimeObservation'`, `'probed'`, `'negotiated'`) would fork the
 * vocabulary from the spec that gives it meaning, quietly, with nothing to
 * catch it — which is exactly how this codebase produced local status enums
 * three times before.
 *
 * These are compile-time assertions: this file failing `npm run typecheck` IS
 * the failure. The runtime expectations below exist so the file also fails
 * visibly under vitest rather than passing as an empty suite.
 */

import type { BuiltinStationControlDelivery } from '@kontourai/station-contracts/engine-capability-matrix';
import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';
import type { EvidenceType } from '@kontourai/surface';
import { describe, expect, test } from 'vitest';

type Basis = BuiltinStationControlDelivery['basis'];

/** Every basis is either the local "statically reviewed" token or a Surface evidence type. */
type BasisIsSurfaceVocabulary = Basis extends 'declared' | EvidenceType
  ? true
  : never;
const _basisIsSurfaceVocabulary: BasisIsSurfaceVocabulary = true;

/**
 * And specifically: the observation basis IS Surface's `runtime_observation`
 * member, not a look-alike. `extends` in this direction fails if the literal
 * is ever re-spelled, even to something that still satisfies the union above
 * by accident.
 */
type ObservationBasisIsSurfaceMember =
  'runtime_observation' extends EvidenceType
    ? 'runtime_observation' extends Basis
      ? true
      : never
    : never;
const _observationBasisIsSurfaceMember: ObservationBasisIsSurfaceMember = true;

describe('station#1549: capability basis vocabulary is Surface’s, not a local coinage', () => {
  test('the compile-time pins hold', () => {
    expect(_basisIsSurfaceVocabulary).toBe(true);
    expect(_observationBasisIsSurfaceMember).toBe(true);
  });

  test('every shipped delivery mechanism carries an explicit basis — no cell may be silent about how it is verified', () => {
    for (const matrix of Object.values(ENGINE_CAPABILITY_MATRICES)) {
      const cell = matrix.toolServers;
      if (cell.state !== 'session') continue;
      const delivery = cell.builtinStationControlDelivery;
      if (delivery === undefined) continue;
      expect(delivery.basis).toBeDefined();
      expect(['declared', 'runtime_observation']).toContain(delivery.basis);
    }
  });
});
