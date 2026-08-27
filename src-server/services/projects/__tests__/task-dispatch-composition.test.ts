import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { composeTaskDispatcher } from '../task-dispatch-composition.js';
import { TaskGraphService } from '../task-graph-service.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('TaskDispatcher runtime composition', () => {
  test('composes real graph, session, and telemetry Adapters behind the dispatcher Interface', async () => {
    const workspace = temporaryDirectory('station-task-dispatch-workspace-');
    const service = new TaskGraphService(
      temporaryDirectory('station-task-dispatch-graph-'),
      {
        projectService: {
          getProject: (slug) => ({
            id: slug,
            slug,
            name: slug,
            workingDirectory: workspace,
            createdAt: '2026-08-13T00:00:00.000Z',
            updatedAt: '2026-08-13T00:00:00.000Z',
          }),
        },
      },
    );
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Compose a dispatcher',
    });

    const outcome = await composeTaskDispatcher(service).dispatch(task.id, {
      sourceSurface: 'composition-test',
    });

    expect(outcome).toMatchObject({
      kind: 'dispatched',
      result: {
        task: { id: task.id, status: 'ready' },
        dispatch: { outcome: 'seeded', sourceSurface: 'composition-test' },
      },
    });
    expect(service.readTask(task.id)).toMatchObject({
      id: task.id,
      status: 'ready',
      sessionId: expect.any(String),
    });
    await expect(
      composeTaskDispatcher(service).dispatch('missing-task', {}),
    ).resolves.toEqual({
      kind: 'not-found',
      reason: 'Task not found: missing-task',
    });
  });
});
