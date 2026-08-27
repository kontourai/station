import type { WorkflowStateEntry } from '@voltagent/core';
import { describe, expect, test } from 'vitest';
import {
  deserializeWorkflowState,
  serializeWorkflowState,
} from '../memory-adapter-workflows.js';

function buildWorkflowState(): WorkflowStateEntry {
  return {
    id: 'exec-1',
    workflowId: 'wf-1',
    workflowName: 'Workflow',
    status: 'suspended',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    suspension: {
      suspendedAt: new Date('2026-01-03T00:00:00.000Z'),
      stepIndex: 2,
      reason: 'waiting',
    },
  };
}

describe('memory-adapter workflow helpers', () => {
  test('serializeWorkflowState converts dates to strings', () => {
    expect(serializeWorkflowState(buildWorkflowState())).toMatchObject({
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      suspension: {
        suspendedAt: '2026-01-03T00:00:00.000Z',
      },
    });
  });

  test('deserializeWorkflowState restores dates', () => {
    const state = deserializeWorkflowState(
      serializeWorkflowState(buildWorkflowState()),
    );

    expect(state).toEqual(buildWorkflowState());
  });
});
