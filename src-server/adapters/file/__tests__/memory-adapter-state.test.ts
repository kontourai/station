import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowStateEntry } from '@voltagent/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MemoryAdapterPaths } from '../memory-adapter-paths.js';
import {
  deleteWorkingMemoryState,
  getSuspendedWorkflowStateEntries,
  getWorkflowStateEntry,
  getWorkingMemoryState,
  setWorkflowStateEntry,
  setWorkingMemoryState,
} from '../memory-adapter-state.js';

describe('memory-adapter state helpers', () => {
  let dir: string;
  let paths: MemoryAdapterPaths;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-adapter-state-'));
    paths = new MemoryAdapterPaths(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('conversation working memory round-trips', async () => {
    const resolveResourceId = async () => 'writer';

    await setWorkingMemoryState({
      paths,
      resolveResourceId,
      conversationId: 'conv-1',
      content: 'remember this',
      scope: 'conversation',
    });

    expect(
      await getWorkingMemoryState({
        paths,
        resolveResourceId,
        conversationId: 'conv-1',
        scope: 'conversation',
      }),
    ).toBe('remember this');

    await deleteWorkingMemoryState({
      paths,
      resolveResourceId,
      conversationId: 'conv-1',
      scope: 'conversation',
    });

    expect(
      await getWorkingMemoryState({
        paths,
        resolveResourceId,
        conversationId: 'conv-1',
        scope: 'conversation',
      }),
    ).toBeNull();
  });

  test('workflow state helpers persist and filter suspended workflow entries', async () => {
    const suspended: WorkflowStateEntry = {
      id: 'exec-1',
      workflowId: 'wf-1',
      workflowName: 'Workflow 1',
      status: 'suspended',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      suspension: {
        suspendedAt: new Date('2026-01-03T00:00:00.000Z'),
        stepIndex: 2,
        reason: 'waiting',
      },
    };
    const completed: WorkflowStateEntry = {
      ...suspended,
      id: 'exec-2',
      status: 'completed',
      workflowId: 'wf-2',
      suspension: undefined,
    };

    await setWorkflowStateEntry(paths, suspended.id, suspended);
    await setWorkflowStateEntry(paths, completed.id, completed);

    expect(await getWorkflowStateEntry(paths, suspended.id)).toEqual(suspended);
    expect(await getSuspendedWorkflowStateEntries(paths, 'wf-1')).toEqual([
      suspended,
    ]);
  });
});
