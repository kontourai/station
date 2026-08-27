import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import {
  STATION_TASK_BASIS_MCP_RESOURCE_URI,
  STATION_TASK_BASIS_MCP_TOOL_REF,
} from './task-basis-mcp-app';
import {
  createDirectAnswerBasisPaneInstance,
  createTaskAnswerBasisPaneInstance,
  createWholeTaskBasisPaneInstance,
} from './workspace-basis-pane';

export const STATION_BASIS_MCP_SERVER_ID = 'station-control';
export const STATION_BASIS_MCP_TOOL_NAME = 'get_basis';
export const STATION_BASIS_MCP_TOOL_REF = `${STATION_BASIS_MCP_SERVER_ID}/${STATION_BASIS_MCP_TOOL_NAME}`;
export const STATION_BASIS_MCP_RESOURCE_URI = 'ui://station/basis/v1';

export interface WorkspaceBasisMcpPaneOccurrence {
  descriptor: WorkspacePaneDescriptor;
  instance: WorkspacePaneInstance;
}

function occurrence(
  native: WorkspacePaneInstance | null,
  initialArguments: Record<string, unknown>,
  mode: { id: string; contextRequirement: Record<string, true> },
  app = {
    ref: STATION_BASIS_MCP_TOOL_REF,
    resourceUri: STATION_BASIS_MCP_RESOURCE_URI,
    name: 'Basis App',
    description: 'Portable answer Basis MCP App.',
  },
): WorkspaceBasisMcpPaneOccurrence | null {
  if (!native?.boundContext) return null;
  const identity = `mcp:${native.instanceId}`;
  const descriptor = parseWorkspacePaneDescriptor({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    id: `pane:mcp:basis:${native.instanceId}`,
    name: app.name,
    description: app.description,
    rendererId: 'renderer:mcp:basis',
    renderer: {
      kind: 'mcp-tool-ui',
      ref: app.ref,
      resourceUri: app.resourceUri,
      approvalPolicy: 'read-only',
      initialArguments,
    },
    placement: {
      supportedRegions: ['primary', 'secondary', 'standalone'],
      preferredRegion: 'secondary',
    },
    modes: [mode],
    provenance: {
      origin: 'mcp',
      mcpServerId: STATION_BASIS_MCP_SERVER_ID,
    },
    lifecycle: { stage: 'preview' },
  });
  if (!descriptor) return null;
  const instance = parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: descriptor.id,
    instanceId: identity,
    stateKey: identity,
    boundContext: native.boundContext,
  });
  return instance ? { descriptor, instance } : null;
}

export function createDirectAnswerBasisMcpPaneOccurrence(
  projectId: string,
  sessionId: string,
  turnId: string,
): WorkspaceBasisMcpPaneOccurrence | null {
  return occurrence(
    createDirectAnswerBasisPaneInstance(projectId, sessionId, turnId),
    { scope: 'answer', sessionId, turnId },
    {
      id: 'answer',
      contextRequirement: { project: true, session: true },
    },
  );
}

export function createTaskAnswerBasisMcpPaneOccurrence(
  projectId: string,
  taskId: string,
  answerReferenceId: string,
): WorkspaceBasisMcpPaneOccurrence | null {
  return occurrence(
    createTaskAnswerBasisPaneInstance(projectId, taskId, answerReferenceId),
    { scope: 'task-answer', taskId, answerReferenceId },
    {
      id: 'task-answer',
      contextRequirement: { project: true, task: true },
    },
  );
}

export function createWholeTaskBasisMcpPaneOccurrence(
  projectId: string,
  taskId: string,
): WorkspaceBasisMcpPaneOccurrence | null {
  return occurrence(
    createWholeTaskBasisPaneInstance(projectId, taskId),
    { taskId },
    { id: 'whole-task', contextRequirement: { project: true, task: true } },
    {
      ref: STATION_TASK_BASIS_MCP_TOOL_REF,
      resourceUri: STATION_TASK_BASIS_MCP_RESOURCE_URI,
      name: 'Basis App',
      description: 'Portable whole Task Basis MCP App.',
    },
  );
}

export function resolveWorkspaceBasisMcpPaneOccurrence(
  instance: WorkspacePaneInstance,
): WorkspaceBasisMcpPaneOccurrence | null {
  const context = instance.boundContext;
  const expected =
    context?.projectId && context.sessionId && context.turnId
      ? createDirectAnswerBasisMcpPaneOccurrence(
          context.projectId,
          context.sessionId,
          context.turnId,
        )
      : context?.projectId && context.taskId && context.answerReferenceId
        ? createTaskAnswerBasisMcpPaneOccurrence(
            context.projectId,
            context.taskId,
            context.answerReferenceId,
          )
        : context?.projectId && context.taskId
          ? createWholeTaskBasisMcpPaneOccurrence(
              context.projectId,
              context.taskId,
            )
          : null;
  return expected &&
    instance.descriptorId === expected.instance.descriptorId &&
    instance.instanceId === expected.instance.instanceId &&
    instance.stateKey === expected.instance.stateKey &&
    JSON.stringify(instance.boundContext) ===
      JSON.stringify(expected.instance.boundContext)
    ? expected
    : null;
}
