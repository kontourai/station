import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { describe, expect, test, vi } from 'vitest';
import {
  LOCAL_WORK_ITEM_PROVIDER_IDENTITY,
  LocalWorkItemProvider,
} from '../work-item-providers/local-work-item-provider.js';

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    projectId: 'project-alpha',
    title: 'Existing task',
    description: '',
    priority: 'normal',
    status: 'todo',
    createdBy: 'user',
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('LocalWorkItemProvider', () => {
  test('declares a read-write, dispatch-capable, local identity', () => {
    const provider = new LocalWorkItemProvider({ listTasks: vi.fn(() => []) });
    expect(provider.identity).toEqual(LOCAL_WORK_ITEM_PROVIDER_IDENTITY);
    expect(provider.capabilities).toEqual({
      readOnly: false,
      supportsDispatch: true,
      supportsStatusWrite: false,
    });
  });

  test('adapts TaskGraphService.listTasks into provider-neutral work items', async () => {
    const listTasks = vi.fn(() => [
      task(),
      task({
        id: 'task-2',
        title: 'Second task',
        status: 'in_progress',
        priority: 'high',
        workItemRef: 'github:kontourai/station#583',
        updatedAt: '2026-05-04T00:00:00.000Z',
      }),
    ]);
    const provider = new LocalWorkItemProvider({ listTasks });

    const result = await provider.listWorkItems({
      projectId: 'project-alpha',
      workingDirectory: '/tmp/project-alpha',
    });

    expect(listTasks).toHaveBeenCalledWith('project-alpha');
    expect(result.available).toBe(true);
    expect(result.items).toEqual([
      {
        id: 'task-1',
        title: 'Existing task',
        status: 'todo',
        provider: LOCAL_WORK_ITEM_PROVIDER_IDENTITY,
        workItemRef: undefined,
        priority: 'normal',
        updatedAt: '2026-05-03T00:00:00.000Z',
      },
      {
        id: 'task-2',
        title: 'Second task',
        status: 'in_progress',
        provider: LOCAL_WORK_ITEM_PROVIDER_IDENTITY,
        workItemRef: 'github:kontourai/station#583',
        priority: 'high',
        updatedAt: '2026-05-04T00:00:00.000Z',
      },
    ]);
  });

  test('always reports available (zero-dependency fallback)', async () => {
    const provider = new LocalWorkItemProvider({ listTasks: () => [] });
    const result = await provider.listWorkItems({
      projectId: 'project-alpha',
      workingDirectory: '/tmp/project-alpha',
    });
    expect(result).toEqual({ available: true, items: [] });
  });
});
