import { describe, expect, test } from 'vitest';
import {
  describeSkipped,
  planLibraryUpload,
} from '../project-library-upload-plan';
import {
  EXPLORE_TASK_TITLE,
  setupRecommendations,
} from '../setup-recommendations';

describe('setupRecommendations', () => {
  test('a repository gets the read-only explore Task; a Project without a brief gets one', () => {
    const recommendations = setupRecommendations({
      project: { name: 'Billing', hasRepository: true },
    });
    expect(recommendations.map((item) => item.id)).toEqual([
      'brief',
      'explore',
    ]);
    const explore = recommendations[1]!;
    expect(explore.kind === 'task' && explore.task.title).toBe(
      EXPLORE_TASK_TITLE,
    );
    expect(explore.kind === 'task' && explore.task.description).toMatch(
      /without changing, committing or pushing/,
    );
  });

  test('no repository, no explore Task; an existing brief is left alone', () => {
    expect(
      setupRecommendations({
        project: {
          name: 'Notes',
          description: 'Already set',
          hasRepository: false,
        },
      }),
    ).toEqual([]);
  });

  test('a Project continued from a chat offers a Task citing that answer', () => {
    const [, task] = setupRecommendations({
      project: { name: 'Revenue', hasRepository: false },
      continuation: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        title: 'Continue: Revenue',
        description: 'Continued from the chat …',
        savedAt: '2026-11-16T12:00:00.000Z',
      },
    });
    expect(task).toEqual(
      expect.objectContaining({
        kind: 'task',
        task: expect.objectContaining({
          reference: { sessionId: 'session-1', turnId: 'turn-1' },
        }),
      }),
    );
  });
});

describe('planLibraryUpload', () => {
  test('a picked folder keeps its layout and skips hidden files, node_modules and oversize files', () => {
    const plan = planLibraryUpload([
      { name: 'a.md', size: 1, webkitRelativePath: 'site/docs/a.md' },
      { name: 'config', size: 1, webkitRelativePath: 'site/.git/config' },
      { name: 'x.js', size: 1, webkitRelativePath: 'site/node_modules/x/x.js' },
      {
        name: 'big.bin',
        size: 26 * 1024 * 1024,
        webkitRelativePath: 'site/big.bin',
      },
      { name: 'loose.txt', size: 1 },
    ]);
    expect(plan.accepted.map((entry) => entry.relativePath)).toEqual([
      'site/docs/a.md',
      'loose.txt',
    ]);
    expect(describeSkipped(plan.skipped)).toBe(
      'Skipped 2 hidden or node_modules files, 1 over 25 MB.',
    );
  });
});
