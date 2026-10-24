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
    // 1,200 is pinned here as well as derived: the seed must leave most of
    // the Task room document's lifetime capacity to people (#4007).
    expect(WORK_ITEM_BRIEF_MAX_CHARS).toBe(1200);
    const link =
      '[github:acme/widgets#42](<https://github.com/acme/widgets/issues/42>)';
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
    expect(brief.length - link.length).toBeLessThanOrEqual(1200);
    expect(brief.length - link.length).toBeGreaterThan(1100);
    expect(brief.split(link)).toHaveLength(2);
    expect(brief.startsWith(`Started from ${link}.`)).toBe(true);
    expect(brief).toContain('[Cut here: the full description is on the item.]');
    // The two newest comments, each cut to 200 characters.
    expect(brief).not.toContain('**@c1**');
    expect(brief).toContain('**@c2**');
    expect(brief).toContain(`> ${'x'.repeat(200)}…`);
    expect(brief).not.toContain('x'.repeat(201));
    expect(brief).not.toMatch(/^## /m);
  });

  test('a short issue is copied whole, quoted', () => {
    const brief = workItemTaskBrief(
      observation({ body: '## Done\nNothing yet.' }),
    );
    expect(brief).toBe(
      [
        'Started from [github:acme/widgets#42](<https://github.com/acme/widgets/issues/42>).',
        '> ## Done\n> Nothing yet.',
        'Read the whole item, with every comment, on the tracker.',
      ].join('\n\n'),
    );
  });

  test('an item without a description says so', () => {
    expect(workItemTaskBrief(observation())).toContain(
      '_The item has no description._',
    );
  });
});
