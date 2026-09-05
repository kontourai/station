import type { LayoutCatalogContribution } from '@kontourai/station-contracts/layout';

/** Compare the declared identity fields, independently of JSON key order. */
export function sameLayoutContribution(
  left: LayoutCatalogContribution,
  right: LayoutCatalogContribution,
): boolean {
  return Boolean(
    left.sourceIdentity &&
      right.sourceIdentity &&
      left.provenance &&
      right.provenance &&
      left.id === right.id &&
      left.version === right.version &&
      left.sourceIdentity.id === right.sourceIdentity.id &&
      left.sourceIdentity.kind === right.sourceIdentity.kind &&
      left.sourceIdentity.source === right.sourceIdentity.source &&
      left.provenance.origin === right.provenance.origin &&
      left.provenance.pluginId === right.provenance.pluginId &&
      left.provenance.mcpServerId === right.provenance.mcpServerId,
  );
}
