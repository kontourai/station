import type { WorkItemObservation } from '@kontourai/station-contracts/work-item-provider';
import { describe, expect, test } from 'vitest';
import {
  WORK_ITEM_BRIEF_MAX_CHARS,
  workItemTaskBrief,
} from '../work-item-task-brief.js';

const observation = (
  overrides: Partial<WorkItemObservation> = {},
): WorkItemObservation => ({
  workItemRef: 'github:acme/widgets#42',
  url: 'https://github.com/acme/widgets/issues/42',
  title: 'Widgets jam',
  state: 'open',
  labels: [],
  updatedAt: '2026-10-20T00:00:00Z',
  observedAt: '2026-10-21T00:00:00.000Z',
  ...overrides,
});

describe('workItemTaskBrief', () => {
  test('keeps a long issue within the brief budget, says where it was cut, and keeps the link', () => {
    // 3,000 is pinned here as well as derived: the Task room refused a
    // one-batch document of about 3,650 characters.
    expect(WORK_ITEM_BRIEF_MAX_CHARS).toBe(3000);
    const brief = workItemTaskBrief(
      observation({
        body: 'line of the issue body\n'.repeat(400),
        comments: [1, 2, 3].map((index) => ({
          author: `c${index}`,
          createdAt: '2026-10-20T00:00:00Z',
          excerpt: 'x'.repeat(1000),
        })),
      }),
    );
    expect(brief.length).toBeLessThanOrEqual(3000);
    expect(brief.length).toBeGreaterThan(2900);
    expect(brief).toContain('[Cut here: the full description is on the item.]');
    expect(brief).toContain(
      'Read the whole item, with every comment, at [github:acme/widgets#42](<https://github.com/acme/widgets/issues/42>).',
    );
    expect(brief).toContain(`> ${'x'.repeat(400)}…`);
  });

  test('a short issue is copied whole, quoted', () => {
    const brief = workItemTaskBrief(
      observation({ body: '## Done\nNothing yet.' }),
    );
    expect(brief).toBe(
      [
        'Started from [github:acme/widgets#42](<https://github.com/acme/widgets/issues/42>).',
        '> ## Done\n> Nothing yet.',
        'Read the whole item, with every comment, at [github:acme/widgets#42](<https://github.com/acme/widgets/issues/42>).',
      ].join('\n\n'),
    );
  });

  test('an item without a description says so', () => {
    expect(workItemTaskBrief(observation())).toContain(
      '_The item has no description._',
    );
  });
});
