/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import type { ChatSession } from '../../types';
import { workflowPlanRuntimeState } from '../builtinWorkspacePaneRegistry';

const session = (overrides: Partial<ChatSession>) =>
  ({ status: 'idle', ...overrides }) as ChatSession;

describe('the plan pane runtime state', () => {
  test('counts the approval requests still waiting on the user, not the ones already answered', () => {
    expect(
      workflowPlanRuntimeState(
        session({
          pendingApprovals: ['req-1', 'req-2'],
          answeredApprovals: ['req-1'],
        }),
      ).pendingApprovals,
    ).toBe(1);
    expect(
      workflowPlanRuntimeState(
        session({
          pendingApprovals: ['req-1'],
          answeredApprovals: ['req-1'],
        }),
      ).pendingApprovals,
    ).toBe(0);
  });

  test('has no approvals and no status without a plan session', () => {
    expect(workflowPlanRuntimeState(undefined)).toEqual({
      status: null,
      pendingApprovals: 0,
      isProcessingStep: false,
    });
  });
});
