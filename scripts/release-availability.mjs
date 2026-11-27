import { reduceDeliveryAvailability } from './issue-availability.mjs';
import { parseReleaseTag } from './lib/release-tag.mjs';

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const predicates = Object.freeze({
  portable: 'npm/runtime',
  desktop: 'npm/runtime,rust/native',
  mobile: 'npm/runtime,rust/native',
  container: 'container/image',
});

/** The driver authenticates the receipt before supplying this unchanged inventory lineage. */
function matchesPublication(evidence) {
  if (!evidence?.promotion) return evidence?.inventory?.tag === evidence?.tag;
  const lineage = evidence.promotion;
  try {
    const producer = parseReleaseTag(lineage.producerTag);
    const publication = parseReleaseTag(evidence.tag);
    return (
      evidence.channel === 'stable' &&
      producer.kind === 'rc' &&
      publication.kind === 'final' &&
      producer.baseVersion === publication.baseVersion &&
      lineage.publicationTag === evidence.tag &&
      lineage.sourceSha === evidence.sourceSha &&
      lineage.version === evidence.version &&
      lineage.inventorySha === evidence.inventorySha &&
      evidence.inventory?.tag === producer.tag &&
      evidence.inventory?.version === producer.baseVersion
    );
  } catch {
    return false;
  }
}

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
    !matchesPublication(evidence) ||
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
