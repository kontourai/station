import type { EnsembleInspectionFact } from '@kontourai/station-contracts/ensemble';

/** Display geometry only. Member ownership lines do not represent execution routes. */
export function layoutEnsembleInspection(
  facts: readonly EnsembleInspectionFact[],
) {
  const nodes = [...facts]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((fact, index) => ({
      fact,
      x: (index % 3) * 240 + 10,
      y: Math.floor(index / 3) * 100 + 10,
    }));
  const byId = new Map(nodes.map((node) => [node.fact.id, node]));
  const edges = nodes.flatMap((node) => {
    const parent =
      node.fact.memberId && byId.get(`member:${node.fact.memberId}`);
    return parent && parent !== node ? [{ from: parent, to: node }] : [];
  });
  return {
    nodes,
    edges,
    width: 730,
    height: Math.max(110, Math.ceil(nodes.length / 3) * 100 + 10),
  };
}
