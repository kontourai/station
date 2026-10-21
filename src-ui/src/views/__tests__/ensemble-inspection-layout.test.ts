import type { EnsembleInspectionFact } from '@kontourai/station-contracts/ensemble';
import { expect, test } from 'vitest';
import { layoutEnsembleInspection } from '../ensemble-inspection-layout';

test('large and cyclic display relations have finite stable geometry independent of input order', () => {
  const facts: EnsembleInspectionFact[] = Array.from(
    { length: 256 },
    (_, index) => ({
      id: index < 2 ? `member:${index}` : `tool:${index}`,
      memberId: index === 0 ? '1' : '0',
      category: 'tools/services',
      label: `Setting ${index}`,
      value: 'Configured reference',
      state: 'unknown',
      origin: 'authored',
      owner: { label: 'Preset source' },
    }),
  );
  const layout = layoutEnsembleInspection(facts);
  expect(layoutEnsembleInspection([...facts].reverse())).toEqual(layout);
  expect(layout.nodes).toHaveLength(256);
  expect(layout.edges).toHaveLength(256);
  expect(new Set(layout.nodes.map(({ x, y }) => `${x}:${y}`)).size).toBe(256);
  expect(layout.height).toBe(8610);
  expect(
    layout.edges
      .slice(0, 2)
      .map((edge) => [edge.from.fact.id, edge.to.fact.id]),
  ).toEqual([
    ['member:1', 'member:0'],
    ['member:0', 'member:1'],
  ]);
});
