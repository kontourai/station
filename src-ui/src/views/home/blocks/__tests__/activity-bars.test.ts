/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import type { HomeWorkItem } from '../../home-view-model';
import { barHeight, bucketLabel, buildHeatRows } from '../activity-bars';

const NOW = 1_760_000_000_000;

function item(
  id: string,
  project: string,
  minutesAgo: number,
): HomeWorkItem & { stableId: string } {
  return {
    id,
    stableId: id,
    kind: 'orchestration',
    kindLabel: 'Session',
    title: `work ${id}`,
    projectLabel: project,
    agentLabel: 'Codex',
    modelLabel: 'gpt-5.4',
    updatedAt: NOW - minutesAgo * 60_000,
    lifecycleLabel: 'Completed',
  } as HomeWorkItem & { stableId: string };
}

describe('buildHeatRows', () => {
  test('buckets by project and time, busiest project first', () => {
    const rows = buildHeatRows(
      [
        item('a', 'Station', 10),
        item('b', 'Station', 20),
        item('c', 'Station', 700),
        item('d', 'Flow', 30),
      ],
      NOW,
    );
    expect(rows.map((r) => r.project)).toEqual(['Station', 'Flow']);
    expect(rows[0].total).toBe(3);
    expect(rows[0].cells).toHaveLength(12);
    // Newest column is last; the two 10/20-minute items share it.
    expect(rows[0].cells[11].count).toBe(2);
  });

  test('drops items older than the rendered window rather than crushing them into column zero', () => {
    const rows = buildHeatRows([item('old', 'Station', 60 * 24 * 5)], NOW);
    expect(rows).toEqual([]);
  });

  test('each cell carries its latest item, so a click has a target', () => {
    const rows = buildHeatRows(
      [item('older', 'Station', 30), item('newer', 'Station', 5)],
      NOW,
    );
    expect(rows[0].cells[11].latest?.id).toBe('newer');
  });
});

/**
 * The row's slug is what makes its label navigable, and a row is only
 * navigable when its items agree. These pin the disagreement cases, because
 * the harm is one-directional: a row that links to the wrong project claims
 * the work in it belongs there.
 */
describe('buildHeatRows project slug agreement', () => {
  const withSlug = (id: string, project: string, slug?: string) =>
    ({
      ...item(id, project, 10),
      ...(slug ? { projectSlug: slug } : {}),
    }) as HomeWorkItem & { stableId: string };

  test('a row whose items all name one slug carries it', () => {
    const rows = buildHeatRows(
      [
        withSlug('a', 'Station', 'station'),
        withSlug('b', 'Station', 'station'),
      ],
      NOW,
    );
    expect(rows[0].projectSlug).toBe('station');
  });

  test('a row whose items name two different slugs carries none', () => {
    const rows = buildHeatRows(
      [withSlug('a', 'Station', 'station'), withSlug('b', 'Station', 'beacon')],
      NOW,
    );
    expect(rows[0].projectSlug).toBeNull();
  });

  test('one item without a slug withholds it from the whole row', () => {
    const rows = buildHeatRows(
      [withSlug('a', 'Station', 'station'), withSlug('b', 'Station')],
      NOW,
    );
    expect(rows[0].projectSlug).toBeNull();
  });

  test('a row of slug-less items carries none', () => {
    const rows = buildHeatRows([withSlug('a', 'No project')], NOW);
    expect(rows[0].projectSlug).toBeNull();
  });

  test('rows do not borrow each other’s slugs', () => {
    const rows = buildHeatRows(
      [withSlug('a', 'Station', 'station'), withSlug('b', 'Flow')],
      NOW,
    );
    const byProject = new Map(rows.map((row) => [row.project, row]));
    expect(byProject.get('Station')?.projectSlug).toBe('station');
    expect(byProject.get('Flow')?.projectSlug).toBeNull();
  });
});

describe('buildHeatRows clock skew', () => {
  /**
   * A client whose clock trails the server's receives future-dated items —
   * and they are the NEWEST ones, exactly what this block exists to show.
   * Without the clamp a negative age indexes one past the last bucket, the
   * cell is undefined, and reading `.count` throws: one skewed timestamp
   * takes the whole Home route down to its error boundary. The clamp was
   * untested until the independent verifier's injection sweep found that
   * removing it left every suite green.
   */
  test('a future-dated item lands in the newest bucket rather than throwing', () => {
    const future = { ...item('skewed', 'Station', 0), updatedAt: NOW + 90_000 };
    expect(() => buildHeatRows([future], NOW)).not.toThrow();
    const rows = buildHeatRows([future], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(1);
    expect(rows[0].cells[11].count).toBe(1);
    expect(rows[0].cells[11].latest?.id).toBe('skewed');
  });

  test('a badly skewed item is still counted, not dropped', () => {
    const veryFuture = {
      ...item('way-off', 'Station', 0),
      updatedAt: NOW + 7 * 24 * 60 * 60_000,
    };
    const rows = buildHeatRows([veryFuture], NOW);
    expect(rows[0].total).toBe(1);
  });
});

describe('barHeight', () => {
  test('a bucket with work never renders as an empty one', () => {
    expect(barHeight(1, 40)).toBeGreaterThanOrEqual(0.18);
    expect(barHeight(0, 40)).toBe(0);
  });

  test('the tallest bucket fills the row', () => {
    expect(barHeight(7, 7)).toBe(1);
  });

  test('a zero peak cannot divide by zero', () => {
    expect(Number.isFinite(barHeight(3, 0))).toBe(true);
  });
});

describe('bucketLabel', () => {
  /** The grid this replaced had twelve unnamed columns; a cell said how many
   * but never when. */
  test('names the window each column covers, newest last', () => {
    expect(bucketLabel(11)).toBe('in the last 4 hours');
    expect(bucketLabel(10)).toBe('about 4 hours ago');
    expect(bucketLabel(0)).toBe('about 44 hours ago');
  });
});
