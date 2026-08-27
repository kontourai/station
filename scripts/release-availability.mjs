import { reduceDeliveryAvailability } from './issue-availability.mjs';

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const predicates = Object.freeze({
  portable: 'npm/runtime',
  desktop: 'npm/runtime,rust/native',
  mobile: 'npm/runtime,rust/native',
  container: 'container/image',
});

/**
 * Pure Slice-B projector. Its caller supplies only completed provider receipts;
 * branches, dry runs and uncertain effects have no admissible evidence shape.
 */
export function projectReleaseAvailability(labels, evidence) {
  const stage =
    evidence?.channel === 'preview'
      ? 'stage:preview'
      : evidence?.channel === 'stable'
        ? 'stage:stable'
        : null;
  if (
    !stage ||
    evidence?.success !== true ||
    !SHA.test(evidence?.sourceSha ?? '') ||
    evidence?.tag !== `v${evidence?.version}` ||
    evidence?.inventory?.schemaVersion !== 2 ||
    evidence.inventory?.tag !== evidence.tag ||
    evidence.inventory?.sourceSha !== evidence.sourceSha ||
    evidence.inventory?.channel !== evidence.channel ||
    !SHA256.test(evidence?.inventorySha ?? '') ||
    evidence?.attestation?.sourceSha !== evidence.sourceSha ||
    evidence.attestation?.inventorySha !== evidence.inventorySha ||
    evidence?.release?.effect !== 'published' ||
    evidence.release?.draft !== false ||
    evidence.release?.public !== true ||
    evidence.release?.tag !== evidence.tag ||
    evidence.release?.sourceSha !== evidence.sourceSha ||
    Object.entries(predicates).some(
      ([scope, predicate]) => evidence?.sbomPredicates?.[scope] !== predicate,
    )
  )
    return { kind: 'ignored', add: [], remove: [] };
  return reduceDeliveryAvailability(labels, stage);
}
