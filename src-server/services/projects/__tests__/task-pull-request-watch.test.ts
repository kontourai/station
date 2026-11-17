/**
 * #5066: a Task's pull request watch choice and the hold Station puts on it
 * when a watched pull request uses every fix attempt, over the REAL
 * `TaskGraphService` (its store, validator and status transitions).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { TaskGraphService } from '../task-graph-service.js';

const makeTempDir = trackTempDirs();

function fixture() {
  const home = makeTempDir('station-pr-watch-');
  const workspace = makeTempDir('station-pr-watch-workspace-');
  const graph = new TaskGraphService(home, {
    projectService: {
      getProject: (slug: string) => {
        if (slug !== 'project-alpha') throw new Error('missing project');
        return {
          id: slug,
          slug,
          name: 'Project alpha',
          workingDirectory: workspace,
          createdAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        };
      },
    },
  } as never);
  return { graph, home };
}

const HOLD = {
  checks: ['ci / unit-tests'],
  pullRequest: 'acme/widgets#42',
  at: '2026-11-10T12:00:00.000Z',
};

describe('a Task’s pull request watch', () => {
  test('a person’s choice is stored, reloads, and clears back to the Project’s', async () => {
    const { graph, home } = fixture();
    const task = await graph.createTask({
      projectId: 'project-alpha',
      title: 'Ship it',
    });
    expect(task.pullRequestWatch).toBeUndefined();
    expect(
      (await graph.setPullRequestWatch(task.id, 'off')).pullRequestWatch,
    ).toBe('off');
    // A fresh service over the same store reads it back (the validator
    // accepts it).
    const reloaded = new TaskGraphService(home, {} as never);
    expect(reloaded.readTask(task.id)?.pullRequestWatch).toBe('off');
    expect(
      (await graph.setPullRequestWatch(task.id, 'project')).pullRequestWatch,
    ).toBeUndefined();
  });

  test('a spent fix budget blocks the Task with its checks named, and any move clears the reason', async () => {
    const { graph, home } = fixture();
    const task = await graph.createTask({
      projectId: 'project-alpha',
      title: 'Ship it',
    });
    await graph.updateTaskStatus(task.id, 'in_progress');
    await expect(
      graph.holdTaskForPullRequestWatch({ taskId: task.id, hold: HOLD }),
    ).resolves.toBe(true);
    const held = graph.readTask(task.id);
    expect(held?.status).toBe('blocked');
    expect(held?.pullRequestWatchHold).toEqual(HOLD);
    const stored = JSON.parse(
      readFileSync(join(home, 'task-graph.json'), 'utf8'),
    );
    expect(
      stored.tasks.find((item: { id: string }) => item.id === task.id)
        .pullRequestWatchHold,
    ).toEqual(HOLD);
    expect(
      new TaskGraphService(home, {} as never).readTask(task.id)?.status,
    ).toBe('blocked');

    await graph.updateTaskStatus(task.id, 'in_progress');
    expect(graph.readTask(task.id)?.pullRequestWatchHold).toBeUndefined();
  });

  test('a Task that may not move to blocked is left alone', async () => {
    const { graph } = fixture();
    const task = await graph.createTask({
      projectId: 'project-alpha',
      title: 'Ship it',
    });
    await graph.updateTaskStatus(task.id, 'in_progress');
    await graph.updateTaskStatus(task.id, 'done');
    await expect(
      graph.holdTaskForPullRequestWatch({ taskId: task.id, hold: HOLD }),
    ).resolves.toBe(false);
    expect(graph.readTask(task.id)?.status).toBe('done');
    await expect(graph.setPullRequestWatch(task.id, 'on')).rejects.toThrow(
      'already done',
    );
  });
});
