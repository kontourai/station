import { describe, expect, test } from 'vitest';
import {
  STATION_TASK_BASIS_MCP_RESOURCE_URI,
  STATION_TASK_BASIS_MCP_TOOL_REF,
} from '../task-basis-mcp-app';
import {
  createDirectAnswerBasisMcpPaneOccurrence,
  createTaskAnswerBasisMcpPaneOccurrence,
  createWholeTaskBasisMcpPaneOccurrence,
  resolveWorkspaceBasisMcpPaneOccurrence,
  STATION_BASIS_MCP_RESOURCE_URI,
  STATION_BASIS_MCP_TOOL_REF,
} from '../workspace-basis-mcp-pane';

describe('portable Basis MCP Pane occurrence', () => {
  test('captures exact answer arguments in an MCP-provenance descriptor and bound context', () => {
    const direct = createDirectAnswerBasisMcpPaneOccurrence(
      'project-a',
      'session-a',
      'turn-a',
    );
    expect(direct).not.toBeNull();
    expect(direct?.descriptor).toMatchObject({
      renderer: {
        kind: 'mcp-tool-ui',
        ref: STATION_BASIS_MCP_TOOL_REF,
        resourceUri: STATION_BASIS_MCP_RESOURCE_URI,
        approvalPolicy: 'read-only',
        initialArguments: {
          scope: 'answer',
          sessionId: 'session-a',
          turnId: 'turn-a',
        },
      },
      provenance: { origin: 'mcp', mcpServerId: 'station-control' },
    });
    expect(direct?.instance.boundContext).toMatchObject({
      projectId: 'project-a',
      sessionId: 'session-a',
      turnId: 'turn-a',
    });
    expect(resolveWorkspaceBasisMcpPaneOccurrence(direct!.instance)).toEqual(
      direct,
    );
  });

  test('keeps selected Task identity exact and fails closed for hostile or tampered occurrences', () => {
    const task = createTaskAnswerBasisMcpPaneOccurrence(
      'project-a',
      'task-a',
      'answer-a',
    );
    expect(task?.descriptor.renderer).toMatchObject({
      initialArguments: {
        scope: 'task-answer',
        taskId: 'task-a',
        answerReferenceId: 'answer-a',
      },
    });
    expect(
      createDirectAnswerBasisMcpPaneOccurrence('project-a', '\ud800', 'turn-a'),
    ).toBeNull();
    expect(
      resolveWorkspaceBasisMcpPaneOccurrence({
        ...task!.instance,
        stateKey: 'forged' as NonNullable<typeof task>['instance']['stateKey'],
      }),
    ).toBeNull();
  });

  test('declares the whole-Task App with a stable task identity', () => {
    const whole = createWholeTaskBasisMcpPaneOccurrence('project-a', 'task-a');
    expect(whole?.descriptor.renderer).toMatchObject({
      ref: STATION_TASK_BASIS_MCP_TOOL_REF,
      resourceUri: STATION_TASK_BASIS_MCP_RESOURCE_URI,
      approvalPolicy: 'read-only',
      initialArguments: { taskId: 'task-a' },
    });
    expect(resolveWorkspaceBasisMcpPaneOccurrence(whole!.instance)).toEqual(
      whole,
    );
  });
});
