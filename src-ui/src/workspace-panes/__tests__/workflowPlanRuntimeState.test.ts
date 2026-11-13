/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import { deriveWorkflowRuntimeStrip } from '../../components/flow/WorkflowPlanPanel';
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
      pendingInputs: 0,
      waitingOnUser: false,
      isProcessingStep: false,
    });
  });
});

test('the plan strip reads input kinds from its real session projection, with permission first', () => {
  const question = session({
    orchestrationStatus: 'awaiting-approval',
    pendingApprovals: ['q'],
    pendingRequestKinds: { q: 'input' },
  });
  expect(
    deriveWorkflowRuntimeStrip(workflowPlanRuntimeState(question))?.label,
  ).toBe('Needs input (1)');
  const mixed = session({
    ...question,
    pendingApprovals: ['q', 'p'],
    pendingRequestKinds: { q: 'input', p: 'approval' },
  });
  expect(
    deriveWorkflowRuntimeStrip(workflowPlanRuntimeState(mixed))?.label,
  ).toBe('Needs approval (1)');
  expect(
    deriveWorkflowRuntimeStrip(
      workflowPlanRuntimeState(
        session({ ...question, answeredApprovals: ['q'] }),
      ),
    ),
  ).toBeNull();
});
