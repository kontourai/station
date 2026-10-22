import type { EnsembleInspectionFact } from '@kontourai/station-contracts/ensemble';

/** Display geometry only; declarations never establish a ready frontier. */
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
    const settings =
      parent && parent !== node
        ? [
            {
              kind: 'configuration' as const,
              factId: node.fact.id,
              from: parent,
              to: node,
            },
          ]
        : [];
    const prerequisites = (node.fact.needs ?? []).flatMap((memberId) => {
      const from = byId.get(`member:${memberId}`);
      return from && parent
        ? [
            {
              kind: 'prerequisite' as const,
              factId: node.fact.id,
              from,
              to: parent,
            },
          ]
        : [];
    });
    return [...settings, ...prerequisites];
  });
  return {
    nodes,
    edges,
    width: 730,
    height: Math.max(110, Math.ceil(nodes.length / 3) * 100 + 10),
  };
}
