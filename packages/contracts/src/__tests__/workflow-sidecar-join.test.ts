import { describe, expect, test } from 'vitest';
import {
  looksLikeWorkflowTaskSlugRef,
  resolveWorkflowTaskMatch,
  slugifyWorkflowTaskTitle,
} from '../workflow.js';

describe('slugifyWorkflowTaskTitle', () => {
  test('lowercases and collapses non-alphanumeric runs to single hyphens', () => {
    expect(slugifyWorkflowTaskTitle('Sidecar Join #582')).toBe(
      'sidecar-join-582',
    );
    expect(slugifyWorkflowTaskTitle('  Trim Me  ')).toBe('trim-me');
    expect(slugifyWorkflowTaskTitle('multi---dash__title')).toBe(
      'multi-dash-title',
    );
  });

  test('returns empty string for titles with no alphanumeric characters', () => {
    expect(slugifyWorkflowTaskTitle('***')).toBe('');
    expect(slugifyWorkflowTaskTitle('')).toBe('');
  });
});

describe('looksLikeWorkflowTaskSlugRef', () => {
  test('accepts bare filesystem-safe slug shapes', () => {
    expect(looksLikeWorkflowTaskSlugRef('sidecar-join-582')).toBe(true);
    expect(looksLikeWorkflowTaskSlugRef('s2.sidecar_join')).toBe(true);
  });

  test('rejects URLs, owner/repo#issue refs, and other opaque external ids', () => {
    expect(
      looksLikeWorkflowTaskSlugRef('https://github.com/org/repo/issues/582'),
    ).toBe(false);
    expect(looksLikeWorkflowTaskSlugRef('kontourai/station#582')).toBe(false);
    expect(looksLikeWorkflowTaskSlugRef('')).toBe(false);
  });
});

describe('resolveWorkflowTaskMatch', () => {
  const sidecarTasks = [
    { taskSlug: 'sidecar-join-582', status: 'in_progress' },
    {
      taskSlug: 'other-task',
      status: 'new',
      workItemRefs: ['kontourai/station#592'],
    },
  ];

  test('prefers a durable workItemRef match over the title heuristic', () => {
    const task = {
      title: 'Totally different title',
      workItemRef: 'other-task',
    };
    const result = resolveWorkflowTaskMatch(task, [task], sidecarTasks);
    expect(result).toEqual({ match: sidecarTasks[1], kind: 'workItemRef' });
  });

  test('matches a provider-shaped workItemRef against canonical sidecar refs', () => {
    const task = {
      title: 'Totally different title',
      workItemRef: 'kontourai/station#592',
    };
    expect(resolveWorkflowTaskMatch(task, [task], sidecarTasks)).toEqual({
      match: sidecarTasks[1],
      kind: 'workItemRef',
    });
  });

  test('rejects an ambiguous provider-shaped workItemRef', () => {
    const task = {
      title: 'Totally different title',
      workItemRef: 'kontourai/station#592',
    };
    expect(
      resolveWorkflowTaskMatch(
        task,
        [task],
        [
          ...sidecarTasks,
          {
            taskSlug: 'duplicate',
            status: 'new',
            workItemRefs: ['kontourai/station#592'],
          },
        ],
      ),
    ).toBeUndefined();
  });

  test('ignores a workItemRef that is not slug-shaped and falls back to title', () => {
    const task = {
      title: 'Sidecar Join #582',
      workItemRef: 'https://github.com/org/repo/issues/582',
    };
    const result = resolveWorkflowTaskMatch(task, [task], sidecarTasks);
    expect(result).toEqual({ match: sidecarTasks[0], kind: 'title-heuristic' });
  });

  test('falls back to the title heuristic when there is no workItemRef match', () => {
    const task = { title: 'Sidecar Join #582' };
    const result = resolveWorkflowTaskMatch(task, [task], sidecarTasks);
    expect(result).toEqual({ match: sidecarTasks[0], kind: 'title-heuristic' });
  });

  test('returns undefined when there is no exact match at all (never guesses)', () => {
    const task = { title: 'Unrelated title' };
    expect(
      resolveWorkflowTaskMatch(task, [task], sidecarTasks),
    ).toBeUndefined();
  });

  test('returns undefined for a title that slugifies to empty', () => {
    const task = { title: '***' };
    expect(
      resolveWorkflowTaskMatch(task, [task], sidecarTasks),
    ).toBeUndefined();
  });

  test('returns undefined against an empty sidecar list', () => {
    const task = { title: 'Sidecar Join #582' };
    expect(resolveWorkflowTaskMatch(task, [task], [])).toBeUndefined();
  });

  test('collision: two titles normalizing identically suppress the join for BOTH', () => {
    const taskA = { title: 'Sidecar Join #582' };
    const taskB = { title: 'sidecar join   582' }; // normalizes to the same slug
    const allProjectTasks = [taskA, taskB];

    expect(
      resolveWorkflowTaskMatch(taskA, allProjectTasks, sidecarTasks),
    ).toBeUndefined();
    expect(
      resolveWorkflowTaskMatch(taskB, allProjectTasks, sidecarTasks),
    ).toBeUndefined();
  });

  test('a workItemRef match is unaffected by a title-slug collision elsewhere', () => {
    const taskA = { title: 'Sidecar Join #582', workItemRef: 'other-task' };
    const taskB = { title: 'sidecar join   582' };
    const allProjectTasks = [taskA, taskB];

    expect(
      resolveWorkflowTaskMatch(taskA, allProjectTasks, sidecarTasks),
    ).toEqual({ match: sidecarTasks[1], kind: 'workItemRef' });
    expect(
      resolveWorkflowTaskMatch(taskB, allProjectTasks, sidecarTasks),
    ).toBeUndefined();
  });
});
