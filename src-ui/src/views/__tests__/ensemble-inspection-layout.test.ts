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
  facts.push(
    ...['0', '1'].map((memberId) => ({
      id: `needs:${memberId}`,
      memberId,
      needs: [memberId === '0' ? '1' : '0'],
      category: 'routing/triggers' as const,
      label: 'Declared prerequisites',
      value: 'Cyclic draft',
      state: 'configured' as const,
      origin: 'authored' as const,
      owner: { label: 'Group dependency draft' },
    })),
  );
  const layout = layoutEnsembleInspection(facts);
  expect(layoutEnsembleInspection([...facts].reverse())).toEqual(layout);
  expect(layout.nodes).toHaveLength(258);
  expect(layout.edges).toHaveLength(260);
  expect(new Set(layout.nodes.map(({ x, y }) => `${x}:${y}`)).size).toBe(258);
  expect(
    layout.edges
      .filter((edge) => edge.kind === 'prerequisite')
      .map((edge) => [edge.from.fact.id, edge.to.fact.id, edge.factId]),
  ).toEqual([
    ['member:1', 'member:0', 'needs:0'],
    ['member:0', 'member:1', 'needs:1'],
  ]);
  expect(Number.isFinite(layout.height)).toBe(true);
  expect(
    layout.nodes.every(
      ({ x, y }) =>
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x >= 0 &&
        y >= 0 &&
        x < layout.width &&
        y < layout.height,
    ),
  ).toBe(true);
  expect(
    layout.edges
      .slice(0, 2)
      .map((edge) => [edge.from.fact.id, edge.to.fact.id]),
  ).toEqual([
    ['member:1', 'member:0'],
    ['member:0', 'member:1'],
  ]);
});
